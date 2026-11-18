// Coordination primitives for the worker. Server-only.
//
// 1. Worker lock file (data/worker.lock): exactly one `pnpm worker` per data dir. The file holds
//    JSON with `pid` as its first number (doctor.ts reads the first digits). A lock whose pid is
//    dead is stale and gets replaced.
// 2. Task leases (kv 'lease.<task>'): the Next server ("run now") and the worker are separate
//    processes sharing one SQLite file, so an in-process mutex is not enough. A lease is taken in a
//    BEGIN IMMEDIATE transaction, expires after a TTL, and is renewed while the task runs.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kvDelete, kvGet, kvSet, db, tx } from '@/lib/db';
import { WORKER_LOCK } from '@/lib/paths';

// ───────────────────────────── Process liveness ─────────────────────────────

/** True when a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ───────────────────────────── Worker lock file ─────────────────────────────

export interface LockInfo { pid: number; host: string; startedAt: string }

export type LockResult =
  | { ok: true; info: LockInfo; release: () => void }
  | { ok: false; holder: LockInfo | null; reason: string };

function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>;
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, host: String(parsed.host ?? ''), startedAt: String(parsed.startedAt ?? '') };
  } catch {
    return null;
  }
}

/**
 * Takes the single-instance lock. Replaces a stale lock (dead pid, or unreadable file). The returned
 * `release` only removes the file while it still names this process.
 */
export function acquireWorkerLock(file: string = WORKER_LOCK): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const info: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  const body = `${JSON.stringify(info)}\n`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o644 });
      const release = () => {
        const current = readLock(file);
        if (current?.pid === process.pid) fs.rmSync(file, { force: true });
      };
      return { ok: true, info, release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, holder: null, reason: `cannot write lock file ${file}: ${(err as Error).message}` };
      }
    }
    const holder = readLock(file);
    if (holder && holder.pid !== process.pid && isPidAlive(holder.pid)) {
      return { ok: false, holder, reason: `another worker is running (pid ${holder.pid}, since ${holder.startedAt || 'unknown'})` };
    }
    // Stale (dead pid, our own leftover pid, or garbage): remove and retry. A concurrent starter may
    // win the race; the 'wx' write on the next attempt settles who owns it.
    fs.rmSync(file, { force: true });
  }
  return { ok: false, holder: readLock(file), reason: 'could not take the worker lock after 3 attempts' };
}

// ───────────────────────────── Task leases ─────────────────────────────

export const LEASE_PREFIX = 'lease.';
export const DEFAULT_LEASE_TTL_MS = 10 * 60_000;

export interface Lease { owner: string; pid: number; host: string; acquiredAt: string; expiresAt: string }

export type LeaseResult = { ok: true; lease: Lease } | { ok: false; holder: Lease };

let processOwnerId: string | undefined;

/** Stable id for this process (host:pid:random), used as the lease owner. */
export function processOwner(): string {
  processOwnerId ??= `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  return processOwnerId;
}

export const leaseKey = (name: string) => `${LEASE_PREFIX}${name}`;

function isLease(v: unknown): v is Lease {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as Record<string, unknown>;
  return typeof l.owner === 'string' && typeof l.expiresAt === 'string';
}

function isLive(lease: Lease, now: Date): boolean {
  const expires = Date.parse(lease.expiresAt);
  return Number.isFinite(expires) && expires > now.getTime();
}

/** Current lease for `name` if it is still live. */
export function readLease(name: string, now: Date = new Date()): Lease | undefined {
  const value = kvGet<unknown>(leaseKey(name));
  return isLease(value) && isLive(value, now) ? value : undefined;
}

/** Atomically takes (or re-takes, for the same owner) the lease unless someone else holds a live one. */
export function acquireLease(
  name: string,
  opts: { owner?: string; ttlMs?: number; now?: Date } = {},
): LeaseResult {
  const owner = opts.owner ?? processOwner();
  const now = opts.now ?? new Date();
  const ttl = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  return tx(() => {
    const current = kvGet<unknown>(leaseKey(name));
    if (isLease(current) && current.owner !== owner && isLive(current, now)) return { ok: false, holder: current };
    const lease: Lease = {
      owner,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
    };
    kvSet(leaseKey(name), lease);
    return { ok: true, lease };
  });
}

/** Extends a lease we still own. Returns false if it was lost (expired and taken by someone else). */
export function renewLease(name: string, opts: { owner?: string; ttlMs?: number; now?: Date } = {}): boolean {
  const owner = opts.owner ?? processOwner();
  const now = opts.now ?? new Date();
  const ttl = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  return tx(() => {
    const current = kvGet<unknown>(leaseKey(name));
    if (!isLease(current) || current.owner !== owner) return false;
    kvSet(leaseKey(name), { ...current, expiresAt: new Date(now.getTime() + ttl).toISOString() });
    return true;
  });
}

/** Drops the lease if we own it. */
export function releaseLease(name: string, owner: string = processOwner()): void {
  tx(() => {
    const current = kvGet<unknown>(leaseKey(name));
    if (isLease(current) && current.owner === owner) kvDelete(leaseKey(name));
  });
}

function allLeaseRows(): { key: string; value: unknown }[] {
  const rows = db().prepare("SELECT key, value FROM kv WHERE key LIKE 'lease.%'").all();
  return rows.map((r) => {
    let value: unknown;
    try {
      value = JSON.parse(String(r.value));
    } catch {
      value = undefined;
    }
    return { key: String(r.key), value };
  });
}

/** Releases every lease this process owns (graceful shutdown). */
export function releaseOwnedLeases(owner: string = processOwner()): number {
  let released = 0;
  for (const { key, value } of allLeaseRows()) {
    if (isLease(value) && value.owner === owner) {
      releaseLease(key.slice(LEASE_PREFIX.length), owner);
      released++;
    }
  }
  return released;
}

/**
 * Removes leases left by a crashed process on this host (dead pid), so a restarted worker doesn't
 * wait out the TTL. Leases from other hosts are left to expire on their own.
 */
export function clearDeadLeases(): string[] {
  const host = os.hostname();
  const cleared: string[] = [];
  for (const { key, value } of allLeaseRows()) {
    if (!isLease(value)) {
      kvDelete(key);
      cleared.push(key);
      continue;
    }
    if (value.host === host && value.pid !== process.pid && !isPidAlive(value.pid)) {
      tx(() => {
        const again = kvGet<unknown>(key);
        if (isLease(again) && again.owner === value.owner) kvDelete(key);
      });
      cleared.push(key);
    }
  }
  return cleared;
}
