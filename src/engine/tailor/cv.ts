// Per-job CV tailoring (SPEC §5.4). Server-only.
//
// Pipeline: parse the master CV (never modified) → pick a summary variant by role family →
// order sections, entries and bullets by relevance to the JD keywords Kayzee can honestly claim →
// optionally let the LLM rephrase summary/bullets toward JD vocabulary using ONLY the cited facts →
// truth-guard everything (any failure falls back to the master wording) → render with the master's
// macros → compile with Tectonic, dropping the least relevant bullets until it fits on 2 pages →
// ATS check → write data/artifacts/<jobId>/Kshitiz_Mittal_CV.{tex,pdf} and register artifacts.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { addArtifact } from '@/lib/db';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import { log } from '@/lib/log';
import { ensureDir, jobArtifactDir, MASTER_CV_TEX } from '@/lib/paths';
import type { AtsReport, CvBullet, CvEntry, CvModel, CvSection, Fact, FactBank, Job, KeywordCoverage, Profile, TailoredCv } from '@/lib/types';
import { guardBullet, guardCv, guardText } from '../truthguard';
import { atsCheck, MAX_PAGES, pdfPageCount } from './ats';
import { cloneModel, parseMasterCv, renderCv } from './cvModel';
import { compileTex } from './latex';

/** Neutral upload filename (no company/role in it). */
export const CV_BASENAME = 'Kshitiz_Mittal_CV';

export type RoleFamily = 'pr_comms' | 'content_social' | 'digital_marketing' | 'events_community' | 'general';

export interface TailorOptions {
  /** Master CV source; defaults to reading MASTER_CV_TEX. */
  masterTex?: string;
  /** Output directory; defaults to data/artifacts/<jobId>. */
  outDir?: string;
  /** Defaults to hasLLM(). */
  useLLM?: boolean;
  /** Injectable LLM client (tests). */
  llm?: typeof llmJSON;
  /** Register cv_tex/cv_pdf/ats_report/compile_log artifacts (default true). */
  registerArtifacts?: boolean;
  /** Max recompiles spent trimming to two pages (default 3). */
  maxFitLoops?: number;
}

// ───────────────────────────── Role family ─────────────────────────────

const FAMILY_ORDER: Exclude<RoleFamily, 'general'>[] = ['pr_comms', 'content_social', 'digital_marketing', 'events_community'];

const FAMILY_SIGNALS: Record<Exclude<RoleFamily, 'general'>, string[]> = {
  pr_comms: [
    'public relations', 'pr', 'communications', 'comms', 'press', 'press release', 'media relations', 'corporate affairs',
    'public affairs', 'reputation', 'spokesperson', 'internal communications', 'stakeholder', 'press office', 'publicity',
  ],
  content_social: [
    'content', 'social media', 'social', 'copywriter', 'copywriting', 'video', 'videographer', 'tiktok', 'instagram', 'creator',
    'editorial', 'storytelling', 'community manager', 'photography', 'reels', 'short-form',
  ],
  digital_marketing: [
    'digital marketing', 'seo', 'sem', 'ppc', 'paid social', 'performance marketing', 'email marketing', 'crm', 'analytics',
    'growth', 'ecommerce', 'e-commerce', 'marketing executive', 'marketing assistant', 'google ads', 'lead generation',
  ],
  events_community: [
    'events', 'event', 'community', 'engagement', 'student', 'volunteer', 'outreach', 'partnerships', 'programme coordinator',
    'membership', 'campus', 'ambassador',
  ],
};

function countTerm(text: string, term: string, cap: number): number {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+')}(?![\\p{L}\\p{N}])`, 'giu');
  return Math.min(cap, (text.match(re) ?? []).length);
}

/** Deterministic: title hits weigh 3×, description hits 1× (each term capped at 3). Ties go to FAMILY_ORDER. */
export function roleFamily(job: Pick<Job, 'title' | 'description'> & { department?: string }): RoleFamily {
  const title = `${job.title} ${job.department ?? ''}`.toLowerCase();
  const desc = (job.description ?? '').toLowerCase().slice(0, 20_000);
  let best: RoleFamily = 'general';
  let bestScore = 0;
  for (const family of FAMILY_ORDER) {
    const score = FAMILY_SIGNALS[family].reduce((s, term) => s + 3 * countTerm(title, term, 3) + countTerm(desc, term, 3), 0);
    if (score > bestScore) {
      best = family;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : 'general';
}

export function isGraduateScheme(job: Pick<Job, 'title' | 'description'>): boolean {
  if (/\bgraduate\b|\bgrad\b/i.test(job.title)) return true;
  return /\bgraduate (scheme|programme|program)\b|\bgrad scheme\b/i.test((job.description ?? '').slice(0, 4000));
}

/** Summary variant for the family, falling back to 'general', then to the master summary. */
export function pickSummary(family: RoleFamily, facts: FactBank, masterSummary: string): { variant: string; text: string } {
  const own = facts.summaries[family]?.trim();
  if (own) return { variant: family, text: own };
  const general = facts.summaries.general?.trim();
  if (general) return { variant: 'general', text: general };
  return { variant: 'master', text: masterSummary };
}

// ───────────────────────────── Relevance ─────────────────────────────

const FAMILY_TAGS: Record<RoleFamily, string[]> = {
  pr_comms: ['pr', 'comms', 'press-releases', 'stakeholder', 'copywriting', 'campaign', 'presentation', 'advocacy', 'internal-comms', 'outreach', 'influencer', 'public-speaking'],
  content_social: ['content', 'social', 'video', 'photography', 'drone', 'editing', 'copywriting', 'design', 'influencer'],
  digital_marketing: ['seo', 'local-seo', 'digital-marketing', 'analytics', 'lead-generation', 'growth', 'metrics', 'automation', 'reporting', 'marketing', 'sales'],
  events_community: ['events', 'community', 'student-engagement', 'international', 'partnerships', 'outreach', 'representation', 'launch'],
  general: [],
};

interface Relevance {
  factWeight: Map<string, number>;
  terms: { term: string; weight: number; factIds: Set<string>; words: string[] }[];
  familyTags: Set<string>;
  factsById: Map<string, Fact>;
}

function buildRelevance(kw: KeywordCoverage, facts: FactBank, family: RoleFamily): Relevance {
  const weightOf = (term: string) => kw.keywords.find((k) => k.term.toLowerCase() === term.toLowerCase())?.weight ?? 1;
  const factWeight = new Map<string, number>();
  const terms = kw.matched.map((m) => {
    const weight = Math.max(0.1, weightOf(m.term));
    for (const id of m.factIds) factWeight.set(id, (factWeight.get(id) ?? 0) + weight);
    return { term: m.term, weight, factIds: new Set(m.factIds), words: m.term.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2) };
  });
  return { factWeight, terms, familyTags: new Set(FAMILY_TAGS[family]), factsById: new Map(facts.facts.map((f) => [f.id, f])) };
}

function mentions(text: string, term: string): boolean {
  return countTerm(text.toLowerCase(), term.toLowerCase(), 1) > 0;
}

/** Higher = more relevant to this JD. */
export function bulletScore(bullet: CvBullet, rel: Relevance): number {
  let score = 0;
  for (const id of bullet.factIds) score += rel.factWeight.get(id) ?? 0;
  for (const t of rel.terms) if (mentions(bullet.text, t.term)) score += 0.5 * t.weight;
  const tags = new Set(bullet.factIds.flatMap((id) => rel.factsById.get(id)?.tags ?? []));
  for (const tag of tags) {
    if (rel.familyTags.has(tag)) score += 0.3;
    const parts = tag.split('-');
    if (rel.terms.some((t) => t.words.some((w) => parts.includes(w) || w === tag))) score += 0.2;
  }
  return score;
}

function entryRelevance(entry: CvEntry, rel: Relevance): number {
  const top = entry.bullets.map((b) => bulletScore(b, rel)).sort((a, b) => b - a).slice(0, 2);
  return top.reduce((s, v) => s + v, 0) + (entry.factId ? (rel.factWeight.get(entry.factId) ?? 0) : 0);
}

type SectionRole = 'experience' | 'education' | 'projects' | 'skills' | 'interests' | 'other';

function sectionRole(section: CvSection): SectionRole {
  const t = section.title.toLowerCase();
  if (/education|qualification/.test(t)) return 'education';
  if (/project|campaign|freelance|portfolio/.test(t)) return 'projects';
  if (/experience|employment|career/.test(t)) return 'experience';
  if (/skill/.test(t)) return 'skills';
  if (/interest|hobb/.test(t)) return 'interests';
  return 'other';
}

/**
 * Within experience/projects: relevance (normalised to 0-3 within the section) plus a recency
 * bonus (0-2 by master position) so a current role isn't buried by a tangential older one.
 * Education keeps master order (degree first). Bullets: most relevant first, stable.
 */
function orderEntries(section: CvSection, rel: Relevance): CvSection {
  if (section.raw !== undefined) return section;
  const role = sectionRole(section);
  const entries = section.entries.map((entry) => ({
    ...entry,
    bullets: entry.bullets
      .map((b, i) => ({ b, i, s: bulletScore(b, rel) }))
      .sort((x, y) => y.s - x.s || x.i - y.i)
      .map((x) => x.b),
  }));
  if (role !== 'experience' && role !== 'projects') return { ...section, entries };
  const raw = entries.map((e) => entryRelevance(e, rel));
  const max = Math.max(...raw, 0);
  const n = entries.length;
  return {
    ...section,
    entries: entries
      .map((e, i) => ({ e, i, s: (max > 0 ? (raw[i] / max) * 3 : 0) + (2 * (n - i)) / n }))
      .sort((x, y) => y.s - x.s || x.i - y.i)
      .map((x) => x.e),
  };
}

function sectionStrength(section: CvSection, rel: Relevance): number {
  return section.entries.reduce((m, e) => Math.max(m, entryRelevance(e, rel)), 0);
}

/**
 * Section order: experience first (education first for graduate schemes); relevant projects go
 * above education (as in the Ryanair tailoring), otherwise after skills; interests always last.
 */
export function orderSections(sections: CvSection[], rel: Relevance, graduate: boolean): CvSection[] {
  const byRole = (r: SectionRole) => sections.filter((s) => sectionRole(s) === r);
  const experience = byRole('experience');
  const education = byRole('education');
  const projects = byRole('projects');
  const expStrength = Math.max(0, ...experience.map((s) => sectionStrength(s, rel)));
  const projStrength = Math.max(0, ...projects.map((s) => sectionStrength(s, rel)));
  const projectsStrong = projStrength > 0 && projStrength >= 0.5 * expStrength;

  const ordered: CvSection[] = [];
  if (graduate) ordered.push(...education, ...experience);
  else ordered.push(...experience);
  if (projectsStrong) ordered.push(...projects);
  if (!graduate) ordered.push(...education);
  ordered.push(...byRole('skills'));
  if (!projectsStrong) ordered.push(...projects);
  ordered.push(...byRole('other'), ...byRole('interests'));
  return ordered;
}

// ───────────────────────────── LLM rewrites ─────────────────────────────

const RewriteSchema = z.object({
  bullets: z.array(z.object({ id: z.string(), text: z.string().min(1).max(500), factIds: z.array(z.string()).default([]) })),
});
const SummarySchema = z.object({ summary: z.string().min(40).max(1200) });

const STYLE_RULES = [
  'Use ONLY what the given text and facts say. Never add numbers, employers, job titles, tools, skills, audiences or outcomes.',
  'You may use a listed JD term only where the facts genuinely support it. Never add a term just because the job ad uses it.',
  'Irish/British spelling. Plain, specific wording. No dashes as punctuation. No buzzwords (leverage, spearhead, dynamic, passionate, synergy, robust, seamless, elevate).',
  'Never mention visa, work permit or sponsorship status. Never use first person in CV text.',
];

/** Tidies model output: one line, no list marker, no dash punctuation, ends with a full stop. */
export function tidyBullet(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim().replace(/^[•\-*–—]\s*/, '');
  t = t.replace(/\s[–—-]{1,2}\s/g, ', ').replace(/[—]/g, ', ');
  if (t && !/[.!?]$/.test(t)) t += '.';
  return t;
}

/**
 * JD terms come from untrusted job ads. Only short, plain keyword-shaped terms are put in a prompt,
 * so a "keyword" can never smuggle instructions to the model.
 */
export function promptSafeTerms(terms: string[]): string[] {
  return [...new Set(terms.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length > 1 && t.length <= 48 && /^[\p{L}\p{N} &+/.'-]+$/u.test(t) && t.split(' ').length <= 5))];
}

interface RewriteCandidate { id: string; bullet: CvBullet; allowedTerms: string[] }

function rewriteCandidates(model: CvModel, rel: Relevance): RewriteCandidate[] {
  const out: RewriteCandidate[] = [];
  let n = 0;
  for (const section of model.sections) {
    for (const entry of section.entries) {
      for (const bullet of entry.bullets) {
        const id = `b${n++}`;
        if (!bullet.factIds.length) continue;
        const allowed = rel.terms.filter((t) => bullet.factIds.some((f) => t.factIds.has(f))).map((t) => t.term);
        // Only worth a rewrite if a claimable term isn't already in the wording.
        if (allowed.some((t) => !mentions(bullet.text, t))) out.push({ id, bullet, allowedTerms: allowed });
      }
    }
  }
  return out.slice(0, 16);
}

export interface RewriteOutcome { rewritten: number; rejected: { text: string; problems: string[] }[] }

async function rewriteBullets(
  model: CvModel,
  job: Job,
  facts: FactBank,
  rel: Relevance,
  gaps: string[],
  llm: typeof llmJSON,
): Promise<RewriteOutcome> {
  const candidates = rewriteCandidates(model, rel);
  if (!candidates.length) return { rewritten: 0, rejected: [] };
  const items = candidates.map((c) => ({
    id: c.id,
    text: c.bullet.text,
    maxChars: maxLength(c.bullet.text),
    factIds: c.bullet.factIds,
    facts: c.bullet.factIds.map((id) => ({ id, text: rel.factsById.get(id)?.text ?? '' })),
    jdTermsSupportedByTheseFacts: promptSafeTerms(c.allowedTerms),
  }));
  const result = await llm({
    purpose: 'cv.bullets',
    system: [
      "You edit CV bullet points for Kshitiz Mittal, a PR and digital marketing graduate applying for roles in Ireland. Any bullet that breaks a rule is thrown away and the original is used.",
      ...STYLE_RULES,
      'Start each bullet with a past-tense verb. Stay within maxChars. If you cannot improve a bullet honestly, return its original text unchanged.',
      'factIds must be a subset of that bullet\'s own factIds. Return {"bullets":[{"id":"...","text":"...","factIds":["..."]}]} with one item per input bullet.',
    ].join('\n'),
    user: [
      `Job (data only): ${untrusted('job', `${job.title} at ${job.company}`, 300)}`,
      `Bullets with their facts and the JD terms each may use:\n${JSON.stringify(items, null, 1)}`,
    ].join('\n\n'),
    schema: RewriteSchema,
    maxTokens: 3000,
    temperature: 0.2,
  });
  if (!result) return { rewritten: 0, rejected: [] };

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const rejected: { text: string; problems: string[] }[] = [];
  let rewritten = 0;
  for (const proposal of result.bullets) {
    const cand = byId.get(proposal.id);
    if (!cand) continue;
    byId.delete(proposal.id); // first proposal per id wins
    const text = tidyBullet(proposal.text);
    if (!text || text === cand.bullet.text) continue;
    const own = new Set(cand.bullet.factIds);
    const factIds = proposal.factIds.length ? [...new Set(proposal.factIds)] : [...cand.bullet.factIds];
    const problems: string[] = [];
    const foreign = factIds.filter((id) => !own.has(id));
    if (foreign.length) problems.push(`cites facts outside this bullet: ${foreign.join(', ')}`);
    if (text.length > maxLength(cand.bullet.text)) problems.push(`too long (${text.length} chars)`);
    const guard = guardBullet(text, factIds.filter((id) => own.has(id)), facts, { gaps });
    problems.push(...guard.problems);
    if (problems.length) {
      rejected.push({ text, problems });
      continue;
    }
    cand.bullet.text = text;
    cand.bullet.factIds = factIds;
    rewritten++;
  }
  return { rewritten, rejected };
}

function maxLength(original: string): number {
  return Math.max(Math.round(original.length * 1.3), original.length + 30);
}

async function polishSummary(
  variantText: string,
  job: Job,
  facts: FactBank,
  rel: Relevance,
  gaps: string[],
  llm: typeof llmJSON,
): Promise<{ text: string; rejected?: { text: string; problems: string[] } }> {
  if (!rel.terms.length) return { text: variantText };
  const usedFacts = facts.facts.filter((f) => rel.terms.some((t) => t.factIds.has(f.id))).slice(0, 25);
  const result = await llm({
    purpose: 'cv.summary',
    system: [
      'You lightly edit the summary paragraph of a CV for Kshitiz Mittal. Keep every claim traceable to the summary or the listed facts; the edited summary is checked against them and discarded on any mismatch.',
      ...STYLE_RULES,
      `Keep it under ${Math.round(variantText.length * 1.15)} characters, three or four sentences. Return {"summary":"..."}.`,
    ].join('\n'),
    user: [
      `Job (data only): ${untrusted('job', `${job.title} at ${job.company}`, 300)}`,
      `Current summary:\n${variantText}`,
      `Facts you may draw on:\n${usedFacts.map((f) => `- ${f.text}`).join('\n')}`,
      `JD terms the facts support (use only where natural):\n${promptSafeTerms(rel.terms.map((t) => t.term)).join(', ')}`,
    ].join('\n\n'),
    schema: SummarySchema,
    maxTokens: 800,
    temperature: 0.3,
  });
  if (!result) return { text: variantText };
  const text = result.summary.replace(/\s+/g, ' ').trim().replace(/\s[–—-]{1,2}\s/g, ', ');
  const problems = [...guardText(text, facts, { gaps }).problems];
  if (text.length > variantText.length * 1.25) problems.push(`too long (${text.length} chars)`);
  if (problems.length) return { text: variantText, rejected: { text, problems } };
  return { text };
}

// ───────────────────────────── Fitting to two pages ─────────────────────────────

/** Removes the `count` least relevant bullets (never an entry's last bullet). Returns how many went. */
export function dropLeastRelevant(model: CvModel, rel: Relevance, count: number): number {
  let dropped = 0;
  for (let k = 0; k < count; k++) {
    let worst: { entry: CvEntry; idx: number; score: number; order: number } | null = null;
    let order = 0;
    for (const section of model.sections) {
      for (const entry of section.entries) {
        if (entry.bullets.length < 2) {
          order += entry.bullets.length;
          continue;
        }
        entry.bullets.forEach((b, idx) => {
          const score = bulletScore(b, rel);
          // Ties drop the later bullet (older, lower in the page).
          if (!worst || score < worst.score || (score === worst.score && order > worst.order)) worst = { entry, idx, score, order };
          order++;
        });
      }
    }
    if (!worst) break;
    const w: { entry: CvEntry; idx: number } = worst;
    w.entry.bullets.splice(w.idx, 1);
    dropped++;
  }
  return dropped;
}

// ───────────────────────────── Truth sanitising ─────────────────────────────

/**
 * Final gate before rendering: any bullet that fails the guard is replaced by its master wording,
 * or removed if even that fails (e.g. facts.json no longer backs it). The summary falls back to the
 * variant, then the master summary.
 */
function sanitize(model: CvModel, master: CvModel, facts: FactBank, gaps: string[], fallbackSummary: string): { ok: boolean; removed: { text: string; problems: string[] }[] } {
  const removed: { text: string; problems: string[] }[] = [];
  const masterByFacts = new Map<string, string>();
  for (const s of master.sections) for (const e of s.entries) for (const b of e.bullets) if (b.factIds.length) masterByFacts.set(b.factIds.join('|'), b.text);

  for (const section of model.sections) {
    for (const entry of section.entries) {
      entry.bullets = entry.bullets.flatMap((b) => {
        const g = guardBullet(b.text, b.factIds, facts, { gaps });
        if (g.ok) return [b];
        const original = masterByFacts.get(b.factIds.join('|'));
        if (original && original !== b.text && guardBullet(original, b.factIds, facts, { gaps }).ok) {
          removed.push({ text: b.text, problems: g.problems });
          return [{ text: original, factIds: b.factIds }];
        }
        removed.push({ text: b.text, problems: [...g.problems, 'removed from the CV'] });
        return [];
      });
    }
  }
  let summaryOk = guardText(model.summary, facts, { gaps }).ok;
  if (!summaryOk) {
    for (const candidate of [fallbackSummary, master.summary]) {
      if (candidate && guardText(candidate, facts, { gaps }).ok) {
        removed.push({ text: model.summary, problems: guardText(model.summary, facts, { gaps }).problems });
        model.summary = candidate;
        summaryOk = true;
        break;
      }
    }
  }
  return { ok: summaryOk && guardCv(model, facts, gaps).ok, removed };
}

// ───────────────────────────── Main ─────────────────────────────

function readMaster(opts: TailorOptions): string {
  if (opts.masterTex !== undefined) return opts.masterTex;
  try {
    return fs.readFileSync(MASTER_CV_TEX, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read master CV at ${MASTER_CV_TEX}: ${(err as Error).message}`);
  }
}

interface CompileOutcome { pdfPath: string | null; pages: number; log: string; loops: number; dropped: number }

async function compileWithinPages(model: CvModel, texPath: string, outDir: string, rel: Relevance, maxLoops: number): Promise<CompileOutcome> {
  const logs: string[] = [];
  let dropped = 0;
  for (let loop = 0; ; loop++) {
    fs.writeFileSync(texPath, renderCv(model), 'utf8');
    const res = await compileTex(texPath, outDir);
    logs.push(`── compile ${loop + 1} (${res.durationMs} ms, ${res.ok ? 'ok' : 'FAILED'})\n${res.log}`);
    if (!res.ok || !res.pdfPath) return { pdfPath: null, pages: 0, log: logs.join('\n\n'), loops: loop + 1, dropped };
    let pages = 0;
    try {
      pages = await pdfPageCount(res.pdfPath);
    } catch (err) {
      logs.push(`page count failed: ${(err as Error).message}`);
    }
    if (pages <= MAX_PAGES || loop >= maxLoops) {
      if (pages > MAX_PAGES) logs.push(`Still ${pages} pages after ${loop} trims.`);
      return { pdfPath: res.pdfPath, pages, log: logs.join('\n\n'), loops: loop + 1, dropped };
    }
    const n = dropLeastRelevant(model, rel, 2);
    dropped += n;
    logs.push(`${pages} pages: dropped ${n} least relevant bullet(s).`);
    if (!n) return { pdfPath: res.pdfPath, pages, log: logs.join('\n\n'), loops: loop + 1, dropped };
  }
}

function register(job: Job, entries: Parameters<typeof addArtifact>[0][]): void {
  for (const a of entries) {
    try {
      addArtifact(a);
    } catch (err) {
      log.forJob('warn', job.id, 'tailor.cv', `could not register ${a.kind} artifact`, { error: (err as Error).message });
    }
  }
}

/**
 * Builds the truthful tailored CV for `job`. Never modifies the master. Throws only if the master
 * can't be read or parsed; compile/ATS failures are reported in the result (pdfPath null, ats null).
 */
export async function tailorCv(job: Job, facts: FactBank, profile: Profile, kw: KeywordCoverage, opts: TailorOptions = {}): Promise<TailoredCv> {
  const master = parseMasterCv(readMaster(opts), facts);
  if (profile.email && !master.header.includes(profile.email)) {
    log.forJob('warn', job.id, 'tailor.cv', 'master CV header does not contain the profile email', { email: profile.email });
  }
  const gaps = kw.gaps ?? [];
  const family = roleFamily(job);
  const rel = buildRelevance(kw, facts, family);
  const summary = pickSummary(family, facts, master.summary);
  const useLLM = opts.useLLM ?? hasLLM();
  const llm = opts.llm ?? llmJSON;
  const rejectedBullets: { text: string; problems: string[] }[] = [];

  const model = cloneModel(master);
  model.summary = summary.text;
  model.sections = orderSections(model.sections.map((s) => orderEntries(s, rel)), rel, isGraduateScheme(job));

  let rewritten = 0;
  let summaryPolished = false;
  if (useLLM) {
    try {
      const polished = await polishSummary(summary.text, job, facts, rel, gaps, llm);
      if (polished.rejected) rejectedBullets.push({ text: polished.rejected.text, problems: polished.rejected.problems.map((p) => `summary: ${p}`) });
      summaryPolished = polished.text !== summary.text;
      model.summary = polished.text;
      const outcome = await rewriteBullets(model, job, facts, rel, gaps, llm);
      rewritten = outcome.rewritten;
      rejectedBullets.push(...outcome.rejected);
    } catch (err) {
      log.forJob('warn', job.id, 'tailor.cv', 'LLM rewrite failed; using master wording', { error: (err as Error).message });
    }
  }

  const safety = sanitize(model, master, facts, gaps, summary.text);
  rejectedBullets.push(...safety.removed);

  const outDir = ensureDir(opts.outDir ?? jobArtifactDir(job.id));
  const texPath = path.join(outDir, `${CV_BASENAME}.tex`);
  const maxLoops = opts.maxFitLoops ?? 3;
  let compiled = await compileWithinPages(model, texPath, outDir, rel, maxLoops);
  let finalModel = model;

  if (!compiled.pdfPath && (rewritten > 0 || summaryPolished)) {
    // An LLM edit may have produced something TeX dislikes: retry with master wording, same order.
    const plain = cloneModel(master);
    plain.summary = summary.text;
    plain.sections = orderSections(plain.sections.map((s) => orderEntries(s, rel)), rel, isGraduateScheme(job));
    const retry = await compileWithinPages(plain, texPath, outDir, rel, maxLoops);
    retry.log = `${compiled.log}\n\n── retry with master wording\n${retry.log}`;
    compiled = retry;
    finalModel = plain;
  }

  let ats: AtsReport | null = null;
  if (compiled.pdfPath) {
    try {
      ats = await atsCheck(compiled.pdfPath, kw);
    } catch (err) {
      log.forJob('warn', job.id, 'tailor.cv', 'ATS check failed', { error: (err as Error).message });
    }
  }

  const guard = { ok: safety.ok && guardCv(finalModel, facts, gaps).ok, rejectedBullets };
  const meta = { summaryVariant: summary.variant, family, llmUsed: useLLM, bulletsRewritten: rewritten, summaryPolished, bulletsDropped: compiled.dropped, rejected: rejectedBullets.length };

  if (opts.registerArtifacts !== false) {
    register(job, [
      { jobId: job.id, kind: 'cv_tex', path: texPath, meta },
      // guard goes on the PDF record: autopilot refuses a CV without guard.ok === true (Nov 2026: it was left off,
      // so every CV written here blocked hands-free with "CV truth guard is not clean").
      ...(compiled.pdfPath ? [{ jobId: job.id, kind: 'cv_pdf' as const, path: compiled.pdfPath, meta: { ...meta, pages: compiled.pages, atsScore: ats?.score ?? null, guard } }] : []),
      ...(ats ? [{ jobId: job.id, kind: 'ats_report' as const, content: JSON.stringify(ats, null, 2), meta: { score: ats.score, pages: ats.pages } }] : []),
      { jobId: job.id, kind: 'compile_log', content: compiled.log, meta: { ok: Boolean(compiled.pdfPath), loops: compiled.loops } },
    ]);
  }

  log.forJob(compiled.pdfPath ? 'info' : 'error', job.id, 'tailor.cv', compiled.pdfPath ? 'CV tailored' : 'CV compile failed', {
    ...meta,
    pages: compiled.pages,
    atsScore: ats?.score,
    guardOk: guard.ok,
  });

  return {
    model: finalModel,
    texPath,
    pdfPath: compiled.pdfPath,
    summaryVariant: summary.variant,
    guard,
    ats,
    compileLog: compiled.log,
  };
}
