// Server-only data helpers for dashboard pages and server actions. Composes src/lib/db reads into
// view models. Import only from server components, route handlers and 'use server' files.

import fs from 'node:fs';
import { connection } from 'next/server';
import {
  countByStatus, countJobs, funnelStats, getJob, getSettings, kvGet, latestArtifact, listApplications, listArtifacts,
  listContacts, listEvents, listInbox, listJobs, listMessages, listRuns,
} from '@/lib/db';
import { loadProfile } from '@/lib/config';
import { hasLLM, hasMail } from '@/lib/env';
import { ARTIFACTS_DIR, ROOT, SCREENSHOTS_DIR } from '@/lib/paths';
import { addDays, dublinClock, dublinDate, dublinParts, isQuietHours } from '@/lib/time';
import { DEFAULT_SETTINGS, JOB_STATUSES, type Application, type Artifact, type ArtifactKind, type Contact, type FunnelStats, type Job, type JobStatus, type Message, type RunRow, type Settings } from '@/lib/types';
import { resolveServablePath } from '@/app/api/_lib/artifact';
import { buildStatusPayload, HEARTBEAT_KEY, toStatusRun, workerHealth, type StatusPayload, type StatusRun, type WorkerHealth } from '@/app/api/_lib/status';
import { describeEvent, isFeedWorthy, type EventView } from '@/components/job/events';
import { parseJobsFilter, toJobQuery, PAGE_SIZE, type JobsFilter, type SearchParams } from '@/components/job/filters';
import {
  approvalGate, jobFlags, letterFindings, parseAnswers, parseAtsReport,
  type DraftView, type LetterView, type QueueItem,
} from '@/components/queue/model';

const MAX_ARTIFACT_TEXT = 1_000_000;

// ───────────────────────────── Artifacts ─────────────────────────────

/** Text of an artifact: inline content, else its file when it lives inside data/. */
export function readArtifactText(a: Artifact | undefined): string | null {
  if (!a) return null;
  if (typeof a.content === 'string') return a.content;
  const file = resolveServablePath(a.path, [ARTIFACTS_DIR, SCREENSHOTS_DIR], { base: ROOT });
  if (!file) return null;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_ARTIFACT_TEXT) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** True when the artifact's file exists inside data/ (servable by /api/artifact). */
export function artifactFileExists(a: Artifact | undefined): boolean {
  return Boolean(a?.path && resolveServablePath(a.path, [ARTIFACTS_DIR, SCREENSHOTS_DIR], { base: ROOT }));
}

function toDraftView(m: Message): DraftView {
  return {
    id: m.id, channel: m.channel, kind: m.kind, to: m.to, subject: m.subject, body: m.body,
    guardProblems: m.guardProblems, slopHits: m.slopHits, status: m.status,
  };
}

function letterView(a: Artifact | undefined): LetterView | null {
  if (!a) return null;
  const text = readArtifactText(a);
  if (text === null) return null;
  return { artifactId: a.id, version: a.version, text, ...letterFindings(a.meta) };
}

/** Everything the approval card needs for one job. */
export function buildQueueItem(job: Job): QueueItem {
  const cv = latestArtifact(job.id, 'cv_pdf');
  const hasCv = artifactFileExists(cv);
  const answersArtifact = latestArtifact(job.id, 'answers');
  const answers = parseAnswers(readArtifactText(answersArtifact)).list;
  const atsArtifact = latestArtifact(job.id, 'ats_report');
  const ats = parseAtsReport(readArtifactText(atsArtifact)) ?? parseAtsReport(JSON.stringify(cv?.meta?.ats ?? null));
  return {
    job,
    cvPdfId: hasCv && cv ? cv.id : null,
    cvVersion: cv?.version ?? null,
    compileLogId: latestArtifact(job.id, 'compile_log')?.id ?? null,
    letter: letterView(latestArtifact(job.id, 'cover_letter')),
    answers,
    answersArtifactId: answersArtifact?.id ?? null,
    ats,
    drafts: listMessages({ jobId: job.id, status: 'draft', limit: 20 }).map(toDraftView),
    flags: jobFlags(job),
    gate: approvalGate({ status: job.status, ats: job.ats, answers, hasCv }),
  };
}

// ───────────────────────────── Shell ─────────────────────────────

export interface ShellData {
  status: StatusPayload;
  inboxUnhandled: number;
  draftsPending: number;
  dbError: string | null;
}

const EMPTY_COUNTS = (): Record<JobStatus, number> => Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;

function currentStatus(): StatusPayload {
  return buildStatusPayload({
    counts: countByStatus(),
    settings: getSettings(),
    heartbeat: kvGet(HEARTBEAT_KEY),
    runs: listRuns(6),
    hasLLM: hasLLM(),
    hasMail: hasMail(),
  });
}

/** Sidebar data. Never throws: a broken DB still renders the shell with an error notice. */
export async function getShellData(): Promise<ShellData> {
  await connection();
  try {
    return {
      status: currentStatus(),
      inboxUnhandled: listInbox({ handled: false, limit: 500 }).filter((i) => i.kind && i.kind !== 'job_alert' && i.kind !== 'other').length,
      draftsPending: listMessages({ status: 'draft', direction: 'out', limit: 500 }).length,
      dbError: null,
    };
  } catch (err) {
    return {
      status: buildStatusPayload({
        counts: EMPTY_COUNTS(), settings: DEFAULT_SETTINGS, heartbeat: null, runs: [], hasLLM: hasLLM(), hasMail: hasMail(),
      }),
      inboxUnhandled: 0,
      draftsPending: 0,
      dbError: (err as Error).message,
    };
  }
}

// ───────────────────────────── Today ─────────────────────────────

export interface JobRef { id: string; title: string; company: string }

export interface TodayData {
  greeting: string;
  name: string;
  dateLabel: string;
  counts: Record<JobStatus, number>;
  funnel: FunnelStats;
  needsYou: Job[];
  interviews: Job[];
  activity: (EventView & { job?: JobRef })[];
  runs: StatusRun[];
  worker: WorkerHealth;
  settings: Settings;
  nextDiscovery: string;
  llm: boolean;
  mail: boolean;
}

export function greetingFor(hour: number): string {
  if (hour < 5) return 'Late one';
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

function preferredName(): string {
  try {
    return loadProfile().name.preferred || 'Kayzee';
  } catch {
    return 'Kayzee';
  }
}

function jobRefs(ids: (string | undefined)[]): Map<string, JobRef> {
  const map = new Map<string, JobRef>();
  for (const id of new Set(ids.filter((x): x is string => Boolean(x)))) {
    const job = getJob(id);
    if (job) map.set(id, { id, title: job.title, company: job.company });
  }
  return map;
}

function lastRunOf(kinds: string[]): RunRow | undefined {
  return kinds.map((k) => listRuns(1, k)[0]).filter((r): r is RunRow => Boolean(r)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function formatWhen(d: Date, now: Date): string {
  const ymd = dublinDate(d);
  const today = dublinDate(now);
  const day = ymd === today ? 'today' : ymd === addDays(today, 1) ? 'tomorrow' : d.toLocaleDateString('en-IE', { timeZone: 'Europe/Dublin', weekday: 'long' });
  return `${day} at ${dublinClock(d)}`;
}

/** Human estimate of the next discovery run (worker schedule: every N hours outside quiet hours). */
export function describeNextDiscovery(settings: Settings, lastStartedAt: string | undefined, workerOnline: boolean, now: Date = new Date()): string {
  if (!workerOnline) return 'The worker is offline: start it with pnpm worker and discovery runs straight away.';
  if (!lastStartedAt) return 'Discovery runs on the worker’s first pass.';
  let next = new Date(new Date(lastStartedAt).getTime() + settings.discoveryEveryHours * 3_600_000);
  if (next.getTime() <= now.getTime()) return 'Discovery is due now.';
  // Discovery pauses overnight: walk forward in 15-minute steps to the end of quiet hours
  // (step-walking sidesteps DST arithmetic).
  for (let i = 0; i < 24 * 4 && isQuietHours(settings, next); i++) next = new Date(next.getTime() + 15 * 60_000);
  return `Next discovery ${formatWhen(next, now)}.`;
}

export async function getTodayData(): Promise<TodayData> {
  await connection();
  const now = new Date();
  const settings = getSettings();
  const worker = workerHealth(kvGet(HEARTBEAT_KEY), now);
  const events = listEvents({ limit: 80 }).filter(isFeedWorthy).slice(0, 14);
  const refs = jobRefs(events.map((e) => e.jobId));
  const lastDiscovery = lastRunOf(['discover', 'discovery']);
  return {
    greeting: greetingFor(dublinParts(now).hour),
    name: preferredName(),
    dateLabel: now.toLocaleDateString('en-IE', { timeZone: 'Europe/Dublin', weekday: 'long', day: 'numeric', month: 'long' }),
    counts: countByStatus(),
    funnel: funnelStats(),
    needsYou: listJobs({ status: 'needs_you', orderBy: 'updatedAt', dir: 'desc', limit: 12 }),
    interviews: listJobs({ status: 'interview', orderBy: 'updatedAt', dir: 'desc', limit: 6 }),
    activity: events.map((e) => ({ ...describeEvent(e), job: e.jobId ? refs.get(e.jobId) : undefined })),
    runs: listRuns(6).map(toStatusRun),
    worker,
    settings,
    nextDiscovery: describeNextDiscovery(settings, lastDiscovery?.startedAt, worker.online, now),
    llm: hasLLM(),
    mail: hasMail(),
  };
}

// ───────────────────────────── Queue ─────────────────────────────

export const QUEUE_LIMIT = 200;

export interface QueueData {
  items: QueueItem[];
  paused: boolean;
  nextDiscovery: string;
  inFlight: number;
}

export async function getQueue(): Promise<QueueData> {
  await connection();
  const settings = getSettings();
  const worker = workerHealth(kvGet(HEARTBEAT_KEY));
  const counts = countByStatus();
  return {
    items: listJobs({ status: 'ready', orderBy: 'score', dir: 'desc', limit: QUEUE_LIMIT }).map(buildQueueItem),
    paused: settings.paused,
    nextDiscovery: describeNextDiscovery(settings, lastRunOf(['discover', 'discovery'])?.startedAt, worker.online),
    inFlight: counts.approved + counts.applying,
  };
}

// ───────────────────────────── Jobs ─────────────────────────────

export interface JobsPageData {
  filter: JobsFilter;
  jobs: Job[];
  total: number;
  pages: number;
  counts: Record<JobStatus, number>;
}

export async function getJobsPage(sp: SearchParams): Promise<JobsPageData> {
  await connection();
  const filter = parseJobsFilter(sp);
  const query = toJobQuery(filter);
  const total = countJobs(query);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (filter.page > pages) {
    filter.page = pages;
    Object.assign(query, toJobQuery(filter));
  }
  return { filter, jobs: listJobs(query), total, pages, counts: countByStatus() };
}

export interface ArtifactGroup { kind: ArtifactKind; versions: Artifact[]; servable: Record<number, boolean> }

export interface JobDetail extends QueueItem {
  artifactGroups: ArtifactGroup[];
  contacts: Contact[];
  messages: Message[];
  timeline: EventView[];
  applications: Application[];
  paused: boolean;
}

const ARTIFACT_ORDER: ArtifactKind[] = ['cv_pdf', 'cover_letter', 'answers', 'ats_report', 'cv_tex', 'compile_log', 'prep', 'screenshot'];

export async function getJobDetail(id: string): Promise<JobDetail | null> {
  await connection();
  const job = getJob(id);
  if (!job) return null;
  const all = listArtifacts(job.id);
  const artifactGroups = ARTIFACT_ORDER.map((kind) => {
    const versions = all.filter((a) => a.kind === kind).sort((a, b) => b.version - a.version);
    const servable = Object.fromEntries(versions.map((a) => [a.id, a.content !== undefined || artifactFileExists(a)]));
    return { kind, versions, servable };
  }).filter((g) => g.versions.length > 0);
  return {
    ...buildQueueItem(job),
    artifactGroups,
    contacts: listContacts({ jobId: job.id, limit: 50 }),
    messages: listMessages({ jobId: job.id, limit: 100 }),
    timeline: listEvents({ jobId: job.id, limit: 200 }).map(describeEvent),
    applications: listApplications({ jobId: job.id, limit: 20 }),
    paused: getSettings().paused,
  };
}

export interface JobHit { id: string; title: string; company: string; status: JobStatus; score: number | null }

export function searchJobHits(q: string, limit = 8): JobHit[] {
  const search = q.trim().slice(0, 80);
  if (!search) return [];
  return listJobs({ search, orderBy: 'score', dir: 'desc', limit }).map((j) => ({
    id: j.id, title: j.title, company: j.company, status: j.status, score: j.score ?? null,
  }));
}

// ───────────────────────────── Readiness ─────────────────────────────

export interface ReadinessChip {
  id: 'llm' | 'gmail' | 'chrome' | 'tectonic' | 'cv';
  label: string;
  ok: boolean;
  detail: string;
}

export interface SetupStep {
  id: string;
  title: string;
  why: string;
  /** Lines to add to .env.local (placeholders only, never real values). */
  envLines?: string[];
  command?: string;
}

export interface Readiness {
  chips: ReadinessChip[];
  steps: SetupStep[];
}

const SETUP_STEPS: Record<ReadinessChip['id'], SetupStep> = {
  llm: {
    id: 'llm',
    title: 'Turn the LLM on',
    why: 'Without it, scoring, letters and answers use plain heuristics. Create a key at openrouter.ai/keys.',
    envLines: ['OPENROUTER_API_KEY=sk-or-v1-…'],
  },
  gmail: {
    id: 'gmail',
    title: 'Connect Gmail',
    why: 'Lets Pursuit read replies and job alerts and send the emails you approve. Use an app password (Google Account → Security → 2-Step Verification → App passwords), not your real password.',
    envLines: ['GMAIL_USER=you@gmail.com', 'GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx'],
  },
  chrome: {
    id: 'chrome',
    title: 'Install Google Chrome',
    why: 'Applications are filled in a separate Chrome profile (data/chrome-profile), never your own browser.',
  },
  tectonic: {
    id: 'tectonic',
    title: 'Install tectonic',
    why: 'Compiles the tailored LaTeX CV to PDF. Without it no CV can be approved.',
    command: 'brew install tectonic',
  },
  cv: {
    id: 'cv',
    title: 'Master CV missing',
    why: 'Every tailored CV starts from your master .tex file. Set PURSUIT_MASTER_CV in .env.local if it lives elsewhere.',
    envLines: ['PURSUIT_MASTER_CV=/Users/you/skill/cv/Kshitiz_Mittal_CV.tex'],
  },
};

/** Integration chips + the "finish setup" steps for anything missing. Never exposes secret values. */
export async function getReadiness(): Promise<Readiness> {
  const llm = hasLLM();
  const mail = hasMail();
  let checks: { name: string; ok: boolean; detail: string }[] = [];
  try {
    const { doctorChecks } = await import('@/lib/doctor');
    checks = await doctorChecks();
  } catch {
    checks = [];
  }
  const find = (prefix: string) => checks.find((c) => c.name.startsWith(prefix));
  const fromCheck = (id: ReadinessChip['id'], label: string, prefix: string): ReadinessChip => {
    const c = find(prefix);
    return { id, label, ok: c?.ok ?? false, detail: c?.detail ?? 'not checked' };
  };
  const chips: ReadinessChip[] = [
    { id: 'llm', label: 'LLM', ok: llm, detail: llm ? 'OpenRouter key set' : 'off: heuristics only' },
    { id: 'gmail', label: 'Gmail', ok: mail, detail: mail ? 'app password set' : 'not configured' },
    fromCheck('chrome', 'Chrome', 'Google Chrome'),
    fromCheck('tectonic', 'LaTeX', 'tectonic'),
    fromCheck('cv', 'Master CV', 'Master CV'),
  ];
  return { chips, steps: chips.filter((c) => !c.ok).map((c) => SETUP_STEPS[c.id]) };
}
