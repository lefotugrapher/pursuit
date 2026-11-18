import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-coach-'));
process.env.PURSUIT_DB_PATH = path.join(TMP, 'coach.db');
process.env.PURSUIT_CONFIG_DIR = path.join(TMP, 'config');
process.env.OPENROUTER_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.ORCAROUTER_API_KEY = '';
fs.mkdirSync(process.env.PURSUIT_CONFIG_DIR, { recursive: true });
for (const f of ['facts', 'profile', 'answers', 'sources']) {
  fs.copyFileSync(path.join(import.meta.dirname, '..', 'config', `${f}.example.json`), path.join(process.env.PURSUIT_CONFIG_DIR, `${f}.example.json`));
}

const coach = await import('../src/engine/coach');
const config = await import('../src/lib/config');
const db = await import('../src/lib/db');
const { cleanTitle, cleanCompany, namesCompany } = await import('../src/engine/tailor/letter');
const { hardFilters } = await import('../src/engine/score');

describe('letter names', () => {
  test('cleanTitle drops location, contract and pipe suffixes', () => {
    assert.equal(cleanTitle('Product Marketing Operations Manager | Ireland | Remote'), 'Product Marketing Operations Manager');
    assert.equal(cleanTitle('Community Fundraising Executive, Fundraising, Dublin'), 'Community Fundraising Executive');
    assert.equal(cleanTitle('Communications Executive (Fixed Term - 11 months)'), 'Communications Executive');
    assert.equal(cleanTitle('Digital Marketing Executive - Dublin 15'), 'Digital Marketing Executive');
    assert.equal(cleanTitle('Digital Marketing Executive - Legal Sector'), 'Digital Marketing Executive - Legal Sector');
  });
  test('cleanCompany and namesCompany', () => {
    assert.equal(cleanCompany("Ryanair - Europe's Favourite Airline"), 'Ryanair');
    assert.equal(cleanCompany('LUCEY GROUP LIMITED'), 'Lucey Group');
    assert.ok(namesCompany('I would love to join Lucey Group.', 'LUCEY GROUP LIMITED'));
    assert.ok(!namesCompany('I would love to join your team.', 'Virgin Media Ireland'));
  });
});

describe('manager titles', () => {
  const profile = () => config.loadProfile();
  const job = (title: string) => ({ id: 'x', source: 'manual', sourceId: 'x', company: 'Acme', title, location: 'Dublin, Ireland', country: 'IE', remote: false, url: '', applyUrl: '', ats: 'unknown', atsMeta: {}, description: 'A role in Dublin.', status: 'discovered', discoveredAt: '', updatedAt: '' }) as never;
  test('senior manager titles are rejected when "manager" is excluded; entry-level ones pass', () => {
    const p = profile();
    p.targets.excludeTitleWords = [...p.targets.excludeTitleWords, 'manager'];
    assert.equal(hardFilters(job('Digital Marketing Manager'), p).pass, false);
    assert.equal(hardFilters(job('Social Media Manager'), p).rejected.some((r) => /manager/i.test(r)), false);
    assert.equal(hardFilters(job('Community Manager'), p).rejected.some((r) => /manager/i.test(r)), false);
  });
});

describe('coach', () => {
  before(() => db.kvSet('coach.thread', [{ role: 'coach', text: 'How big was the Instagram?', ts: '2026-11-16T10:00:00.000Z', facts: [
    { key: 'k1', text: 'Grew the Canopy Coffee Instagram from 800 to 2,100 followers in six months.', kind: 'achievement', tags: ['social'], numbers: ['800', '2,100'], status: 'pending' },
    { key: 'k2', text: 'Ran a podcast with 10,000 listeners.', kind: 'project', tags: [], numbers: ['10,000'], status: 'pending' },
  ] }]));

  test('without an AI key the coach explains itself instead of making things up', async () => {
    const turns = await coach.coachReply('hello');
    assert.match(turns.at(-1)!.text, /OpenRouter/);
  });

  test('approving a suggestion adds exactly that fact (with edits), tagged from-coach', () => {
    const before = config.loadFacts().facts.length;
    const r = coach.approveFact('k1', 'Grew the Canopy Coffee Instagram from 800 to 2,100 followers in 6 months.');
    assert.equal(r.ok, true);
    const facts = config.loadFacts().facts;
    assert.equal(facts.length, before + 1);
    const added = facts.find((f) => f.id === r.factId)!;
    assert.match(added.text, /in 6 months/);
    assert.ok(added.tags.includes('from-coach'));
    assert.deepEqual(added.numbers?.sort(), ['2,100', '6', '800'].sort());
    assert.equal(coach.approveFact('k1').ok, false, 'cannot add twice');
  });

  test('dismissing never touches the fact bank', () => {
    const before = config.loadFacts().facts.length;
    assert.equal(coach.dismissProposal('k2').ok, true);
    assert.equal(config.loadFacts().facts.length, before);
    assert.equal(coach.approveFact('k2').ok, false);
  });
});
