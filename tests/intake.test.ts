// About-me intake: grounding of suggestions, approval into the fact bank, evidence files, and the job-chat guard
// that stops a model claiming an application was sent.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-intake-test-'));
process.env.PURSUIT_DB_PATH = path.join(TMP, 'intake.db');
process.env.PURSUIT_DATA_DIR = path.join(TMP, 'data');
process.env.PURSUIT_CONFIG_DIR = path.join(TMP, 'config');
fs.mkdirSync(process.env.PURSUIT_CONFIG_DIR, { recursive: true });
for (const k of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ORCAROUTER_API_KEY', 'ANTHROPIC_API_KEY']) process.env[k] = '';

const BANK = {
  version: 1,
  summaries: { general: 'PR and content graduate.' },
  facts: [{ id: 'f1', kind: 'achievement', text: 'Wrote press releases for the Ribbon Runway campaign in Dundalk.', tags: ['pr'] }],
  skills: ['press releases'],
  tools: ['Mailchimp'],
  doNotClaim: ['Canva', 'media monitoring'],
};
const writeBank = () => fs.writeFileSync(path.join(process.env.PURSUIT_CONFIG_DIR!, 'facts.json'), JSON.stringify(BANK));
writeBank();

const dbm = await import('../src/lib/db');
const cfg = await import('../src/lib/config');
const intake = await import('../src/engine/intake');
const chat = await import('../src/engine/jobchat');

after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  writeBank();
  dbm.db().exec('DELETE FROM kv; DELETE FROM events;');
});

describe('groundSuggestions', () => {
  const source = 'I use Claude Code and Canva every week. In March 2026 I sent a Mailchimp newsletter to 420 subscribers for Canopy Coffee.';
  test('keeps only what his own words support and the bank does not already hold', () => {
    const out = intake.groundSuggestions({
      facts: [
        { text: 'Sent a Mailchimp newsletter to 420 subscribers for Canopy Coffee in March 2026.', kind: 'achievement', tags: ['email'] },
        { text: 'Grew the newsletter list by 35% in 2025.', kind: 'achievement', tags: [] },              // numbers he never gave
        { text: 'Wrote press releases for the Ribbon Runway campaign in Dundalk.', kind: 'achievement', tags: [] }, // already known
      ],
      skills: ['email newsletters', 'newsletter'],
      tools: ['Claude Code', 'Canva', 'Mailchimp', 'Figma'],
    }, source, cfg.loadFacts());
    assert.deepEqual(out.filter((p) => p.target === 'fact').map((p) => p.text), ['Sent a Mailchimp newsletter to 420 subscribers for Canopy Coffee in March 2026.']);
    assert.deepEqual(out.filter((p) => p.target === 'tool').map((p) => p.text), ['Claude Code', 'Canva'], 'Mailchimp is known, Figma is not in his words');
    assert.deepEqual(out.filter((p) => p.target === 'skill').map((p) => p.text), ['newsletter'], '"email newsletters" is not his wording');
  });
});

describe('answers and approval', () => {
  test('an approved tool is added and comes off the do-not-claim list; nothing is added without approval', () => {
    intake.saveIntakeAnswer('ai-tools', 'I use Claude Code and Canva every week.');
    const all = intake.loadIntake();
    all['ai-tools'].proposals = intake.groundSuggestions({ facts: [], skills: [], tools: ['Canva', 'Claude Code'] }, all['ai-tools'].answer, cfg.loadFacts());
    dbm.kvSet('intake.entries', all);
    assert.deepEqual(cfg.loadFacts().tools, ['Mailchimp'], 'drafted, not added');

    const canva = all['ai-tools'].proposals.find((p) => p.text === 'Canva')!;
    const claude = all['ai-tools'].proposals.find((p) => p.text === 'Claude Code')!;
    assert.equal(intake.approveIntake({ scope: 'answer', id: 'ai-tools' }, canva.key).ok, true);
    assert.equal(intake.dismissIntake({ scope: 'answer', id: 'ai-tools' }, claude.key).ok, true);
    const bank = cfg.loadFacts();
    assert.deepEqual(bank.tools, ['Mailchimp', 'Canva']);
    assert.deepEqual(bank.doNotClaim, ['media monitoring']);
    assert.equal(intake.approveIntake({ scope: 'answer', id: 'ai-tools' }, canva.key).ok, false, 'not twice');
    assert.deepEqual(intake.loadIntake()['ai-tools'].proposals.map((p) => p.status).sort(), ['added', 'dismissed']);
  });

  test('an approved fact lands in the bank tagged with where it came from, in his edited wording', () => {
    intake.saveIntakeAnswer('newsletters', 'In March 2026 I sent a newsletter to 420 subscribers.');
    const all = intake.loadIntake();
    all.newsletters.proposals = intake.groundSuggestions({ facts: [{ text: 'Sent a newsletter to 420 subscribers in March 2026.', kind: 'achievement', tags: ['email'] }], skills: [], tools: [] }, all.newsletters.answer, cfg.loadFacts());
    dbm.kvSet('intake.entries', all);
    const key = all.newsletters.proposals[0].key;
    assert.equal(intake.approveIntake({ scope: 'answer', id: 'newsletters' }, key, 'Sent an email newsletter to 420 subscribers in March 2026.').ok, true);
    const fact = cfg.loadFacts().facts.at(-1)!;
    assert.equal(fact.text, 'Sent an email newsletter to 420 subscribers in March 2026.');
    assert.ok(fact.tags.includes('from-about-me'));
    assert.deepEqual(fact.numbers, ['420', '2026']);
  });

  test('a bad question id is refused', () => {
    assert.throws(() => intake.saveIntakeAnswer('../etc', 'x'));
  });
});

describe('evidence files', () => {
  test('stores a text file, reads it back, refuses odd types and removes cleanly', async () => {
    const r = await intake.addEvidence('../../ref letter.txt', new TextEncoder().encode('Kayzee ran our Instagram for 6 months.'));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.doc.name, 'ref letter.txt', 'path stripped from the name');
    assert.ok(r.doc.chars > 10);
    const found = intake.evidenceFile(r.doc.id)!;
    assert.ok(found.path.startsWith(path.join(TMP, 'data', 'evidence')));
    assert.equal(intake.evidenceFile('../../etc/passwd'), null);
    assert.equal((await intake.addEvidence('run.sh', new Uint8Array([1]))).ok, false);
    assert.equal(intake.removeEvidence(r.doc.id).ok, true);
    assert.equal(fs.existsSync(found.path), false);
    assert.deepEqual(intake.loadEvidence(), []);
  });
});

describe('job chat never claims an unsent application went out', () => {
  test('wronglyClaimsSent', () => {
    assert.equal(chat.wronglyClaimsSent('I see you applied via LinkedIn guest on Nov 20.', 'scored'), true);
    assert.equal(chat.wronglyClaimsSent('No confirmation email. Status is scored, applied via LinkedIn guest.', 'scored'), true);
    assert.equal(chat.wronglyClaimsSent('This has not been applied to yet. It is scored 68.', 'scored'), false);
    assert.equal(chat.wronglyClaimsSent("Pursuit hasn't submitted it; a CV is being written.", 'tailoring'), false);
    assert.equal(chat.wronglyClaimsSent('You applied on 20 Nov and the confirmation is saved.', 'applied'), false);
  });
  test('unsentStatus says plainly that nothing was sent', () => {
    const s = chat.unsentStatus({ status: 'scored', score: 68, ats: 'unknown', needs: [] });
    assert.match(s, /^This application has not been sent\. It is scored 68/);
    assert.match(chat.unsentStatus({ status: 'scored', score: 70, ats: 'linkedin' }), /can't submit on LinkedIn/);
  });
});
