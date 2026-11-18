// One-tap handoff session: which jobs qualify, GO/STOP, the per-job loop and the nudge rate limit.
// The browser is stubbed: `open` decides the outcome.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-handoff-test-'));
process.env.PURSUIT_DB_PATH = path.join(TMP, 'handoff.db');

const dbm = await import('../src/lib/db');
const h = await import('../src/worker/handoff');

after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
function job(company: string, needs: string[], over: Record<string, unknown> = {}): string {
  const id = `handoff${String(++n).padStart(9, '0')}`;
  dbm.upsertJob({
    id, source: 'greenhouse', sourceId: id, company, title: 'PR Executive', location: 'Dublin', url: `https://x.test/${id}`,
    applyUrl: `https://x.test/${id}`, ats: 'greenhouse', description: 'd', ...over,
  } as never);
  dbm.updateJob(id, { needs, score: 80 - n } as never);
  dbm.setStatus(id, 'needs_you', {});
  return id;
}

beforeEach(() => {
  dbm.db().exec("DELETE FROM jobs; DELETE FROM kv; DELETE FROM events;");
  dbm.updateSettings({ paused: false });
});

describe('humanCheckQueue', () => {
  test('only human checks qualify; account walls, open questions and LinkedIn do not', () => {
    const a = job('A', ['CAPTCHA or bot check on the page: complete it yourself']);
    const b = job('B', ['CAPTCHA appeared after submit: solve it in the browser window, then mark applied if it goes through']);
    const c = job('C', ['submitted but no confirmation seen — check manually']);
    job('D', ['Workday needs you to sign in or create an account before applying']);
    job('E', ['Answer required question: "Postal Code"', 'CAPTCHA or bot check on the page: complete it yourself']);
    job('F', ['CAPTCHA or bot check on the page'], { ats: 'linkedin' });
    assert.deepEqual(h.humanCheckQueue().map((j) => j.id).sort(), [a, b, c].sort());
  });
});

describe('session', () => {
  test('GO with nothing waiting says so; GO while paused refuses', () => {
    assert.match(h.startHandoffSession(), /Nothing is waiting/);
    job('A', ['CAPTCHA or bot check on the page']);
    dbm.updateSettings({ paused: true });
    assert.match(h.startHandoffSession(), /paused/);
    assert.equal(h.handoffSession(), undefined);
  });

  test('applied jobs advance; the session ends with a summary', async () => {
    const a = job('A', ['CAPTCHA or bot check on the page']);
    const b = job('B', ['CAPTCHA or bot check on the page']);
    assert.match(h.startHandoffSession(), /Opening PR Executive at A/);
    const opened: string[] = [];
    const sent: string[] = [];
    const deps = {
      open: async (id: string) => {
        opened.push(id);
        dbm.setStatus(id, 'applied', {});
        return { status: 'applied' };
      },
      notify: (t: string) => void sent.push(t),
    };
    assert.deepEqual(await h.handoffStep(deps), { active: true, applied: a });
    assert.deepEqual(await h.handoffStep(deps), { active: true, applied: b });
    assert.deepEqual(await h.handoffStep(deps), { active: false, done: true });
    assert.deepEqual(opened, [a, b]);
    assert.match(sent[0], /Applied ✓ PR Executive at A[\s\S]*Next: PR Executive at B/);
    assert.match(sent.at(-1)!, /2 applied this session/);
    assert.equal(h.handoffSession(), undefined);
  });

  test('two misses in a row stop the session; a tick without GO does nothing', async () => {
    job('A', ['CAPTCHA or bot check on the page']);
    job('B', ['CAPTCHA or bot check on the page']);
    job('C', ['CAPTCHA or bot check on the page']);
    const sent: string[] = [];
    const deps = { open: async () => ({ status: 'needs_you' }), notify: (t: string) => void sent.push(t) };
    assert.deepEqual(await h.handoffStep(deps), { active: false });
    h.startHandoffSession();
    assert.equal((await h.handoffStep(deps)).active, true);
    assert.equal((await h.handoffStep(deps)).active, false);
    assert.match(sent.at(-1)!, /stopped for now/);
    assert.equal(h.handoffSession(), undefined);
  });

  test('STOP ends it', () => {
    job('A', ['CAPTCHA or bot check on the page']);
    h.startHandoffSession();
    assert.match(h.stopHandoffSession(), /Stopped/);
    assert.equal(h.handoffSession(), undefined);
  });
});

describe('nudge', () => {
  test('one message per 6 hours, never in quiet hours or during a session', () => {
    const now = new Date('2026-11-17T10:00:00Z');
    assert.equal(h.handoffNudge(now, false), null); // nothing waiting
    job('A', ['CAPTCHA or bot check on the page']);
    assert.equal(h.handoffNudge(now, true), null);
    assert.match(h.handoffNudge(now, false) ?? '', /1 application is filled in[\s\S]*Reply GO/);
    assert.equal(h.handoffNudge(new Date(now.getTime() + 3_600_000), false), null);
    assert.ok(h.handoffNudge(new Date(now.getTime() + 7 * 3_600_000), false));
    h.startHandoffSession();
    assert.equal(h.handoffNudge(new Date(now.getTime() + 20 * 3_600_000), false), null);
  });
});
