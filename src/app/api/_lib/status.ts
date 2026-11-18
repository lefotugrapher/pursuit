// /api/status payload + worker heartbeat parsing. Pure: unit-tested in tests/api.test.ts.

import type { JobStatus, RunRow, Settings } from '@/lib/types';

/** KV key the worker refreshes every loop tick. */
export const HEARTBEAT_KEY = 'worker.heartbeat';
/** Worker counts as online when its heartbeat is younger than this. */
export const HEARTBEAT_ONLINE_SEC = 90;

const TIMESTAMP_FIELDS = ['ts', 'at', 'time', 'iso', 'updatedAt', 'lastBeat', 'beat'];

function isoFrom(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value; // epoch seconds or ms
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * The worker may store its heartbeat as an ISO string, epoch number, or an object such as
 * {ts, pid}. Returns the beat as an ISO string, or null when absent/unreadable.
 */
export function parseHeartbeat(value: unknown): string | null {
  const direct = isoFrom(value);
  if (direct) return direct;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const field of TIMESTAMP_FIELDS) {
      const iso = isoFrom(record[field]);
      if (iso) return iso;
    }
  }
  return null;
}

/** Whole seconds since the beat (never negative); null when there is no beat. */
export function heartbeatAgeSec(beatIso: string | null, now: Date = new Date()): number | null {
  if (!beatIso) return null;
  const t = new Date(beatIso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now.getTime() - t) / 1000));
}

export interface WorkerHealth {
  heartbeatAt: string | null;
  ageSec: number | null;
  online: boolean;
}

export function workerHealth(heartbeat: unknown, now: Date = new Date()): WorkerHealth {
  const heartbeatAt = parseHeartbeat(heartbeat);
  const ageSec = heartbeatAgeSec(heartbeatAt, now);
  return { heartbeatAt, ageSec, online: ageSec !== null && ageSec < HEARTBEAT_ONLINE_SEC };
}

export interface StatusRun {
  id: number;
  kind: string;
  startedAt: string;
  finishedAt: string | null;
  state: 'running' | 'ok' | 'failed';
  error: string | null;
}

export interface StatusPayload {
  ok: true;
  now: string;
  paused: boolean;
  mode: Settings['mode'];
  autopilot: boolean;
  counts: Record<JobStatus, number>;
  total: number;
  queueSize: number;
  needsYou: number;
  inFlight: number;
  worker: WorkerHealth;
  lastRuns: StatusRun[];
  integrations: { llm: boolean; mail: boolean };
}

export interface StatusInput {
  counts: Record<JobStatus, number>;
  settings: Pick<Settings, 'paused' | 'mode' | 'autopilot'>;
  heartbeat: unknown;
  runs: RunRow[];
  hasLLM: boolean;
  hasMail: boolean;
  now?: Date;
  runLimit?: number;
}

const ERROR_PREVIEW = 240;

export function toStatusRun(run: RunRow): StatusRun {
  const state: StatusRun['state'] = run.finishedAt == null ? 'running' : run.ok ? 'ok' : 'failed';
  return {
    id: run.id,
    kind: run.kind,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    state,
    error: run.error ? run.error.slice(0, ERROR_PREVIEW) : null,
  };
}

export function buildStatusPayload(input: StatusInput): StatusPayload {
  const now = input.now ?? new Date();
  const counts = input.counts;
  const total = Object.values(counts).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  return {
    ok: true,
    now: now.toISOString(),
    paused: input.settings.paused,
    mode: input.settings.mode,
    autopilot: input.settings.mode === 'autopilot' && input.settings.autopilot.enabled,
    counts,
    total,
    queueSize: counts.ready ?? 0,
    needsYou: counts.needs_you ?? 0,
    inFlight: (counts.approved ?? 0) + (counts.applying ?? 0),
    worker: workerHealth(input.heartbeat, now),
    lastRuns: input.runs.slice(0, input.runLimit ?? 6).map(toStatusRun),
    integrations: { llm: input.hasLLM, mail: input.hasMail },
  };
}
