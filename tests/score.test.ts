// Scoring + hard filters (SPEC §5.3). Pure, offline: the LLM is either disabled or a local mock.
process.env.PURSUIT_SKIP_ENV_FILE = '1';
process.env.OPENROUTER_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.GROQ_API_KEY = '';
process.env.ORCAROUTER_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FactBank, Profile } from '@/lib/types';
import {
  annualSalaryEur,
  classifyLocation,
  freshnessComponent,
  hardFilters,
  parseSalaryFromText,
  roleFitHeuristic,
  scoreJob,
  SCORE_WEIGHTS,
  titleSeniority,
  totalScore,
  yearsRequired,
  type ScorableJob,
} from '@/engine/score';

// ───────────────────────────── Fixtures ─────────────────────────────

const NOW = new Date('2026-11-15T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const PROFILE: Profile = {
  name: { first: 'Kshitiz', last: 'Mittal', preferred: 'Kayzee', full: 'Kshitiz Mittal' },
  email: 'test@example.com',
  phone: '+353 00 000 0000',
  location: 'Dundalk, Co. Louth, Ireland',
  links: {},
  targets: {
    roles: [
      'PR & Communications Executive', 'PR Executive', 'PR Assistant', 'Communications Officer',
      'Communications Executive', 'Content Creator', 'Content Executive', 'Social Media Executive',
      'Social Media Coordinator', 'Digital Marketing Executive', 'Marketing Executive', 'Marketing Assistant',
      'Graduate Marketing Programme', 'Events & Engagement Executive', 'Engagement Officer',
    ],
    keywords: ['public relations', 'communications executive', 'content creator', 'social media executive'],
    locations: ['dublin', 'dundalk', 'louth', 'drogheda', 'swords', 'ireland', 'remote'],
    secondaryLocations: ['newry', 'belfast', 'northern ireland', 'armagh'],
    remoteOk: true,
    seniority: ['intern', 'graduate', 'junior', 'executive'],
    excludeTitleWords: ['senior', 'sr.', 'head of', 'director', 'lead', 'principal', 'chief', 'vice president'],
    maxYearsRequired: 2,
    salaryFloorEUR: 36_700,
    blacklistCompanies: ['Shady Recruiters Ltd'],
    languages: ['English', 'Hindi'],
  },
  workAuth: { summary: 'test', needsSponsorship: null, confirm: true },
  coverLetter: { signOff: 'Kind Regards,\nKayzee', voiceNotes: [] },
};

const FACTS: FactBank = {
  version: 1,
  summaries: { general: 'PR and content graduate.' },
  facts: [
    { id: 'press-releases', kind: 'achievement', text: 'Wrote press releases and promotional material for a charity fashion event.', tags: ['pr', 'press-releases', 'events'] },
    { id: 'social-content', kind: 'achievement', text: 'Produced Students Union communications and social media content for the student body.', tags: ['comms', 'social', 'content'] },
    { id: 'events', kind: 'achievement', text: 'Organised orientation and welcome events for incoming international students.', tags: ['events', 'community'] },
    { id: 'committees', kind: 'achievement', text: 'Represented students on college committees and boards.', tags: ['stakeholder', 'representation'] },
    { id: 'seo', kind: 'achievement', text: 'Moved a tourism site from page three to page one of Google through on-page SEO.', tags: ['seo', 'digital-marketing'] },
    { id: 'video', kind: 'achievement', text: 'Shot and edited photo and video content for local brands, including short-form video for Instagram and TikTok.', tags: ['video', 'photography', 'content'] },
    { id: 'presented', kind: 'achievement', text: 'Presented research findings to a national panel in Dublin.', tags: ['research', 'presentation'] },
  ],
  skills: ['public relations', 'press releases', 'media relations', 'stakeholder engagement', 'content creation', 'copywriting', 'social media content', 'event organisation', 'SEO', 'video editing'],
  tools: ['DaVinci Resolve', 'Adobe Creative Suite', 'Instagram', 'TikTok'],
  doNotClaim: ['media monitoring', 'Canva', 'Microsoft Office', 'press queries', 'media coverage'],
};

function job(partial: Partial<ScorableJob> & Pick<ScorableJob, 'title' | 'description'>): ScorableJob {
  return { company: 'Example Co', location: 'Dublin, Ireland', remote: false, ...partial };
}

const PR_EXEC_DUBLIN = job({
  title: 'Graduate PR Executive',
  company: 'Brightside Communications',
  location: 'Dublin, Ireland',
  country: 'IE',
  postedAt: daysAgo(2),
  salary: { min: 38_000, max: 42_000, currency: 'EUR', period: 'year' },
  description: `About the Role
Brightside is an award-winning PR agency in Dublin and we are hiring a Graduate PR Executive. Recent graduates welcome.

Key Responsibilities
- Write press releases and pitch stories to journalists
- Build media relations with national and regional press
- Create social media content for client channels
- Support the planning and delivery of client events and launches
- Stakeholder engagement with clients and partners

Requirements
- A degree in public relations, communications or marketing
- Excellent written communication and attention to detail
- Strong copywriting skills

Desirable
- Experience with Canva
- Knowledge of media monitoring tools

About Us
We are a friendly team with a hybrid working policy and a great benefits package.`,
});

const SENIOR_COMMS_MANAGER = job({
  title: 'Senior Communications Manager',
  company: 'Big Corp',
  location: 'Dublin',
  country: 'IE',
  postedAt: daysAgo(5),
  description: `The Role
Lead our corporate communications and internal communications strategy across EMEA.

Requirements
- A minimum of 7 years' experience in corporate communications or public relations
- Proven crisis communications and media relations experience
- Experience managing a team and a budget`,
});

const SOCIAL_BELFAST = job({
  title: 'Social Media Executive',
  company: 'Lagan Brands',
  location: 'Belfast, Northern Ireland',
  country: 'GB-NIR',
  postedAt: daysAgo(10),
  salary: { min: 32_000, max: 35_000, currency: 'GBP', period: 'year' },
  description: `What you'll do
- Manage our social channels across Instagram, TikTok and LinkedIn
- Plan the content calendar and create short-form video
- Report on performance using Meta Business Suite

What you'll need
- 1-2 years in a social media role or a relevant degree
- You must have the right to work in the UK.`,
});

const SOFTWARE_ENGINEER = job({
  title: 'Software Engineer',
  company: 'Stack Ltd',
  location: 'Dublin, Ireland',
  country: 'IE',
  postedAt: daysAgo(1),
  description: `Requirements
- 3+ years of experience building TypeScript services
- Experience with Kubernetes and PostgreSQL`,
});

const CONTENT_CREATOR_REMOTE = job({
  title: 'Content Creator',
  company: 'Hearth Media',
  location: 'Remote - Ireland',
  country: 'IE',
  remote: true,
  postedAt: daysAgo(4),
  description: `About the role
We need a Content Creator to produce short-form video and social media content for our brands. Fully remote within Ireland.
Pay: €20 per hour, freelance.

You will have
- A portfolio of video content (Reels, TikTok videos)
- Video editing skills (Premiere Pro or DaVinci Resolve)
- Good storytelling and copywriting`,
});

const GERMAN_MARKETING = job({
  title: 'Marketing Executive (DACH)',
  company: 'Euro SaaS',
  location: 'Dublin, Ireland',
  country: 'IE',
  postedAt: daysAgo(3),
  description: `Responsibilities
- Run digital marketing campaigns and email marketing for the DACH market

Requirements
- Fluent German is essential, both written and spoken
- Experience with HubSpot`,
});

const noLlm = { llm: false as const, now: NOW };

// ───────────────────────────── Hard filters on the six JDs ─────────────────────────────

describe('hardFilters: unpaid flag', () => {
  const flags = (extra: string, title = PR_EXEC_DUBLIN.title) =>
    hardFilters({ ...PR_EXEC_DUBLIN, title, description: `${PR_EXEC_DUBLIN.description}\n${extra}` }, PROFILE).flags;
  it('does not treat unpaid leave or breaks as an unpaid job (Ryanair, Nov 2026)', () => {
    for (const perk of ['Option for up to 5 additional unpaid leave days per year', 'Unpaid parental leave', '30 minute unpaid lunch break']) {
      assert.ok(!flags(perk).includes('Unpaid or voluntary role'), perk);
    }
  });
  it('still flags genuinely unpaid roles', () => {
    assert.ok(flags('This is an unpaid internship.').includes('Unpaid or voluntary role'));
    assert.ok(flags('', 'UNPAID VOLUNTEER - Communications').includes('Unpaid or voluntary role'));
  });
});

describe('hardFilters: six realistic postings', () => {
  it('passes the Dublin graduate PR executive role with no rejections', () => {
    const r = hardFilters(PR_EXEC_DUBLIN, PROFILE);
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.deepEqual(r.rejected, []);
  });

  it('rejects the senior comms manager on title and on 7 mandatory years', () => {
    const r = hardFilters(SENIOR_COMMS_MANAGER, PROFILE);
    assert.equal(r.pass, false);
    assert.ok(r.rejected.some((x) => /title contains "senior"/i.test(x)), r.rejected.join(' | '));
    assert.ok(r.rejected.some((x) => /7\+ years/.test(x)), r.rejected.join(' | '));
  });

  it('passes the Belfast social role but flags Northern Ireland and right-to-work wording', () => {
    const r = hardFilters(SOCIAL_BELFAST, PROFILE);
    assert.equal(r.pass, true, JSON.stringify(r));
    assert.ok(r.flags.some((f) => /northern ireland/i.test(f)), r.flags.join(' | '));
    assert.ok(r.flags.some((f) => /right-to-work/i.test(f)), r.flags.join(' | '));
  });

  it('rejects the software engineer as a non-target role family', () => {
    const r = hardFilters(SOFTWARE_ENGINEER, PROFILE);
    assert.equal(r.pass, false);
    assert.ok(r.rejected.some((x) => /not a target role \(software/i.test(x)), r.rejected.join(' | '));
  });

  it('passes the remote Ireland hourly content creator role (€20/h annualises over the floor)', () => {
    const r = hardFilters(CONTENT_CREATOR_REMOTE, PROFILE);
    assert.equal(r.pass, true, JSON.stringify(r));
  });

  it('rejects the German-speaking marketing role', () => {
    const r = hardFilters(GERMAN_MARKETING, PROFILE);
    assert.equal(r.pass, false);
    assert.ok(r.rejected.some((x) => /german/i.test(x)), r.rejected.join(' | '));
  });
});

// ───────────────────────────── Score ordering ─────────────────────────────

describe('scoreJob: heuristic path (no LLM)', () => {
  it('orders the six postings sensibly', async () => {
    const [pr, senior, social, swe, content, german] = await Promise.all(
      [PR_EXEC_DUBLIN, SENIOR_COMMS_MANAGER, SOCIAL_BELFAST, SOFTWARE_ENGINEER, CONTENT_CREATOR_REMOTE, GERMAN_MARKETING].map((j) =>
        scoreJob(j, PROFILE, FACTS, noLlm),
      ),
    );
    const totals = { pr: pr.total, senior: senior.total, social: social.total, swe: swe.total, content: content.total, german: german.total };
    const msg = JSON.stringify(totals);
    assert.ok(pr.total >= 70, `PR exec should score high: ${msg}`);
    assert.ok(pr.total > content.total, msg);
    assert.ok(content.total > senior.total, msg);
    assert.ok(social.total > senior.total, msg);
    assert.ok(pr.total > social.total, msg);
    assert.ok(swe.total < 40, `software engineer should score low: ${msg}`);
    assert.ok(senior.total < pr.total - 20, msg);
    for (const s of [pr, senior, social, swe, content, german]) {
      assert.equal(s.llmUsed, false);
      assert.ok(s.total >= 0 && s.total <= 100);
      for (const v of Object.values(s.components)) assert.ok(v >= 0 && v <= 1);
    }
  });

  it('gives location components: primary 1, remote 0.9, secondary 0.6', async () => {
    const pr = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, noLlm);
    const content = await scoreJob(CONTENT_CREATOR_REMOTE, PROFILE, FACTS, noLlm);
    const social = await scoreJob(SOCIAL_BELFAST, PROFILE, FACTS, noLlm);
    assert.equal(pr.components.location, 1);
    assert.equal(content.components.location, 0.9);
    assert.equal(social.components.location, 0.6);
  });

  it('writes human-readable reasons: strengths and gaps, never claiming do-not-claim terms', async () => {
    const s = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, noLlm);
    const strong = s.reasons.find((r) => /^(Strong|Partial) match: /.test(r));
    assert.ok(strong, s.reasons.join(' | '));
    assert.match(strong, /media relations|press releases/);
    assert.ok(!/canva|media monitoring/i.test(strong), 'do-not-claim terms must not be listed as strengths');
    assert.ok(s.reasons.some((r) => /do-not-claim/.test(r) && /Canva|media monitoring/.test(r)), s.reasons.join(' | '));
    assert.ok(s.reasons.some((r) => /Salary €38,000-€42,000 meets your floor/.test(r)), s.reasons.join(' | '));
    assert.ok(s.reasons.length <= 8);
  });

  it('carries filter rejections into flags so the UI can show them', async () => {
    const s = await scoreJob(SOFTWARE_ENGINEER, PROFILE, FACTS, noLlm);
    assert.ok(s.flags.some((f) => f.startsWith('Filtered: ')), s.flags.join(' | '));
  });

  it('total equals the SPEC-weighted sum of components', async () => {
    const s = await scoreJob(SOCIAL_BELFAST, PROFILE, FACTS, noLlm);
    assert.deepEqual({ ...SCORE_WEIGHTS }, { skills: 40, roleFit: 25, seniority: 15, location: 10, freshness: 5, salary: 5 });
    const c = s.components;
    const expected = Math.round(40 * c.skills + 25 * c.roleFit + 15 * c.seniority + 10 * c.location + 5 * c.freshness + 5 * c.salary);
    assert.equal(s.total, expected);
    assert.equal(totalScore({ skills: 1, roleFit: 1, seniority: 1, location: 1, freshness: 1, salary: 1 }), 100);
  });

  it('works through the default judge without a key (no network, llmUsed=false)', async () => {
    const s = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, { now: NOW });
    assert.equal(s.llmUsed, false);
  });
});

describe('scoreJob: LLM blending (mocked judge)', () => {
  it('blends roleFit and seniority 50/50 and adds the judge reasons', async () => {
    const base = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, noLlm);
    const blended = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, {
      now: NOW,
      llm: async () => ({ roleFit: 0, seniority: 0, reasons: ['Agency PR role — matches the graduate target', 'Writing heavy'] }),
    });
    assert.equal(blended.llmUsed, true);
    assert.equal(blended.components.roleFit, Math.round(base.components.roleFit * 50) / 100);
    assert.equal(blended.components.seniority, Math.round(base.components.seniority * 50) / 100);
    assert.equal(blended.components.skills, base.components.skills);
    assert.ok(blended.total < base.total);
    assert.ok(blended.reasons.includes('Agency PR role, matches the graduate target'), blended.reasons.join(' | '));
  });

  it('accepts 0-100 judge scales', async () => {
    const s = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, { now: NOW, llm: async () => ({ roleFit: 100, seniority: 100, reasons: ['ok fit'] }) });
    assert.ok(s.components.roleFit <= 1 && s.components.roleFit > 0.9);
  });

  it('falls back to the heuristic when the judge throws or returns null', async () => {
    const base = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, noLlm);
    const thrown = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, { now: NOW, llm: async () => { throw new Error('boom'); } });
    const nulled = await scoreJob(PR_EXEC_DUBLIN, PROFILE, FACTS, { now: NOW, llm: async () => null });
    for (const s of [thrown, nulled]) {
      assert.equal(s.llmUsed, false);
      assert.equal(s.total, base.total);
    }
  });
});

// ───────────────────────────── Individual rules ─────────────────────────────

describe('hardFilters: individual rules', () => {
  const base = { company: 'Acme', location: 'Dublin', remote: false };

  it('rejects blacklisted companies regardless of suffix', () => {
    const r = hardFilters({ ...base, company: 'Shady Recruiters Limited', title: 'Marketing Executive', description: '' }, PROFILE);
    assert.ok(r.rejected.some((x) => /blacklist/.test(x)));
  });

  it('matches exclude words on word boundaries with a lead-generation exception', () => {
    const lead = hardFilters({ ...base, title: 'Lead Generation Executive', description: 'Digital marketing role.' }, PROFILE);
    assert.ok(!lead.rejected.some((x) => /Title contains/.test(x)), lead.rejected.join(' | '));
    const leadership = hardFilters({ ...base, title: 'Marketing Executive, Leadership Programme', description: '' }, PROFILE);
    assert.ok(!leadership.rejected.some((x) => /Title contains/.test(x)));
    const senior = hardFilters({ ...base, title: 'Graduate Senior PR Executive', description: '' }, PROFILE);
    assert.ok(senior.rejected.some((x) => /Title contains "senior"/.test(x)), 'graduate does not override an exclude word');
    const head = hardFilters({ ...base, title: 'Head of Content', description: '' }, PROFILE);
    assert.ok(head.rejected.some((x) => /head of/.test(x)));
  });

  it('rejects non-target families only when the title has no target word', () => {
    for (const title of ['Accountant', 'Staff Nurse', 'Sales Account Executive', 'Graduate Software Developer']) {
      const r = hardFilters({ ...base, title, description: '' }, PROFILE);
      assert.ok(r.rejected.some((x) => /Not a target role/.test(x)), `${title}: ${r.rejected.join(' | ')}`);
    }
    const mixed = hardFilters({ ...base, title: 'Sales and Marketing Executive', description: '' }, PROFILE);
    assert.ok(!mixed.rejected.some((x) => /Not a target role/.test(x)));
    const agency = hardFilters({ ...base, title: 'Account Executive', description: 'Join our PR agency writing press releases for clients.' }, PROFILE);
    assert.ok(!agency.rejected.some((x) => /Not a target role/.test(x)), 'PR agency account executives are target roles');
    const socialCare = hardFilters({ ...base, title: 'Social Care Worker', description: '' }, PROFILE);
    assert.ok(socialCare.rejected.some((x) => /Not a target role/.test(x)));
  });

  it('rejects locations outside his areas and remote roles in other countries', () => {
    const london = hardFilters({ ...base, location: 'London, UK', title: 'PR Executive', description: '' }, PROFILE);
    assert.ok(london.rejected.some((x) => /Location outside/.test(x)));
    const remoteUs = hardFilters({ ...base, location: 'Remote, US', remote: true, title: 'PR Executive', description: '' }, PROFILE);
    assert.ok(remoteUs.rejected.some((x) => /Location outside/.test(x)));
    const cork = hardFilters({ ...base, location: 'Cork', title: 'PR Executive', description: '' }, PROFILE);
    assert.equal(cork.pass, true, 'profile accepts anywhere in Ireland');
    const newry = classifyLocation({ ...base, location: 'Newry, Co. Down', title: 'x', description: '' }, PROFILE);
    assert.equal(newry.cls, 'secondary');
  });

  it('converts GBP at 1.17 and rejects salaries under the floor', () => {
    const belowGbp = hardFilters({ ...base, location: 'Belfast', title: 'PR Executive', description: '', salary: { min: 26_000, max: 30_000, currency: 'GBP' } }, PROFILE);
    assert.ok(belowGbp.rejected.some((x) => /Salary €35,100 is below your floor/.test(x)), belowGbp.rejected.join(' | '));
    const aboveGbp = hardFilters({ ...base, location: 'Belfast', title: 'PR Executive', description: '', salary: { min: 30_000, max: 32_000, currency: 'GBP' } }, PROFILE);
    assert.ok(!aboveGbp.rejected.some((x) => /Salary/.test(x)));
    const lowHourly = hardFilters({ ...base, title: 'Content Creator', description: 'Pay: €13.50 per hour.' }, PROFILE);
    assert.ok(lowHourly.rejected.some((x) => /Salary/.test(x)), lowHourly.rejected.join(' | '));
    const unknown = hardFilters({ ...base, title: 'Content Creator', description: 'Competitive salary.' }, PROFILE);
    assert.ok(!unknown.rejected.some((x) => /Salary/.test(x)));
  });

  it('rejects only mandatory years over the limit', () => {
    const mandatory = hardFilters({ ...base, title: 'PR Executive', description: 'Requirements:\n- At least five years’ experience in PR.' }, PROFILE);
    assert.ok(mandatory.rejected.some((x) => /5\+ years/.test(x)), mandatory.rejected.join(' | '));
    const optional = hardFilters({ ...base, title: 'PR Executive', description: 'Ideally 3 years experience in communications.' }, PROFILE);
    assert.ok(!optional.rejected.some((x) => /years/.test(x)), optional.rejected.join(' | '));
    assert.ok(optional.flags.some((f) => /Prefers 3\+ years/.test(f)));
    const atLimit = hardFilters({ ...base, title: 'PR Executive', description: '2 years of experience in marketing required.' }, PROFILE);
    assert.ok(atLimit.pass && atLimit.flags.some((f) => /2 years/.test(f)));
  });

  it('raises soft flags without rejecting', () => {
    const r = hardFilters(
      {
        ...base,
        title: 'Communications Intern',
        description: [
          'Irish language skills would be an advantage.',
          'A full clean driving licence is required.',
          'This is an unpaid internship.',
          'Candidates must be able to work in Ireland without sponsorship.',
        ].join('\n'),
      },
      PROFILE,
    );
    assert.equal(r.pass, true, r.rejected.join(' | '));
    const all = r.flags.join(' | ');
    assert.match(all, /Irish language listed as desirable/);
    assert.match(all, /Driving licence/);
    assert.match(all, /Unpaid/);
    assert.match(all, /No sponsorship/);
  });

  it('flags a desirable foreign language instead of rejecting', () => {
    const r = hardFilters({ ...base, title: 'Marketing Executive', description: 'French language skills would be a plus.' }, PROFILE);
    assert.equal(r.pass, true, r.rejected.join(' | '));
    assert.ok(r.flags.some((f) => /French listed as desirable/.test(f)));
    const verb = hardFilters({ ...base, title: 'Marketing Executive', description: 'Polish our brand copy until it shines.' }, PROFILE);
    assert.equal(verb.pass, true, '"polish" as a verb is not a language requirement');
  });
});

describe('helpers', () => {
  it('yearsRequired parses digits, words, plus signs and ignores company history', () => {
    assert.deepEqual(yearsRequired('3+ years of experience in PR'), { mandatory: 3, optional: null });
    assert.equal(yearsRequired('You will have a minimum of 4 years in a communications role.').mandatory, 4);
    assert.equal(yearsRequired('At least five years experience required.').mandatory, 5);
    assert.equal(yearsRequired('Founded over 20 years ago, we are a leading agency with experience across sectors.').mandatory, null);
    assert.equal(yearsRequired('Applicants must be 18 years old.').mandatory, null);
    assert.equal(yearsRequired('Desirable:\n- 4 years experience in an agency').optional, 4);
  });

  it('parses salary text in EUR, GBP, k and hourly forms', () => {
    assert.deepEqual(parseSalaryFromText('Salary: €35,000 - €40,000 per annum'), { min: 35_000, max: 40_000, currency: 'EUR', period: 'year', raw: '€35,000 - €40,000 per annum' });
    assert.equal(parseSalaryFromText('£28k-£32k')?.currency, 'GBP');
    assert.equal(parseSalaryFromText('£28k-£32k')?.max, 32_000);
    assert.equal(parseSalaryFromText('€20 per hour')?.min, 39_000);
    assert.equal(parseSalaryFromText('We raised €40m last year'), undefined);
    const conv = annualSalaryEur({ title: 'x', company: 'y', location: '', remote: false, description: '', salary: { min: 30_000, max: 30_000, currency: 'GBP' } });
    assert.equal(conv?.max, 35_100);
  });

  it('seniority: graduate/executive high, officer medium, manager low', () => {
    assert.equal(titleSeniority('Graduate Marketing Programme').score, 1);
    assert.ok(titleSeniority('Marketing Executive').score >= 0.9);
    assert.ok(titleSeniority('Communications Coordinator').score >= 0.9);
    assert.equal(titleSeniority('Communications Officer').score, 0.7);
    assert.ok(titleSeniority('Marketing Manager').score <= 0.3);
    assert.equal(titleSeniority('Head of PR').score, 0);
  });

  it('role fit: exact targets near 1, adjacent lower, unrelated low', () => {
    assert.ok(roleFitHeuristic('PR Executive', PROFILE).score >= 0.95);
    assert.ok(roleFitHeuristic('Public Relations Assistant', PROFILE).score >= 0.9);
    assert.ok(roleFitHeuristic('Brand Ambassador', PROFILE).score < roleFitHeuristic('Content Executive', PROFILE).score);
    assert.ok(roleFitHeuristic('Data Engineer', PROFILE).score < 0.2);
  });

  it('freshness decays linearly over 30 days', () => {
    assert.equal(freshnessComponent(daysAgo(0), NOW), 1);
    assert.equal(freshnessComponent(daysAgo(15), NOW), 0.5);
    assert.equal(freshnessComponent(daysAgo(45), NOW), 0);
    assert.equal(freshnessComponent(undefined, NOW), 0.5);
    assert.equal(freshnessComponent('not a date', NOW), 0.5);
  });
});
