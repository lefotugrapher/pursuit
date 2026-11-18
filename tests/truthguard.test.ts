// Truth guard: invented numbers, employers, tools, do-not-claim phrases and JD gaps are caught;
// honest rephrases and every master CV bullet pass. Pure: reads config/facts.json, writes nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';

const { guardBullet, guardText, guardCv, extractNumbers, phraseRegex } = await import('../src/engine/truthguard');
const { parseMasterCv, allBullets } = await import('../src/engine/tailor/cvModel');
const { FactBankSchema } = await import('../src/lib/config');
type FactBank = import('../src/lib/types').FactBank;

const ROOT = path.resolve(import.meta.dirname, '..');
const facts: FactBank = FactBankSchema.parse(JSON.parse(fs.readFileSync(path.join(ROOT, 'config/facts.json'), 'utf8')));
const MASTER = process.env.PURSUIT_MASTER_CV ?? path.join(process.env.HOME ?? '', 'skill/cv/Kshitiz_Mittal_CV.tex');

const has = (problems: string[], needle: RegExp) => problems.some((p) => needle.test(p));

describe('extractNumbers', () => {
  test('digits, percentages, currency, ranges, ratios, words, ordinals, multipliers', () => {
    const raws = extractNumbers('Grew sales 48% to €35,000 for 5–10 creators, 4,000+ products, 1:1, two brands, second month, doubled bookings, 3x reach')
      .map((c) => `${c.kind}:${c.value}${c.percent ? '%' : ''}${c.currency ?? ''}${c.plus ? '+' : ''}`);
    for (const want of ['num:48%', 'num:35000EUR', 'num:5', 'num:10', 'num:4000+', 'ratio:1', 'num:2', 'ordinal:2', 'mult:2', 'mult:3']) {
      assert.ok(raws.includes(want), `missing ${want} in ${raws.join(', ')}`);
    }
  });

  test('codes glued to letters are not quantities; bare "one" is ignored', () => {
    assert.deepEqual(extractNumbers('B2B work for no one in particular'), []);
    assert.equal(extractNumbers('reached page one of Google')[0]?.value, 1);
  });
});

describe('guardBullet', () => {
  test('catches an invented metric', () => {
    const r = guardBullet('Increased engagement by 40% through Students’ Union social media content.', ['su-comms-social'], facts);
    assert.equal(r.ok, false);
    assert.ok(has(r.problems, /invented number "40%"/), r.problems.join('; '));
  });

  test('catches a percentage that exists only as a bare number elsewhere', () => {
    const r = guardBullet('Managed inventory for 4,000% more products.', ['mini-india-inventory'], facts);
    assert.ok(has(r.problems, /invented number/));
  });

  test('catches an invented employer', () => {
    const r = guardBullet('Produced communications and social media content for Ryanair.', ['su-comms-social'], facts);
    assert.equal(r.ok, false);
    assert.ok(has(r.problems, /unverified name "Ryanair"/), r.problems.join('; '));
  });

  test('catches an employer from a different fact (wrong attribution)', () => {
    const r = guardBullet('Doubled bookings at Canopy Coffee.', ['sharpz-bookings-doubled'], facts);
    assert.ok(has(r.problems, /Canopy Coffee/), r.problems.join('; '));
  });

  test('catches an unconfirmed tool', () => {
    const r = guardBullet('Shot Instagram content and edited it in Microsoft Office.', ['canopy-local-listings-social'], facts);
    assert.ok(has(r.problems, /Microsoft/));
  });

  test('catches do-not-claim terms, including inflections', () => {
    const r1 = guardBullet('Ran media monitoring for the Students’ Union.', ['su-comms-social'], facts);
    assert.ok(has(r1.problems, /do-not-claim phrase "media monitoring"/), r1.problems.join('; '));
    const r2 = guardBullet('Handled press queries and media statements.', ['su-comms-social'], facts);
    assert.ok(has(r2.problems, /press queries/) && has(r2.problems, /media statements/));
    const r3 = guardBullet('Media-monitored campaign mentions.', ['su-comms-social'], facts);
    assert.ok(has(r3.problems, /media monitoring/), r3.problems.join('; '));
    const r4 = guardBullet('Designed social posts in Canva.', ['su-comms-social'], facts);
    assert.ok(has(r4.problems, /Canva/));
  });

  test('catches a JD gap term unless the cited fact backs it', () => {
    const gap = guardBullet('Produced crisis management communications for the student body.', ['su-comms-social'], facts, { gaps: ['crisis management'] });
    assert.ok(has(gap.problems, /JD gap "crisis management"/), gap.problems.join('; '));
    const backed = guardBullet('Produced communications and social media content for the student body.', ['su-comms-social'], facts, { gaps: ['social media'] });
    assert.equal(backed.ok, true, backed.problems.join('; '));
  });

  test('passes a legitimate rephrase toward JD vocabulary', () => {
    const cases: [string, string[]][] = [
      ['Created internal communications and social media content for the DkIT student body.', ['su-comms-social']],
      ['Wrote press releases and promotional copy for the Ribbon Runway charity event.', ['ribbon-runway-press-releases']],
      ['Grew average daily sales 48% from Aug to Sep 2026 by tracking takings against break-even targets.', ['canopy-sales-growth']],
      ['Shortlisted 5 founders for a 12-week incubation phase, with two reaching the national top seven.', ['rdc-founders-selected']],
      ['Lifted Visit Things to Do from page three to page one of Google results with on-page SEO.', ['vttd-page-one']],
      ['Shot Instagram and TikTok content and managed the brand’s Google Business Profile listing.', ['canopy-local-listings-social']],
    ];
    for (const [text, ids] of cases) {
      const r = guardBullet(text, ids, facts);
      assert.equal(r.ok, true, `${text}\n  → ${r.problems.join('; ')}`);
    }
  });

  test('rejects unknown or missing fact ids', () => {
    assert.ok(has(guardBullet('Wrote press releases.', ['nope'], facts).problems, /unknown fact id/));
    assert.ok(has(guardBullet('Wrote press releases.', [], facts).problems, /cites no facts/));
  });

  test('every master CV bullet passes against its linked fact', { skip: !fs.existsSync(MASTER) }, () => {
    const model = parseMasterCv(fs.readFileSync(MASTER, 'utf8'), facts);
    const bullets = allBullets(model);
    assert.ok(bullets.length >= 20);
    for (const { bullet } of bullets) {
      assert.ok(bullet.factIds.length > 0, `master bullet has no linked fact: ${bullet.text}`);
      const r = guardBullet(bullet.text, bullet.factIds, facts);
      assert.equal(r.ok, true, `${bullet.text}\n  → ${r.problems.join('; ')}`);
    }
    assert.equal(guardCv(model, facts).ok, true, guardCv(model, facts).problems.join('; '));
  });
});

describe('guardText', () => {
  test('every summary variant passes against the whole bank', () => {
    for (const [variant, text] of Object.entries(facts.summaries)) {
      const r = guardText(text, facts);
      assert.equal(r.ok, true, `${variant}: ${r.problems.join('; ')}`);
    }
  });

  test('letters may name the employer only when allowed explicitly', () => {
    const text = 'I would love to bring my press release writing to Acme Media as your PR Executive.';
    assert.equal(guardText(text, facts).ok, false);
    const r = guardText(text, facts, { allowTerms: ['Acme Media', 'PR Executive'] });
    assert.equal(r.ok, true, r.problems.join('; '));
  });

  test('flags invented numbers and visa talk in free text', () => {
    const r = guardText('I have 3 years of experience and hold Stamp 1G.', facts);
    assert.ok(has(r.problems, /years of experience/));
    assert.ok(has(r.problems, /Stamp 1G/));
  });
});

describe('phraseRegex', () => {
  test('brand names match exactly, lowercase phrases match inflections', () => {
    assert.equal(phraseRegex('Canva')!.test('Canvas tote bags'), false);
    assert.equal(phraseRegex('Canva')!.test("Canva's templates"), true);
    assert.equal(phraseRegex('attendees')!.test('attended the event'), false);
    assert.equal(phraseRegex('attendees')!.test('200 attendees'), true);
    assert.equal(phraseRegex('press queries')!.test('answered a press query'), true);
  });
});
