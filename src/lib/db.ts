// SQLite persistence (node:sqlite). Server-only. Both the Next server and the worker open the same
// WAL-mode file; writes that read-modify-write run inside BEGIN IMMEDIATE transactions.
//
// Conventions:
// - Timestamps are UTC ISO strings; "today" means the current Europe/Dublin calendar day.
// - JSON columns are TEXT. Columns are snake_case; returned objects are camelCase contract types.
// - Optional fields that are NULL in the DB are omitted from returned objects.
// - In patch objects, a key present with value `undefined` clears a nullable column.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { SettingsSchema } from './config';
import { redactSecrets } from './env';
import { DB_PATH } from './paths';
import { dublinDate, dublinDayStartIso, addDays, nowIso, toIso } from './time';
import {
  DEFAULT_SETTINGS, JOB_STATUSES,
  type Application, type Artifact, type ArtifactKind, type Contact, type EmailKind, type EventRow, type FunnelStats,
  type InboxItem, type Job, type JobQuery, type JobStatus, type LLMUsage, type Message, type MessageStatus,
  type NewArtifact, type NewContact, type NewJob, type NewMessage, type ResponseRateRow, type RunRow, type Settings,
} from './types';

// ───────────────────────────── Public helper types ─────────────────────────────

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

export type NewApplication = Omit<Application, 'id' | 'startedAt'> & { startedAt?: string };
export type ApplicationPatch = Partial<Omit<Application, 'id' | 'jobId'>>;
export interface ApplicationQuery { jobId?: string; status?: Application['status'] | Application['status'][]; method?: Application['method']; since?: string; limit?: number }

export interface ContactQuery { jobId?: string; company?: string; hasEmail?: boolean; limit?: number }

export type MessagePatch = Partial<Omit<Message, 'id' | 'createdAt'>>;
export interface MessageQuery {
  jobId?: string; contactId?: number; inboxId?: number;
  status?: MessageStatus | MessageStatus[]; channel?: NewMessage['channel']; kind?: NewMessage['kind'] | NewMessage['kind'][];
  direction?: NewMessage['direction']; limit?: number;
}

export type NewInboxItem = Omit<InboxItem, 'id' | 'createdAt' | 'handled' | 'snippet'> & { handled?: boolean; snippet?: string };
export type InboxPatch = Partial<Omit<InboxItem, 'id' | 'messageId' | 'createdAt'>>;
export interface InboxQuery { jobId?: string; kind?: EmailKind | EmailKind[]; handled?: boolean; since?: string; limit?: number }

export interface EventQuery { jobId?: string; type?: string; typePrefix?: string; since?: string; limit?: number }

export interface LLMUsageSummary {
  since: string;
  calls: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  byPurpose: { purpose: string; calls: number; failed: number; promptTokens: number; completionTokens: number; costUsd: number }[];
  byModel: { model: string; calls: number; promptTokens: number; completionTokens: number; costUsd: number }[];
}

/** Event type written by setStatus/updateJob/upsertJob: detail = {from, to, detail?}. */
export const STATUS_EVENT = 'status';

// ───────────────────────────── Connection ─────────────────────────────

interface DbHandle { db: DatabaseSync; path: string; stmts: Map<string, StatementSync> }
const g = globalThis as typeof globalThis & { __pursuitDb?: DbHandle };

/** Resolved at open time so tests can set PURSUIT_DB_PATH after import. */
function resolveDbPath(): string {
  const override = process.env.PURSUIT_DB_PATH?.trim();
  return override ? path.resolve(override) : DB_PATH;
}

function openDb(file: string): DbHandle {
  // getBuiltinModule keeps bundlers (Next/Turbopack) from trying to resolve node:sqlite.
  const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file, { timeout: 5000, enableForeignKeyConstraints: true });
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.function('dublin_date', { deterministic: true }, (value) => {
    if (typeof value !== 'string') return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : dublinDate(d);
  });
  try {
    runMigrations(database);
  } catch (err) {
    database.close();
    throw err;
  }
  return { db: database, path: file, stmts: new Map() };
}

/** Shared connection (one per process; survives Next dev hot reloads via globalThis). */
export function db(): DatabaseSync {
  return handle().db;
}

function handle(): DbHandle {
  const file = resolveDbPath();
  const current = g.__pursuitDb;
  if (current && current.path === file) return current;
  if (current) closeDb();
  g.__pursuitDb = openDb(file);
  return g.__pursuitDb;
}

/** Closes the shared connection (tests, graceful shutdown). The next db() call reopens. */
export function closeDb(): void {
  const current = g.__pursuitDb;
  if (!current) return;
  g.__pursuitDb = undefined;
  try {
    current.db.close();
  } catch {
    // already closed
  }
}

function stmt(sql: string): StatementSync {
  const h = handle();
  let s = h.stmts.get(sql);
  if (!s) {
    s = h.db.prepare(sql);
    h.stmts.set(sql, s);
  }
  return s;
}

type Row = Record<string, SQLOutputValue>;

const all = (sql: string, ...params: SQLInputValue[]): Row[] => stmt(sql).all(...params);
const get = (sql: string, ...params: SQLInputValue[]): Row | undefined => stmt(sql).get(...params);
const run = (sql: string, ...params: SQLInputValue[]) => stmt(sql).run(...params);
const count = (sql: string, ...params: SQLInputValue[]): number => Number(get(sql, ...params)?.n ?? 0);

let savepointSeq = 0;

/**
 * Runs `fn` atomically (BEGIN IMMEDIATE, or a SAVEPOINT when nested). `fn` must be synchronous:
 * node:sqlite is synchronous and an await inside would leave the transaction open.
 */
export function tx<T>(fn: () => T): T {
  const database = db();
  const nested = database.isTransaction;
  const savepoint = `sp_${++savepointSeq}`;
  database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('tx() callback must be synchronous');
    database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (err) {
    if (nested) {
      database.exec(`ROLLBACK TO ${savepoint}`);
      database.exec(`RELEASE ${savepoint}`);
    } else if (database.isTransaction) {
      database.exec('ROLLBACK');
    }
    throw err;
  }
}

// ───────────────────────────── Migrations ─────────────────────────────

interface Migration { version: number; name: string; sql: string }

const APPLIED_STATUSES = ['applied', 'replied', 'interview', 'offer'] as const satisfies readonly JobStatus[];

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        company TEXT NOT NULL,
        title TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        country TEXT,
        remote INTEGER NOT NULL DEFAULT 0,
        url TEXT NOT NULL,
        apply_url TEXT NOT NULL,
        ats TEXT NOT NULL DEFAULT 'unknown',
        ats_meta TEXT NOT NULL DEFAULT '{}',
        description TEXT NOT NULL DEFAULT '',
        salary TEXT,
        employment_type TEXT,
        department TEXT,
        posted_at TEXT,
        status TEXT NOT NULL DEFAULT 'discovered',
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        score REAL,
        score_detail TEXT,
        filters TEXT,
        keywords TEXT,
        needs TEXT,
        notes TEXT,
        starred INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_jobs_status ON jobs(status);
      CREATE INDEX idx_jobs_score ON jobs(score);
      CREATE INDEX idx_jobs_company ON jobs(company COLLATE NOCASE);
      CREATE INDEX idx_jobs_discovered ON jobs(discovered_at);
      CREATE INDEX idx_jobs_source ON jobs(source);

      CREATE TABLE artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        path TEXT,
        content TEXT,
        meta TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (job_id, kind, version)
      );

      CREATE TABLE applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        submitted_at TEXT,
        method TEXT NOT NULL,
        status TEXT NOT NULL,
        confirmation TEXT,
        screenshot_path TEXT,
        cv_artifact_id INTEGER REFERENCES artifacts(id) ON DELETE SET NULL,
        summary_variant TEXT,
        error TEXT
      );
      CREATE INDEX idx_applications_job ON applications(job_id);
      CREATE INDEX idx_applications_submitted ON applications(submitted_at);

      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        company TEXT NOT NULL,
        name TEXT,
        role TEXT,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        linkedin_url TEXT,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE
      );
      CREATE INDEX idx_contacts_job ON contacts(job_id);

      CREATE TABLE inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        from_address TEXT NOT NULL,
        from_header TEXT NOT NULL,
        subject TEXT NOT NULL,
        date TEXT NOT NULL,
        snippet TEXT NOT NULL,
        body TEXT NOT NULL,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        kind TEXT,
        confidence REAL,
        summary TEXT,
        handled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_inbox_job ON inbox(job_id);
      CREATE INDEX idx_inbox_date ON inbox(date);

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
        inbox_id INTEGER REFERENCES inbox(id) ON DELETE SET NULL,
        direction TEXT NOT NULL,
        channel TEXT NOT NULL,
        kind TEXT NOT NULL,
        to_addr TEXT,
        subject TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        attach_cv INTEGER NOT NULL DEFAULT 0,
        in_reply_to TEXT,
        guard_problems TEXT,
        slop_hits TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        message_id TEXT,
        error TEXT
      );
      CREATE INDEX idx_messages_job ON messages(job_id);
      CREATE INDEX idx_messages_status ON messages(status, channel);
      CREATE INDEX idx_messages_sent ON messages(sent_at);

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        job_id TEXT,
        detail TEXT
      );
      CREATE INDEX idx_events_job ON events(job_id, type);
      CREATE INDEX idx_events_ts ON events(ts);
      CREATE INDEX idx_events_type ON events(type, ts);

      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        ok INTEGER,
        stats TEXT,
        error TEXT
      );
      CREATE INDEX idx_runs_kind ON runs(kind, started_at);

      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

      CREATE TABLE llm_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        ok INTEGER NOT NULL
      );
      CREATE INDEX idx_llm_usage_ts ON llm_usage(ts);

      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

      -- One row per job that was ever applied: earliest confirmed submission or status change into
      -- an applied-or-later status. Drives funnel, caps and analytics.
      CREATE VIEW applied_jobs AS
        SELECT x.job_id AS job_id, MIN(x.ts) AS applied_at
        FROM (
          SELECT job_id, submitted_at AS ts FROM applications
            WHERE status = 'submitted' AND submitted_at IS NOT NULL
          UNION ALL
          SELECT job_id, ts FROM events
            WHERE type = '${STATUS_EVENT}' AND job_id IS NOT NULL
              AND json_extract(detail, '$.to') IN (${APPLIED_STATUSES.map((s) => `'${s}'`).join(', ')})
        ) x
        JOIN jobs j ON j.id = x.job_id
        GROUP BY x.job_id;
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function currentVersion(database: DatabaseSync): number {
  const row = database.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get();
  return Number(row?.v ?? 0);
}

function runMigrations(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  if (currentVersion(database) >= SCHEMA_VERSION) return;
  for (const m of MIGRATIONS) {
    database.exec('BEGIN IMMEDIATE'); // re-check inside the lock: the other process may have migrated
    try {
      if (currentVersion(database) < m.version) {
        database.exec(m.sql);
        database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, nowIso());
      }
      database.exec('COMMIT');
    } catch (err) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`);
    }
  }
}

/** Applied migration version (doctor). */
export function schemaVersion(): number {
  return currentVersion(db());
}

// ───────────────────────────── Column mapping ─────────────────────────────

type ColType = 'text' | 'int' | 'real' | 'bool' | 'json' | 'iso';
interface Col { col: string; type: ColType; notNull?: boolean }
type Spec<T> = { [K in keyof T]-?: Col };

const c = (col: string, type: ColType, notNull = false): Col => ({ col, type, notNull });

const MAX_TEXT = 200_000;

function encode(col: Col, value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  switch (col.type) {
    case 'text': {
      const s = String(value);
      return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
    }
    case 'int':
    case 'real': {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return col.type === 'int' ? Math.trunc(n) : n;
    }
    case 'bool':
      return value ? 1 : 0;
    case 'json':
      return toJsonText(value);
    case 'iso':
      return toIso(value as string | Date | number) ?? String(value);
  }
}

function decodeValue(col: Col, value: SQLOutputValue): unknown {
  switch (col.type) {
    case 'text':
    case 'iso':
      return String(value);
    case 'int':
    case 'real':
      return Number(value);
    case 'bool':
      return Number(value) !== 0;
    case 'json':
      try {
        return JSON.parse(String(value));
      } catch {
        return undefined; // corrupt JSON should never take the dashboard down
      }
  }
}

function decodeRow<T>(spec: Spec<T>, row: Row): T {
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(spec) as [string, Col][]) {
    const raw = row[col.col];
    if (raw === null || raw === undefined) {
      if (col.type === 'bool' && col.notNull) out[key] = false;
      continue;
    }
    const value = decodeValue(col, raw);
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

function insertRow<T>(table: string, spec: Spec<T>, obj: Partial<T>, extra: Record<string, SQLInputValue> = {}): number {
  const cols: string[] = [];
  const vals: SQLInputValue[] = [];
  for (const [key, col] of Object.entries(spec) as [string, Col][]) {
    const value = (obj as Record<string, unknown>)[key];
    if (value === undefined) continue;
    cols.push(col.col);
    vals.push(encode(col, value));
  }
  for (const [col, value] of Object.entries(extra)) {
    cols.push(col);
    vals.push(value);
  }
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return Number(run(sql, ...vals).lastInsertRowid);
}

/** Builds `SET` assignments from a patch. Returns null when nothing to update. */
function buildSet<T>(spec: Spec<T>, patch: Partial<T>, readonly: ReadonlySet<string>): { sql: string; params: SQLInputValue[] } | null {
  const sets: string[] = [];
  const params: SQLInputValue[] = [];
  for (const key of Object.keys(patch)) {
    if (readonly.has(key)) continue;
    const col = (spec as Record<string, Col | undefined>)[key];
    if (!col) continue;
    const value = (patch as Record<string, unknown>)[key];
    const encoded = encode(col, value);
    if (encoded === null && col.notNull) continue;
    sets.push(`${col.col} = ?`);
    params.push(encoded);
  }
  return sets.length ? { sql: sets.join(', '), params } : null;
}

// Keys whose string values are always redacted in stored JSON. Plain `token` is deliberately absent:
// ATS board tokens are public identifiers and useful in logs. Real env secrets are also redacted by value.
const SECRET_KEY = /^(pass|pwd)$|password|passwd|secret|api[-_]?key|authorization|cookie|bearer|(access|refresh|auth|id)[-_]?token/i;
const MAX_DETAIL = 20_000;

/** JSON.stringify that survives bigint/Error/circular values and redacts secrets. */
export function toJsonText(value: unknown): string {
  const seen = new WeakSet<object>();
  const text = JSON.stringify(value, function replacer(key, v: unknown) {
    if (key && SECRET_KEY.test(key) && typeof v === 'string') return '[redacted]';
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split('\n').slice(0, 6).join('\n') };
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
  return redactSecrets(text ?? 'null');
}

function inList(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

function clampLimit(limit: number | undefined, fallback: number, max = 10_000): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

// ───────────────────────────── Jobs ─────────────────────────────

const JOB_SPEC: Spec<Job> = {
  id: c('id', 'text', true),
  source: c('source', 'text', true),
  sourceId: c('source_id', 'text', true),
  company: c('company', 'text', true),
  title: c('title', 'text', true),
  location: c('location', 'text', true),
  country: c('country', 'text'),
  remote: c('remote', 'bool', true),
  url: c('url', 'text', true),
  applyUrl: c('apply_url', 'text', true),
  ats: c('ats', 'text', true),
  atsMeta: c('ats_meta', 'json', true),
  description: c('description', 'text', true),
  salary: c('salary', 'json'),
  employmentType: c('employment_type', 'text'),
  department: c('department', 'text'),
  postedAt: c('posted_at', 'iso'),
  status: c('status', 'text', true),
  discoveredAt: c('discovered_at', 'iso', true),
  updatedAt: c('updated_at', 'iso', true),
  score: c('score', 'real'),
  scoreDetail: c('score_detail', 'json'),
  filters: c('filters', 'json'),
  keywords: c('keywords', 'json'),
  needs: c('needs', 'json'),
  notes: c('notes', 'text'),
  starred: c('starred', 'bool', true),
};

const toJob = (row: Row): Job => {
  const job = decodeRow(JOB_SPEC, row);
  job.atsMeta ??= {};
  return job;
};

function assertStatus(status: string): asserts status is JobStatus {
  if (!(JOB_STATUSES as string[]).includes(status)) throw new Error(`Unknown job status: ${JSON.stringify(status)}`);
}

const ATS_RANK: Record<string, number> = {
  greenhouse: 3, lever: 3, ashby: 3, smartrecruiters: 3, workable: 3, workday: 2, email: 2, linkedin: 1, indeed: 1, unknown: 0,
};

function salaryRichness(s: Job['salary']): number {
  if (!s) return 0;
  return (s.min !== undefined ? 1 : 0) + (s.max !== undefined ? 1 : 0) + (s.currency ? 1 : 0) + (s.raw ? 0.5 : 0);
}

function isDirectApplyUrl(applyUrl: string | undefined, url: string): boolean {
  return Boolean(applyUrl && applyUrl.trim() && applyUrl !== url);
}

/** Fields of `incoming` that improve `existing`. Never touches status, identity or first-seen source. */
function mergePatch(existing: Job, incoming: NewJob): Partial<Job> {
  const patch: Partial<Job> = {};
  const betterAts = (ATS_RANK[incoming.ats] ?? 0) > (ATS_RANK[existing.ats] ?? 0);

  if ((incoming.description ?? '').trim().length > existing.description.trim().length) patch.description = incoming.description;

  if (betterAts) {
    patch.ats = incoming.ats;
    if (incoming.applyUrl?.trim()) patch.applyUrl = incoming.applyUrl;
  } else if (!isDirectApplyUrl(existing.applyUrl, existing.url) && isDirectApplyUrl(incoming.applyUrl, incoming.url)) {
    patch.applyUrl = incoming.applyUrl;
  } else if (!existing.applyUrl.trim() && incoming.applyUrl?.trim()) {
    patch.applyUrl = incoming.applyUrl;
  }

  if (salaryRichness(incoming.salary) > salaryRichness(existing.salary)) patch.salary = incoming.salary;
  if (!existing.postedAt && incoming.postedAt) patch.postedAt = incoming.postedAt;
  if (!existing.employmentType && incoming.employmentType) patch.employmentType = incoming.employmentType;
  if (!existing.department && incoming.department) patch.department = incoming.department;
  if (!existing.country && incoming.country) patch.country = incoming.country;
  if (!existing.remote && incoming.remote) patch.remote = true;

  const incomingMeta = Object.fromEntries(
    Object.entries(incoming.atsMeta ?? {}).filter(([, v]) => v !== undefined && v !== null),
  );
  // Same source (or a better ATS) refreshes keys; another source may only add missing keys.
  const overwrite = betterAts || incoming.source === existing.source;
  const mergedMeta = overwrite ? { ...existing.atsMeta, ...incomingMeta } : { ...incomingMeta, ...existing.atsMeta };
  if (toJsonText(mergedMeta) !== toJsonText(existing.atsMeta)) patch.atsMeta = mergedMeta;

  return patch;
}

function insertStatusEvent(jobId: string, from: JobStatus | null, to: JobStatus, detail?: unknown): void {
  insertEvent(STATUS_EVENT, detail === undefined ? { from, to } : { from, to, detail }, jobId);
}

/** Insert a new job as 'discovered', or merge richer details into the existing row (status untouched). */
export function upsertJob(j: NewJob): { job: Job; created: boolean } {
  if (!j.id?.trim()) throw new Error('upsertJob: job id is required');
  return tx(() => {
    const existingRow = get('SELECT * FROM jobs WHERE id = ?', j.id);
    const now = nowIso();
    if (!existingRow) {
      const job: Job = {
        ...j,
        location: j.location ?? '',
        applyUrl: j.applyUrl?.trim() ? j.applyUrl : j.url,
        atsMeta: j.atsMeta ?? {},
        description: j.description ?? '',
        status: 'discovered',
        discoveredAt: now,
        updatedAt: now,
        starred: false,
      };
      insertRow('jobs', JOB_SPEC, job);
      insertStatusEvent(j.id, null, 'discovered', { source: j.source });
      return { job: getJobOrThrow(j.id), created: true };
    }
    const existing = toJob(existingRow);
    const patch = mergePatch(existing, j);
    if (Object.keys(patch).length) {
      const set = buildSet(JOB_SPEC, { ...patch, updatedAt: now }, JOB_READONLY);
      if (set) run(`UPDATE jobs SET ${set.sql} WHERE id = ?`, ...set.params, j.id);
    }
    return { job: getJobOrThrow(j.id), created: false };
  });
}

export function getJob(id: string): Job | undefined {
  const row = get('SELECT * FROM jobs WHERE id = ?', id);
  return row ? toJob(row) : undefined;
}

function getJobOrThrow(id: string): Job {
  const job = getJob(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  return job;
}

const ORDER_COLUMNS: Record<NonNullable<JobQuery['orderBy']>, string> = {
  score: 'score',
  discoveredAt: 'discovered_at',
  updatedAt: 'updated_at',
  postedAt: 'posted_at',
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function jobWhere(q: JobQuery): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.status !== undefined) {
    const statuses = Array.isArray(q.status) ? q.status : [q.status];
    if (!statuses.length) clauses.push('0');
    else {
      clauses.push(`status IN (${inList(statuses)})`);
      params.push(...statuses);
    }
  }
  if (q.source) {
    clauses.push('source = ?');
    params.push(q.source);
  }
  if (q.minScore !== undefined && Number.isFinite(q.minScore)) {
    clauses.push('score >= ?');
    params.push(q.minScore);
  }
  if (q.company?.trim()) {
    clauses.push('lower(company) = lower(?)');
    params.push(q.company.trim());
  }
  const search = q.search?.trim();
  if (search) {
    const like = `%${escapeLike(search.toLowerCase())}%`;
    clauses.push(`(lower(title) LIKE ? ESCAPE '\\' OR lower(company) LIKE ? ESCAPE '\\' OR lower(location) LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Filtered, ordered job list. Unspecified limit returns every match. */
export function listJobs(q: JobQuery = {}): Job[] {
  const { where, params } = jobWhere(q);
  const col = ORDER_COLUMNS[q.orderBy ?? 'discoveredAt'] ?? 'discovered_at';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const order = `ORDER BY (${col} IS NULL) ASC, ${col} ${dir}, discovered_at DESC, id ASC`;
  const limit = q.limit !== undefined ? clampLimit(q.limit, 50, 100_000) : -1;
  const offset = Math.max(0, Math.trunc(q.offset ?? 0));
  return all(`SELECT * FROM jobs ${where} ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).map(toJob);
}

/** Total matches for a query, ignoring limit/offset (pagination). */
export function countJobs(q: JobQuery = {}): number {
  const { where, params } = jobWhere(q);
  return count(`SELECT COUNT(*) AS n FROM jobs ${where}`, ...params);
}

const JOB_READONLY = new Set<string>(['id', 'discoveredAt']);

/** Patch a job. A status change here is recorded like setStatus. Returns the updated job. */
export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  if (patch.status !== undefined) assertStatus(patch.status);
  return tx(() => {
    const before = getJob(id);
    if (!before) return undefined;
    const set = buildSet(JOB_SPEC, { ...patch, updatedAt: nowIso() }, JOB_READONLY);
    if (set) run(`UPDATE jobs SET ${set.sql} WHERE id = ?`, ...set.params, id);
    if (patch.status && patch.status !== before.status) insertStatusEvent(id, before.status, patch.status);
    return getJob(id);
  });
}

/** Moves a job to `status` and records {from, to, detail} in events. */
export function setStatus(id: string, status: JobStatus, detail?: string | Record<string, unknown>): Job | undefined {
  assertStatus(status);
  return tx(() => {
    const before = getJob(id);
    if (!before) return undefined;
    if (before.status === status && detail === undefined) return before;
    run('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
    insertStatusEvent(id, before.status, status, detail);
    return getJob(id);
  });
}

export function countByStatus(): Record<JobStatus, number> {
  const out = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const row of all('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')) {
    const status = String(row.status);
    if (status in out) out[status as JobStatus] = Number(row.n);
  }
  return out;
}

// ───────────────────────────── Artifacts ─────────────────────────────

const ARTIFACT_SPEC: Spec<Artifact> = {
  id: c('id', 'int', true),
  jobId: c('job_id', 'text', true),
  kind: c('kind', 'text', true),
  version: c('version', 'int', true),
  path: c('path', 'text'),
  content: c('content', 'text'),
  meta: c('meta', 'json'),
  createdAt: c('created_at', 'iso', true),
};

const toArtifact = (row: Row): Artifact => decodeRow(ARTIFACT_SPEC, row);

/** Adds a new version of an artifact (version = previous max + 1 for that job+kind). */
export function addArtifact(a: NewArtifact): Artifact {
  return tx(() => {
    const version = count('SELECT COALESCE(MAX(version), 0) AS n FROM artifacts WHERE job_id = ? AND kind = ?', a.jobId, a.kind) + 1;
    const id = insertRow('artifacts', ARTIFACT_SPEC, { ...a, version, createdAt: nowIso() });
    return toArtifact(get('SELECT * FROM artifacts WHERE id = ?', id)!);
  });
}

export function getArtifact(id: number): Artifact | undefined {
  const row = get('SELECT * FROM artifacts WHERE id = ?', id);
  return row ? toArtifact(row) : undefined;
}

/** Newest first. */
export function listArtifacts(jobId: string, kind?: ArtifactKind): Artifact[] {
  const rows = kind
    ? all('SELECT * FROM artifacts WHERE job_id = ? AND kind = ? ORDER BY version DESC, id DESC', jobId, kind)
    : all('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at DESC, id DESC', jobId);
  return rows.map(toArtifact);
}

export function latestArtifact(jobId: string, kind: ArtifactKind): Artifact | undefined {
  const row = get('SELECT * FROM artifacts WHERE job_id = ? AND kind = ? ORDER BY version DESC, id DESC LIMIT 1', jobId, kind);
  return row ? toArtifact(row) : undefined;
}

// ───────────────────────────── Applications ─────────────────────────────

const APPLICATION_SPEC: Spec<Application> = {
  id: c('id', 'int', true),
  jobId: c('job_id', 'text', true),
  startedAt: c('started_at', 'iso', true),
  submittedAt: c('submitted_at', 'iso'),
  method: c('method', 'text', true),
  status: c('status', 'text', true),
  confirmation: c('confirmation', 'text'),
  screenshotPath: c('screenshot_path', 'text'),
  cvArtifactId: c('cv_artifact_id', 'int'),
  summaryVariant: c('summary_variant', 'text'),
  error: c('error', 'text'),
};

const toApplication = (row: Row): Application => decodeRow(APPLICATION_SPEC, row);

export function addApplication(a: NewApplication): Application {
  const startedAt = a.startedAt ?? nowIso();
  const submittedAt = a.status === 'submitted' ? (a.submittedAt ?? nowIso()) : a.submittedAt;
  const id = insertRow('applications', APPLICATION_SPEC, { ...a, startedAt, submittedAt });
  return getApplication(id)!;
}

export function getApplication(id: number): Application | undefined {
  const row = get('SELECT * FROM applications WHERE id = ?', id);
  return row ? toApplication(row) : undefined;
}

/** Setting status 'submitted' without submittedAt stamps it now. */
export function updateApplication(id: number, patch: ApplicationPatch): Application | undefined {
  const full: ApplicationPatch = { ...patch };
  if (full.status === 'submitted' && !full.submittedAt) {
    const current = getApplication(id);
    if (current && !current.submittedAt) full.submittedAt = nowIso();
  }
  const set = buildSet(APPLICATION_SPEC, full, new Set(['id', 'jobId']));
  if (set) run(`UPDATE applications SET ${set.sql} WHERE id = ?`, ...set.params, id);
  return getApplication(id);
}

/** Newest first; default limit 500. */
export function listApplications(q: ApplicationQuery = {}): Application[] {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.jobId) {
    clauses.push('job_id = ?');
    params.push(q.jobId);
  }
  if (q.status !== undefined) {
    const statuses = Array.isArray(q.status) ? q.status : [q.status];
    clauses.push(statuses.length ? `status IN (${inList(statuses)})` : '0');
    params.push(...statuses);
  }
  if (q.method) {
    clauses.push('method = ?');
    params.push(q.method);
  }
  if (q.since) {
    clauses.push('started_at >= ?');
    params.push(toIso(q.since) ?? q.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT * FROM applications ${where} ORDER BY started_at DESC, id DESC LIMIT ?`, ...params, clampLimit(q.limit, 500))
    .map(toApplication);
}

/**
 * Jobs applied today (Dublin day): confirmed submissions plus jobs marked applied by hand.
 * With `method`, counts only submitted application rows of that method (e.g. autopilot's own cap).
 */
export function applicationsToday(method?: Application['method']): number {
  const since = dublinDayStartIso(0);
  if (method) {
    return count(
      "SELECT COUNT(*) AS n FROM applications WHERE status = 'submitted' AND method = ? AND submitted_at >= ?",
      method, since,
    );
  }
  return count('SELECT COUNT(*) AS n FROM applied_jobs WHERE applied_at >= ?', since);
}

// ───────────────────────────── Contacts ─────────────────────────────

const CONTACT_SPEC: Spec<Contact> = {
  id: c('id', 'int', true),
  jobId: c('job_id', 'text'),
  company: c('company', 'text', true),
  name: c('name', 'text'),
  role: c('role', 'text'),
  email: c('email', 'text'),
  emailVerified: c('email_verified', 'bool', true),
  linkedinUrl: c('linkedin_url', 'text'),
  source: c('source', 'text', true),
  confidence: c('confidence', 'real', true),
  createdAt: c('created_at', 'iso', true),
};

const toContact = (row: Row): Contact => decodeRow(CONTACT_SPEC, row);

function contactKey(nc: NewContact): string {
  const norm = (s?: string) => (s ?? '').trim().toLowerCase();
  const scope = nc.jobId ?? '';
  if (nc.email?.trim()) return `${scope}|email:${norm(nc.email)}`;
  return `${scope}|person:${norm(nc.company)}:${norm(nc.name)}:${norm(nc.linkedinUrl)}`;
}

/** Dedupes per job on email (else company+name+linkedin); merges missing fields, keeps max confidence. */
export function upsertContact(nc: NewContact): Contact {
  const key = contactKey(nc);
  return tx(() => {
    const row = get('SELECT * FROM contacts WHERE dedupe_key = ?', key);
    if (!row) {
      const id = insertRow('contacts', CONTACT_SPEC, { ...nc, createdAt: nowIso() }, { dedupe_key: key });
      return toContact(get('SELECT * FROM contacts WHERE id = ?', id)!);
    }
    const existing = toContact(row);
    const patch: Partial<Contact> = {};
    for (const field of ['name', 'role', 'email', 'linkedinUrl'] as const) {
      if (!existing[field] && nc[field]) patch[field] = nc[field];
    }
    if (nc.emailVerified && !existing.emailVerified) patch.emailVerified = true;
    if (nc.confidence > existing.confidence) patch.confidence = nc.confidence;
    const set = buildSet(CONTACT_SPEC, patch, new Set(['id', 'createdAt']));
    if (set) run(`UPDATE contacts SET ${set.sql} WHERE id = ?`, ...set.params, existing.id);
    return toContact(get('SELECT * FROM contacts WHERE id = ?', existing.id)!);
  });
}

export function getContact(id: number): Contact | undefined {
  const row = get('SELECT * FROM contacts WHERE id = ?', id);
  return row ? toContact(row) : undefined;
}

/** Highest confidence first; default limit 500. */
export function listContacts(q: ContactQuery = {}): Contact[] {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.jobId) {
    clauses.push('job_id = ?');
    params.push(q.jobId);
  }
  if (q.company?.trim()) {
    clauses.push('lower(company) = lower(?)');
    params.push(q.company.trim());
  }
  if (q.hasEmail !== undefined) clauses.push(q.hasEmail ? "email IS NOT NULL AND email <> ''" : "(email IS NULL OR email = '')");
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT * FROM contacts ${where} ORDER BY confidence DESC, id DESC LIMIT ?`, ...params, clampLimit(q.limit, 500))
    .map(toContact);
}

// ───────────────────────────── Messages ─────────────────────────────

const MESSAGE_SPEC: Spec<Message> = {
  id: c('id', 'int', true),
  jobId: c('job_id', 'text'),
  contactId: c('contact_id', 'int'),
  inboxId: c('inbox_id', 'int'),
  direction: c('direction', 'text', true),
  channel: c('channel', 'text', true),
  kind: c('kind', 'text', true),
  to: c('to_addr', 'text'),
  subject: c('subject', 'text'),
  body: c('body', 'text', true),
  status: c('status', 'text', true),
  attachCv: c('attach_cv', 'bool', true),
  inReplyTo: c('in_reply_to', 'text'),
  guardProblems: c('guard_problems', 'json'),
  slopHits: c('slop_hits', 'json'),
  createdAt: c('created_at', 'iso', true),
  sentAt: c('sent_at', 'iso'),
  messageId: c('message_id', 'text'),
  error: c('error', 'text'),
};

const toMessage = (row: Row): Message => decodeRow(MESSAGE_SPEC, row);

export function addMessage(m: NewMessage): Message {
  const sentAt = m.status === 'sent' ? nowIso() : undefined;
  const id = insertRow('messages', MESSAGE_SPEC, { ...m, attachCv: m.attachCv ?? false, createdAt: nowIso(), sentAt });
  return getMessage(id)!;
}

export function getMessage(id: number): Message | undefined {
  const row = get('SELECT * FROM messages WHERE id = ?', id);
  return row ? toMessage(row) : undefined;
}

/** Setting status 'sent' without sentAt stamps it now (daily caps depend on it). */
export function updateMessage(id: number, patch: MessagePatch): Message | undefined {
  const full: MessagePatch = { ...patch };
  if (full.status === 'sent' && !full.sentAt) full.sentAt = nowIso();
  const set = buildSet(MESSAGE_SPEC, full, new Set(['id', 'createdAt']));
  if (set) run(`UPDATE messages SET ${set.sql} WHERE id = ?`, ...set.params, id);
  return getMessage(id);
}

/** Newest first; default limit 500. */
export function listMessages(q: MessageQuery = {}): Message[] {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const eq = (col: string, value: SQLInputValue | undefined) => {
    if (value === undefined) return;
    clauses.push(`${col} = ?`);
    params.push(value);
  };
  const oneOf = <T extends string>(col: string, value: T | T[] | undefined) => {
    if (value === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    clauses.push(values.length ? `${col} IN (${inList(values)})` : '0');
    params.push(...values);
  };
  eq('job_id', q.jobId);
  eq('contact_id', q.contactId);
  eq('inbox_id', q.inboxId);
  eq('channel', q.channel);
  eq('direction', q.direction);
  oneOf('status', q.status);
  oneOf('kind', q.kind);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT * FROM messages ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, clampLimit(q.limit, 500))
    .map(toMessage);
}

/** Outbound messages actually sent today (Dublin day) on a channel. Digests to self don't count. */
export function sentToday(channel: NewMessage['channel']): number {
  return count(
    "SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND status = 'sent' AND channel = ? AND kind <> 'digest' AND sent_at >= ?",
    channel, dublinDayStartIso(0),
  );
}

// ───────────────────────────── Inbox ─────────────────────────────

const INBOX_SPEC: Spec<InboxItem> = {
  id: c('id', 'int', true),
  messageId: c('message_id', 'text', true),
  fromAddress: c('from_address', 'text', true),
  from: c('from_header', 'text', true),
  subject: c('subject', 'text', true),
  date: c('date', 'iso', true),
  snippet: c('snippet', 'text', true),
  body: c('body', 'text', true),
  jobId: c('job_id', 'text'),
  kind: c('kind', 'text'),
  confidence: c('confidence', 'real'),
  summary: c('summary', 'text'),
  handled: c('handled', 'bool', true),
  createdAt: c('created_at', 'iso', true),
};

const toInbox = (row: Row): InboxItem => decodeRow(INBOX_SPEC, row);

function makeSnippet(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

/** Inserts an inbound email; returns the existing row (created=false) when the Message-ID was seen before. */
export function addInbox(i: NewInboxItem): { item: InboxItem; created: boolean } {
  if (!i.messageId?.trim()) throw new Error('addInbox: messageId is required');
  return tx(() => {
    const existing = get('SELECT * FROM inbox WHERE message_id = ?', i.messageId);
    if (existing) return { item: toInbox(existing), created: false };
    const id = insertRow('inbox', INBOX_SPEC, {
      ...i,
      from: i.from ?? i.fromAddress,
      subject: i.subject ?? '',
      body: i.body ?? '',
      date: i.date ?? nowIso(),
      snippet: i.snippet ?? makeSnippet(i.body ?? ''),
      handled: i.handled ?? false,
      createdAt: nowIso(),
    });
    return { item: toInbox(get('SELECT * FROM inbox WHERE id = ?', id)!), created: true };
  });
}

export function getInbox(id: number): InboxItem | undefined {
  const row = get('SELECT * FROM inbox WHERE id = ?', id);
  return row ? toInbox(row) : undefined;
}

/** Newest email first; default limit 200. */
export function listInbox(q: InboxQuery = {}): InboxItem[] {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.jobId) {
    clauses.push('job_id = ?');
    params.push(q.jobId);
  }
  if (q.kind !== undefined) {
    const kinds = Array.isArray(q.kind) ? q.kind : [q.kind];
    clauses.push(kinds.length ? `kind IN (${inList(kinds)})` : '0');
    params.push(...kinds);
  }
  if (q.handled !== undefined) {
    clauses.push('handled = ?');
    params.push(q.handled ? 1 : 0);
  }
  if (q.since) {
    clauses.push('date >= ?');
    params.push(toIso(q.since) ?? q.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT * FROM inbox ${where} ORDER BY date DESC, id DESC LIMIT ?`, ...params, clampLimit(q.limit, 200)).map(toInbox);
}

export function updateInbox(id: number, patch: InboxPatch): InboxItem | undefined {
  const set = buildSet(INBOX_SPEC, patch, new Set(['id', 'messageId', 'createdAt']));
  if (set) run(`UPDATE inbox SET ${set.sql} WHERE id = ?`, ...set.params, id);
  return getInbox(id);
}

// ───────────────────────────── Events ─────────────────────────────

const EVENT_SPEC: Spec<EventRow> = {
  id: c('id', 'int', true),
  ts: c('ts', 'iso', true),
  type: c('type', 'text', true),
  jobId: c('job_id', 'text'),
  detail: c('detail', 'json'),
};

const toEvent = (row: Row): EventRow => decodeRow(EVENT_SPEC, row);

function normalizeDetail(detail: unknown): Record<string, unknown> | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail === 'object' && !Array.isArray(detail) && !(detail instanceof Error)) return detail as Record<string, unknown>;
  return { value: detail };
}

function insertEvent(type: string, detail?: unknown, jobId?: string): number {
  const normalized = normalizeDetail(detail);
  let text = normalized === undefined ? null : toJsonText(normalized);
  if (text && text.length > MAX_DETAIL) text = toJsonText({ truncated: true, preview: text.slice(0, MAX_DETAIL) });
  return Number(run('INSERT INTO events (ts, type, job_id, detail) VALUES (?, ?, ?, ?)', nowIso(), type, jobId ?? null, text).lastInsertRowid);
}

/** Appends to the timeline. Never throws (logging must not break callers); returns -1 on failure. */
export function logEvent(type: string, detail?: unknown, jobId?: string): number {
  try {
    return insertEvent(type, detail, jobId);
  } catch (err) {
    console.error(`[pursuit] logEvent(${type}) failed: ${(err as Error).message}`);
    return -1;
  }
}

/** Newest first; default limit 200. */
export function listEvents(q: EventQuery = {}): EventRow[] {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.jobId) {
    clauses.push('job_id = ?');
    params.push(q.jobId);
  }
  if (q.type) {
    clauses.push('type = ?');
    params.push(q.type);
  }
  if (q.typePrefix) {
    clauses.push("type LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(q.typePrefix)}%`);
  }
  if (q.since) {
    clauses.push('ts >= ?');
    params.push(toIso(q.since) ?? q.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return all(`SELECT * FROM events ${where} ORDER BY ts DESC, id DESC LIMIT ?`, ...params, clampLimit(q.limit, 200)).map(toEvent);
}

// ───────────────────────────── Runs ─────────────────────────────

const RUN_SPEC: Spec<RunRow> = {
  id: c('id', 'int', true),
  kind: c('kind', 'text', true),
  startedAt: c('started_at', 'iso', true),
  finishedAt: c('finished_at', 'iso'),
  ok: c('ok', 'bool'),
  stats: c('stats', 'json'),
  error: c('error', 'text'),
};

const toRun = (row: Row): RunRow => decodeRow(RUN_SPEC, row);

export function startRun(kind: string): number {
  return Number(run('INSERT INTO runs (kind, started_at) VALUES (?, ?)', kind, nowIso()).lastInsertRowid);
}

export function finishRun(id: number, ok: boolean, stats?: Record<string, unknown>, error?: string): void {
  run(
    'UPDATE runs SET finished_at = ?, ok = ?, stats = ?, error = ? WHERE id = ?',
    nowIso(), ok ? 1 : 0, stats === undefined ? null : toJsonText(stats), error === undefined ? null : redactSecrets(error).slice(0, 4000), id,
  );
}

/** Newest first. */
export function listRuns(limit = 50, kind?: string): RunRow[] {
  const n = clampLimit(limit, 50, 1000);
  const rows = kind
    ? all('SELECT * FROM runs WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT ?', kind, n)
    : all('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?', n);
  return rows.map(toRun);
}

/** Most recent run of each kind (worker health panel). */
export function latestRunByKind(): RunRow[] {
  return all(
    `SELECT r.* FROM runs r JOIN (SELECT kind, MAX(id) AS id FROM runs GROUP BY kind) last ON last.id = r.id ORDER BY r.kind`,
  ).map(toRun);
}

/** Marks runs left unfinished by a crashed worker as failed. Call once at worker start. */
export function abandonOpenRuns(reason = 'abandoned: worker stopped before finishing'): number {
  return Number(run('UPDATE runs SET finished_at = ?, ok = 0, error = ? WHERE finished_at IS NULL', nowIso(), reason).changes);
}

// ───────────────────────────── Settings ─────────────────────────────

const SETTINGS_KEY = 'settings';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge `override` onto `base`, keeping base's shape; values of the wrong type fall back to base. */
function typedMerge<T>(base: T, override: unknown): T {
  if (isPlainObject(base)) {
    const src = isPlainObject(override) ? override : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) out[key] = typedMerge(value, src[key]);
    return out as T;
  }
  if (Array.isArray(base)) return (Array.isArray(override) ? [...override] : [...base]) as T;
  if (typeof base === 'number') return (typeof override === 'number' && Number.isFinite(override) ? override : base) as T;
  return (override !== undefined && typeof override === typeof base ? override : base) as T;
}

function readStoredSettings(): unknown {
  const row = get('SELECT value FROM settings WHERE key = ?', SETTINGS_KEY);
  if (!row) return {};
  try {
    return JSON.parse(String(row.value));
  } catch {
    return {};
  }
}

/** Stored settings deep-merged over DEFAULT_SETTINGS; invalid stored sections fall back to defaults. */
export function getSettings(): Settings {
  const merged = typedMerge(structuredClone(DEFAULT_SETTINGS), readStoredSettings());
  const parsed = SettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  const repaired: Record<string, unknown> = { ...merged };
  for (const issue of parsed.error.issues) {
    const top = issue.path[0];
    if (typeof top === 'string' && top in DEFAULT_SETTINGS) repaired[top] = structuredClone(DEFAULT_SETTINGS[top as keyof Settings]);
  }
  const second = SettingsSchema.safeParse(repaired);
  return second.success ? second.data : structuredClone(DEFAULT_SETTINGS);
}

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

function rawDeepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = rawDeepMerge(base[key], value);
  }
  return out;
}

/** Deep-merges `patch` (arrays replace), validates, persists. Throws SettingsValidationError if invalid. */
export function updateSettings(patch: DeepPartial<Settings>): Settings {
  return tx(() => {
    const current = getSettings();
    const parsed = SettingsSchema.safeParse(rawDeepMerge(current, patch));
    if (!parsed.success) throw new SettingsValidationError(`Invalid settings:\n${z.prettifyError(parsed.error)}`);
    const next = parsed.data;
    run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      SETTINGS_KEY, JSON.stringify(next), nowIso(),
    );
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    if (changed.length) insertEvent('settings.updated', { changed });
    return next;
  });
}

/** Global outbound kill switch (SPEC §0.6). */
export function isPaused(): boolean {
  return getSettings().paused;
}

// ───────────────────────────── LLM usage ─────────────────────────────

export function recordLLM(u: LLMUsage): void {
  run(
    'INSERT INTO llm_usage (ts, purpose, model, prompt_tokens, completion_tokens, cost_usd, ok) VALUES (?, ?, ?, ?, ?, ?, ?)',
    toIso(u.ts) ?? nowIso(), u.purpose, u.model,
    Math.max(0, Math.trunc(u.promptTokens || 0)), Math.max(0, Math.trunc(u.completionTokens || 0)),
    u.costUsd !== undefined && Number.isFinite(u.costUsd) ? u.costUsd : null, u.ok ? 1 : 0,
  );
}

/** USD recorded against models whose id starts with `modelPrefix` (e.g. "anthropic/"), optionally since a time. */
export function llmSpendUsd(modelPrefix: string, sinceIso?: string): number {
  const like = `${modelPrefix.replace(/[%_]/g, '')}%`;
  const row = sinceIso
    ? get('SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_usage WHERE model LIKE ? AND ts >= ?', like, toIso(sinceIso) ?? sinceIso)
    : get('SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM llm_usage WHERE model LIKE ?', like);
  return Number(row?.cost ?? 0);
}

export function llmUsageSummary(sinceIso: string): LLMUsageSummary {
  const since = toIso(sinceIso) ?? sinceIso;
  const totals = get(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(ok = 0), 0) AS failed, COALESCE(SUM(prompt_tokens), 0) AS pt,
            COALESCE(SUM(completion_tokens), 0) AS ct, COALESCE(SUM(cost_usd), 0) AS cost
     FROM llm_usage WHERE ts >= ?`,
    since,
  );
  const byPurpose = all(
    `SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(ok = 0), 0) AS failed, COALESCE(SUM(prompt_tokens), 0) AS pt,
            COALESCE(SUM(completion_tokens), 0) AS ct, COALESCE(SUM(cost_usd), 0) AS cost
     FROM llm_usage WHERE ts >= ? GROUP BY purpose ORDER BY (pt + ct) DESC`,
    since,
  ).map((r) => ({
    purpose: String(r.purpose), calls: Number(r.calls), failed: Number(r.failed),
    promptTokens: Number(r.pt), completionTokens: Number(r.ct), costUsd: Number(r.cost),
  }));
  const byModel = all(
    `SELECT model, COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS pt, COALESCE(SUM(completion_tokens), 0) AS ct,
            COALESCE(SUM(cost_usd), 0) AS cost
     FROM llm_usage WHERE ts >= ? GROUP BY model ORDER BY calls DESC`,
    since,
  ).map((r) => ({ model: String(r.model), calls: Number(r.calls), promptTokens: Number(r.pt), completionTokens: Number(r.ct), costUsd: Number(r.cost) }));
  return {
    since,
    calls: Number(totals?.calls ?? 0),
    failed: Number(totals?.failed ?? 0),
    promptTokens: Number(totals?.pt ?? 0),
    completionTokens: Number(totals?.ct ?? 0),
    costUsd: Number(totals?.cost ?? 0),
    byPurpose,
    byModel,
  };
}

// ───────────────────────────── KV ─────────────────────────────

/** JSON value stored under `key`, or undefined. */
export function kvGet<T = unknown>(key: string): T | undefined {
  const row = get('SELECT value FROM kv WHERE key = ?', key);
  if (!row) return undefined;
  try {
    return JSON.parse(String(row.value)) as T;
  } catch {
    return undefined;
  }
}

export function kvSet(key: string, value: unknown): void {
  run(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    key, JSON.stringify(value ?? null), nowIso(),
  );
}

export function kvDelete(key: string): void {
  run('DELETE FROM kv WHERE key = ?', key);
}

// ───────────────────────────── Stats ─────────────────────────────

const sqlList = (values: readonly string[]) => values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');

/** SQL predicate: job `alias` is in, or has ever moved into, one of `statuses`. */
function reached(alias: string, statuses: readonly JobStatus[]): string {
  const list = sqlList(statuses);
  return `(${alias}.status IN (${list}) OR EXISTS (SELECT 1 FROM events e WHERE e.job_id = ${alias}.id AND e.type = '${STATUS_EVENT}' AND json_extract(e.detail, '$.to') IN (${list})))`;
}

const SCORED_SET: JobStatus[] = ['scored', 'tailoring', 'ready', 'approved', 'applying', 'needs_you', 'applied', 'replied', 'interview', 'offer'];
const READY_SET: JobStatus[] = ['ready', 'approved', 'applying', 'needs_you', 'applied', 'replied', 'interview', 'offer'];
const INTERVIEW_SET: JobStatus[] = ['interview', 'offer'];

/** For an applied job `alias`: any employer response (linked inbound mail or a response status). */
function responded(alias: string): string {
  return `(${reached(alias, ['replied', 'interview', 'offer', 'rejected'])}
    OR EXISTS (SELECT 1 FROM inbox i WHERE i.job_id = ${alias}.id AND COALESCE(i.kind, 'other') NOT IN ('job_alert', 'confirmation'))
    OR EXISTS (SELECT 1 FROM messages m WHERE m.job_id = ${alias}.id AND m.direction = 'in'))`;
}

const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10_000) / 10_000 : 0);

/** Cumulative funnel. responseRate is a 0-1 fraction of applied jobs that got any response. */
export function funnelStats(): FunnelStats {
  const row = get(
    `SELECT
       (SELECT COUNT(*) FROM jobs) AS discovered,
       (SELECT COUNT(*) FROM jobs j WHERE j.score IS NOT NULL OR ${reached('j', SCORED_SET)} OR j.id IN (SELECT job_id FROM applied_jobs)) AS scored,
       (SELECT COUNT(*) FROM jobs j WHERE ${reached('j', READY_SET)} OR j.id IN (SELECT job_id FROM applied_jobs)) AS ready,
       (SELECT COUNT(*) FROM applied_jobs) AS applied,
       (SELECT COUNT(*) FROM jobs j JOIN applied_jobs a ON a.job_id = j.id WHERE ${responded('j')}) AS replied,
       (SELECT COUNT(*) FROM jobs j WHERE ${reached('j', INTERVIEW_SET)}) AS interview,
       (SELECT COUNT(*) FROM jobs j WHERE ${reached('j', ['offer'])}) AS offer,
       (SELECT COUNT(*) FROM jobs WHERE status = 'rejected') AS rejected,
       (SELECT COUNT(*) FROM applied_jobs WHERE applied_at >= ?) AS applied_today,
       (SELECT COUNT(*) FROM applied_jobs WHERE applied_at >= ?) AS applied_week`,
    dublinDayStartIso(0),
    dublinDayStartIso(6),
  );
  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    discovered: n('discovered'),
    scored: n('scored'),
    ready: n('ready'),
    applied: n('applied'),
    replied: n('replied'),
    interview: n('interview'),
    offer: n('offer'),
    rejected: n('rejected'),
    appliedToday: n('applied_today'),
    appliedWeek: n('applied_week'),
    responseRate: ratio(n('replied'), n('applied')),
  };
}

const SCORE_BUCKETS = ['90+', '80-89', '70-79', '60-69', '45-59', '<45', 'unscored'];
const DIMENSIONS: ResponseRateRow['dimension'][] = ['source', 'ats', 'scoreBucket', 'summaryVariant'];

/** Response rate of applied jobs by source, ATS, score bucket and CV summary variant. */
export function responseRates(): ResponseRateRow[] {
  const rows = all(
    `WITH base AS (
       SELECT j.source AS source, j.ats AS ats,
         CASE WHEN j.score IS NULL THEN 'unscored'
              WHEN j.score >= 90 THEN '90+'
              WHEN j.score >= 80 THEN '80-89'
              WHEN j.score >= 70 THEN '70-79'
              WHEN j.score >= 60 THEN '60-69'
              WHEN j.score >= 45 THEN '45-59'
              ELSE '<45' END AS bucket,
         COALESCE((SELECT ap.summary_variant FROM applications ap
                   WHERE ap.job_id = j.id AND ap.summary_variant IS NOT NULL
                   ORDER BY (ap.status = 'submitted') DESC, ap.id DESC LIMIT 1), 'unknown') AS variant,
         CASE WHEN ${responded('j')} THEN 1 ELSE 0 END AS responded,
         CASE WHEN ${reached('j', INTERVIEW_SET)} THEN 1 ELSE 0 END AS interviewed
       FROM jobs j JOIN applied_jobs a ON a.job_id = j.id
     )
     SELECT 'source' AS dimension, source AS key, COUNT(*) AS applied, SUM(responded) AS responded, SUM(interviewed) AS interviews FROM base GROUP BY source
     UNION ALL
     SELECT 'ats', ats, COUNT(*), SUM(responded), SUM(interviewed) FROM base GROUP BY ats
     UNION ALL
     SELECT 'scoreBucket', bucket, COUNT(*), SUM(responded), SUM(interviewed) FROM base GROUP BY bucket
     UNION ALL
     SELECT 'summaryVariant', variant, COUNT(*), SUM(responded), SUM(interviewed) FROM base GROUP BY variant`,
  );
  const result: ResponseRateRow[] = rows.map((r) => {
    const applied = Number(r.applied);
    const resp = Number(r.responded ?? 0);
    return {
      dimension: String(r.dimension) as ResponseRateRow['dimension'],
      key: String(r.key),
      applied,
      responded: resp,
      interviews: Number(r.interviews ?? 0),
      rate: ratio(resp, applied),
    };
  });
  return result.sort((a, b) => {
    const d = DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension);
    if (d) return d;
    if (a.dimension === 'scoreBucket') return SCORE_BUCKETS.indexOf(a.key) - SCORE_BUCKETS.indexOf(b.key);
    return b.applied - a.applied || a.key.localeCompare(b.key);
  });
}

/** Applications per Dublin day for the last `days` days (oldest first, zero-filled). */
export function dailyApplied(days: number): { date: string; count: number }[] {
  const n = Math.max(1, Math.min(366, Math.trunc(days) || 1));
  const counts = new Map<string, number>();
  for (const r of all(
    'SELECT dublin_date(applied_at) AS d, COUNT(*) AS n FROM applied_jobs WHERE applied_at >= ? GROUP BY d',
    dublinDayStartIso(n - 1),
  )) {
    counts.set(String(r.d), Number(r.n));
  }
  const today = dublinDate();
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(today, i - (n - 1));
    return { date, count: counts.get(date) ?? 0 };
  });
}
