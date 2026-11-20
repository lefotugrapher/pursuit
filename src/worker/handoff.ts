// One-tap handoff session (Kayzee, Nov 2026): applications that Pursuit filled but that stopped at a human check
// (CAPTCHA, "verify you are human", a submit it couldn't confirm) are finished by him in ~10 s each.
//
// Flow: Pursuit sends ONE Telegram nudge a day ("N applications only need you to tick the box, reply GO"). When he
// replies GO, the worker opens the first one in a visible Chrome window and watches it. He clears the human check;
// Pursuit fills the form (also when the check only showed up after "Apply") and, in hands-free mode, presses Submit.
// Pursuit sees the confirmation, saves the proof screenshot, marks it applied, texts "Applied ✓" and
// opens the next. Two in a row without a confirmation ends the session. Pursuit never touches the check itself.

import { getJob, getSettings, kvGet, kvSet, listJobs } from '@/lib/db';
import { log } from '@/lib/log';
import type { Job } from '@/lib/types';

export const HANDOFF_SESSION_KEY = 'handoff.session';
export const HANDOFF_NUDGE_KEY = 'handoff.lastNudge';
export const HANDOFF_WATCH_MS = 10 * 60_000;
const NUDGE_EVERY_MS = 20 * 3_600_000; // one batch a day, not a drip of reminders
const MAX_MISSES = 2;

/** Needs that a person can clear in seconds in the open window. Account walls and missing answers are not these. */
const HUMAN_CHECK_RE = /captcha|bot check|verify (that )?you('| a)re (a )?human|human (check|verification)|submitted but no confirmation/i;
const NOT_ONE_TAP_RE = /sign in or create an account|account before applying|answer required question|file upload required|open this posting in your own browser/i;

export interface HandoffSession { active: boolean; startedAt: string; tried: string[]; applied: string[]; misses: number }

export function handoffSession(): HandoffSession | undefined {
  const s = kvGet<HandoffSession>(HANDOFF_SESSION_KEY);
  return s?.active ? s : undefined;
}

function save(s: HandoffSession): void {
  kvSet(HANDOFF_SESSION_KEY, s);
}

/** needs_you jobs that only need a human check, best score first. */
export function humanCheckQueue(): Job[] {
  return listJobs({ status: 'needs_you', orderBy: 'score', dir: 'desc' }).filter((j) => {
    const needs = (j.needs ?? []).join(' | ');
    return HUMAN_CHECK_RE.test(needs) && !NOT_ONE_TAP_RE.test(needs) && !['linkedin', 'indeed', 'workday', 'email'].includes(j.ats);
  });
}

const name = (j: Pick<Job, 'title' | 'company'>) => `${j.title} at ${j.company}`;

/** "GO" on Telegram. Returns the reply text. */
export function startHandoffSession(now: Date = new Date()): string {
  const queue = humanCheckQueue();
  if (!queue.length) return 'Nothing is waiting on a human check right now.';
  if (getSettings().paused) return 'Pursuit is paused. Send /resume first, then GO.';
  const existing = handoffSession();
  save({ active: true, startedAt: existing?.startedAt ?? now.toISOString(), tried: [], applied: existing?.applied ?? [], misses: 0 });
  return `Opening ${name(queue[0])} in Chrome on your Mac now (${queue.length} waiting). Clear the "I'm human" check when it shows. I fill the form and press Submit, then open the next one. If a form is left waiting, press Submit yourself. Reply STOP to end.`;
}

export function stopHandoffSession(): string {
  const s = handoffSession();
  if (!s) return 'No handoff is running.';
  save({ ...s, active: false });
  return `Stopped. ${s.applied.length ? `${s.applied.length} applied this session. ` : ''}Reply GO any time to carry on.`;
}

export interface HandoffDeps {
  open: (jobId: string, watchMs: number) => Promise<{ status: string }>;
  notify: (text: string) => void;
}

/** One worker tick: opens and watches the next job while a session is active. */
export async function handoffStep(deps: HandoffDeps): Promise<Record<string, unknown>> {
  const s = handoffSession();
  if (!s) return { active: false };
  if (getSettings().paused) return { active: true, skipped: 'paused' };
  const next = humanCheckQueue().find((j) => !s.tried.includes(j.id));
  if (!next) {
    save({ ...s, active: false });
    deps.notify(s.applied.length ? `All done: ${s.applied.length} applied this session. 🎉` : 'Nothing left that needs a human check.');
    return { active: false, done: true };
  }
  save({ ...s, tried: [...s.tried, next.id] });
  let status = 'failed';
  try {
    status = (await deps.open(next.id, HANDOFF_WATCH_MS)).status;
  } catch (err) {
    log.warn('handoff', `could not open ${next.id}`, { error: (err as Error).message });
  }
  const after = handoffSession() ?? { ...s, active: false };
  if (!after.active) return { active: false, stopped: true, jobId: next.id, status };
  const remaining = humanCheckQueue().filter((j) => !after.tried.includes(j.id));
  if (status === 'applied') {
    save({ ...after, applied: [...after.applied, next.id], misses: 0 });
    deps.notify(`Applied ✓ ${name(getJob(next.id) ?? next)}${remaining.length ? `\nNext: ${name(remaining[0])} (${remaining.length} left)` : ''}`);
    return { active: true, applied: next.id };
  }
  const misses = after.misses + 1;
  if (misses >= MAX_MISSES || !remaining.length) {
    save({ ...after, active: false, misses });
    deps.notify(`No confirmation on ${name(next)} within 10 minutes, so I've stopped for now. Reply GO when you're back at your Mac.`);
    return { active: false, missed: next.id };
  }
  save({ ...after, misses });
  deps.notify(`No confirmation on ${name(next)}, moving on.\nNext: ${name(remaining[0])}`);
  return { active: true, missed: next.id };
}

/** One nudge a day when something waits on a human check and no session is running. */
export function handoffNudge(now: Date, quiet: boolean): string | null {
  if (quiet || handoffSession()) return null;
  const n = humanCheckQueue().length;
  if (!n) return null;
  const last = Date.parse(kvGet<string>(HANDOFF_NUDGE_KEY) ?? '');
  if (Number.isFinite(last) && now.getTime() - last < NUDGE_EVERY_MS) return null;
  kvSet(HANDOFF_NUDGE_KEY, now.toISOString());
  return `${n} application${n === 1 ? ' is' : 's are'} filled in and only need you to tick "I'm human" (about 10 s each). Reply GO when you're at your Mac.`;
}
