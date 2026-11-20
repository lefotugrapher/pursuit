// Task registry + runTask: the single entry point used by the worker loop, `pnpm task <name>` and
// the dashboard's POST /api/task/[name]. Server-only.
//
// runTask guarantees, in order:
// 1. outbound tasks (anything that can reach an employer or send mail) are refused while paused;
// 2. the same task never runs twice at once: an in-process mutex (per task) plus a DB lease in kv
//    'lease.<task>' (10-min TTL, renewed while running) because Next and the worker are separate processes;
// 3. each real run is recorded with startRun/finishRun, and a failure is caught, logged and returned.

import { finishRun, getSettings, kvGet, kvSet, startRun } from '@/lib/db';
import { log } from '@/lib/log';
import { nowIso } from '@/lib/time';
import { defaultTaskEngine } from './deps';
import { acquireLease, DEFAULT_LEASE_TTL_MS, processOwner, releaseLease, renewLease, type Lease } from './lock';
import { autopilotPass, DEFAULT_BATCH, outreachPending, processApproved, scorePending, tailorPending } from './pipeline';

export const TASK_NAMES = ['discover', 'score', 'tailor', 'apply', 'inbox', 'send', 'followups', 'digest', 'autopilot', 'outreach', 'telegram', 'telegramSummary', 'resolve', 'handoff'] as const;
export type TaskName = (typeof TASK_NAMES)[number];

export interface TaskContext { signal?: AbortSignal }

export interface TaskDef {
  label: string;
  /** Can reach an employer or send mail: refused while settings.paused. */
  outbound: boolean;
  /** The scheduler skips the task while this isn't configured (a manual run still reports why). */
  requires?: 'mail' | 'telegram';
  run: (ctx?: TaskContext) => Promise<Record<string, unknown>>;
}

export type SkipReason = 'paused' | 'running' | 'leased';

export interface TaskResult {
  task: string;
  ok: boolean;
  skipped?: SkipReason;
  runId?: number;
  stats?: Record<string, unknown>;
  error?: string;
  /** Who holds the lease when skipped: 'leased'. */
  holder?: Pick<Lease, 'pid' | 'host' | 'acquiredAt' | 'expiresAt'>;
  startedAt: string;
  durationMs: number;
}

export function isTaskName(value: unknown): value is TaskName {
  return typeof value === 'string' && (TASK_NAMES as readonly string[]).includes(value);
}

/** kv key holding the ISO time a task last finished a real run (drives the scheduler). */
export const lastRunKey = (name: TaskName) => `task.lastRun.${name}`;

export function lastRunAt(name: TaskName): string | undefined {
  const v = kvGet<unknown>(lastRunKey(name));
  return typeof v === 'string' ? v : undefined;
}

/** Engine results may be anything; runs.stats wants an object. */
function toStats(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return value === undefined ? {} : { result: value };
}

const SCORE_BATCHES_PER_RUN = 4;
const SCORE_TIME_BUDGET_MS = 90_000;

/** Scores up to a few small batches per run so a big discovery haul doesn't take hours to clear. */
async function scoreRun(): Promise<Record<string, unknown>> {
  const started = Date.now();
  const total = { batches: 0, considered: 0, scored: 0, skipped: 0, filteredOut: 0, failed: 0, errors: [] as unknown[] };
  while (total.batches < SCORE_BATCHES_PER_RUN && Date.now() - started < SCORE_TIME_BUDGET_MS) {
    const s = await scorePending(DEFAULT_BATCH);
    total.batches++;
    total.considered += s.considered;
    total.scored += s.scored;
    total.skipped += s.skipped;
    total.filteredOut += s.filteredOut;
    total.failed += s.failed;
    total.errors.push(...s.errors);
    if (s.considered < DEFAULT_BATCH) break;
  }
  return total;
}

export const TASKS: Record<TaskName, TaskDef> = {
  discover: { label: 'Discover jobs', outbound: false, run: async () => toStats(await defaultTaskEngine.runDiscovery()) },
  score: { label: 'Score new jobs', outbound: false, run: scoreRun },
  tailor: { label: 'Tailor CVs + letters', outbound: false, run: async () => toStats(await tailorPending(DEFAULT_BATCH)) },
  apply: { label: 'Submit approved applications', outbound: true, run: async (ctx) => toStats(await processApproved(undefined, ctx?.signal)) },
  inbox: { label: 'Check inbox', outbound: false, requires: 'mail', run: async () => toStats(await defaultTaskEngine.processInbox()) },
  send: { label: 'Send approved emails', outbound: true, requires: 'mail', run: async () => toStats(await defaultTaskEngine.sendApprovedEmails()) },
  followups: { label: 'Draft follow-ups', outbound: false, run: async () => toStats(await defaultTaskEngine.scheduleFollowUps()) },
  digest: { label: 'Email daily digest to self', outbound: true, requires: 'mail', run: async () => toStats(await defaultTaskEngine.sendDigestToSelf()) },
  autopilot: { label: 'Autopilot pass', outbound: true, run: async () => toStats(await autopilotPass()) },
  outreach: { label: 'Find contacts + draft outreach', outbound: false, run: async () => toStats(await outreachPending(DEFAULT_BATCH)) },
  // Not outbound: it must keep running while paused, so /resume and his answers still work.
  // Finds the employer's own application page for LinkedIn/aggregator jobs. Small batches: LinkedIn's public API
  // rate-limits after ~10 requests. Never overlaps discovery (both read LinkedIn).
  resolve: {
    label: 'Find employer apply pages',
    outbound: false,
    run: async (ctx) => {
      if (runningTasks().includes('discover')) return { skipped: 'discovery is running' };
      const { resolveApplyTargets } = await import('@/engine/resolve');
      const { details, ...counts } = await resolveApplyTargets({ limit: 8, signal: ctx?.signal } as Parameters<typeof resolveApplyTargets>[0]);
      return { ...counts, details: details.map((d) => ({ jobId: d.jobId, result: d.result, ats: d.ats })) };
    },
  },
  telegramSummary: { label: 'Telegram morning summary', outbound: false, requires: 'telegram', run: async () => toStats(await (await import('@/engine/telegram/bot')).sendDailySummary()) },
  // One-tap handoff (only while he has said GO): opens the next human-check application in Chrome, filled in.
  handoff: {
    label: 'One-tap handoff (after GO)',
    outbound: true,
    run: async () => {
      const { handoffStep } = await import('./handoff');
      const { openForHandoff } = await import('@/engine/apply/runner');
      const { notifyTelegram } = await import('@/engine/telegram/outbox');
      return toStats(await handoffStep({
        open: (jobId, watchMs) => openForHandoff(jobId, { watchMs, autoSubmit: getSettings().autopilot.handsFree === true }),
        notify: (text) => void notifyTelegram(text, { high: true }),
      }));
    },
  },
  telegram: { label: 'Telegram: questions + updates', outbound: false, requires: 'telegram', run: async (ctx) => toStats(await (await import('@/engine/telegram/bot')).telegramPass({ signal: ctx?.signal })) },
};

// In-process mutex. Kept on globalThis so Next dev hot reloads don't forget a task is running.
const g = globalThis as typeof globalThis & { __pursuitRunningTasks?: Set<string> };
const running = (g.__pursuitRunningTasks ??= new Set<string>());

/** Tasks currently running in this process. */
export function runningTasks(): string[] {
  return [...running];
}

export interface RunTaskOptions {
  signal?: AbortSignal;
  /** Who asked: recorded in the run stats. */
  trigger?: 'worker' | 'manual' | 'cli';
  /** Test hook: replacement task definitions. */
  tasks?: Partial<Record<TaskName, TaskDef>>;
  leaseTtlMs?: number;
  /** How often the lease is extended while the task runs (default TTL / 4). */
  renewEveryMs?: number;
  owner?: string;
}

function skipped(task: string, reason: SkipReason, started: number, extra: Partial<TaskResult> = {}): TaskResult {
  return { task, ok: true, skipped: reason, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ...extra };
}

/** Runs one task once. Never throws: failures come back as { ok: false, error }. */
export async function runTask(name: TaskName, opts: RunTaskOptions = {}): Promise<TaskResult> {
  const started = Date.now();
  if (!isTaskName(name)) {
    return { task: String(name), ok: false, error: `Unknown task "${String(name)}". Known: ${TASK_NAMES.join(', ')}`, startedAt: nowIso(), durationMs: 0 };
  }
  const def = opts.tasks?.[name] ?? TASKS[name];
  const owner = opts.owner ?? processOwner();
  const ttlMs = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;

  try {
    if (def.outbound && getSettings().paused) return skipped(name, 'paused', started);
  } catch (err) {
    return { task: name, ok: false, error: `cannot read settings: ${(err as Error).message}`, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started };
  }

  // Check-and-add with no await in between: atomic within this process.
  if (running.has(name)) return skipped(name, 'running', started);
  running.add(name);

  let renewTimer: NodeJS.Timeout | undefined;
  let leaseHeld = false;
  try {
    const lease = acquireLease(name, { owner, ttlMs });
    if (!lease.ok) {
      const { pid, host, acquiredAt, expiresAt } = lease.holder;
      return skipped(name, 'leased', started, { holder: { pid, host, acquiredAt, expiresAt } });
    }
    leaseHeld = true;
    renewTimer = setInterval(() => {
      try {
        if (!renewLease(name, { owner, ttlMs })) log.warn('worker', `lost the lease for task ${name}`);
      } catch (err) {
        log.warn('worker', `lease renewal failed for ${name}: ${(err as Error).message}`);
      }
    }, opts.renewEveryMs ?? Math.max(1_000, Math.floor(ttlMs / 4)));
    renewTimer.unref();

    const runId = startRun(name);
    try {
      const stats = await def.run({ signal: opts.signal });
      const recorded = opts.trigger ? { ...stats, trigger: opts.trigger } : stats;
      finishRun(runId, true, recorded);
      return { task: name, ok: true, runId, stats, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishRun(runId, false, opts.trigger ? { trigger: opts.trigger } : undefined, message);
      log.error('worker', `task ${name} failed: ${message}`, err);
      return { task: name, ok: false, runId, error: message, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started };
    } finally {
      try {
        kvSet(lastRunKey(name), nowIso());
      } catch (err) {
        log.warn('worker', `could not record last run for ${name}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    // DB unavailable (locked past busy_timeout, disk full...): report, never throw into the caller.
    const message = err instanceof Error ? err.message : String(err);
    return { task: name, ok: false, error: message, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started };
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (leaseHeld) {
      try {
        releaseLease(name, owner);
      } catch {
        // expires on its own
      }
    }
    running.delete(name);
  }
}
