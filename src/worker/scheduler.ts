// Scheduling: which tasks are due (pure, clock-injected) and the tick loop that starts them.
// Server-only. Last-run times live in kv ('task.lastRun.<name>', written by runTask) so a restart,
// or a "run now" from the dashboard, both count.

import os from 'node:os';
import { getSettings, kvGet, kvSet } from '@/lib/db';
import { env, hasMail } from '@/lib/env';
import { log } from '@/lib/log';
import { dublinClock, dublinDate, isQuietHours, parseHHMM } from '@/lib/time';
import type { Settings } from '@/lib/types';
import { lastRunAt, runningTasks, runTask, TASK_NAMES, TASKS, type TaskDef, type TaskName, type TaskResult } from './tasks';

export const TICK_MS = 30_000;
export const HEARTBEAT_KEY = 'worker.heartbeat';
/** The dashboard shows the worker offline when the heartbeat is older than this. */
export const OFFLINE_AFTER_MS = 3 * TICK_MS;
/** A tick that lands a few seconds early still counts (ticks are 30 s apart, tasks take time). */
const EARLY_SLACK_MS = 5_000;

const MIN = 60_000;
const HOUR = 60 * MIN;

type Schedule =
  | { kind: 'interval'; everyMs: (s: Settings) => number; skipQuietHours?: boolean; enabled?: (s: Settings) => boolean }
  | { kind: 'daily'; at: string };

export const SCHEDULES: Record<TaskName, Schedule> = {
  discover: { kind: 'interval', everyMs: (s) => s.discoveryEveryHours * HOUR, skipQuietHours: true },
  score: { kind: 'interval', everyMs: () => 2 * MIN },
  tailor: { kind: 'interval', everyMs: () => 2 * MIN },
  apply: { kind: 'interval', everyMs: () => 1 * MIN },
  send: { kind: 'interval', everyMs: () => 1 * MIN },
  inbox: { kind: 'interval', everyMs: () => 10 * MIN },
  outreach: { kind: 'interval', everyMs: () => 15 * MIN },
  // A pass long-polls for up to ~100 s; the scheduler never starts a second one while one is running.
  telegram: { kind: 'interval', everyMs: () => 20_000 },
  telegramSummary: { kind: 'daily', at: '08:00' },
  resolve: { kind: 'interval', everyMs: () => 30 * MIN, skipQuietHours: true },
  // Cheap no-op unless he replied GO; then each run opens and watches one application (up to 10 min).
  handoff: { kind: 'interval', everyMs: () => 15_000 },
  followups: { kind: 'daily', at: '09:30' },
  digest: { kind: 'daily', at: '08:00' },
  autopilot: {
    kind: 'interval',
    everyMs: () => 15 * MIN,
    skipQuietHours: true,
    enabled: (s) => s.mode === 'autopilot' && s.autopilot.enabled,
  },
};

export interface DueContext {
  now: Date;
  settings: Settings;
  lastRuns: Partial<Record<TaskName, string | undefined>>;
  mailConfigured: boolean;
  /** Telegram bot token present (tests leave it unset, so the bot is never polled from a test). */
  telegramConfigured?: boolean;
  defs?: Record<TaskName, Pick<TaskDef, 'outbound' | 'requires'>>;
}

export type DueCheck = { due: true } | { due: false; reason: string };

function intervalDue(everyMs: number, lastRun: string | undefined, now: Date): DueCheck {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return { due: false, reason: 'disabled (interval is 0)' };
  if (!lastRun) return { due: true };
  const last = Date.parse(lastRun);
  if (!Number.isFinite(last)) return { due: true };
  const elapsed = now.getTime() - last;
  return elapsed >= everyMs - EARLY_SLACK_MS ? { due: true } : { due: false, reason: `next in ${Math.ceil((everyMs - elapsed) / 1000)}s` };
}

function dailyDue(at: string, lastRun: string | undefined, now: Date): DueCheck {
  const atMin = parseHHMM(at);
  const nowMin = parseHHMM(dublinClock(now));
  if (atMin === null || nowMin === null) return { due: false, reason: `bad daily time ${at}` };
  if (nowMin < atMin) return { due: false, reason: `runs daily at ${at} Dublin` };
  if (lastRun) {
    const last = new Date(lastRun);
    if (!Number.isNaN(last.getTime()) && dublinDate(last) === dublinDate(now)) return { due: false, reason: 'already ran today' };
  }
  return { due: true };
}

/** Hands-free mode (Kayzee's request: apply while he sleeps) ignores quiet hours; review mode keeps them. */
export function quietNow(settings: Settings, now: Date): boolean {
  if (settings.mode === 'autopilot' && settings.autopilot.enabled && settings.autopilot.handsFree) return false;
  return isQuietHours(settings, now);
}

/** Whether `name` should start now, and why not. Pure given the context. */
export function checkDue(name: TaskName, ctx: DueContext): DueCheck {
  const def = (ctx.defs ?? TASKS)[name];
  const schedule = SCHEDULES[name];
  if (def.outbound && ctx.settings.paused) return { due: false, reason: 'paused' };
  if (def.requires === 'mail' && !ctx.mailConfigured) return { due: false, reason: 'Gmail not configured' };
  if (def.requires === 'telegram' && !ctx.telegramConfigured) return { due: false, reason: 'Telegram not configured' };

  if (schedule.kind === 'daily') {
    if (quietNow(ctx.settings, ctx.now)) return { due: false, reason: 'quiet hours' };
    return dailyDue(schedule.at, ctx.lastRuns[name], ctx.now);
  }
  if (schedule.enabled && !schedule.enabled(ctx.settings)) return { due: false, reason: 'disabled in settings' };
  if (schedule.skipQuietHours && quietNow(ctx.settings, ctx.now)) return { due: false, reason: 'quiet hours' };
  return intervalDue(schedule.everyMs(ctx.settings), ctx.lastRuns[name], ctx.now);
}

export function dueTasks(ctx: DueContext): TaskName[] {
  return TASK_NAMES.filter((name) => checkDue(name, ctx).due);
}

export function readLastRuns(): Partial<Record<TaskName, string | undefined>> {
  return Object.fromEntries(TASK_NAMES.map((n) => [n, lastRunAt(n)]));
}

// ───────────────────────────── Heartbeat ─────────────────────────────

export interface Heartbeat { pid: number; host: string; at: string; startedAt: string; running: string[]; tickMs: number }

export interface WorkerStatus { online: boolean; heartbeat?: Heartbeat; ageMs?: number }

export function writeHeartbeat(startedAt: string, tickMs: number, now: Date = new Date()): void {
  const beat: Heartbeat = { pid: process.pid, host: os.hostname(), at: now.toISOString(), startedAt, running: runningTasks(), tickMs };
  kvSet(HEARTBEAT_KEY, beat);
}

/** Dashboard helper: online when the last heartbeat is recent. */
export function workerStatus(now: Date = new Date()): WorkerStatus {
  const beat = kvGet<Heartbeat>(HEARTBEAT_KEY);
  if (!beat?.at) return { online: false };
  const ageMs = now.getTime() - Date.parse(beat.at);
  const limit = Math.max(OFFLINE_AFTER_MS, 3 * (beat.tickMs || TICK_MS));
  return { online: Number.isFinite(ageMs) && ageMs < limit, heartbeat: beat, ageMs };
}

// ───────────────────────────── Tick loop ─────────────────────────────

export interface SchedulerOptions {
  tickMs?: number;
  now?: () => Date;
  run?: (name: TaskName, signal: AbortSignal) => Promise<TaskResult>;
  settings?: () => Settings;
  mailConfigured?: () => boolean;
  telegramConfigured?: () => boolean;
  lastRuns?: () => Partial<Record<TaskName, string | undefined>>;
  onResult?: (result: TaskResult) => void;
  heartbeat?: boolean;
}

export interface Scheduler {
  start(): void;
  /** One scheduling pass; returns the tasks it started. */
  tick(): Promise<TaskName[]>;
  /** Stops ticking, aborts in-flight tasks' waits, and waits up to graceMs. Returns tasks still running. */
  stop(graceMs?: number): Promise<TaskName[]>;
  inFlight(): TaskName[];
}

export function createScheduler(opts: SchedulerOptions = {}): Scheduler {
  const tickMs = opts.tickMs ?? TICK_MS;
  const now = opts.now ?? (() => new Date());
  const run = opts.run ?? ((name, signal) => runTask(name, { signal, trigger: 'worker' }));
  const readSettings = opts.settings ?? getSettings;
  const mailConfigured = opts.mailConfigured ?? hasMail;
  const telegramConfigured = opts.telegramConfigured ?? (() => Boolean(env.TELEGRAM_BOT_TOKEN));
  const lastRuns = opts.lastRuns ?? readLastRuns;
  const controller = new AbortController();
  const inFlight = new Map<TaskName, Promise<void>>();
  const startedAt = now().toISOString();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let ticking = false;

  async function tick(): Promise<TaskName[]> {
    if (stopped || ticking) return [];
    ticking = true;
    try {
      const at = now();
      if (opts.heartbeat !== false) writeHeartbeat(startedAt, tickMs, at);
      const ctx: DueContext = { now: at, settings: readSettings(), lastRuns: lastRuns(), mailConfigured: mailConfigured(), telegramConfigured: telegramConfigured() };
      const due = dueTasks(ctx).filter((name) => !inFlight.has(name));
      for (const name of due) {
        const p = run(name, controller.signal)
          .then((result) => opts.onResult?.(result))
          .catch((err: unknown) => log.error('worker', `task ${name} crashed outside runTask: ${(err as Error)?.message ?? err}`))
          .finally(() => inFlight.delete(name));
        inFlight.set(name, p);
      }
      return due;
    } catch (err) {
      // A tick must never kill the loop (DB busy, settings unreadable...). Try again next tick.
      log.error('worker', `scheduler tick failed: ${(err as Error)?.message ?? err}`);
      return [];
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      void tick();
      timer = setInterval(() => void tick(), tickMs);
    },
    tick,
    async stop(graceMs = 90_000) {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      controller.abort();
      if (inFlight.size) {
        let graceTimer: NodeJS.Timeout | undefined;
        const grace = new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, graceMs);
        });
        await Promise.race([Promise.allSettled([...inFlight.values()]), grace]);
        if (graceTimer) clearTimeout(graceTimer);
      }
      return [...inFlight.keys()];
    },
    inFlight: () => [...inFlight.keys()],
  };
}
