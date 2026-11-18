// `pnpm seed`: inserts demo jobs across every status so the dashboard can be previewed without live
// data. `pnpm seed --clear` removes them. Re-running `pnpm seed` replaces the previous demo set.
//
// Demo rows are unmistakable: source 'manual', company 'Demo …', atsMeta.demo = true, URLs and
// emails on example.com (reserved, never a real employer). The worker pipeline skips any job with
// atsMeta.demo, and demo text is labelled as sample content, never claims about Kayzee.

import { createHash } from 'node:crypto';
import {
  addApplication, addArtifact, addInbox, addMessage, closeDb, db, logEvent, setStatus, tx, updateJob, upsertContact, upsertJob,
} from '@/lib/db';
import { loadFacts } from '@/lib/config';
import type { AnsweredQuestion, AtsKind, AtsReport, JobStatus, KeywordCoverage, NewJob, ScoreDetail } from '@/lib/types';

const DAY = 86_400_000;
const HOUR = 3_600_000;

interface DemoSpec {
  slug: string;
  company: string;
  title: string;
  location: string;
  country: NewJob['country'];
  ats: AtsKind;
  status: JobStatus;
  score?: number;
  ageDays: number;
  salary?: { min: number; max: number; currency: 'EUR' | 'GBP' };
  flags?: string[];
  rejected?: string[];
  needs?: string[];
}

const DEMOS: DemoSpec[] = [
  { slug: 'harbour-pr-exec', company: 'Demo Harbour Communications', title: 'PR & Communications Executive', location: 'Dublin, Ireland', country: 'IE', ats: 'greenhouse', status: 'ready', score: 91, ageDays: 1, salary: { min: 36000, max: 42000, currency: 'EUR' } },
  { slug: 'lough-content', company: 'Demo Lough Media', title: 'Content & Social Media Executive', location: 'Dundalk, Co. Louth', country: 'IE', ats: 'lever', status: 'ready', score: 84, ageDays: 1 },
  { slug: 'brightside-digital', company: 'Demo Brightside Digital', title: 'Digital Marketing Assistant', location: 'Remote (Ireland)', country: 'REMOTE', ats: 'ashby', status: 'discovered', ageDays: 0.2 },
  { slug: 'granite-senior', company: 'Demo Granite Group', title: 'Senior Head of Communications', location: 'Dublin, Ireland', country: 'IE', ats: 'workday', status: 'filtered_out', ageDays: 2, rejected: ['Title contains an excluded word: "senior"', 'Requires 10+ years of experience'] },
  { slug: 'quay-marketing', company: 'Demo Quay Retail', title: 'Marketing Executive', location: 'Drogheda, Co. Louth', country: 'IE', ats: 'smartrecruiters', status: 'scored', score: 66, ageDays: 1.5 },
  { slug: 'atlas-sales', company: 'Demo Atlas Logistics', title: 'Sales & Marketing Coordinator', location: 'Cork, Ireland', country: 'IE', ats: 'workable', status: 'skipped', score: 38, ageDays: 3 },
  { slug: 'fern-comms-officer', company: 'Demo Fern Housing Trust', title: 'Communications Officer', location: 'Dublin, Ireland', country: 'IE', ats: 'greenhouse', status: 'tailoring', score: 79, ageDays: 0.5 },
  { slug: 'kestrel-social', company: 'Demo Kestrel Studios', title: 'Social Media Coordinator', location: 'Belfast, Northern Ireland', country: 'GB-NIR', ats: 'lever', status: 'approved', score: 82, ageDays: 2, flags: ['Northern Ireland: UK right to work differs from Ireland'] },
  { slug: 'birch-content', company: 'Demo Birch Publishing', title: 'Content Executive', location: 'Galway, Ireland', country: 'IE', ats: 'ashby', status: 'applying', score: 77, ageDays: 2 },
  { slug: 'meridian-pr', company: 'Demo Meridian Events', title: 'PR Assistant', location: 'Dublin, Ireland', country: 'IE', ats: 'unknown', status: 'needs_you', score: 80, ageDays: 3, needs: ['CAPTCHA on the application form (demo)'] },
  { slug: 'oak-marketing', company: 'Demo Oak & Ivy', title: 'Marketing Assistant', location: 'Navan, Co. Meath', country: 'IE', ats: 'greenhouse', status: 'applied', score: 74, ageDays: 8 },
  { slug: 'pier-digital', company: 'Demo Pier Analytics', title: 'Digital Marketing Executive', location: 'Remote (Ireland)', country: 'REMOTE', ats: 'workday', status: 'failed', score: 72, ageDays: 5 },
  { slug: 'summit-comms', company: 'Demo Summit Charity', title: 'Communications Assistant', location: 'Dublin, Ireland', country: 'IE', ats: 'lever', status: 'replied', score: 81, ageDays: 10 },
  { slug: 'river-content', company: 'Demo River Foods', title: 'Content Creator', location: 'Dundalk, Co. Louth', country: 'IE', ats: 'greenhouse', status: 'interview', score: 88, ageDays: 12 },
  { slug: 'cobalt-pr', company: 'Demo Cobalt Agency', title: 'PR Executive', location: 'Dublin, Ireland', country: 'IE', ats: 'ashby', status: 'offer', score: 90, ageDays: 20, salary: { min: 38000, max: 40000, currency: 'EUR' } },
  { slug: 'willow-social', company: 'Demo Willow Fitness', title: 'Social Media Executive', location: 'Newry, Co. Down', country: 'GB-NIR', ats: 'workable', status: 'rejected', score: 70, ageDays: 15 },
  { slug: 'apex-marketing', company: 'Demo Apex Software', title: 'Marketing & Communications Executive', location: 'Dublin, Ireland', country: 'IE', ats: 'smartrecruiters', status: 'withdrawn', score: 69, ageDays: 6 },
];

const TAILOR_PATH: JobStatus[] = ['scored', 'tailoring', 'ready'];
const APPLY_PATH: JobStatus[] = [...TAILOR_PATH, 'approved', 'applying'];

/** The status events each demo job passes through, so its timeline looks like a real one. */
const PATHS: Record<JobStatus, JobStatus[]> = {
  discovered: [],
  filtered_out: ['filtered_out'],
  scored: ['scored'],
  skipped: ['skipped'],
  tailoring: ['scored', 'tailoring'],
  ready: TAILOR_PATH,
  approved: [...TAILOR_PATH, 'approved'],
  applying: APPLY_PATH,
  needs_you: [...APPLY_PATH, 'needs_you'],
  applied: [...APPLY_PATH, 'applied'],
  failed: [...APPLY_PATH, 'failed'],
  replied: [...APPLY_PATH, 'applied', 'replied'],
  interview: [...APPLY_PATH, 'applied', 'interview'],
  offer: [...APPLY_PATH, 'applied', 'interview', 'offer'],
  rejected: [...APPLY_PATH, 'applied', 'rejected'],
  withdrawn: [...TAILOR_PATH, 'withdrawn'],
};

const APPLIED_LIKE = new Set<JobStatus>(['applied', 'replied', 'interview', 'offer', 'rejected']);
const TAILORED = new Set<JobStatus>(['ready', 'approved', 'applying', 'needs_you', 'applied', 'failed', 'replied', 'interview', 'offer', 'rejected', 'withdrawn']);

const demoId = (slug: string) => createHash('sha1').update(`demo|${slug}`).digest('hex').slice(0, 16);

function description(d: DemoSpec): string {
  return [
    `[Demo listing] ${d.company} is hiring a ${d.title} in ${d.location}. This is sample text for previewing Pursuit.`,
    'Responsibilities: write press releases and social media content, support media relations, plan campaign content,',
    'coordinate events and track results. Requirements: a degree in communications, marketing or similar; strong',
    'copywriting; comfort with Instagram, LinkedIn and short-form video; good stakeholder engagement.',
  ].join(' ');
}

function factIdsFor(n: number, all: string[]): string[] {
  return all.length ? [all[n % all.length]] : [];
}

function coverageFor(d: DemoSpec, factIds: string[]): KeywordCoverage {
  const terms = ['press releases', 'social media content', 'media relations', 'copywriting', 'stakeholder engagement', 'campaign strategy'];
  const gaps = ['Google Analytics', 'Hootsuite'];
  return {
    keywords: [...terms, ...gaps].map((term, i) => ({ term, kind: i < terms.length ? 'skill' : 'tool', weight: 1 })),
    matched: terms.map((term, i) => ({ term, factIds: factIdsFor(i, factIds) })),
    gaps,
    pct: Math.min(95, (d.score ?? 60) - 4),
  };
}

function scoreDetailFor(d: DemoSpec, at: string): ScoreDetail {
  const s = (d.score ?? 0) / 100;
  return {
    total: d.score ?? 0,
    components: { skills: s, roleFit: Math.min(1, s + 0.05), seniority: 0.9, location: d.country === 'GB-NIR' ? 0.6 : 1, freshness: 0.8, salary: d.salary ? 1 : 0.5 },
    reasons: ['[Demo] Title matches a target role family', '[Demo] Most JD skills are backed by the fact bank'],
    flags: d.flags ?? [],
    llmUsed: false,
    scoredAt: at,
  };
}

function demoAnswers(): AnsweredQuestion[] {
  return [
    { id: 'demo_q1', label: 'Are you legally entitled to work in Ireland?', type: 'yesno', required: true, answer: null, source: 'none', needsHuman: true },
    { id: 'demo_q2', label: 'How did you hear about this role?', type: 'text', required: false, answer: 'Company careers page', source: 'bank', answerId: 'demo', needsHuman: false },
  ];
}

function demoAtsReport(score: number): AtsReport {
  return {
    score, pages: 1, textExtractable: true, badChars: [], sectionsFound: ['Education', 'Experience', 'Skills'], sectionsMissing: [],
    contactFound: true, keywordPct: score - 6, keywordsInText: ['press releases', 'copywriting'], keywordsMissing: [], problems: [],
  };
}

// ───────────────────────────── Clear ─────────────────────────────

function demoJobIds(): string[] {
  const rows = db()
    .prepare("SELECT id FROM jobs WHERE source = 'manual' AND company LIKE 'Demo %' AND json_extract(ats_meta, '$.demo') = 1")
    .all();
  return rows.map((r) => String(r.id));
}

function clearDemo(): number {
  const ids = demoJobIds();
  tx(() => {
    const database = db();
    for (const id of ids) {
      database.prepare('DELETE FROM messages WHERE job_id = ?').run(id);
      database.prepare('DELETE FROM contacts WHERE job_id = ?').run(id);
      database.prepare('DELETE FROM inbox WHERE job_id = ?').run(id);
      database.prepare('DELETE FROM events WHERE job_id = ?').run(id);
      database.prepare('DELETE FROM jobs WHERE id = ?').run(id); // artifacts + applications cascade
    }
    database.prepare("DELETE FROM inbox WHERE message_id LIKE 'demo-%@example.com'").run();
  });
  return ids.length;
}

// ───────────────────────────── Seed ─────────────────────────────

/** Rewrites a job's timestamps into the past so demo history doesn't count toward today's caps. */
function backdate(jobId: string, start: number): void {
  const database = db();
  const iso = (ms: number) => new Date(ms).toISOString();
  const events = database.prepare('SELECT id FROM events WHERE job_id = ? ORDER BY id').all(jobId);
  events.forEach((e, i) => database.prepare('UPDATE events SET ts = ? WHERE id = ?').run(iso(start + i * 6 * HOUR), Number(e.id)));
  const last = start + Math.max(0, events.length - 1) * 6 * HOUR;
  database.prepare('UPDATE jobs SET discovered_at = ?, updated_at = ? WHERE id = ?').run(iso(start), iso(last), jobId);
  database.prepare('UPDATE artifacts SET created_at = ? WHERE job_id = ?').run(iso(start + 12 * HOUR), jobId);
  database.prepare('UPDATE applications SET started_at = ?, submitted_at = CASE WHEN submitted_at IS NULL THEN NULL ELSE ? END WHERE job_id = ?')
    .run(iso(last - HOUR), iso(last - HOUR), jobId);
}

function seedOne(d: DemoSpec, factIds: string[]): void {
  const id = demoId(d.slug);
  const now = Date.now();
  const start = now - d.ageDays * DAY;
  const url = `https://example.com/demo/${d.slug}`;
  const scoredAt = new Date(start + HOUR).toISOString();

  upsertJob({
    id, source: 'manual', sourceId: `demo-${d.slug}`, company: d.company, title: d.title, location: d.location, country: d.country,
    remote: d.country === 'REMOTE', url, applyUrl: url, ats: d.ats, atsMeta: { demo: true }, description: description(d),
    salary: d.salary ? { ...d.salary, period: 'year', raw: `${d.salary.currency === 'EUR' ? '€' : '£'}${d.salary.min} - ${d.salary.max}` } : undefined,
    employmentType: 'full-time', postedAt: new Date(start - DAY).toISOString(),
  });

  const filters = { pass: !d.rejected?.length, rejected: d.rejected ?? [], flags: d.flags ?? [] };
  updateJob(id, {
    filters,
    ...(d.score !== undefined ? { score: d.score, scoreDetail: scoreDetailFor(d, scoredAt), keywords: coverageFor(d, factIds) } : {}),
    needs: d.needs,
    starred: d.status === 'interview',
  });

  for (const status of PATHS[d.status]) {
    const detail = status === 'skipped' ? { reason: `Score ${d.score} is below the auto-skip threshold`, demo: true }
      : status === 'filtered_out' ? { reasons: d.rejected ?? [], demo: true } : { demo: true };
    setStatus(id, status, detail);
  }

  if (TAILORED.has(d.status)) {
    addArtifact({ jobId: id, kind: 'cover_letter', content: '[Demo] Sample cover-letter text for previewing the approval queue. Real letters are written only from facts.json.\n\nKind Regards,\nKayzee', meta: { demo: true, guard: { ok: true, problems: [] }, slop: { ok: true, hits: [] } } });
    addArtifact({ jobId: id, kind: 'answers', content: JSON.stringify(demoAnswers()), meta: { demo: true, total: 2, unanswered: ['Are you legally entitled to work in Ireland?'] } });
    addArtifact({ jobId: id, kind: 'ats_report', content: JSON.stringify(demoAtsReport(Math.min(96, (d.score ?? 70) + 2))), meta: { demo: true } });
  }

  if (APPLIED_LIKE.has(d.status) || d.status === 'failed') {
    const submitted = d.status !== 'failed';
    addApplication({
      jobId: id, method: 'auto', status: submitted ? 'submitted' : 'failed',
      submittedAt: submitted ? new Date().toISOString() : undefined,
      confirmation: submitted ? '[demo] "Thank you for applying" page shown' : undefined,
      error: submitted ? undefined : '[demo] Workday account required',
    });
  }

  if (d.status === 'ready' && d.slug === 'harbour-pr-exec') {
    const contact = upsertContact({ jobId: id, company: d.company, name: 'Demo Recruiter', role: 'Talent Partner', email: 'talent@example.com', emailVerified: true, source: 'manual', confidence: 0.9 });
    addMessage({
      jobId: id, contactId: contact.id, direction: 'out', channel: 'email', kind: 'outreach', to: 'talent@example.com',
      subject: `${d.title} application`, body: '[Demo] Sample outreach draft. Drafts always wait for approval.', status: 'draft',
    });
  }

  const inboxFor: Partial<Record<JobStatus, { kind: 'interview' | 'rejection' | 'question'; subject: string; body: string }>> = {
    interview: { kind: 'interview', subject: `Interview: ${d.title}`, body: '[Demo] Thanks for applying. Could you share your availability for a 30-minute call next week?' },
    rejected: { kind: 'rejection', subject: `Your application to ${d.company}`, body: '[Demo] Unfortunately we have decided not to move forward with your application.' },
    replied: { kind: 'question', subject: `Quick question about your application`, body: '[Demo] Are you available to start within a month?' },
  };
  const mail = inboxFor[d.status];
  if (mail) {
    addInbox({
      messageId: `demo-${d.slug}@example.com`, fromAddress: 'careers@example.com', from: `${d.company} Careers <careers@example.com>`,
      subject: mail.subject, date: new Date(now - Math.max(1, d.ageDays - 3) * DAY).toISOString(), body: mail.body, jobId: id,
      kind: mail.kind, confidence: 0.9, summary: `[Demo] ${mail.kind}`,
    });
  }

  logEvent('seed.demo', { slug: d.slug }, id);
  backdate(id, start);
}

function main(): void {
  process.env.PURSUIT_LOG_SILENT ??= '1';
  const clearOnly = process.argv.includes('--clear');
  const removed = clearDemo();
  if (clearOnly) {
    console.log(`Removed ${removed} demo job${removed === 1 ? '' : 's'}.`);
    return;
  }
  let factIds: string[] = [];
  try {
    factIds = loadFacts().facts.map((f) => f.id);
  } catch {
    // Demo keyword coverage then has no fact citations; still previewable.
  }
  tx(() => {
    for (const d of DEMOS) seedOne(d, factIds);
  });
  const statuses = new Set(DEMOS.map((d) => d.status));
  console.log(`Seeded ${DEMOS.length} demo jobs across ${statuses.size} statuses${removed ? ` (replaced ${removed})` : ''}. Remove with: pnpm seed --clear`);
}

try {
  main();
} finally {
  closeDb();
}
