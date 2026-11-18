// GET /api/status: live counts + worker health for the sidebar dot and "run now" feedback.

import { countByStatus, getSettings, kvGet, listRuns } from '@/lib/db';
import { hasLLM, hasMail, redactSecrets } from '@/lib/env';
import { guardRequest } from '../_lib/guard';
import { buildStatusPayload, HEARTBEAT_KEY } from '../_lib/status';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(req: Request): Promise<Response> {
  const blocked = guardRequest(req, { mutating: false });
  if (blocked) return blocked;
  try {
    const payload = buildStatusPayload({
      counts: countByStatus(),
      settings: getSettings(),
      heartbeat: kvGet(HEARTBEAT_KEY),
      runs: listRuns(6),
      hasLLM: hasLLM(),
      hasMail: hasMail(),
    });
    return Response.json(payload, { headers: NO_STORE });
  } catch (err) {
    return Response.json({ ok: false, error: redactSecrets((err as Error).message) }, { status: 500, headers: NO_STORE });
  }
}
