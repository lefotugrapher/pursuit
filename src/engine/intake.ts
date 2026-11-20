// "About me": a plain form Kayzee fills in at his own pace, plus evidence uploads (asked for 2026-11-20, after the
// scorer listed newsletters, paid media and AI work as gaps that he does in fact have).
//
// Truth rules are the Coach's: nothing reaches facts.json until he approves it, a suggested fact may only use numbers,
// months and years that are in his own words (or the uploaded document), and a suggested skill or tool must literally
// appear in what he wrote. Answers and extracted document text are sent to the free models to draft suggestions, so
// the page warns him not to put other people's personal details in.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadFacts, saveFacts } from '@/lib/config';
import { getJob, kvGet, kvSet, listEvents, listJobs, logEvent, setStatus, updateJob } from '@/lib/db';
import { hasLLM } from '@/lib/env';
import { llmJSON, untrusted } from '@/lib/llm';
import { EVIDENCE_DIR } from '@/lib/paths';
import type { Fact, FactBank } from '@/lib/types';
import { factIsGrounded, topGaps } from './coach';

// ───────────────────────────── Questions ─────────────────────────────

export interface IntakeQuestion {
  id: string;
  group: string;
  text: string;
  hint?: string;
  /** Set for questions generated from what job postings keep asking for. */
  gap?: { term: string; jobs: number };
}

const DETAIL = 'For each one say what you did, for whom, when (month and year), and any numbers.';

export const CORE_QUESTIONS: IntakeQuestion[] = [
  { id: 'ai-tools', group: 'AI and automation', text: 'Which AI tools do you use for real work?', hint: `Claude, Claude Code, ChatGPT, image or video generators, anything else. ${DETAIL}` },
  { id: 'ai-content', group: 'AI and automation', text: 'What AI-made or AI-assisted content have you produced?', hint: 'Video, images, avatars, copy. Name the project, where it was published and what happened.' },
  { id: 'ai-systems', group: 'AI and automation', text: 'What have you built that runs on its own?', hint: 'Bots, automations, websites, apps, scripts. What does each one do, and who uses it?' },
  { id: 'newsletters', group: 'Email and newsletters', text: 'Have you written or sent newsletters or email campaigns?', hint: 'Which tool, for which organisation, how many subscribers, how often, open or click rates if you know them.' },
  { id: 'paid-media', group: 'Paid media', text: 'Have you run paid ads?', hint: 'Meta, Google, TikTok, LinkedIn. For which business, what budget, over what period, and what result.' },
  { id: 'social-accounts', group: 'Content and social', text: 'Which social accounts or channels have you run?', hint: 'Followers before and after, the period, your best-performing post and its numbers.' },
  { id: 'video-photo', group: 'Content and social', text: 'What video and photo work have you done?', hint: 'What you shoot and edit, with what kit and software, for whom.' },
  { id: 'writing', group: 'Content and social', text: 'What have you written that was published?', hint: 'Web copy, blog posts, scripts, captions, articles. Say where each one appeared.' },
  { id: 'pr', group: 'PR and communications', text: 'What PR work have you done?', hint: 'Press releases, pitching journalists, coverage you got, statements, internal communications. Name the outlet when there was coverage.' },
  { id: 'web-seo', group: 'Web, SEO and analytics', text: 'Which websites have you built or managed, and what SEO work have you done?', hint: 'The site, the platform, rankings or traffic before and after.' },
  { id: 'reporting', group: 'Web, SEO and analytics', text: 'What reporting or analytics have you done?', hint: 'Which tools, what you measured, who read the report, what changed because of it.' },
  { id: 'events', group: 'Events and community', text: 'Which events or campaigns have you organised?', hint: 'Your exact part in it, attendance, budget, sponsors, outcome.' },
  { id: 'roles', group: 'Work history', text: 'List every job, role and business you have had.', hint: 'Exact title, organisation, start and end month, and what you were responsible for.' },
  { id: 'tools', group: 'Tools', text: 'Which tools can you use confidently without help?', hint: 'Design, video, ads, email, analytics, website builders, office software, AI, code. List them by name.' },
  { id: 'proud', group: 'Anything else', text: 'What are you proudest of that is not on your CV?', hint: DETAIL },
  { id: 'other', group: 'Anything else', text: 'Anything else an employer should know?' },
];

const gapId = (term: string) => `gap:${term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`;

/** The fixed questions plus one per skill that job postings keep asking for and his facts can't back. */
export function intakeQuestions(gapLimit = 12): IntakeQuestion[] {
  const gaps = topGaps(gapLimit).map((g): IntakeQuestion => ({
    id: gapId(g.term),
    group: 'Employers keep asking for',
    text: `"${g.term}"`,
    hint: `Asked for in ${g.jobs} job${g.jobs === 1 ? '' : 's'}. If you have done it: what, where, when, and any numbers. If not, leave it empty.`,
    gap: g,
  }));
  return [...CORE_QUESTIONS, ...gaps];
}

// ───────────────────────────── Stored state ─────────────────────────────

export type ProposalTarget = 'fact' | 'skill' | 'tool';

export interface IntakeProposal {
  key: string;
  target: ProposalTarget;
  text: string;
  kind: Fact['kind'];
  org?: string;
  title?: string;
  tags: string[];
  status: 'pending' | 'added' | 'dismissed';
}

export interface IntakeEntry {
  answer: string;
  link?: string;
  updatedAt: string;
  /** When suggestions were last drafted from this answer. */
  checkedAt?: string;
  proposals: IntakeProposal[];
}

export interface EvidenceDoc {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: string;
  /** Characters of text Pursuit could read from it (0 = stored as evidence only). */
  chars: number;
  checkedAt?: string;
  proposals: IntakeProposal[];
}

const ENTRIES_KEY = 'intake.entries';
const DOCS_KEY = 'intake.docs';

export function loadIntake(): Record<string, IntakeEntry> {
  return kvGet<Record<string, IntakeEntry>>(ENTRIES_KEY) ?? {};
}

export function loadEvidence(): EvidenceDoc[] {
  return kvGet<EvidenceDoc[]>(DOCS_KEY) ?? [];
}

const QUESTION_ID_RE = /^[a-z0-9:-]{1,80}$/;

export function saveIntakeAnswer(questionId: string, answer: string, link?: string, now: Date = new Date()): IntakeEntry {
  if (!QUESTION_ID_RE.test(questionId)) throw new Error('Unknown question.');
  const all = loadIntake();
  const text = String(answer ?? '').trim().slice(0, 8000);
  const url = String(link ?? '').trim().slice(0, 500);
  const prev = all[questionId];
  const entry: IntakeEntry = {
    answer: text,
    ...(url ? { link: url } : {}),
    updatedAt: now.toISOString(),
    ...(prev?.checkedAt && prev.answer === text ? { checkedAt: prev.checkedAt } : {}),
    proposals: prev?.proposals ?? [],
  };
  all[questionId] = entry;
  kvSet(ENTRIES_KEY, all);
  return entry;
}

// ───────────────────────────── Drafting suggestions ─────────────────────────────

const SuggestSchema = z.object({
  facts: z.array(z.object({
    text: z.string().min(8).max(400),
    kind: z.enum(['role', 'achievement', 'education', 'project', 'skill', 'tool', 'award', 'other']).catch('other'),
    org: z.string().max(120).optional().nullable(),
    title: z.string().max(120).optional().nullable(),
    tags: z.array(z.string().max(40)).max(10).catch([]),
  })).max(10).catch([]),
  skills: z.array(z.string().min(2).max(60)).max(15).catch([]),
  tools: z.array(z.string().min(2).max(60)).max(20).catch([]),
});

const SUGGEST_SYSTEM = [
  "You turn one person's own words into entries for his private fact bank, which is the only source his CVs and cover letters may draw on.",
  'Return JSON: {"facts": [{text, kind, org?, title?, tags[]}], "skills": string[], "tools": string[]}.',
  'facts: short, CV-ready statements of things he says he DID, each standing on its own. Keep his numbers, names and dates exactly. One fact per distinct piece of work.',
  'skills: short lower-case phrases for things he clearly says he does (for example "email newsletters", "paid social advertising").',
  'tools: product names he says he uses himself, spelled as he wrote them.',
  'Hard rules: use ONLY what the SOURCE states. Never invent, infer, round up or add a number, date, employer or result that is not there. If the source is vague, return fewer entries or none.',
  'Skip anything already listed under ALREADY KNOWN. No dashes as punctuation.',
].join('\n');

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim();

function words(s: string): Set<string> {
  return new Set(norm(s).split(' ').filter((w) => w.length > 2));
}

function similar(a: string, b: string): boolean {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return false;
  const shared = [...A].filter((x) => B.has(x)).length;
  return shared / new Set([...A, ...B]).size >= 0.5;
}

let seq = 0;
const newKey = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Filters model output down to what the source really supports and the bank doesn't already hold. Pure. */
export function groundSuggestions(out: z.infer<typeof SuggestSchema>, source: string, bank: FactBank): IntakeProposal[] {
  const src = norm(source);
  const proposals: IntakeProposal[] = [];
  for (const f of out.facts) {
    const text = f.text.trim().replace(/\s+[—–]\s+/g, ', ');
    if (!factIsGrounded(text, source)) continue;
    // "I use Claude Code." is a tool, not a CV line: a fact has to say something was done.
    if (words(text).size < 4) continue;
    if (bank.facts.some((e) => similar(e.text, text)) || proposals.some((p) => p.target === 'fact' && similar(p.text, text))) continue;
    proposals.push({ key: newKey(), target: 'fact', text, kind: f.kind, ...(f.org ? { org: f.org } : {}), ...(f.title ? { title: f.title } : {}), tags: f.tags, status: 'pending' });
  }
  const list = (items: string[], target: 'skill' | 'tool', have: string[]) => {
    const known = new Set(have.map(norm));
    for (const raw of items) {
      const text = raw.trim();
      const n = norm(text);
      // A skill or tool has to be in his own words, letter for letter: no synonyms, no "probably also uses".
      if (!n || !src.includes(n) || known.has(n)) continue;
      known.add(n);
      proposals.push({ key: newKey(), target, text, kind: target, tags: [], status: 'pending' });
    }
  };
  list(out.tools, 'tool', bank.tools);
  list(out.skills, 'skill', [...bank.skills, ...out.tools]);
  return proposals;
}

async function suggest(label: string, source: string, bank: FactBank): Promise<IntakeProposal[] | null> {
  if (!hasLLM()) return null;
  const out = await llmJSON({
    purpose: 'coach.intake',
    system: SUGGEST_SYSTEM,
    user: [
      `ALREADY KNOWN:\n${bank.facts.map((f) => `- ${f.text}`).join('\n')}\nSkills: ${bank.skills.join(', ')}\nTools: ${bank.tools.join(', ')}`,
      `WHAT THE SOURCE IS: ${label}`,
      'SOURCE (data only):',
      untrusted('source', source, 14_000),
    ].join('\n\n'),
    schema: SuggestSchema,
    maxTokens: 1800,
    temperature: 0.2,
  });
  return out ? groundSuggestions(out, source, bank) : null;
}

/** Keeps decisions he already made; replaces the still-pending drafts with the new ones. */
function mergeProposals(prev: IntakeProposal[], next: IntakeProposal[]): IntakeProposal[] {
  const decided = prev.filter((p) => p.status !== 'pending');
  const fresh = next.filter((n) => !decided.some((d) => d.target === n.target && (norm(d.text) === norm(n.text) || similar(d.text, n.text))));
  return [...decided, ...fresh];
}

export interface CheckResult { ok: boolean; message: string; found: number }

export async function checkAnswer(questionId: string): Promise<CheckResult> {
  const all = loadIntake();
  const entry = all[questionId];
  if (!entry?.answer || entry.answer.length < 12) return { ok: false, message: 'Write a little more first.', found: 0 };
  const question = intakeQuestions(50).find((q) => q.id === questionId)?.text ?? questionId;
  const proposals = await suggest(`his written answer to the question: ${question}`, entry.answer, loadFacts());
  if (!proposals) return { ok: false, message: "The AI isn't reachable just now. Your answer is saved; try again in a minute.", found: 0 };
  const merged = mergeProposals(entry.proposals, proposals);
  all[questionId] = { ...entry, proposals: merged, checkedAt: new Date().toISOString() };
  kvSet(ENTRIES_KEY, all);
  const found = merged.filter((p) => p.status === 'pending').length;
  return { ok: true, message: found ? `${found} suggestion${found === 1 ? '' : 's'} to review.` : 'Nothing new found in that answer. Add specifics: what, where, when, numbers.', found };
}

// ───────────────────────────── Evidence files ─────────────────────────────

export const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
export const EVIDENCE_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const TEXT_EXT = new Set(['.txt', '.md', '.csv']);
const DOC_ID_RE = /^[a-z0-9]{6,24}$/;

function ensureDir(): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

const filePath = (id: string, ext: string) => path.join(EVIDENCE_DIR, `${id}${ext}`);
const textPath = (id: string) => path.join(EVIDENCE_DIR, `${id}.extracted.txt`);

async function extractText(ext: string, bytes: Uint8Array): Promise<string> {
  try {
    if (TEXT_EXT.has(ext)) return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (ext === '.pdf') {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
      const { text } = await pdfText(await getDocumentProxy(new Uint8Array(bytes)), { mergePages: true });
      return Array.isArray(text) ? text.join('\n') : text;
    }
  } catch {
    // unreadable: keep the file as evidence only
  }
  return '';
}

export async function addEvidence(name: string, bytes: Uint8Array, now: Date = new Date()): Promise<{ ok: true; doc: EvidenceDoc } | { ok: false; message: string }> {
  const clean = path.basename(String(name ?? '')).replace(/[^\w.()\- ]+/g, '_').slice(0, 120) || 'file';
  const ext = path.extname(clean).toLowerCase();
  if (!EVIDENCE_TYPES[ext]) return { ok: false, message: `That file type isn't supported. Use ${Object.keys(EVIDENCE_TYPES).join(', ')}.` };
  if (!bytes.byteLength) return { ok: false, message: 'That file is empty.' };
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) return { ok: false, message: 'That file is over 20 MB.' };
  ensureDir();
  const id = `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(filePath(id, ext), bytes, { mode: 0o600 });
  const text = (await extractText(ext, bytes)).replace(/\u0000/g, '').trim().slice(0, 200_000);
  if (text) fs.writeFileSync(textPath(id), text, { mode: 0o600 });
  const doc: EvidenceDoc = { id, name: clean, size: bytes.byteLength, type: EVIDENCE_TYPES[ext], uploadedAt: now.toISOString(), chars: text.length, proposals: [] };
  kvSet(DOCS_KEY, [...loadEvidence(), doc]);
  logEvent('intake.evidence_added', { id, name: clean, size: bytes.byteLength, chars: text.length });
  return { ok: true, doc };
}

/** Where a stored evidence file lives, or null when the id is unknown (never built from user input alone). */
export function evidenceFile(id: string): { doc: EvidenceDoc; path: string } | null {
  if (!DOC_ID_RE.test(id)) return null;
  const doc = loadEvidence().find((d) => d.id === id);
  if (!doc) return null;
  const p = filePath(id, path.extname(doc.name).toLowerCase());
  return fs.existsSync(p) ? { doc, path: p } : null;
}

export function removeEvidence(id: string): { ok: boolean; message: string } {
  const found = evidenceFile(id);
  const docs = loadEvidence();
  if (!docs.some((d) => d.id === id)) return { ok: false, message: 'That file is no longer here.' };
  if (found) fs.rmSync(found.path, { force: true });
  if (DOC_ID_RE.test(id)) fs.rmSync(textPath(id), { force: true });
  kvSet(DOCS_KEY, docs.filter((d) => d.id !== id));
  logEvent('intake.evidence_removed', { id });
  return { ok: true, message: 'Removed. Facts you already added from it stay in your fact bank.' };
}

export async function checkEvidence(id: string): Promise<CheckResult> {
  const docs = loadEvidence();
  const doc = docs.find((d) => d.id === id);
  if (!doc || !DOC_ID_RE.test(id)) return { ok: false, message: 'That file is no longer here.', found: 0 };
  let text = '';
  try {
    text = fs.readFileSync(textPath(id), 'utf8');
  } catch {
    text = '';
  }
  if (text.length < 40) return { ok: false, message: "Pursuit can't read text from this file, so it is kept as evidence only. Type the key points into a question instead.", found: 0 };
  const proposals = await suggest(`a document he uploaded as evidence about himself, named "${doc.name}". Extract only what it states about him and his own work.`, text, loadFacts());
  if (!proposals) return { ok: false, message: "The AI isn't reachable just now. Try again in a minute.", found: 0 };
  const merged = mergeProposals(doc.proposals, proposals);
  kvSet(DOCS_KEY, docs.map((d) => (d.id === id ? { ...d, proposals: merged, checkedAt: new Date().toISOString() } : d)));
  const found = merged.filter((p) => p.status === 'pending').length;
  return { ok: true, message: found ? `${found} suggestion${found === 1 ? '' : 's'} to review.` : 'Nothing new found in that document.', found };
}

// ───────────────────────────── Approving ─────────────────────────────

export type Owner = { scope: 'answer'; id: string } | { scope: 'doc'; id: string };

function withProposal(owner: Owner, key: string, fn: (p: IntakeProposal) => { ok: boolean; message: string }): { ok: boolean; message: string } {
  if (owner.scope === 'answer') {
    const all = loadIntake();
    const p = all[owner.id]?.proposals.find((x) => x.key === key);
    if (!p) return { ok: false, message: 'That suggestion no longer exists.' };
    const r = fn(p);
    if (r.ok) kvSet(ENTRIES_KEY, all);
    return r;
  }
  const docs = loadEvidence();
  const p = docs.find((d) => d.id === owner.id)?.proposals.find((x) => x.key === key);
  if (!p) return { ok: false, message: 'That suggestion no longer exists.' };
  const r = fn(p);
  if (r.ok) kvSet(DOCS_KEY, docs);
  return r;
}

function slugId(text: string, existing: Set<string>): string {
  const base = `about-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-')}`;
  let id = base;
  for (let n = 2; existing.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Adds an approved suggestion to facts.json. A skill or tool he confirms also comes off the do-not-claim list. */
export function approveIntake(owner: Owner, key: string, editedText?: string): { ok: boolean; message: string } {
  return withProposal(owner, key, (p) => {
    if (p.status !== 'pending') return { ok: false, message: `Already ${p.status}.` };
    const text = (editedText ?? p.text).trim().slice(0, 400);
    if (text.length < (p.target === 'fact' ? 8 : 2)) return { ok: false, message: 'That is too short.' };
    const bank = loadFacts();
    const allowed = (list: string[]) => list.filter((x) => norm(x) !== norm(text));
    if (p.target === 'fact') {
      const id = slugId(text, new Set(bank.facts.map((f) => f.id)));
      const numbers = [...new Set((text.match(/\d[\d,.:%]*/g) ?? []).map((n) => n.replace(/[.,:]+$/, '')))];
      const fact: Fact = { id, kind: p.kind, text, tags: [...new Set([...p.tags, 'from-about-me'])], ...(p.org ? { org: p.org } : {}), ...(p.title ? { title: p.title } : {}), ...(numbers.length ? { numbers } : {}) };
      saveFacts({ ...bank, facts: [...bank.facts, fact] });
      // Same event the Coach logs, so its "re-tailor with the new facts" prompt counts these too.
      logEvent('coach.fact_added', { factId: id, text, via: 'about-me' });
    } else if (p.target === 'tool') {
      if (!bank.tools.some((t) => norm(t) === norm(text))) saveFacts({ ...bank, tools: [...bank.tools, text], doNotClaim: allowed(bank.doNotClaim) });
      logEvent('intake.tool_added', { tool: text });
    } else {
      if (!bank.skills.some((s) => norm(s) === norm(text))) saveFacts({ ...bank, skills: [...bank.skills, text.toLowerCase()], doNotClaim: allowed(bank.doNotClaim) });
      logEvent('intake.skill_added', { skill: text });
    }
    p.status = 'added';
    p.text = text;
    return { ok: true, message: p.target === 'fact' ? 'Added to your fact bank.' : `Added to your ${p.target}s.` };
  });
}

export function dismissIntake(owner: Owner, key: string): { ok: boolean; message: string } {
  return withProposal(owner, key, (p) => {
    p.status = 'dismissed';
    return { ok: true, message: 'Dismissed.' };
  });
}

// ───────────────────────────── Using the new facts ─────────────────────────────

const RECONSIDER_DAYS = 14;

/**
 * Sends open jobs back through scoring so they are judged against the current fact bank: everything still at
 * "scored", plus jobs the fit gate turned down in the last two weeks (a gap he has now filled may have been the
 * reason). Jobs already applied to, waiting on him, or skipped for age are left alone.
 */
export function rescoreWithNewFacts(now: Date = new Date()): { rescored: number; reconsidered: number } {
  let rescored = 0;
  let reconsidered = 0;
  for (const j of listJobs({ status: 'scored', limit: 2000 })) {
    updateJob(j.id, { keywords: undefined });
    setStatus(j.id, 'discovered', { reason: 'rescore', by: 'kayzee' });
    rescored++;
  }
  const since = now.getTime() - RECONSIDER_DAYS * 86_400_000;
  for (const j of listJobs({ status: 'skipped', orderBy: 'updatedAt', dir: 'desc', limit: 600 })) {
    if (Date.parse(j.updatedAt) < since) break;
    const last = listEvents({ jobId: j.id, type: 'status', limit: 1 })[0];
    const reason = String((last?.detail?.detail as Record<string, unknown> | undefined)?.reason ?? '');
    if (!/^(Fit check:|Role fit )/.test(reason)) continue;
    if (!getJob(j.id)) continue;
    updateJob(j.id, { keywords: undefined });
    setStatus(j.id, 'discovered', { reason: 'reconsider with new facts', by: 'kayzee' });
    reconsidered++;
  }
  logEvent('intake.rescore', { rescored, reconsidered });
  return { rescored, reconsidered };
}
