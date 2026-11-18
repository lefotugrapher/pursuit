// Writing modules: slop linter, dash repair, screening answers, cover letters, prep packs.
// Fixture profile/facts/answer bank only (no real config). The LLM is either disabled or
// globalThis.fetch is mocked: OpenRouter and employer sites are never contacted.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';

process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.PURSUIT_LOG_SILENT = '1';
delete process.env.OPENROUTER_API_KEY;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-writing-test-'));
process.env.PURSUIT_DATA_DIR = path.join(TMP, 'data');
process.env.PURSUIT_DB_PATH = path.join(TMP, 'writing.db');

const slop = await import('../src/engine/slop');
const letter = await import('../src/engine/tailor/letter');
const answersMod = await import('../src/engine/tailor/answers');
const prep = await import('../src/engine/prep');
const pdf = await import('../src/engine/tailor/letterPdf');
const llm = await import('../src/lib/llm');
const dbm = await import('../src/lib/db');

import type { AnswerBank, FactBank, Job, Profile, ScreeningQuestion } from '../src/lib/types';

// ───────────────────────────── Fixtures ─────────────────────────────

const PROFILE: Profile = {
  name: { first: 'Kshitiz', last: 'Mittal', preferred: 'Kayzee', full: 'Kshitiz Mittal' },
  email: 'kayzee@example.test',
  phone: '+353 80 000 0000',
  location: 'Dundalk, Co. Louth, Ireland',
  links: { linkedin: 'https://www.linkedin.com/in/example' },
  targets: {
    roles: ['PR Executive'], keywords: ['pr executive'], locations: ['dublin'], secondaryLocations: [], remoteOk: true,
    seniority: ['graduate'], excludeTitleWords: ['senior'], maxYearsRequired: 2, salaryFloorEUR: 36700, blacklistCompanies: [], languages: ['English'],
  },
  workAuth: { summary: 'unconfirmed', needsSponsorship: null, confirm: true },
  coverLetter: { signOff: 'Kind Regards,\nKayzee', voiceNotes: ['Plain, direct language.', 'Use contractions.'] },
};

const FACTS: FactBank = {
  version: 1,
  summaries: { general: "PR graduate and Vice President of DkIT Students' Union." },
  facts: [
    { id: 'su-vp-role', kind: 'role', text: "Vice President of DkIT Students' Union in Dundalk, Ireland, full-time since Jul 2026.", org: "DkIT Students' Union", title: 'Vice President', start: '2026-07', end: null, tags: ['leadership', 'comms'], numbers: ['2026'] },
    { id: 'su-comms-social', kind: 'achievement', text: "Produced DkIT Students' Union communications and social media content for the student body, since Sep 2025.", org: "DkIT Students' Union", tags: ['comms', 'social', 'content'], numbers: ['2025'] },
    { id: 'rr-press', kind: 'achievement', text: "Wrote press releases and promotional material for Breastcare by Alison's Ribbon Runway event.", org: 'Breastcare by Alison', tags: ['pr', 'press-releases', 'copywriting', 'events'] },
    { id: 'canopy-sales', kind: 'achievement', text: 'At Canopy Coffee, tracked daily takings against break-even targets; average daily sales rose 48% from Aug to Sep 2026.', org: 'Canopy Coffee', tags: ['analytics', 'sales'], numbers: ['48%', '48', '2026'] },
    { id: 'canopy-influencer', kind: 'achievement', text: 'For Canopy Coffee, pitched a Newry influencer agency and scoped a gifted collaboration with 5-10 local food and drink micro-creators.', org: 'Canopy Coffee', tags: ['influencer', 'pr', 'outreach', 'social'], numbers: ['5-10', '5', '10'] },
    { id: 'vttd-seo', kind: 'achievement', text: 'Moved the Visit Things to Do site from page three to page one of Google search results through on-page SEO and keyword work.', org: 'Visit Things to Do', tags: ['seo', 'digital-marketing'], numbers: ['three', 'one', 'page one', 'page three'] },
    { id: 'ntutorr-panel', kind: 'achievement', text: 'Presented N-TUTORR research findings to a national panel in Dublin.', org: 'N-TUTORR', tags: ['research', 'presentation'] },
    { id: 'edu-ba', kind: 'education', text: 'BA (Hons) Digital Marketing and Public Relations at Dundalk Institute of Technology (DkIT), from Sep 2022 to Oct 2026.', org: 'Dundalk Institute of Technology (DkIT)', title: 'BA (Hons) Digital Marketing and Public Relations', start: '2022-09', end: '2026-10', tags: ['education'], numbers: ['2022', '2026'] },
  ],
  skills: ['press releases', 'media relations', 'influencer outreach', 'social media content', 'copywriting', 'SEO', 'event PR'],
  tools: ['Google Analytics', 'Instagram', 'TikTok'],
  doNotClaim: ['media monitoring', 'Meltwater', 'Microsoft Office', 'visa sponsorship', 'years of experience'],
};

const BANK: AnswerBank = {
  entries: [
    // Sponsorship patterns mirror config/answers.json: the combined question must beat "require visa sponsorship".
    { id: 'sponsorship-now-or-future', patterns: ['now or in the future require', 'now or in the future'], answer: 'Yes', type: 'yesno', confirm: true },
    { id: 'sponsorship-now', patterns: ['require sponsorship', 'require visa sponsorship', 'visa sponsorship'], answer: '', type: 'yesno', confirm: true },
    { id: 'right-to-work-ireland', patterns: ['right to work in ireland', 'do you have the right to work'], answer: '', type: 'yesno', confirm: true },
    { id: 'salary-expectation', patterns: ['salary expectation', 'expected salary'], answer: 'In line with the market rate for the role', type: 'text', confirm: true },
    { id: 'heard-about', patterns: ['how did you hear'], answer: 'Company careers page', type: 'select', confirm: false },
    { id: 'linkedin-url', patterns: ['linkedin'], answer: 'https://www.linkedin.com/in/example', type: 'url' },
    { id: 'highest-education', patterns: ['highest level of education'], answer: "Bachelor's Degree", type: 'select' },
    { id: 'degree-name', patterns: ['degree', 'major'], answer: 'BA (Hons) Digital Marketing and Public Relations', type: 'text' },
    { id: 'graduation-date', patterns: ['graduation date', 'expected graduation'], answer: 'October 2026', type: 'text' },
    { id: 'age-18', patterns: ['at least 18', '18 years of age'], answer: 'Yes', type: 'yesno' },
    { id: 'eeo-gender', patterns: ['gender'], answer: 'Prefer not to say', type: 'select' },
    { id: 'eeo-ethnicity', patterns: ['ethnicity', 'race ethnicity'], answer: 'Prefer not to say', type: 'select' },
    { id: 'eeo-other', patterns: ['veteran'], answer: "I don't wish to answer", type: 'select' },
    { id: 'legal-attestation', patterns: ['i confirm that', 'i confirm the', 'i certify'], answer: '', type: 'yesno', confirm: true },
    { id: 'gpa', patterns: ['/^(gpa|grade point average)$/'], answer: 'n/a', type: 'text' },
  ],
};

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-writing-1',
    source: 'greenhouse',
    sourceId: '1',
    company: 'Brightwave Communications',
    title: 'PR & Communications Executive',
    location: 'Dublin',
    remote: false,
    url: 'https://boards.greenhouse.io/brightwave/jobs/1',
    applyUrl: 'https://boards.greenhouse.io/brightwave/jobs/1',
    ats: 'greenhouse',
    atsMeta: {},
    description: [
      'Brightwave Communications is an award-winning PR agency based in Dublin. We work with consumer and tech brands across Ireland.',
      'You will:',
      '- Write press releases and media materials for clients',
      '- Build media relations with journalists',
      '- Create social media content and support influencer outreach',
      'Requirements: experience with media monitoring tools such as Meltwater; strong copywriting; knowledge of Microsoft Office.',
      'Learn more at www.brightwave.example/about',
    ].join('\n'),
    status: 'scored',
    discoveredAt: '2026-11-14T10:00:00.000Z',
    updatedAt: '2026-11-14T10:00:00.000Z',
    keywords: {
      keywords: [
        { term: 'press releases', kind: 'skill', weight: 3 },
        { term: 'media relations', kind: 'skill', weight: 2 },
        { term: 'media monitoring', kind: 'tool', weight: 2 },
      ],
      matched: [
        { term: 'press releases', factIds: ['rr-press'] },
        { term: 'media relations', factIds: [] },
      ],
      gaps: ['media monitoring', 'Meltwater'],
      pct: 60,
    },
    ...over,
  };
}

function seedJob(job: Job): void {
  dbm.upsertJob(job);
}

// ───────────────────────────── LLM mock ─────────────────────────────

const realFetch = globalThis.fetch;
let llmCalls: { body: Record<string, unknown> }[] = [];

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockLLM(...replies: string[]): void {
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key-123456';
  llm.LLM_TUNING.backoffMs = 1;
  llmCalls = [];
  const queue = [...replies];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), llm.OPENROUTER_URL, 'only OpenRouter may be called');
    llmCalls.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra LLM call');
    return completion(next);
  }) as typeof fetch;
}

function userPrompt(i: number): string {
  const messages = llmCalls[i]?.body.messages as { role: string; content: string }[];
  return messages.find((m) => m.role === 'user')?.content ?? '';
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

after(() => {
  dbm.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ───────────────────────────── slop.ts ─────────────────────────────

describe('lintSlop', () => {
  const cases: [string, string][] = [
    ['I am excited to apply for this role.', 'stock:excited-to-apply'],
    ["I'd be a great fit for the team.", 'stock:great-fit'],
    ['I have a proven track record in PR.', 'stock:proven-track-record'],
    ['I can hit the ground running.', 'stock:hit-the-ground-running'],
    ["I'm used to wearing many hats.", 'stock:wear-many-hats'],
    ['I am detail-oriented.', 'ai-vocab:detail-oriented'],
    ['A real go-getter.', 'ai-vocab:go-getter'],
    ['I think outside the box.', 'stock:outside-the-box'],
    ['I utilize social tools.', 'ai-vocab:utilize'],
    ['I facilitated workshops.', 'ai-vocab:facilitate'],
    ['I fostered community.', 'ai-vocab:foster'],
    ['It was a pivotal moment.', 'ai-vocab:pivotal'],
    ['In the realm of PR.', 'ai-vocab:realm'],
    ['The media landscape is changing.', 'ai-vocab:landscape'],
    ['I embarked on a new path.', 'ai-vocab:embark'],
    ['My journey in comms.', 'ai-vocab:journey'],
    ['With unwavering focus.', 'ai-vocab:unwavering'],
    ['I am meticulous.', 'ai-vocab:meticulous'],
    ['Furthermore, I wrote copy.', 'ai-vocab:furthermore'],
    ['Moreover, I shot video.', 'ai-vocab:moreover'],
    ['I wrote copy. Additionally, I shot video.', 'stock:additionally-sentence-start'],
    ['I not only wrote the releases but also pitched them.', 'stock:not-only-but-also'],
    ["It's not just a job, it's a calling.", 'stock:not-just-x-its-y'],
    ['I loved it!', 'punct:exclamation'],
    ['Why PR? Why now? Because I care.', 'punct:rhetorical-questions'],
    ['I am writing to express my interest.', 'stock:writing-to-express'],
    ["In today's world, content matters.", 'stock:in-todays'],
    ['I want to delve into this.', 'ai-vocab:delve'],
    ['I am passionate about PR.', 'ai-vocab:passionate'],
    ['I leveraged social media.', 'ai-vocab:leverage'],
    ['A fast-paced, dynamic team.', 'ai-vocab:fast-paced'],
    ['I spearheaded the launch.', 'ai-vocab:spearhead'],
    ['I built it seamlessly.', 'ai-vocab:seamless'],
    ['The results were great — really great.', 'dash:em-dash'],
    ['The results were great – really great.', 'dash:en-dash-punctuation'],
    ['Sep 2022–2026', 'dash:en-dash-range'],
    ['I wrote press releases, media kits and pitches. I shot photos, reels and drone video. I planned events, launches and talks.', 'style:rule-of-three'],
  ];
  for (const [text, rule] of cases) {
    test(`flags ${rule}`, () => {
      const res = slop.lintSlop(text);
      assert.equal(res.ok, false);
      assert.ok(res.hits.some((h) => h.rule === rule), `expected ${rule} in ${JSON.stringify(res.hits)}`);
    });
  }

  test('clean, plain writing passes', () => {
    const text = "I'm applying for the PR Executive role. I wrote press releases for the Ribbon Runway event, and I'd like to do more of that work. Sep 2022-Oct 2026 was my degree. Is the role hybrid?";
    assert.deepEqual(slop.lintSlop(text), { ok: true, hits: [] });
  });

  test('single list of three is fine; words inside other words are not flagged', () => {
    assert.equal(slop.lintSlop('I shot photos, reels and drone video.').ok, true);
    assert.equal(slop.lintSlop('The robustness of fosterage is irrelevant; the journeyman stayed.').hits.filter((h) => h.rule !== 'ai-vocab:robust').length, 0);
  });

  test('detail-oriented and landscape are allowed when they come from the facts or the allow-list', () => {
    const facts: FactBank = { ...FACTS, facts: [...FACTS.facts, { id: 'x', kind: 'other', text: 'Described by the team as detail-oriented.', tags: [] }] };
    assert.equal(slop.lintSlop('I am detail-oriented.', { facts }).ok, true);
    assert.equal(slop.lintSlop('I want to join Landscape Media Group.', { allow: ['Landscape Media Group'] }).ok, true);
    assert.equal(slop.lintSlop('I applied to Dynamic Events Ltd.', { allow: ['Dynamic Events Ltd'] }).ok, true);
  });
});

describe('fixDashes', () => {
  const cases: [string, string][] = [
    ['I loved it — the team was great.', 'I loved it, the team was great.'],
    ['Results came fast — I doubled bookings in a month.', 'Results came fast. I doubled bookings in a month.'],
    ['It was hard — but worth it — and I learned a lot.', 'It was hard, but worth it, and I learned a lot.'],
    ['It was hard – but worth it.', 'It was hard, but worth it.'],
    ['Content—short and sharp—works.', 'Content, short and sharp, works.'],
    ['It worked -- mostly.', 'It worked, mostly.'],
    ['BA (Hons), 2022–2026.', 'BA (Hons), 2022-2026.'],
    ['Sep 2022 – Oct 2026', 'Sep 2022 - Oct 2026'],
    ['Jul 2026 – Present', 'Jul 2026 - Present'],
    ['Open Mon–Fri, 5–10 creators.', 'Open Mon-Fri, 5-10 creators.'],
    ['The Dublin–Belfast corridor.', 'The Dublin-Belfast corridor.'],
    ['Ending on a dash —', 'Ending on a dash.'],
  ];
  for (const [input, expected] of cases) {
    test(JSON.stringify(input), () => assert.equal(slop.fixDashes(input), expected));
  }

  test('is idempotent, keeps paragraphs, and leaves no dash hits', () => {
    const input = 'First para — with a dash.\n\nSecond para, 2022–2026 — and more — here.';
    const once = slop.fixDashes(input);
    assert.equal(slop.fixDashes(once), once);
    assert.equal(once.split('\n\n').length, 2);
    assert.equal(slop.lintSlop(once).hits.filter((h) => h.rule.startsWith('dash:')).length, 0);
    assert.match(once, /2022-2026/);
  });

  test('leaves hyphenated words and plain hyphens alone', () => {
    const s = 'A well-known, short-form video series from 2022-2026.';
    assert.equal(slop.fixDashes(s), s);
  });

  test('tidying keeps ellipses and tokens like .NET', () => {
    assert.equal(slop.fixDashes('I used .NET — briefly.'), 'I used .NET, briefly.');
    assert.equal(slop.fixDashes('Wait for it...'), 'Wait for it...');
  });
});

describe('lintSlop allow-list for punctuation', () => {
  test('a brand name with an exclamation mark is allowed only when listed', () => {
    assert.equal(slop.lintSlop('I applied to Yahoo! last week.', { allow: ['Yahoo!'] }).ok, true);
    assert.equal(slop.lintSlop('I applied to Yahoo! last week.').ok, false);
  });
});

// ───────────────────────────── answers.ts ─────────────────────────────

describe('answer matching helpers', () => {
  test('normaliseLabel strips asterisks, required markers and punctuation', () => {
    assert.equal(answersMod.normaliseLabel("Driver's Licence?* (required)"), 'drivers licence');
    assert.equal(answersMod.normaliseLabel('Race/Ethnicity'), 'race ethnicity');
  });

  test('short patterns need whole words; regex patterns work', () => {
    assert.ok(answersMod.patternScore('major', 'what was your major', 'What was your major?') > 0);
    assert.equal(answersMod.patternScore('major', 'the majority of your time', 'The majority of your time'), 0);
    assert.equal(answersMod.patternScore('gender', 'do you identify as transgender', 'Do you identify as transgender'), 0);
    assert.ok(answersMod.patternScore('/^(gpa|grade point average)$/', 'gpa', 'GPA') > 0);
    assert.equal(answersMod.patternScore('/[unclosed/', 'gpa', 'GPA'), 0);
  });

  test('longest pattern wins over a shorter generic one', () => {
    assert.equal(answersMod.findBankEntry('Expected graduation date for your degree', BANK)?.id, 'graduation-date');
    assert.equal(answersMod.findBankEntry('What is your degree?', BANK)?.id, 'degree-name');
  });

  test('mapOption: exact, yes/no, containment, ambiguity', () => {
    assert.equal(answersMod.mapOption("Bachelor's Degree", ['High school', "Bachelor's degree", "Master's degree"]), "Bachelor's degree");
    assert.equal(answersMod.mapOption('Yes', ['Yes, I am', 'No, I am not']), 'Yes, I am');
    assert.equal(answersMod.mapOption("Bachelor's Degree", ['Level 8 Honours Bachelor Degree', 'Level 9 Masters']), 'Level 8 Honours Bachelor Degree');
    assert.equal(answersMod.mapOption("Bachelor's Degree", ["Bachelor's Degree (Level 7)", "Honours Bachelor's Degree (Level 8)"]), null);
    assert.equal(answersMod.mapOption('Yes', ['Basic', 'Fluent', 'Native']), null);
  });
});

describe('answerQuestions', () => {
  const q = (id: string, label: string, type: ScreeningQuestion['type'], required = true, options?: string[]): ScreeningQuestion => ({
    id, label, type, required, ...(options ? { options } : {}),
  });

  const QUESTIONS: ScreeningQuestion[] = [
    q('first_name', 'First Name*', 'text'),
    q('last_name', 'Last Name', 'text'),
    q('email', 'Email', 'text'),
    q('phone', 'Phone', 'text'),
    q('linkedin', 'LinkedIn Profile', 'url', false),
    q('spons', 'Will you now or in the future require visa sponsorship to work in Ireland?', 'yesno', true, ['Yes', 'No']),
    q('rtw', 'Do you have the right to work in Ireland?', 'yesno'),
    q('gender', 'Gender', 'select', false, ['Male', 'Female', 'Non-binary', "I don't wish to answer"]),
    q('race', 'Race/Ethnicity', 'select', false, ['White', 'Asian', 'Black', 'Decline to self-identify']),
    q('veteran', 'Veteran Status', 'select', true, ['I am a veteran', 'I am not a veteran']),
    q('edu', 'What is your highest level of education?', 'select', true, ['Secondary school', "Bachelor's degree", "Master's degree"]),
    q('heard', 'How did you hear about this job?', 'select', true, ['LinkedIn', 'Company website', 'Referral', 'Other']),
    q('salary_text', 'What are your salary expectations?', 'text'),
    q('salary_num', 'Expected salary (EUR)', 'number'),
    q('cover', 'Cover Letter', 'textarea', false),
    q('why', 'Why do you want to work at Brightwave Communications?', 'textarea'),
    q('sfmc', 'Please describe your experience with Salesforce Marketing Cloud', 'textarea'),
    q('attest', 'I confirm the information provided is accurate', 'checkbox'),
    q('resume', 'Resume/CV', 'file'),
    q('age', 'Are you at least 18 years of age?', 'radio', true, ['Yes', 'No']),
    q('country', 'Country', 'select', true, ['Ireland', 'Northern Ireland', 'United Kingdom']),
    q('pronouns', 'Pronouns', 'text', false),
  ];

  test('maps 22 realistic questions without fabricating', async () => {
    const job = makeJob();
    const res = await answersMod.answerQuestions(QUESTIONS, BANK, PROFILE, FACTS, job, { coverLetter: 'Dear Hiring Team,\n\nLetter body.', save: false });
    const by = Object.fromEntries(res.map((r) => [r.id, r]));

    assert.deepEqual([by.first_name.answer, by.first_name.source], ['Kshitiz', 'profile']);
    assert.equal(by.last_name.answer, 'Mittal');
    assert.equal(by.email.answer, PROFILE.email);
    assert.equal(by.phone.answer, PROFILE.phone);
    assert.equal(by.linkedin.answer, PROFILE.links.linkedin);

    assert.deepEqual([by.spons.answer, by.spons.source, by.spons.confirm, by.spons.needsHuman], ['Yes', 'bank', true, false]);
    assert.deepEqual([by.rtw.answer, by.rtw.needsHuman, by.rtw.answerId], [null, true, 'right-to-work-ireland']);

    assert.equal(by.gender.answer, "I don't wish to answer");
    assert.equal(by.race.answer, 'Decline to self-identify');
    assert.deepEqual([by.veteran.answer, by.veteran.needsHuman], [null, true], 'no decline option → hand off');

    assert.equal(by.edu.answer, "Bachelor's degree");
    assert.equal(by.heard.answer, 'Company website', 'greenhouse job → careers site option');

    assert.deepEqual([by.salary_text.answer, by.salary_text.confirm], ['In line with the market rate for the role', true]);
    assert.deepEqual([by.salary_num.answer, by.salary_num.needsHuman], [null, true], 'never invent a salary number');

    assert.equal(by.cover.answer, 'Dear Hiring Team,\n\nLetter body.');
    assert.deepEqual([by.why.answer, by.why.needsHuman], [null, true], 'no LLM → Kayzee writes it');
    assert.deepEqual([by.sfmc.answer, by.sfmc.source, by.sfmc.needsHuman], [null, 'none', true]);
    assert.deepEqual([by.attest.answer, by.attest.needsHuman], [null, true], 'attestations always handed off');
    assert.deepEqual([by.resume.answer, by.resume.needsHuman], [null, false], 'CV upload handled by the filler');
    assert.deepEqual([by.age.answer, by.age.confirm], ['Yes', undefined]);
    assert.equal(by.country.answer, 'Ireland');
    assert.deepEqual([by.pronouns.answer, by.pronouns.needsHuman], [null, false], 'unknown optional → leave blank');

    assert.equal(res.length, QUESTIONS.length);
    for (const r of res) assert.ok(r.answer === null || r.answer.trim().length > 0);
  });

  test('heard-about follows the real job source', async () => {
    const res = await answersMod.answerQuestions([q('h', 'How did you hear about us?', 'select', true, ['LinkedIn', 'Indeed', 'Company website'])], BANK, PROFILE, FACTS, makeJob({ source: 'linkedin_guest' }), { save: false });
    assert.equal(res[0].answer, 'LinkedIn');
  });

  test('yes/no question with a non-yes/no bank answer is handed off', async () => {
    const res = await answersMod.answerQuestions([q('d', 'Do you have a degree?', 'yesno')], BANK, PROFILE, FACTS, makeJob(), { save: false });
    assert.deepEqual([res[0].answer, res[0].needsHuman], [null, true]);
  });

  test('stores an answers artifact', async () => {
    const job = makeJob({ id: 'job-answers-store' });
    seedJob(job);
    await answersMod.answerQuestions(QUESTIONS.slice(0, 3), BANK, PROFILE, FACTS, job);
    const art = dbm.latestArtifact(job.id, 'answers');
    assert.ok(art?.content);
    assert.equal((JSON.parse(art.content) as unknown[]).length, 3);
    assert.equal(art.meta?.total, 3);
  });

  test('why-question uses a guarded LLM answer when available', async () => {
    mockLLM(JSON.stringify({ answer: "Brightwave Communications works with consumer brands, and that's the kind of PR I want to do. I wrote press releases for Breastcare by Alison's Ribbon Runway event.", factIds: ['rr-press'] }));
    const res = await answersMod.answerQuestions([q('why', 'Why are you interested in this role?', 'textarea')], BANK, PROFILE, FACTS, makeJob(), { save: false });
    assert.equal(res[0].source, 'llm');
    assert.equal(res[0].needsHuman, false);
    assert.match(res[0].answer ?? '', /Ribbon Runway/);
    assert.match(userPrompt(0), /<untrusted source="job-description">/);
  });

  test('why-question with invented numbers twice is handed off', async () => {
    const bad = JSON.stringify({ answer: 'I grew sales by 300% at Canopy Coffee.', factIds: ['canopy-sales'] });
    mockLLM(bad, bad);
    const res = await answersMod.answerQuestions([q('why', 'Why do you want to join us?', 'textarea')], BANK, PROFILE, FACTS, makeJob(), { save: false });
    assert.deepEqual([res[0].answer, res[0].needsHuman], [null, true]);
    assert.equal(llmCalls.length, 2);
  });
});

// ───────────────────────────── letter.ts ─────────────────────────────

describe('toFirstPerson', () => {
  const f = (text: string) => ({ id: 'x', kind: 'achievement' as const, text, tags: [] });
  test('rewrites verb-led facts without changing claims', () => {
    assert.equal(letter.toFirstPerson(f('Wrote press releases for the event.')), 'I wrote press releases for the event.');
    assert.equal(letter.toFirstPerson(f('At Canopy Coffee, tracked daily takings.')), 'At Canopy Coffee, I tracked daily takings.');
    assert.equal(letter.toFirstPerson(f('Produced comms content for students, since Sep 2025.')), "I've produced comms content for students since Sep 2025.");
    assert.equal(letter.toFirstPerson(f('Vice President of the Union.')), null);
  });
});

describe('writeCoverLetter (template, no LLM)', () => {
  test('passes slop lint and truth guard, names company + title, ≤250 words', async () => {
    const job = makeJob();
    const res = await letter.writeCoverLetter(job, FACTS, PROFILE, { save: false });
    assert.equal(res.llmUsed, false);
    assert.ok(res.text.includes(job.company));
    assert.ok(res.text.includes(job.title));
    assert.ok(res.text.startsWith('Dear Hiring Team,\n\n'));
    assert.ok(res.text.endsWith('Kind Regards,\nKayzee\nKshitiz Mittal'));
    assert.ok(res.wordCount <= letter.LETTER_MAX_WORDS, `${res.wordCount} words`);
    assert.equal(letter.wordCount(res.text), res.wordCount);
    assert.deepEqual(res.slop.hits, []);
    assert.deepEqual(slop.lintSlop(res.text, { allow: [job.company, job.title] }).hits, []);
    assert.equal(res.guard.ok, true, res.guard.problems.join('; '));
    assert.deepEqual(res.flags, []);
    assert.doesNotMatch(res.text, /[—–]|\*\*|^#/m);
    assert.doesNotMatch(res.text, /meltwater|media monitoring|microsoft office|visa|sponsor/i, 'gaps and visa never claimed');
    assert.ok(res.factIds.includes('rr-press'), 'press-release fact chosen for a PR job');
  });

  test('uses a known contact name in the greeting', async () => {
    const res = await letter.writeCoverLetter(makeJob(), FACTS, PROFILE, { save: false, contactName: 'Aoife Byrne' });
    assert.ok(res.text.startsWith('Dear Aoife Byrne,'));
    assert.equal(res.guard.ok, true, res.guard.problems.join('; '));
  });

  test('stores a cover_letter artifact; saveCoverLetter re-guards an edit as a new version', async () => {
    const job = makeJob({ id: 'job-letter-store' });
    seedJob(job);
    const res = await letter.writeCoverLetter(job, FACTS, PROFILE, { pdf: false });
    const first = dbm.latestArtifact(job.id, 'cover_letter');
    assert.equal(first?.id, res.artifactId);
    assert.equal(first?.content, res.text);
    assert.equal(first?.version, 1);

    // saveCoverLetter loads facts from config; point it at the fixture bank.
    const configDir = path.join(TMP, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'facts.json'), JSON.stringify(FACTS));
    fs.writeFileSync(path.join(configDir, 'profile.json'), JSON.stringify(PROFILE));
    process.env.PURSUIT_CONFIG_DIR = configDir;
    try {
      const edited = res.text.replace("Thanks for taking the time", 'I tripled bookings to 900 a week. Thanks for taking the time');
      const saved = await letter.saveCoverLetter(job.id, edited, { pdf: false });
      assert.equal(saved.artifact.version, 2);
      assert.equal(saved.artifact.content, edited.trim());
      assert.equal(saved.guard.ok, false);
      assert.ok(saved.flags.some((f) => /900/.test(f)), saved.flags.join('; '));
      assert.equal(saved.artifact.meta?.edited, true);
      await assert.rejects(() => letter.saveCoverLetter(job.id, '   ', { pdf: false }), /empty/);
      await assert.rejects(() => letter.saveCoverLetter('missing-job', 'text', { pdf: false }), /not found/);
    } finally {
      delete process.env.PURSUIT_CONFIG_DIR;
    }
  });
});

describe('writeCoverLetter (LLM, mocked)', () => {
  const clean = {
    paragraphs: [
      "I'm applying for the PR & Communications Executive role at Brightwave Communications.",
      "I wrote press releases and promotional material for Breastcare by Alison's Ribbon Runway event, and I've produced DkIT Students' Union social media content since Sep 2025.",
      "I'd be glad to talk about the role.",
    ],
    factIds: ['rr-press', 'su-comms-social', 'not-a-real-id'],
  };

  test('regenerates once when the first draft has slop, then keeps the clean draft', async () => {
    const sloppy = { ...clean, paragraphs: ['I am passionate about PR — truly!', ...clean.paragraphs.slice(1)] };
    mockLLM(JSON.stringify(sloppy), JSON.stringify(clean));
    const res = await letter.writeCoverLetter(makeJob(), FACTS, PROFILE, { save: false });
    assert.equal(llmCalls.length, 2);
    assert.match(userPrompt(1), /passionate/);
    assert.match(userPrompt(0), /GAPS[^\n]*media monitoring/);
    assert.match(userPrompt(0), /<untrusted source="job-description">/);
    assert.equal(res.llmUsed, true);
    assert.deepEqual(res.flags, []);
    assert.deepEqual(res.factIds, ['rr-press', 'su-comms-social']);
    assert.ok(res.text.startsWith('Dear Hiring Team,'));
  });

  test('falls back to the template when the LLM keeps inventing claims', async () => {
    const lying = { paragraphs: ['I ran media monitoring with Meltwater for 40 clients.', 'I grew sales 300%.'], factIds: [] };
    mockLLM(JSON.stringify(lying), JSON.stringify(lying));
    const res = await letter.writeCoverLetter(makeJob(), FACTS, PROFILE, { save: false });
    assert.equal(res.llmUsed, false);
    assert.equal(res.guard.ok, true);
    assert.ok(res.flags.some((f) => /truth guard/i.test(f)));
    assert.doesNotMatch(res.text, /Meltwater|300%/);
  });

  test('strips greetings, sign-offs and markdown the model adds', () => {
    const body = letter.sanitizeLetterBody('Dear Sir,\n\n**Hello** there.\n- point one\n\nKind regards,\nBot');
    assert.equal(body, 'Hello there.\npoint one');
  });
});

// ───────────────────────────── letterPdf.ts ─────────────────────────────

describe('letter PDF source', () => {
  test('escapes LaTeX specials and dashes', () => {
    assert.equal(pdf.escapeLatex('100% & #1 $5 _x_ {y} ~ ^'), '100\\% \\& \\#1 \\$5 \\_x\\_ \\{y\\} \\textasciitilde{} \\textasciicircum{}');
    assert.equal(pdf.escapeLatex('a -- b — c'), 'a -{}- b - c');
  });

  test('builds a document with the CV font and the letter text', () => {
    const tex = pdf.buildLetterTex('Dear Hiring Team,\n\nBody & more.\n\nKind Regards,\nKayzee\nKshitiz Mittal', PROFILE, new Date('2026-11-15T12:00:00Z'));
    assert.match(tex, /\\usepackage\[default,semibold,type1\]\{sourcesanspro\}/);
    assert.match(tex, /\\usepackage\[T1\]\{fontenc\}/);
    assert.match(tex, /Body \\& more\./);
    assert.match(tex, /15 November 2026/);
    assert.match(tex, /Kayzee\\\\\nKshitiz Mittal/);
  });
});

// ───────────────────────────── prep.ts ─────────────────────────────

describe('buildPrepPack (deterministic)', () => {
  test('has every section, 10 questions, STAR skeletons from facts and the gaps list', async () => {
    const job = makeJob({ id: 'job-prep' });
    seedJob(job);
    const md = await prep.buildPrepPack(job, FACTS, PROFILE, { fetchHomepage: false });
    for (const h of ['# Interview prep: PR & Communications Executive at Brightwave Communications', '## Company brief', '## 10 likely questions', '## STAR answers from your facts', "## Gaps: don't claim these", '## 5 questions to ask them', '## Logistics']) {
      assert.ok(md.includes(h), `missing ${h}`);
    }
    const likely = md.split('## 10 likely questions')[1].split('##')[0];
    assert.equal((likely.match(/^\d+\. /gm) ?? []).length, 10);
    assert.match(md, /fact: rr-press/);
    assert.match(md, /Brightwave Communications is an award-winning PR agency/);
    assert.match(md, /- Meltwater/);
    assert.doesNotMatch(md, /[—–]/);
    assert.equal(dbm.latestArtifact(job.id, 'prep')?.content, md);
  });

  test('homepage discovery skips ATS hosts and fetch failures are harmless', async () => {
    assert.equal(prep.findHomepageUrl(makeJob()), 'https://www.brightwave.example/');
    assert.equal(prep.findHomepageUrl(makeJob({ description: 'Apply at https://boards.greenhouse.io/x and https://www.linkedin.com/company/x' })), null);
    const okFetch = (async () => new Response('<html><body><script>x()</script><p>We help brands tell better stories across Ireland and beyond.</p></body></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch;
    assert.equal(await prep.fetchHomepageText('https://www.brightwave.example/', okFetch), 'We help brands tell better stories across Ireland and beyond.');
    const failing = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    assert.equal(await prep.fetchHomepageText('https://www.brightwave.example/', failing), null);

    const md = await prep.buildPrepPack(makeJob(), FACTS, PROFILE, { fetchImpl: okFetch, save: false });
    assert.match(md, /From their homepage:\n- We help brands tell better stories/);
  });

  test('never fetches local or private hosts, even through a redirect', async () => {
    for (const bad of ['http://localhost/', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://[::1]/', 'http://router.local/', 'file:///etc/passwd', 'https://acme.com:8080/', 'https://user:pw@acme.com/']) {
      assert.equal(prep.isPublicWebUrl(bad), false, bad);
    }
    assert.equal(prep.isPublicWebUrl('https://www.acme.ie/'), true);
    assert.equal(prep.findHomepageUrl(makeJob({ description: 'See http://10.0.0.5/admin for details.' })), null);

    const calls: string[] = [];
    const redirecting = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
    }) as typeof fetch;
    assert.equal(await prep.fetchHomepageText('https://www.acme.ie/', redirecting), null);
    assert.deepEqual(calls, ['https://www.acme.ie/']);
  });
});

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
});
