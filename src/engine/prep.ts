// Interview prep packs (markdown). Server-only.
//
// Sections: company brief (from the JD, plus the company homepage when one is linked and
// fetchable), likely questions, STAR answers built only from fact-bank entries, gaps to handle
// honestly, questions to ask, logistics. LLM when available (STAR answers are truth-guarded);
// otherwise a deterministic pack with JD-derived questions and STAR skeletons filled from facts.

import { z } from 'zod';
import { addArtifact } from '@/lib/db';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import { log } from '@/lib/log';
import type { Fact, FactBank, Job, KeywordCoverage, Profile } from '@/lib/types';
import { describeSlop, fixDashes, lintSlop, splitSentences } from './slop';
import {
  guardContextFor,
  defaultGuard,
  matchedTerms,
  pickStoryFacts,
  rankFactsForJob,
  runGuard,
  toFirstPerson,
  type GuardTextFn,
} from './tailor/letter';

const HOMEPAGE_TIMEOUT_MS = 10_000;
const HOMEPAGE_MAX_CHARS = 4000;
const ATS_HOSTS = /(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|myworkdayjobs\.com|workday\.com|linkedin\.com|indeed\.|glassdoor\.|irishjobs\.ie|jobs\.ie|adzuna\.|google\.|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com)/i;

// ───────────────────────────── Company context ─────────────────────────────

/** First non-ATS, non-social website mentioned in the JD (often the company's own site). */
export function findHomepageUrl(job: Pick<Job, 'description' | 'atsMeta'>): string | null {
  const meta = job.atsMeta?.companyUrl ?? job.atsMeta?.homepage ?? job.atsMeta?.website;
  if (typeof meta === 'string' && isPublicWebUrl(meta) && !ATS_HOSTS.test(meta)) return meta;
  const urls = job.description.match(/\bhttps?:\/\/[^\s)>\]"']+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s)>\]"']*/gi) ?? [];
  for (const raw of urls) {
    const url = raw.replace(/[.,;:]+$/, '');
    if (ATS_HOSTS.test(url) || /mailto:/i.test(url)) continue;
    try {
      const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      const home = `${parsed.protocol}//${parsed.host}/`;
      if (isPublicWebUrl(home)) return home;
    } catch {
      continue;
    }
  }
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 3;

/**
 * The URL comes from an untrusted JD, so only plain public http(s) hosts are fetched: no
 * localhost, private/link-local IPs, bare IPs, .local/.internal names or odd ports.
 */
export function isPublicWebUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '80' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[')) return false; // single-label or IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // any IPv4 literal
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet|test|invalid)$/.test(host)) return false;
  return true;
}

/** One polite GET of the homepage; null on any failure. The text is untrusted data. */
export async function fetchHomepageText(url: string, fetchImpl: FetchLike = globalThis.fetch): Promise<string | null> {
  try {
    let current = url;
    let res: Response | null = null;
    // Redirects are followed by hand so every hop gets the same public-host check.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isPublicWebUrl(current)) return null;
      res = await fetchImpl(current, {
        headers: { 'User-Agent': 'Pursuit/1.0 (personal job search)', Accept: 'text/html' },
        redirect: 'manual',
        signal: AbortSignal.timeout(HOMEPAGE_TIMEOUT_MS),
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, current).toString();
      res = null;
    }
    if (!res || !res.ok || !/text\/html/i.test(res.headers.get('content-type') ?? 'text/html')) return null;
    const text = htmlToText(await res.text());
    return text ? text.slice(0, HOMEPAGE_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

/** JD sentences that describe the company rather than the job. */
export function companySentences(job: Pick<Job, 'company' | 'description'>, max = 3): string[] {
  const company = job.company.toLowerCase();
  const sentences = splitSentences(job.description.replace(/\s+/g, ' ')).map((s) => s.trim());
  const about = sentences.filter((s) => {
    const l = s.toLowerCase();
    return (l.includes(company) || /\b(we are|we're|our mission|about us|founded|our team|our clients|our customers|we help|we work with)\b/.test(l)) && s.length >= 30 && s.length <= 400;
  });
  return about.slice(0, max);
}

const REQUIREMENT_RE = /\b(experience (in|with|of)|knowledge of|ability to|you will|you'll|responsib|skills? in|proficien|familiar(ity)? with|understanding of|strong|excellent)\b/i;

/** Requirement-style lines from the JD (bullets first), cleaned and capped. */
export function requirementLines(description: string, max = 8): string[] {
  const lines = description
    .split(/\n|(?<=[.;])\s+(?=[A-Z])/)
    .map((l) => l.replace(/^[\s•*·\-–—\d.)]+/, '').trim())
    .filter((l) => l.length >= 15 && l.length <= 220 && REQUIREMENT_RE.test(l));
  return [...new Set(lines)].slice(0, max);
}

// ───────────────────────────── Deterministic pack ─────────────────────────────

const STANDARD_QUESTIONS = [
  'Tell me about yourself.',
  'Tell me about a time you had to deliver something under a tight deadline.',
  'Tell me about a time something you worked on didn\'t go to plan. What did you do?',
  'How do you handle feedback on your work?',
  'Where do you want to be in two years?',
];

/** Ten likely questions: opener, why-company, why-role, then JD-specific and gap questions. */
export function likelyQuestions(job: Job, terms: string[], gaps: string[]): string[] {
  const qs: string[] = [
    'Tell me about yourself.',
    `Why do you want to work at ${job.company}?`,
    `What interests you about the ${job.title} role?`,
  ];
  for (const term of terms.slice(0, 3)) qs.push(`Tell me about your experience with ${term}.`);
  for (const line of requirementLines(job.description, 3)) {
    const duty = line.replace(/^(you will|you'll)\s+/i, '').replace(/[.;:]+$/, '');
    if (duty.length <= 120) qs.push(`The role involves: "${duty}". How would you approach that?`);
  }
  for (const gap of gaps.slice(0, 2)) qs.push(`This role asks for ${gap}. How would you get up to speed?`);
  for (const q of STANDARD_QUESTIONS) qs.push(q);
  return [...new Set(qs)].slice(0, 10);
}

function roleContext(fact: Fact, facts: FactBank): string {
  const role = facts.facts.find((f) => f.kind === 'role' && f.org && f.org === fact.org);
  if (role) return role.text;
  return fact.org ? `Work with ${fact.org}.` : '[fill in: where this happened and when]';
}

function resultFrom(fact: Fact): string {
  return fact.numbers?.length
    ? `${fact.text} (Quote only the numbers in this fact: ${fact.numbers.join(', ')}.)`
    : '[fill in: the outcome, only if it is true and you can back it up]';
}

export function starSkeleton(fact: Fact, facts: FactBank): string {
  const action = toFirstPerson(fact) ?? fact.text;
  return [
    `**${fact.org ?? 'Story'}** _(fact: ${fact.id})_`,
    `- **Situation:** ${roleContext(fact, facts)}`,
    '- **Task:** [fill in: what you were asked to do or set out to do]',
    `- **Action:** ${action}`,
    `- **Result:** ${resultFrom(fact)}`,
  ].join('\n');
}

function questionsToAsk(job: Job): string[] {
  return [
    `What would a great first three months look like for the ${job.title}?`,
    'How does the team measure whether its work is landing?',
    `Who would I work with most closely day to day, and how is the team set up at ${job.company}?`,
    'What is the biggest challenge the team is working on right now?',
    'What are the next steps in the process, and when should I expect to hear back?',
  ];
}

function salaryText(job: Job): string {
  const s = job.salary;
  if (!s || (s.min === undefined && s.max === undefined)) return s?.raw ?? 'Not stated in the posting';
  const cur = s.currency === 'GBP' ? '£' : s.currency === 'USD' ? '$' : '€';
  const fmt = (n: number) => `${cur}${n.toLocaleString('en-IE')}`;
  if (s.min !== undefined && s.max !== undefined && s.min !== s.max) return `${fmt(s.min)} to ${fmt(s.max)} a year`;
  return `${fmt((s.min ?? s.max)!)} a year`;
}

export interface PrepContext {
  homepageText: string | null;
  homepageUrl: string | null;
  interviewAt?: string;
  interviewNotes?: string;
}

function logistics(job: Job, ctx: PrepContext): string[] {
  const lines = [
    `**Role:** ${job.title} at ${job.company}`,
    `**Location:** ${job.location || 'Not stated'}${job.remote ? ' (remote option mentioned)' : ''}`,
    job.employmentType ? `**Type:** ${job.employmentType}` : '',
    `**Salary:** ${salaryText(job)}`,
    `**Posting:** ${job.url}`,
    ctx.homepageUrl ? `**Company site:** ${ctx.homepageUrl}` : '',
    ctx.interviewAt ? `**Interview:** ${ctx.interviewAt}` : '**Interview:** time not confirmed yet',
    ctx.interviewNotes ? `**Notes:** ${ctx.interviewNotes}` : '',
    '**Before the day:** re-read the tailored CV and cover letter you sent, check the route or video link, and have two questions ready.',
  ];
  return lines.filter(Boolean);
}

function briefSection(job: Job, ctx: PrepContext): string {
  const parts: string[] = [];
  const about = companySentences(job);
  parts.push(about.length ? about.map((s) => `- ${s}`).join('\n') : `- The posting doesn't say much about ${job.company} itself. Look at their website and recent social posts before the interview.`);
  if (ctx.homepageText) {
    const first = splitSentences(ctx.homepageText).filter((s) => s.length >= 30 && s.length <= 300).slice(0, 2);
    if (first.length) parts.push(`From their homepage:\n${first.map((s) => `- ${s.trim()}`).join('\n')}`);
  }
  const reqs = requirementLines(job.description, 6);
  if (reqs.length) parts.push(`What they're asking for:\n${reqs.map((r) => `- ${r}`).join('\n')}`);
  return parts.join('\n\n');
}

export function buildDeterministicPack(job: Job, facts: FactBank, profile: Profile, ctx: PrepContext, kw?: KeywordCoverage): string {
  const terms = matchedTerms(job, facts, kw);
  const gaps = (kw ?? job.keywords)?.gaps ?? [];
  const stories = pickStoryFacts(rankFactsForJob(job, facts, kw), 5);
  const sections = [
    `# Interview prep: ${job.title} at ${job.company}`,
    `_For ${profile.name.preferred}. Built from the job posting and your fact bank only. Anything in [brackets] is for you to fill in truthfully._`,
    `## Company brief\n\n${briefSection(job, ctx)}`,
    `## 10 likely questions\n\n${likelyQuestions(job, terms, gaps).map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    `## STAR answers from your facts\n\n${stories.length ? stories.map((f) => starSkeleton(f, facts)).join('\n\n') : '_No matching facts found. Add relevant facts to the fact bank first._'}`,
    terms.length ? `## Keywords you can honestly speak to\n\n${terms.slice(0, 10).map((t) => `- ${t}`).join('\n')}` : '',
    gaps.length
      ? `## Gaps: don't claim these\n\nThe posting mentions these and your fact bank doesn't back them. If they come up, say what you'd do to learn them and point to the closest real experience.\n\n${gaps.map((g) => `- ${g}`).join('\n')}`
      : '',
    `## 5 questions to ask them\n\n${questionsToAsk(job).map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    `## Logistics\n\n${logistics(job, ctx).map((l) => `- ${l}`).join('\n')}`,
  ];
  return fixDashes(sections.filter(Boolean).join('\n\n')) + '\n';
}

// ───────────────────────────── LLM pack ─────────────────────────────

const PrepSchema = z.object({
  companyBrief: z.array(z.string()).min(1).max(8),
  likelyQuestions: z.array(z.string()).min(5).max(12),
  star: z
    .array(
      z.object({
        question: z.string(),
        situation: z.string(),
        task: z.string(),
        action: z.string(),
        result: z.string(),
        factIds: z.array(z.string()).min(1),
      }),
    )
    .min(1)
    .max(6),
  questionsToAsk: z.array(z.string()).min(3).max(7),
});
type LlmPrep = z.infer<typeof PrepSchema>;

function prepSystem(profile: Profile): string {
  return [
    `You prepare interview prep notes for ${profile.name.full} (goes by ${profile.name.preferred}).`,
    '- companyBrief: 3 to 6 short bullet sentences about the company and the role, only from the posting and homepage text.',
    '- likelyQuestions: exactly 10 questions this interviewer is likely to ask, specific to the posting.',
    '- star: 3 to 5 STAR answers. Every situation/task/action/result must come from the cited FACTS. If a part is not in the facts, write "[fill in]" instead of inventing it. Never invent numbers.',
    '- questionsToAsk: exactly 5 thoughtful questions for him to ask them.',
    '- Never claim anything listed under GAPS. Never mention visa or sponsorship.',
    '- Plain language, no em dashes, no exclamation marks.',
  ].join('\n');
}

function renderLlmPack(job: Job, profile: Profile, out: LlmPrep, ctx: PrepContext, gaps: string[], dropped: string[]): string {
  const star = out.star
    .map((s) =>
      [
        `**${s.question}** _(facts: ${s.factIds.join(', ')})_`,
        `- **Situation:** ${s.situation}`,
        `- **Task:** ${s.task}`,
        `- **Action:** ${s.action}`,
        `- **Result:** ${s.result}`,
      ].join('\n'),
    )
    .join('\n\n');
  const sections = [
    `# Interview prep: ${job.title} at ${job.company}`,
    `_For ${profile.name.preferred}. STAR answers use only your fact bank; [fill in] marks parts for you to complete truthfully._`,
    `## Company brief\n\n${out.companyBrief.map((b) => `- ${b}`).join('\n')}`,
    `## 10 likely questions\n\n${out.likelyQuestions.slice(0, 10).map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    `## STAR answers from your facts\n\n${star || '_None passed the truth check. See the fact bank and build these yourself._'}`,
    dropped.length ? `> ${dropped.length} drafted STAR answer(s) were removed because they made claims the fact bank doesn't support.` : '',
    gaps.length ? `## Gaps: don't claim these\n\n${gaps.map((g) => `- ${g}`).join('\n')}` : '',
    `## 5 questions to ask them\n\n${out.questionsToAsk.slice(0, 5).map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
    `## Logistics\n\n${logistics(job, ctx).map((l) => `- ${l}`).join('\n')}`,
  ];
  return fixDashes(sections.filter(Boolean).join('\n\n')) + '\n';
}

async function llmPack(job: Job, facts: FactBank, profile: Profile, ctx: PrepContext, guard: GuardTextFn, kw?: KeywordCoverage): Promise<string | null> {
  const ranked = rankFactsForJob(job, facts, kw).slice(0, 14);
  const gctx = guardContextFor(job);
  const gaps = gctx.gaps ?? [];
  const user = [
    `ROLE: ${job.title} at ${job.company}${job.location ? ` (${job.location})` : ''}`,
    `GAPS (never claim): ${gaps.join(', ') || 'none'}`,
    'FACTS:',
    ...ranked.map((r) => `- [${r.fact.id}] ${r.fact.text}`),
    'JOB DESCRIPTION:',
    untrusted('job-description', job.description, 8000),
    ctx.homepageText ? `COMPANY HOMEPAGE TEXT:\n${untrusted('company-homepage', ctx.homepageText, HOMEPAGE_MAX_CHARS)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const out = await llmJSON({ purpose: 'prep.pack', system: prepSystem(profile), user, schema: PrepSchema, maxTokens: 2500, temperature: 0.3 });
  if (!out) return null;

  const known = new Set(facts.facts.map((f) => f.id));
  const dropped: string[] = [];
  const star = out.star.filter((s) => {
    const cited = s.factIds.filter((id) => known.has(id));
    const claims = [s.situation, s.task, s.action, s.result].join(' ').replace(/\[fill in[^\]]*\]/gi, '');
    const g = runGuard(guard, claims, facts, gctx);
    const ok = cited.length > 0 && g.ok;
    if (!ok) dropped.push(`${s.question}: ${g.problems.join('; ') || 'no valid fact ids'}`);
    return ok;
  });
  if (dropped.length) log.forJob('warn', job.id, 'prep', `dropped ${dropped.length} STAR answer(s) that failed the truth guard`, { dropped });
  const pack = renderLlmPack(job, profile, { ...out, star }, ctx, gaps, dropped);
  const slop = lintSlop(pack, { facts, allow: gctx.allowNames });
  if (!slop.ok) log.forJob('info', job.id, 'prep', 'prep pack has style hits', { hits: describeSlop(slop.hits).slice(0, 10) });
  return pack;
}

// ───────────────────────────── Public API ─────────────────────────────

export interface PrepOptions {
  coverage?: KeywordCoverage;
  /** Fetch the company homepage when the JD links one (default true). */
  fetchHomepage?: boolean;
  fetchImpl?: FetchLike;
  interviewAt?: string;
  interviewNotes?: string;
  /** Store a 'prep' artifact (default true). */
  save?: boolean;
  guard?: GuardTextFn;
}

/** Builds (and by default stores) the markdown prep pack for a job. */
export async function buildPrepPack(job: Job, facts: FactBank, profile: Profile, opts: PrepOptions = {}): Promise<string> {
  const homepageUrl = opts.fetchHomepage === false ? null : findHomepageUrl(job);
  const homepageText = homepageUrl ? await fetchHomepageText(homepageUrl, opts.fetchImpl) : null;
  const ctx: PrepContext = { homepageText, homepageUrl, interviewAt: opts.interviewAt, interviewNotes: opts.interviewNotes };

  let pack: string | null = null;
  let llmUsed = false;
  if (hasLLM()) {
    try {
      const guard = opts.guard ?? defaultGuard;
      pack = await llmPack(job, facts, profile, ctx, guard, opts.coverage);
      llmUsed = pack !== null;
    } catch (err) {
      log.forJob('warn', job.id, 'prep', 'LLM prep pack failed; using the deterministic pack', err);
    }
  }
  pack ??= buildDeterministicPack(job, facts, profile, ctx, opts.coverage);

  if (opts.save !== false) {
    try {
      addArtifact({ jobId: job.id, kind: 'prep', content: pack, meta: { llmUsed, homepageUrl, homepageFetched: Boolean(homepageText) } });
    } catch (err) {
      log.forJob('error', job.id, 'prep', 'could not store prep artifact', err);
    }
  }
  return pack;
}
