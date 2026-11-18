// Validates the seeded config files (facts, profile, answers + their .example twins).
// The real files are gitignored, so checks on them skip cleanly when they're absent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AnswerBank, FactBank, Profile } from '@/lib/types';

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url));
const MASTER_CV = join(homedir(), 'skill', 'cv', 'Kshitiz_Mittal_CV.tex');

// ── Schemas (inline: src/lib/config.ts owns the canonical ones) ──────────────

const ProfileSchema = z.strictObject({
  name: z.strictObject({ first: z.string().min(1), last: z.string().min(1), preferred: z.string().min(1), full: z.string().min(1) }),
  email: z.email(),
  phone: z.string().min(1),
  location: z.string().min(1),
  links: z.strictObject({
    linkedin: z.url().optional(),
    portfolio: z.url().optional(),
    website: z.url().optional(),
    github: z.url().optional(),
  }),
  targets: z.strictObject({
    roles: z.array(z.string().min(1)).min(1),
    keywords: z.array(z.string().min(1)).min(1),
    locations: z.array(z.string().min(1)).min(1),
    secondaryLocations: z.array(z.string()),
    remoteOk: z.boolean(),
    seniority: z.array(z.enum(['intern', 'graduate', 'junior', 'executive', 'mid'])).min(1),
    excludeTitleWords: z.array(z.string().min(1)),
    maxYearsRequired: z.number().int().nonnegative(),
    salaryFloorEUR: z.number().nonnegative(),
    blacklistCompanies: z.array(z.string()),
    languages: z.array(z.string().min(1)).min(1),
    permanentOnly: z.boolean().optional(),
    ukRightToWork: z.boolean().optional(),
  }),
  workAuth: z.strictObject({ summary: z.string().min(1), needsSponsorship: z.boolean().nullable(), confirm: z.boolean() }),
  coverLetter: z.strictObject({ signOff: z.string().min(1), voiceNotes: z.array(z.string().min(1)) }),
});

const FactSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case'),
  kind: z.enum(['role', 'achievement', 'education', 'project', 'skill', 'tool', 'award', 'summary', 'other']),
  text: z.string().min(1),
  org: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  start: z.string().regex(/^\d{4}(?:-\d{2})?$/).optional(),
  end: z.string().regex(/^\d{4}(?:-\d{2})?$/).nullable().optional(),
  tags: z.array(z.string().min(1)),
  numbers: z.array(z.string().min(1)).optional(),
  cvSection: z.string().min(1).optional(),
  cvBullet: z.string().min(1).optional(),
});

const FactBankSchema = z.strictObject({
  version: z.number().int().positive(),
  summaries: z.record(z.string(), z.string().min(1)),
  facts: z.array(FactSchema).min(1),
  skills: z.array(z.string().min(1)),
  tools: z.array(z.string().min(1)),
  doNotClaim: z.array(z.string().min(1)),
});

const AnswerEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  patterns: z.array(z.string().min(1)).min(1),
  answer: z.string(),
  type: z.enum(['text', 'select', 'yesno', 'number', 'url']).optional(),
  confirm: z.boolean().optional(),
  notes: z.string().optional(),
});
const AnswerBankSchema = z.strictObject({ entries: z.array(AnswerEntrySchema) });

// Compile-time lock: a schema drifting from the shared contract fails typecheck.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const profileMatches: Same<z.infer<typeof ProfileSchema>, Profile> = true;
const factBankMatches: Same<z.infer<typeof FactBankSchema>, FactBank> = true;
const answerBankMatches: Same<z.infer<typeof AnswerBankSchema>, AnswerBank> = true;
void [profileMatches, factBankMatches, answerBankMatches];

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(join(CONFIG_DIR, file), 'utf8'));
}
function hasConfig(file: string): boolean {
  return existsSync(join(CONFIG_DIR, file));
}

/** Digit-bearing tokens: 48%, 4,000+, 1:1, 2026, 5 and 10 out of "5-10". */
function digitTokens(text: string): string[] {
  return (text.match(/\d[\d,]*(?::\d+)?\+?%?/g) ?? []).map((t) => t.replace(/,$/, ''));
}

const WORD_FOR_DIGIT: Record<string, string> = { '1': 'one', '2': 'two', '3': 'three', '7': 'seven' };

/** A `numbers` entry must literally appear in the fact text (or be the digit form of a spelled-out number there). */
function numberIsInText(n: string, text: string): boolean {
  const hay = text.toLowerCase();
  const needle = n.toLowerCase();
  if (hay.includes(needle) || hay.replace(/,/g, '').includes(needle)) return true;
  const spelled = needle.replace(/\b[1237]\b/g, (d) => WORD_FOR_DIGIT[d] ?? d);
  return hay.includes(spelled);
}

function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = /^\w/.test(term) ? '\\b' : '';
  const end = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${start}${escaped}${end}`, 'i');
}

/** Same stripping the facts use for cvBullet: LaTeX macros out, `--` to `-`, whitespace collapsed. */
function stripLatex(tex: string): string {
  return tex
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\textbf\{([^}]*)\}/g, '$1')
    .replace(/\\'e/g, 'é')
    .replace(/\\'\{e\}/g, 'é')
    .replace(/\\([%&$#_])/g, '$1')
    .replace(/--/g, '-')
    .replace(/\s+/g, ' ');
}

const BUZZWORDS = ['passionate', 'dynamic', 'leverage', 'results-driven', 'thrilled', 'synergy', 'spearhead', 'robust', 'seamless', 'elevate', 'delve', 'tapestry', 'testament', 'fast-paced'];
const VISA_TERMS = ['visa', 'stamp 1g', 'sponsorship', 'work permit', 'immigration'];
const SPEC_DO_NOT_CLAIM = ['media monitoring', 'coverage analysis', 'press queries', 'media statements', 'briefing docs', 'Microsoft Office', 'Canva', 'CapCut', 'drone licence'];
const REQUIRED_SUMMARIES = ['pr_comms', 'content_social', 'digital_marketing', 'events_community', 'general'];
// His real phone number is read from the gitignored profile.json (when present), so it never sits in the code.
const PHONE_MARKER = (() => {
  try {
    const digits = String((readJson('profile.json') as { phone?: string }).phone ?? '').replace(/\D/g, '');
    return digits.length >= 7 ? [`${digits.slice(-7, -4)} ${digits.slice(-4)}`] : [];
  } catch {
    return [];
  }
})();
const PERSONAL_MARKERS = ['kshitiz', 'mittal', 'kayzee', 'lefotugrapher', 'fotugrapher', ...PHONE_MARKER, 'dundalk', 'dkit', 'sharpz', 'canopy'];

// ── Shape validation ─────────────────────────────────────────────────────────

describe('config files validate against the shared contract', () => {
  const cases: [string, z.ZodType][] = [
    ['facts.json', FactBankSchema], ['facts.example.json', FactBankSchema],
    ['profile.json', ProfileSchema], ['profile.example.json', ProfileSchema],
    ['answers.json', AnswerBankSchema], ['answers.example.json', AnswerBankSchema],
  ];
  for (const [file, schema] of cases) {
    test(file, { skip: !hasConfig(file) && `${file} not present (gitignored)` }, () => {
      const result = schema.safeParse(readJson(file));
      assert.ok(result.success, result.success ? '' : z.prettifyError(result.error));
    });
  }
});

// ── Fact bank truth rules ────────────────────────────────────────────────────

for (const file of ['facts.json', 'facts.example.json']) {
  describe(`${file} truth rules`, { skip: !hasConfig(file) && `${file} not present` }, () => {
    const bank = () => FactBankSchema.parse(readJson(file));

    test('fact ids are unique', () => {
      const ids = bank().facts.map((f) => f.id);
      assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
    });

    test('every number in a fact text is listed in its numbers', () => {
      const problems = bank().facts.flatMap((f) =>
        digitTokens(f.text).filter((t) => !(f.numbers ?? []).includes(t)).map((t) => `${f.id}: "${t}" missing from numbers`));
      assert.deepEqual(problems, []);
    });

    test('every numbers entry is literally backed by the fact text', () => {
      const problems = bank().facts.flatMap((f) =>
        (f.numbers ?? []).filter((n) => !numberIsInText(n, f.text)).map((n) => `${f.id}: "${n}" not in text`));
      assert.deepEqual(problems, []);
    });

    test('summary numbers are all backed by facts', () => {
      const b = bank();
      const allowed = new Set(b.facts.flatMap((f) => f.numbers ?? []));
      const problems = Object.entries(b.summaries).flatMap(([k, s]) =>
        digitTokens(s).filter((t) => !allowed.has(t)).map((t) => `${k}: "${t}"`));
      assert.deepEqual(problems, []);
    });

    test('summaries and facts never contain a do-not-claim phrase', () => {
      const b = bank();
      const texts: [string, string][] = [
        ...Object.entries(b.summaries).map(([k, s]): [string, string] => [`summary:${k}`, s]),
        ...b.facts.map((f): [string, string] => [f.id, f.text]),
        ...b.skills.map((s): [string, string] => [`skill:${s}`, s]),
        ...b.tools.map((t): [string, string] => [`tool:${t}`, t]),
      ];
      const problems = texts.flatMap(([where, text]) =>
        b.doNotClaim.filter((term) => termRegex(term).test(text)).map((term) => `${where} contains "${term}"`));
      assert.deepEqual(problems, []);
    });

    test('summaries: required variants, 1-3 sentences, plain voice', () => {
      const b = bank();
      for (const key of REQUIRED_SUMMARIES) assert.ok(b.summaries[key], `missing summary variant ${key}`);
      for (const [key, s] of Object.entries(b.summaries)) {
        const sentences = s.split(/(?<=[.!?])\s+(?=[A-Z])/).length;
        assert.ok(sentences >= 1 && sentences <= 3, `${key}: ${sentences} sentences`);
        assert.doesNotMatch(s, /[—–]/, `${key}: em/en dash`);
        assert.doesNotMatch(s, /!/, `${key}: exclamation mark`);
        for (const w of BUZZWORDS) assert.doesNotMatch(s, termRegex(w), `${key}: buzzword "${w}"`);
      }
    });

    test('no dashes as punctuation and no visa details in facts or summaries', () => {
      const b = bank();
      for (const text of [...Object.values(b.summaries), ...b.facts.map((f) => f.text)]) {
        assert.doesNotMatch(text, /[—–‑]/, `dash char in: ${text}`);
        for (const term of VISA_TERMS) assert.doesNotMatch(text, termRegex(term), `visa term "${term}" in: ${text}`);
      }
    });

    test('every claimable tool is evidenced in some fact text', () => {
      const b = bank();
      const corpus = b.facts.map((f) => f.text).join('\n');
      assert.deepEqual(b.tools.filter((t) => !termRegex(t).test(corpus)), []);
    });
  });
}

describe('facts.json specifics', { skip: !hasConfig('facts.json') && 'facts.json not present' }, () => {
  const bank = () => FactBankSchema.parse(readJson('facts.json'));

  test('includes the SPEC §8 do-not-claim list', () => {
    const dnc = bank().doNotClaim.map((t) => t.toLowerCase());
    assert.deepEqual(SPEC_DO_NOT_CLAIM.filter((t) => !dnc.includes(t.toLowerCase())), []);
  });

  test('Canopy and Sharpz are past roles ending Oct 2026', () => {
    for (const f of bank().facts.filter((x) => x.org === 'Canopy Coffee' || x.org === 'Sharpz Studio')) {
      assert.equal(f.end, '2026-10', f.id);
    }
  });

  test('every cvBullet appears verbatim in the master CV', { skip: !existsSync(MASTER_CV) && 'master CV not on this machine' }, () => {
    const cv = stripLatex(readFileSync(MASTER_CV, 'utf8'));
    const missing = bank().facts
      .filter((f) => f.cvBullet && !cv.includes(f.cvBullet.replace(/\s+/g, ' ')))
      .map((f) => f.id);
    assert.deepEqual(missing, []);
  });

  test('every master CV bullet is captured as a fact', { skip: !existsSync(MASTER_CV) && 'master CV not on this machine' }, () => {
    const tex = readFileSync(MASTER_CV, 'utf8');
    const bullets = [...tex.matchAll(/^\s*\\item\s+(.+)$/gm)].map((m) => stripLatex(m[1] ?? '').trim());
    const captured = new Set(bank().facts.map((f) => f.cvBullet).filter((b): b is string => Boolean(b)));
    assert.ok(bullets.length > 20, 'expected to parse the CV bullets');
    assert.deepEqual(bullets.filter((b) => !captured.has(b)), []);
  });
});

// ── Profile ──────────────────────────────────────────────────────────────────

describe('profile.json specifics', { skip: !hasConfig('profile.json') && 'profile.json not present' }, () => {
  const profile = () => ProfileSchema.parse(readJson('profile.json'));

  test('identity matches the brief', () => {
    assert.deepEqual(profile().name, { first: 'Kshitiz', last: 'Mittal', preferred: 'Kayzee', full: 'Kshitiz Mittal' });
    assert.equal(profile().coverLetter.signOff, 'Kind Regards,\nKayzee');
  });

  test('work authorisation: Kayzee stated sponsorship need directly (Indian passport)', () => {
    assert.equal(profile().workAuth.needsSponsorship, true);
    assert.equal(profile().workAuth.confirm, false);
  });

  test('targets follow SPEC §8', () => {
    const t = profile().targets;
    assert.equal(t.salaryFloorEUR, 37000);
    assert.equal(t.maxYearsRequired, 4, 'he has 4 years of marketing experience (stated 2026-11-16)');
    for (const loc of ['dublin', 'dundalk', 'louth', 'drogheda', 'ireland', 'remote']) assert.ok(t.locations.includes(loc), loc);
    for (const loc of ['newry', 'belfast', 'northern ireland', 'armagh']) assert.ok(t.secondaryLocations.includes(loc), loc);
    assert.ok(t.locations.every((l) => l === l.toLowerCase()), 'locations must be lowercase');
    // 'manager' is excluded (too senior); entry-level "social media/community/assistant manager" titles are
    // exempted in score.ts EXCLUDE_EXCEPTIONS (covered by tests/coach.test.ts "manager titles").
    assert.ok(t.excludeTitleWords.includes('manager'), "'manager' titles are filtered out");
  });

  test('contact details match the master CV header', { skip: !existsSync(MASTER_CV) && 'master CV not on this machine' }, () => {
    const cv = readFileSync(MASTER_CV, 'utf8');
    const p = profile();
    assert.ok(cv.includes(p.email), 'email');
    assert.ok(cv.includes(p.phone), 'phone');
    assert.ok(p.links.linkedin && cv.includes(p.links.linkedin), 'linkedin');
  });
});

// ── Answer bank ──────────────────────────────────────────────────────────────

for (const file of ['answers.json', 'answers.example.json']) {
  describe(`${file} rules`, { skip: !hasConfig(file) && `${file} not present` }, () => {
    const entries = () => AnswerBankSchema.parse(readJson(file)).entries;

    test('ids unique, patterns lowercase, regex-safe and not shared between entries', () => {
      const es = entries();
      const ids = es.map((e) => e.id);
      assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
      const seen = new Map<string, string>();
      for (const e of es) {
        for (const p of e.patterns) {
          assert.equal(p, p.toLowerCase(), `${e.id}: pattern "${p}" not lowercase`);
          // Answers learned from Telegram for sensitive questions are pinned to the exact wording with an anchored
          // regex (by design); every hand-written entry must stay a plain substring.
          if (!e.id.startsWith('learned-')) assert.doesNotMatch(p, /[.*+?^${}()|[\]\\]/, `${e.id}: pattern "${p}" has regex metacharacters`);
          // A learned answer may shadow a hand-written pattern on purpose (it's saved first, so it wins the tie).
          if (e.id.startsWith('learned-')) continue;
          assert.ok(!seen.has(p), `pattern "${p}" in both ${seen.get(p)} and ${e.id}`);
          seen.set(p, e.id);
        }
      }
    });

    test('blank answers are always flagged for confirmation', () => {
      assert.deepEqual(entries().filter((e) => e.answer === '' && e.confirm !== true).map((e) => e.id), []);
    });

    test('yes/no answers are Yes, No or blank', () => {
      const bad = entries().filter((e) => e.type === 'yesno' && !['Yes', 'No', ''].includes(e.answer));
      assert.deepEqual(bad.map((e) => e.id), []);
    });

    test('visa, sponsorship, salary and attestation answers need confirmation', () => {
      const sensitive = entries().filter((e) => /right-to-work|visa|salary|attestation|criminal/.test(e.id));
      assert.ok(sensitive.length > 0);
      // Sensitive answers stay unconfirmed unless Kayzee stated them himself (recorded in notes).
      assert.deepEqual(sensitive.filter((e) => e.confirm !== true && !/stated by kayzee/i.test(e.notes ?? '')).map((e) => e.id), []);
      if (file === 'answers.json') {
        // Stamp 1G now (can work full-time, no permit needed yet), sponsorship needed before it ends.
        const byId = new Map(entries().map((e) => [e.id, e.answer]));
        assert.equal(byId.get('sponsorship-now'), 'No');
        assert.equal(byId.get('sponsorship-future'), 'Yes');
        assert.equal(byId.get('sponsorship-now-or-future'), 'Yes');
        assert.equal(byId.get('right-to-work-ireland'), 'Yes');
      }
    });

    test('demographic answers decline rather than self-identify', () => {
      const declines = ['Prefer not to say', "I don't wish to answer"];
      for (const e of entries().filter((x) => x.id.startsWith('eeo-'))) assert.ok(declines.includes(e.answer), e.id);
    });
  });
}

describe('answers.json specifics', { skip: !hasConfig('answers.json') && 'answers.json not present' }, () => {
  const entries = () => AnswerBankSchema.parse(readJson('answers.json')).entries;

  test('covers at least 25 common screening questions (it grows as Telegram learns new ones)', () => {
    const n = entries().length;
    assert.ok(n >= 25 && n <= 400, `${n} entries`);
  });

  test('years of experience is his own stated number', () => {
    const e = entries().find((x) => x.id === 'years-experience');
    assert.ok(e);
    assert.equal(e.answer, '4');
    assert.equal(e.confirm, false);
    assert.match(e.notes ?? '', /stated by kayzee/i);
  });

  test('salary expectation uses the agreed wording', () => {
    const salary = entries().find((x) => x.id === 'salary-expectation');
    assert.match(salary?.answer ?? '', /€37,000/);
    assert.match(salary?.answer ?? '', /baseline/i, '€37,000 is his floor, not his target');
  });
});

// ── Example files must be shareable ──────────────────────────────────────────

describe('example files carry no personal data', () => {
  for (const file of ['facts.example.json', 'profile.example.json', 'answers.example.json']) {
    test(file, { skip: !hasConfig(file) && `${file} not present` }, () => {
      const raw = readFileSync(join(CONFIG_DIR, file), 'utf8').toLowerCase();
      assert.deepEqual(PERSONAL_MARKERS.filter((m) => raw.includes(m)), []);
    });
  }
});
