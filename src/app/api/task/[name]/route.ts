// POST /api/task/[name]: runs one worker task in-process for the dashboard's "run now" buttons.
// runTask itself refuses outbound tasks while paused and never runs a task twice at once.
// The request signal is deliberately not forwarded: closing the palette must not abort a run midway.

import { redactSecrets } from '@/lib/env';
import { guardRequest } from '../../_lib/guard';

const NAME_RE = /^[a-z][a-z_-]{0,31}$/;
const NO_STORE = { 'cache-control': 'no-store' };

// Tasks such as tailor or apply can take minutes.
export const maxDuration = 600;

export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }): Promise<Response> {
  const blocked = guardRequest(req, { mutating: true });
  if (blocked) return blocked;

  const name = (await ctx.params).name;
  if (!NAME_RE.test(name)) return Response.json({ ok: false, error: 'Bad task name' }, { status: 400, headers: NO_STORE });

  let tasks: typeof import('@/worker/tasks');
  try {
    tasks = await import('@/worker/tasks');
  } catch (err) {
    return Response.json({ ok: false, error: `Task runner unavailable: ${redactSecrets((err as Error).message)}` }, { status: 503, headers: NO_STORE });
  }

  if (!tasks.isTaskName(name) || !Object.hasOwn(tasks.TASKS, name)) {
    return Response.json({ ok: false, error: `Unknown task "${name}"`, known: Object.keys(tasks.TASKS) }, { status: 404, headers: NO_STORE });
  }

  try {
    const result = await tasks.runTask(name, { trigger: 'manual' });
    const status = result.skipped === 'paused' ? 409 : result.skipped ? 202 : result.ok ? 200 : 500;
    const message =
      result.skipped === 'paused' ? 'Paused: outbound tasks are blocked until you resume.'
        : result.skipped === 'running' || result.skipped === 'leased' ? `${tasks.TASKS[name].label} is already running.`
          : undefined;
    return Response.json(
      { ...result, ok: result.ok && !result.skipped, label: tasks.TASKS[name].label, message, error: result.error ? redactSecrets(result.error) : undefined },
      { status, headers: NO_STORE },
    );
  } catch (err) {
    return Response.json({ ok: false, error: redactSecrets((err as Error).message) }, { status: 500, headers: NO_STORE });
  }
}
