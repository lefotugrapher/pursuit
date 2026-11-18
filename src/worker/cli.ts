// `pnpm task <name>`: run one worker task once and print its result as JSON.
// `pnpm task list` lists tasks with their schedule state; `pnpm task doctor` prints health checks.
// Exit code: 0 ok or skipped, 1 failed, 2 usage error.

import { closeDb, getSettings } from '@/lib/db';
import { doctorChecks } from '@/lib/doctor';
import { hasMail } from '@/lib/env';
import { checkDue, readLastRuns, SCHEDULES, workerStatus } from './scheduler';
import { isTaskName, runTask, TASK_NAMES, TASKS } from './tasks';

function usage(): string {
  return [
    'Usage: pnpm task <name>     run one task once',
    '       pnpm task list       show tasks, schedules and last runs',
    '       pnpm task doctor     environment health checks',
    '',
    `Tasks: ${TASK_NAMES.join(', ')}`,
  ].join('\n');
}

function describeSchedule(name: (typeof TASK_NAMES)[number]): string {
  const s = SCHEDULES[name];
  if (s.kind === 'daily') return `daily ${s.at}`;
  const ms = s.everyMs(getSettings());
  return ms >= 3_600_000 ? `every ${ms / 3_600_000}h` : `every ${ms / 60_000}m`;
}

function list(): void {
  const settings = getSettings();
  const lastRuns = readLastRuns();
  const ctx = { now: new Date(), settings, lastRuns, mailConfigured: hasMail() };
  const rows = TASK_NAMES.map((name) => {
    const due = checkDue(name, ctx);
    return {
      task: name,
      label: TASKS[name].label,
      outbound: TASKS[name].outbound,
      schedule: describeSchedule(name),
      lastRun: lastRuns[name] ?? null,
      next: due.due ? 'due now' : due.reason,
    };
  });
  const worker = workerStatus();
  console.log(JSON.stringify({ paused: settings.paused, mode: settings.mode, workerOnline: worker.online, tasks: rows }, null, 2));
}

async function main(): Promise<number> {
  process.env.PURSUIT_LOG_SILENT ??= '1';
  const arg = process.argv[2]?.trim();
  if (!arg || arg === '--help' || arg === '-h') {
    console.log(usage());
    return arg ? 0 : 2;
  }
  if (arg === 'list') {
    list();
    return 0;
  }
  if (arg === 'doctor') {
    const checks = await doctorChecks();
    console.log(JSON.stringify(checks, null, 2));
    return checks.some((c) => !c.ok && !c.optional) ? 1 : 0;
  }
  if (!isTaskName(arg)) {
    console.error(`Unknown task "${arg}".\n\n${usage()}`);
    return 2;
  }

  const controller = new AbortController();
  process.once('SIGINT', () => {
    console.error('Interrupted: stopping after the current step...');
    controller.abort();
  });
  const result = await runTask(arg, { signal: controller.signal, trigger: 'cli' });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    closeDb();
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error((err as Error)?.stack ?? String(err));
    closeDb();
    process.exit(1);
  });
