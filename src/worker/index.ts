// `pnpm worker`: the long-running engine loop. Server-only.
//
// Start-up: take data/worker.lock (one worker per data dir), close runs a crashed worker left open,
// clear its dead leases, recover jobs stuck mid-tailoring/mid-apply, then tick every 30 s.
// SIGINT/SIGTERM: stop ticking, abort waits (apply jitter), give in-flight tasks up to 90 s, release
// the lock and leases, close the DB. A second signal exits immediately.

import { abandonOpenRuns, closeDb } from '@/lib/db';
import { log } from '@/lib/log';
import { WORKER_LOCK } from '@/lib/paths';
import { acquireWorkerLock, clearDeadLeases, releaseOwnedLeases } from './lock';
import { recoverInterrupted } from './pipeline';
import { createScheduler, TICK_MS } from './scheduler';
import type { TaskResult } from './tasks';

const SHUTDOWN_GRACE_MS = 90_000;

/** One stdout line per run that did something (stdout goes to data/logs/worker.out.log under launchd). */
function report(result: TaskResult): void {
  if (result.skipped) return;
  const time = new Date().toTimeString().slice(0, 8);
  if (!result.ok) {
    console.error(`${time} ${result.task} FAILED after ${result.durationMs}ms: ${result.error}`);
    return;
  }
  const interesting = Object.entries(result.stats ?? {}).filter(
    ([, v]) => (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v) || (Array.isArray(v) && v.length),
  );
  if (!interesting.length) return;
  const summary = interesting
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : typeof v === 'string' ? v.slice(0, 60) : v}`)
    .join(' ');
  console.log(`${time} ${result.task} ok (${result.durationMs}ms) ${summary}`);
}

function startUp(): () => void {
  const lock = acquireWorkerLock(WORKER_LOCK);
  if (!lock.ok) {
    console.error(`Pursuit worker not started: ${lock.reason}`);
    process.exit(1);
  }
  try {
    const abandoned = abandonOpenRuns();
    const leases = clearDeadLeases();
    const recovered = recoverInterrupted();
    log.info('worker', `started (pid ${process.pid})`, { abandonedRuns: abandoned, clearedLeases: leases, recovered });
  } catch (err) {
    lock.release();
    throw err;
  }
  return lock.release;
}

async function main(): Promise<void> {
  const releaseLock = startUp();
  const scheduler = createScheduler({ tickMs: TICK_MS, onResult: report });
  console.log(`Pursuit worker running (pid ${process.pid}, tick ${TICK_MS / 1000}s). Ctrl+C to stop.`);
  scheduler.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) {
      console.error(`${signal} again: exiting now.`);
      process.exit(130);
    }
    stopping = true;
    const inFlight = scheduler.inFlight();
    console.log(`${signal} received; stopping${inFlight.length ? ` (waiting for: ${inFlight.join(', ')})` : ''}...`);
    const left = await scheduler.stop(SHUTDOWN_GRACE_MS);
    try {
      releaseOwnedLeases();
      log.info('worker', `stopped (${signal})`, left.length ? { abandoned: left } : undefined);
    } catch {
      // DB may be unavailable; the lock file still gets removed below.
    }
    releaseLock();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('worker', `unhandled rejection: ${(reason as Error)?.message ?? String(reason)}`);
  });
}

main().catch((err: unknown) => {
  console.error(`Pursuit worker crashed on start: ${(err as Error)?.stack ?? err}`);
  process.exit(1);
});
