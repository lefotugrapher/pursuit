// Apply runner (SPEC §5.5): builds the ApplyPackage, enforces the guards (pause, approval, daily cap,
// duplicates), routes the posting to the right adapter, drives the form (multi-step where needed),
// and only marks a job `applied` after a visible confirmation plus a saved screenshot (SPEC §0.5).
// Anything it cannot finish honestly becomes `needs_you` with reasons, the unanswered questions and
// what blocked it.
//
// Routing: the apply URL decides (LinkedIn/Indeed → skipped until resolved to an employer site, never
// loaded; Workday/iCIMS/Taleo/SuccessFactors… → account wall, handed off without opening a browser);
// otherwise job.ats; on the page, redirects / custom career domains / embedded ATS iframes are
// re-detected; anything unknown goes to the universal filler (llmfill.ts).

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { loadAnswers, loadProfile } from '@/lib/config';
import {
  addApplication, addArtifact, applicationsToday, getJob, getSettings, latestArtifact, listApplications, listEvents, listJobs, logEvent,
  setStatus, updateApplication, updateJob,
} from '@/lib/db';
import { SCREENSHOTS_DIR, ensureDir, safeSegment } from '@/lib/paths';
import { nowIso } from '@/lib/time';
import type {
  AnswerBank, AnsweredQuestion, Application, ApplyOutcome, ApplyPackage, Artifact, AtsKind, Blocker, Job, JobStatus, Profile, ScreeningQuestion,
} from '@/lib/types';
import { adapterFill, adapterScan, clickSubmit, type AtsAdapter } from './adapter';
import * as ashby from './ashby';
import * as bamboohr from './bamboohr';
import { NEVER_DRIVE_HOSTS, ProfileInUseError, isForcedHeadless, keepOpenForHandoff, withBrowser } from './browser';
import { captureBaseline, waitForConfirmation } from './confirm';
import {
  ACCOUNT_WALL_SITES, AUTOMATED_ATS, HANDOFF_ONLY_ATS, NEVER_DRIVE_SITES, describeBlocker, detectSite, detectSiteFromPage, findEmbeddedAtsUrl,
  hardBlockers, scanBlockers, siteLabel, type SiteKind,
} from './detect';
import type { FormFillResult } from './fields';
import { makeGenericAdapter } from './generic';
import { BEST_FORM_SCORE_JS } from './inpage';
import * as greenhouse from './greenhouse';
import * as lever from './lever';
import { makeResolver, makeUniversalAdapter, type LlmMapper } from './llmfill';
import * as personio from './personio';
import * as recruitee from './recruitee';
import * as smartrecruiters from './smartrecruiters';
import * as teamtailor from './teamtailor';
import * as workable from './workable';

// ───────────────────────────── Options + constants ─────────────────────────────

export interface ApplyRunOptions {
  mode: 'submit' | 'fill-only';
  headless: boolean;
  /** Recorded on the application row; autopilot passes 'autopilot'. Default 'auto'. */
  method?: Application['method'];
  /** Chrome profile directory (default data/chrome-profile). */
  profileDir?: string;
  /** Test hook: abort every request to other hosts. */
  allowHosts?: string[];
  /** How long to wait for a confirmation after clicking submit (default 25 s). */
  confirmTimeoutMs?: number;
  /** Whole-run watchdog: the page is closed and the run handed off after this long (default 4 min). */
  deadlineMs?: number;
  /** Test seam / override for the LLM field-mapping call of the universal filler. */
  llm?: LlmMapper;
  /** Force the LLM mapping step on/off (default: on when an LLM key is configured, off for strict autopilot). */
  allowLLM?: boolean;
  /** Test hook: base URL of Greenhouse's embeddable application form (default GREENHOUSE_EMBED_BASE). */
  greenhouseEmbedBase?: string;
}

export interface HandoffOptions {
  profileDir?: string;
  allowHosts?: string[];
  /** Default false (a visible window for Kayzee). Tests pass true. PURSUIT_FORCE_HEADLESS=1 forces true. */
  headless?: boolean;
  /** Test hook, as in ApplyRunOptions. */
  greenhouseEmbedBase?: string;
  /**
   * One-tap mode: keep watching the open window this long for Kayzee to clear the human check and submit. A CAPTCHA
   * that hides the form is waited out first, then the form is filled. On a confirmation the job is marked applied
   * with a screenshot, exactly as an automatic submission would be. Pursuit never touches the CAPTCHA itself.
   */
  watchMs?: number;
}

/**
 * Greenhouse's embeddable application form. Big employers point absolute_url (and the hosted board,
 * via a 302) at their own careers site (e.g. stripe.com/jobs/search?gh_jid=…), which has no form in
 * the page; the embed URL always serves the full form (#application-form).
 */
export const GREENHOUSE_EMBED_BASE = 'https://job-boards.greenhouse.io/embed/job_app';

/** job-boards.greenhouse.io/embed/job_app?for={boardToken}&token={jobId}, or null without both ids. */
export function greenhouseEmbedUrl(job: Pick<Job, 'atsMeta'>, base: string = GREENHOUSE_EMBED_BASE): string | null {
  const token = job.atsMeta?.boardToken;
  const id = job.atsMeta?.jobId;
  if (typeof token !== 'string' || !token.trim()) return null;
  if ((typeof id !== 'string' && typeof id !== 'number') || !String(id).trim()) return null;
  return `${base}?for=${encodeURIComponent(token.trim())}&token=${encodeURIComponent(String(id).trim())}`;
}

export const DUPLICATE_WINDOW_DAYS = 60;
const DAY_MS = 86_400_000;

/** Statuses that mean Kayzee (or autopilot within its limits) already approved the application. */
const SUBMIT_ALLOWED_FROM: readonly JobStatus[] = ['approved', 'applying', 'needs_you', 'failed'];
const APPLIED_LIKE: readonly JobStatus[] = ['applied', 'replied', 'interview', 'offer', 'rejected'];

export const NEED_REVIEW_AND_SUBMIT = 'review and submit yourself';
export const NEED_NO_CONFIRMATION = 'submitted but no confirmation seen — check manually';
export const NEED_NOT_RESOLVED = 'not resolved to an employer site yet';

const ADAPTERS: Partial<Record<SiteKind, AtsAdapter>> = {
  greenhouse: greenhouse.adapter,
  lever: lever.adapter,
  ashby: ashby.adapter,
  smartrecruiters: smartrecruiters.adapter,
  workable: workable.adapter,
  teamtailor: teamtailor.adapter,
  personio: personio.adapter,
  recruitee: recruitee.adapter,
  bamboohr: bamboohr.adapter,
};

/** Adapter for a site; unknown company forms get the universal (LLM-assisted) filler. */
export function adapterFor(site: SiteKind): AtsAdapter {
  if (site === 'email' || NEVER_DRIVE_SITES.includes(site) || ACCOUNT_WALL_SITES.includes(site)) return makeGenericAdapter(site === 'email' ? 'email' : 'unknown');
  return ADAPTERS[site] ?? makeUniversalAdapter(site);
}

/**
 * Where the application actually happens: a Greenhouse job with board token + job id always goes to
 * Greenhouse's embed form; otherwise the apply URL wins, then job.ats.
 */
export function siteForJob(job: Pick<Job, 'ats' | 'applyUrl' | 'url'> & Partial<Pick<Job, 'atsMeta'>>, greenhouseBase?: string): { site: SiteKind; applyUrl: string } {
  if (job.ats === 'greenhouse' && job.atsMeta) {
    const embed = greenhouseEmbedUrl({ atsMeta: job.atsMeta }, greenhouseBase);
    if (embed) return { site: 'greenhouse', applyUrl: embed };
  }
  const applyUrl = job.applyUrl?.trim() || job.url;
  const fromUrl = detectSite(applyUrl);
  if (fromUrl !== 'unknown') return { site: fromUrl, applyUrl };
  const fromJob: SiteKind = job.ats && !NEVER_DRIVE_SITES.includes(job.ats) ? job.ats : 'unknown';
  return { site: fromJob, applyUrl };
}

/** False while the posting still points at LinkedIn/Indeed (the worker can skip these before its jitter). */
export function isResolvedForApply(job: Pick<Job, 'ats' | 'applyUrl' | 'url'>): boolean {
  return !NEVER_DRIVE_SITES.includes(siteForJob(job).site);
}

// ───────────────────────────── Serialisation ─────────────────────────────

// One Chrome profile = one browser process, so browser work in this process runs one job at a time.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// ───────────────────────────── Duplicates ─────────────────────────────

const COMPANY_SUFFIX = /\s+(ltd|limited|inc|incorporated|plc|dac|llc|gmbh|uc|clg|co|company|corp|corporation|group|holdings)$/;

export function normalizeCompany(name: string): string {
  let s = (name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  for (let i = 0; i < 3 && COMPANY_SUFFIX.test(s); i++) s = s.replace(COMPANY_SUFFIX, '').trim();
  return s;
}

export function normalizeTitle(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b[mfwdx]\s*\/\s*[mfwdx](\s*\/\s*[mfwdx])?\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dupKey(job: Pick<Job, 'company' | 'title'>): string {
  return `${normalizeCompany(job.company)}|${normalizeTitle(job.title)}`;
}

/** Another job at the same company with the same normalised title applied to within 60 days. */
export function findDuplicateApplication(job: Job, now: Date = new Date()): { job: Job; at: string } | null {
  const since = new Date(now.getTime() - DUPLICATE_WINDOW_DAYS * DAY_MS).toISOString();
  const key = dupKey(job);
  for (const app of listApplications({ status: 'submitted', since, limit: 5000 })) {
    if (app.jobId === job.id) return { job, at: app.submittedAt ?? app.startedAt };
    const other = getJob(app.jobId);
    if (other && dupKey(other) === key) return { job: other, at: app.submittedAt ?? app.startedAt };
  }
  for (const other of listJobs({ status: [...APPLIED_LIKE] })) {
    if (other.id !== job.id && other.updatedAt >= since && dupKey(other) === key) return { job: other, at: other.updatedAt };
  }
  return null;
}

// ───────────────────────────── Package ─────────────────────────────

/** Accepts AnsweredQuestion[] or {answers: AnsweredQuestion[]} (artifact content written by tailor/answers). */
export function parseAnswersArtifact(text: string | undefined): AnsweredQuestion[] {
  if (!text?.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray((data as { answers?: unknown }).answers) ? (data as { answers: unknown[] }).answers : []);
  return list.filter((q): q is AnsweredQuestion => {
    if (!q || typeof q !== 'object') return false;
    const r = q as Record<string, unknown>;
    return typeof r.label === 'string' && (typeof r.answer === 'string' || r.answer === null);
  }).map((q) => ({
    ...q,
    id: typeof q.id === 'string' ? q.id : '',
    type: q.type ?? 'text',
    required: q.required === true,
    source: q.source ?? 'none',
    needsHuman: q.needsHuman === true || q.answer === null,
  }));
}

function readArtifactText(a: Artifact | undefined): string | undefined {
  if (!a) return undefined;
  if (a.content?.trim()) return a.content;
  if (a.path && /\.(txt|md|json)$/i.test(a.path) && fs.existsSync(a.path)) {
    try {
      return fs.readFileSync(a.path, 'utf8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface PackageBuild {
  pkg: ApplyPackage;
  cvArtifact?: Artifact;
  /** Human-readable reasons the package is incomplete (empty = ready). */
  missing: string[];
}

/** Builds the ApplyPackage from the job's latest artifacts and the profile. Upload paths are absolute. */
export function buildApplyPackage(job: Job, profile: Profile): PackageBuild {
  const missing: string[] = [];
  const cvArtifact = latestArtifact(job.id, 'cv_pdf');
  const cvPath = cvArtifact?.path ? path.resolve(cvArtifact.path) : '';
  if (!cvPath) missing.push('CV PDF missing: tailor or regenerate the CV first');
  else if (!fs.existsSync(cvPath)) missing.push(`CV PDF file not found at ${cvPath}: regenerate the CV`);

  const cover = latestArtifact(job.id, 'cover_letter');
  const metaPdf = typeof cover?.meta?.pdfPath === 'string' ? cover.meta.pdfPath : undefined;
  const pdfCandidate = cover?.path && /\.pdf$/i.test(cover.path) ? cover.path : metaPdf;
  const coverPdf = pdfCandidate && fs.existsSync(pdfCandidate) ? path.resolve(pdfCandidate) : undefined;
  const coverText = readArtifactText(cover) ?? '';

  const answers = parseAnswersArtifact(readArtifactText(latestArtifact(job.id, 'answers')));
  const pkg: ApplyPackage = { job, profile, cvPdfPath: cvPath, coverLetterText: coverText, answers };
  if (coverPdf) pkg.coverLetterPdfPath = coverPdf;
  return { pkg, cvArtifact, missing };
}

function safeLoadBank(): AnswerBank {
  try {
    return loadAnswers();
  } catch {
    return { entries: [] };
  }
}

// ───────────────────────────── Page steps ─────────────────────────────

function entryUrl(url: string, site: SiteKind): string {
  if (site === 'lever') return lever.leverApplyUrl(url);
  if (site === 'workable') return workable.workableApplyUrl(url);
  return url;
}

async function settleLoad(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
}

async function pageHasForm(page: Page): Promise<boolean> {
  return ((await page.evaluate(`(${BEST_FORM_SCORE_JS})()`).catch(() => 0)) as number) >= 6;
}

/**
 * Opens the posting and works out which site the application really lives on. A company page that
 * embeds an ATS iframe (Greenhouse #grnhse_iframe, SmartRecruiters, Workable…) and has no form of its
 * own is swapped for the iframe's URL.
 */
async function openPosting(page: Page, url: string, site: SiteKind): Promise<SiteKind> {
  await page.goto(entryUrl(url, site), { waitUntil: 'domcontentloaded' });
  await settleLoad(page);
  let effective = await detectSiteFromPage(page);
  const embedded = await findEmbeddedAtsUrl(page);
  if (embedded && !NEVER_DRIVE_SITES.includes(detectSite(embedded)) && !(await pageHasForm(page))) {
    await page.goto(embedded, { waitUntil: 'domcontentloaded' });
    await settleLoad(page);
    effective = await detectSiteFromPage(page);
  }
  return effective === 'unknown' ? site : effective;
}

async function saveScreenshot(page: Page, jobId: string, meta: Record<string, unknown>): Promise<string | undefined> {
  try {
    ensureDir(SCREENSHOTS_DIR);
    const file = path.join(SCREENSHOTS_DIR, `${safeSegment(jobId)}-${nowIso().replace(/[:.]/g, '-')}.png`);
    await page.screenshot({ path: file, fullPage: true });
    addArtifact({ jobId, kind: 'screenshot', path: file, meta });
    return file;
  } catch {
    return undefined;
  }
}

function needsFromFill(fill: FormFillResult, site: SiteKind): string[] {
  const needs: string[] = [];
  for (const b of fill.blockers) {
    if (b === 'unknown_required_field' || b === 'attestation') continue; // itemised below
    needs.push(describeBlocker(b, site));
  }
  for (const label of fill.unfilledRequired) needs.push(fill.reasons[label] ?? `Answer required question: "${label}"`);
  return [...new Set(needs)];
}

function recordQuestionsSeen(jobId: string, questions: ScreeningQuestion[], pending?: ScreeningQuestion[]): void {
  if (!questions.length && !pending) return;
  const current = getJob(jobId);
  if (!current) return;
  const meta: Record<string, unknown> = { ...current.atsMeta };
  if (questions.length) {
    meta.questionsSeen = questions;
    meta.questionsSeenAt = nowIso();
  }
  if (pending) {
    meta.pendingQuestions = pending;
    meta.pendingQuestionsAt = nowIso();
  }
  updateJob(jobId, { atsMeta: meta });
}

// ───────────────────────────── Outcome bookkeeping ─────────────────────────────

function skip(jobId: string, reason: string, statusChange?: JobStatus): ApplyOutcome {
  if (statusChange) setStatus(jobId, statusChange, { reason });
  logEvent('apply.skipped', { reason }, jobId);
  return { status: 'skipped', needs: [reason] };
}

/** LinkedIn/Indeed postings wait for the resolver; one event per hour, not one per worker tick. */
function skipUnresolved(jobId: string, url: string): ApplyOutcome {
  const lastSkip = listEvents({ jobId, type: 'apply.skipped', limit: 1 })[0];
  const recent = lastSkip && (lastSkip.detail as { reason?: string } | undefined)?.reason === NEED_NOT_RESOLVED
    && Date.now() - Date.parse(lastSkip.ts) < 3_600_000;
  if (!recent) logEvent('apply.skipped', { reason: NEED_NOT_RESOLVED, url }, jobId);
  return { status: 'skipped', needs: [NEED_NOT_RESOLVED] };
}

interface NeedsExtra {
  questions?: ScreeningQuestion[];
  blockedBy?: Blocker[];
  screenshotPath?: string;
  [k: string]: unknown;
}

function needsYou(jobId: string, appId: number | null, needs: string[], extra: NeedsExtra = {}): ApplyOutcome {
  updateJob(jobId, { needs });
  setStatus(jobId, 'needs_you', { needs });
  if (appId !== null) updateApplication(appId, { status: 'needs_you', error: needs.join('; ').slice(0, 2000) });
  logEvent('apply.needs_you', { needs, ...extra }, jobId);
  const outcome: ApplyOutcome = { status: 'needs_you', needs };
  if (typeof extra.screenshotPath === 'string') outcome.screenshotPath = extra.screenshotPath;
  if (extra.questions?.length) outcome.questions = extra.questions;
  if (extra.blockedBy?.length) outcome.blockedBy = [...new Set(extra.blockedBy)];
  return outcome;
}

function failed(jobId: string, appId: number | null, error: string, needs?: string[]): ApplyOutcome {
  if (needs?.length) updateJob(jobId, { needs });
  setStatus(jobId, 'failed', { error });
  if (appId !== null) updateApplication(appId, { status: 'failed', error: error.slice(0, 2000) });
  logEvent('apply.failed', { error, needs }, jobId);
  return needs?.length ? { status: 'failed', error, needs } : { status: 'failed', error };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);
}

function accountWallNeed(site: SiteKind, url: string): string {
  return `${siteLabel(site)} needs you to sign in or create an account before applying (Pursuit never creates accounts or types passwords): apply yourself at ${url}`;
}

/** Strict autopilot (SPEC §7) may not use LLM help; hands-free autopilot and Kayzee's own approvals may. */
function llmAllowed(opts: ApplyRunOptions): boolean | undefined {
  if (opts.allowLLM !== undefined) return opts.allowLLM;
  if (opts.method === 'autopilot' && !getSettings().autopilot.handsFree) return false;
  return undefined; // default: on when a key is configured
}

/** Closes the page if the run takes longer than `ms`, so a stuck page can never hang the worker. */
function watchdog(page: Page, ms: number): { stop(): void; fired(): boolean } {
  let didFire = false;
  const timer = setTimeout(() => {
    didFire = true;
    void page.close().catch(() => undefined);
  }, ms);
  timer.unref?.();
  return { stop: () => clearTimeout(timer), fired: () => didFire };
}

// ───────────────────────────── applyToJob ─────────────────────────────

/**
 * Applies to one job. mode 'submit' clicks submit only when every required field is filled, no
 * blocker is present, the job is approved, and the page can show a confirmation; 'fill-only' fills
 * and leaves the (headed) window open.
 */
export function applyToJob(jobId: string, opts: ApplyRunOptions): Promise<ApplyOutcome> {
  return exclusive(() => runApply(jobId, opts));
}

async function runApply(jobId: string, opts: ApplyRunOptions): Promise<ApplyOutcome> {
  const job = getJob(jobId);
  if (!job) return { status: 'failed', error: `Job not found: ${jobId}` };
  const submit = opts.mode === 'submit';
  const settings = getSettings();
  const headless = opts.headless || isForcedHeadless();

  // Guards that need no browser.
  if (settings.paused) return skip(jobId, 'Paused: outbound actions are switched off');
  if (APPLIED_LIKE.includes(job.status)) return skip(jobId, `Already ${job.status}`);
  if (submit && !SUBMIT_ALLOWED_FROM.includes(job.status)) return skip(jobId, `Not approved yet (status ${job.status})`);

  const { site, applyUrl } = siteForJob(job, opts.greenhouseEmbedBase);
  // SPEC §0.4: LinkedIn / Indeed application pages are never loaded; wait for the resolver.
  if (NEVER_DRIVE_SITES.includes(site)) return skipUnresolved(jobId, applyUrl);

  const dup = findDuplicateApplication(job);
  if (dup) return skip(jobId, `Already applied to ${dup.job.company}: "${dup.job.title}" on ${dup.at.slice(0, 10)}`, 'skipped');
  if (submit && applicationsToday() >= settings.dailyApplyCap) return skip(jobId, `Daily apply cap reached (${settings.dailyApplyCap})`);

  if (site === 'email') return needsYou(jobId, null, [describeBlocker('unsupported', 'email'), `Open: ${applyUrl}`], { blockedBy: ['unsupported'] });
  if (ACCOUNT_WALL_SITES.includes(site)) {
    return needsYou(jobId, null, [accountWallNeed(site, applyUrl)], { blockedBy: ['account_required'], site });
  }

  let profile: Profile;
  try {
    profile = loadProfile();
  } catch (err) {
    return failed(jobId, null, `Profile config invalid: ${errorText(err)}`);
  }
  const { pkg, cvArtifact, missing } = buildApplyPackage(job, profile);
  if (missing.length) return failed(jobId, null, missing[0], missing);

  setStatus(jobId, 'applying', { mode: opts.mode });
  const appRow: Parameters<typeof addApplication>[0] = { jobId, method: opts.method ?? 'auto', status: 'started' };
  if (cvArtifact) appRow.cvArtifactId = cvArtifact.id;
  const variant = cvArtifact?.meta?.summaryVariant;
  if (typeof variant === 'string') appRow.summaryVariant = variant;
  const app = addApplication(appRow);
  logEvent('apply.start', { mode: opts.mode, headless, ats: site, url: applyUrl, applicationId: app.id }, jobId);

  const bank = safeLoadBank();
  let submitClicked = false;
  let dog: { stop(): void; fired(): boolean } | null = null;
  try {
    return await withBrowser({ headless, profileDir: opts.profileDir, allowHosts: opts.allowHosts, blockHosts: NEVER_DRIVE_HOSTS }, async (page) => {
      dog = watchdog(page, opts.deadlineMs ?? 240_000);
      const effective = await openPosting(page, applyUrl, site);
      if (NEVER_DRIVE_SITES.includes(effective)) {
        updateApplication(app.id, { status: 'failed', error: NEED_NOT_RESOLVED });
        setStatus(jobId, job.status === 'applying' ? 'approved' : job.status, { reason: NEED_NOT_RESOLVED });
        return skipUnresolved(jobId, page.url());
      }
      if (ACCOUNT_WALL_SITES.includes(effective)) {
        if (!headless) keepOpenForHandoff(page);
        return needsYou(jobId, app.id, [accountWallNeed(effective, page.url())], { blockedBy: ['account_required'], site: effective });
      }
      const adapter = adapterFor(effective);

      const pre = await scanBlockers(page);
      if (pre.blockers.length) {
        logEvent('apply.blocker', { blockers: pre.blockers, details: pre.details, stage: 'before-fill' }, jobId);
        if (!headless) keepOpenForHandoff(page);
        return needsYou(jobId, app.id, pre.blockers.map((b) => describeBlocker(b, effective)), { blockers: pre.blockers, details: pre.details, blockedBy: pre.blockers });
      }

      const resolved: { label: string; source: string; key?: string }[] = [];
      const resolve = makeResolver({ pkg, bank, allowLLM: llmAllowed(opts), llm: opts.llm, onResolved: (d) => resolved.push(...d) });
      const fill = await adapterFill(page, pkg, adapter, { bank, resolve });
      recordQuestionsSeen(jobId, fill.questionsSeen, fill.unanswered);
      logEvent('apply.filled', {
        ats: effective, filled: fill.filled, unfilledRequired: fill.unfilledRequired, blockers: fill.blockers, steps: fill.steps,
        bankAnswered: fill.bankAnswered, failedFills: fill.failedFills, resolved, passiveCaptcha: pre.passiveCaptcha.length > 0,
      }, jobId);

      const needs = needsFromFill(fill, effective);
      if (needs.length) {
        if (fill.blockers.some((b) => b !== 'unknown_required_field' && b !== 'attestation')) {
          logEvent('apply.blocker', { blockers: fill.blockers, stage: 'after-fill' }, jobId);
        }
        if (!headless) keepOpenForHandoff(page);
        return needsYou(jobId, app.id, needs, { unfilledRequired: fill.unfilledRequired, questions: fill.unanswered, blockedBy: fill.blockers });
      }

      // A generic page must look like a real application before Pursuit presses its submit button.
      const universal = !ADAPTERS[effective];
      const kinds = new Set(fill.kindsFilled ?? []);
      const looksLikeApplication = !universal || (kinds.has('cv') && kinds.has('email'));
      if (!submit || !adapter.canSubmit || !looksLikeApplication || fill.submitReady === false) {
        if (!headless) keepOpenForHandoff(page);
        const why = !adapter.canSubmit
          ? `${NEED_REVIEW_AND_SUBMIT} (no automated submit for ${effective} forms)`
          : submit && !looksLikeApplication
            ? `${NEED_REVIEW_AND_SUBMIT} (couldn't confirm this page is the job application: no CV upload + email field filled)`
            : NEED_REVIEW_AND_SUBMIT;
        return needsYou(jobId, app.id, [why], { filled: fill.filled.length });
      }

      const baseline = await captureBaseline(page);
      const via = await clickSubmit(page, adapter);
      submitClicked = true;
      logEvent('apply.submitted', { via, applicationId: app.id }, jobId);

      const result = await waitForConfirmation(page, baseline, { timeoutMs: opts.confirmTimeoutMs ?? 25_000, successSelectors: adapter.successSelectors });
      if (result.confirmed) {
        const confirmation = result.evidence ?? 'confirmed';
        const screenshotPath = await saveScreenshot(page, jobId, { confirmed: true, confirmation, applicationId: app.id });
        if (!screenshotPath) {
          // SPEC §0.5: no screenshot, no `applied`.
          if (!headless) keepOpenForHandoff(page);
          return needsYou(jobId, app.id, [`Confirmation seen (${confirmation}) but the screenshot failed: check and mark applied yourself`]);
        }
        updateApplication(app.id, { status: 'submitted', confirmation, screenshotPath, error: undefined });
        updateJob(jobId, { needs: undefined });
        setStatus(jobId, 'applied', { confirmation, screenshotPath, applicationId: app.id });
        logEvent('apply.confirmed', { confirmation, screenshotPath, applicationId: app.id }, jobId);
        return { status: 'applied', confirmation, screenshotPath };
      }

      const screenshotPath = await saveScreenshot(page, jobId, { confirmed: false, applicationId: app.id });
      if (!headless) keepOpenForHandoff(page);
      if (result.captcha) {
        logEvent('apply.blocker', { blockers: ['captcha'], stage: 'after-submit' }, jobId);
        return needsYou(jobId, app.id, ['CAPTCHA appeared after submit: solve it in the browser window, then mark applied if it goes through'], { screenshotPath, blockedBy: ['captcha'] });
      }
      if (result.alreadyApplied) {
        return needsYou(jobId, app.id, [`The site says this application already exists ("${result.alreadyApplied}"): check your email, then mark applied`], { screenshotPath });
      }
      if (result.validationErrors?.length) {
        return needsYou(jobId, app.id, [`The form rejected the submission: ${result.validationErrors.slice(0, 5).join(' | ')}`], { screenshotPath });
      }
      return needsYou(jobId, app.id, [NEED_NO_CONFIRMATION], { screenshotPath });
    });
  } catch (err) {
    const fired = (dog as { fired(): boolean } | null)?.fired() ?? false;
    const msg = fired ? `the run took longer than ${Math.round((opts.deadlineMs ?? 240_000) / 1000)} s and was stopped` : errorText(err);
    if (submitClicked) {
      // Never 'failed' after a submit click: a retry could send a duplicate application.
      return needsYou(jobId, app.id, [`Submit was clicked but confirming failed (${msg}): check the posting or your email before retrying`]);
    }
    if (err instanceof ProfileInUseError) return failed(jobId, app.id, msg, ['Close the open Pursuit Chrome window, then retry']);
    if (fired) return needsYou(jobId, app.id, [`The application page got stuck (${msg}): open it yourself`, `Open: ${applyUrl}`]);
    return failed(jobId, app.id, msg);
  } finally {
    (dog as { stop(): void } | null)?.stop();
  }
}

// ───────────────────────────── Handoff ─────────────────────────────

/**
 * Opens the posting in a visible Chrome window with everything Pursuit can fill pre-filled, and leaves
 * it for Kayzee. Never submits. LinkedIn/Indeed/email postings are not driven at all (SPEC §0.4).
 * With PURSUIT_FORCE_HEADLESS=1 (servers) there is no window: the form is scanned headless, questions
 * are recorded, and the job is left needs_you with the link.
 */
export function openForHandoff(jobId: string, opts: HandoffOptions = {}): Promise<ApplyOutcome> {
  return exclusive(() => runHandoff(jobId, opts));
}

async function runHandoff(jobId: string, opts: HandoffOptions): Promise<ApplyOutcome> {
  const job = getJob(jobId);
  if (!job) return { status: 'failed', error: `Job not found: ${jobId}` };
  const { site, applyUrl } = siteForJob(job, opts.greenhouseEmbedBase);
  const forced = isForcedHeadless();
  const headless = (opts.headless ?? false) || forced;
  const parkStatus = () => {
    if (job.status === 'approved' || job.status === 'applying' || job.status === 'failed') setStatus(jobId, 'needs_you', { reason: 'handoff' });
  };

  if (NEVER_DRIVE_SITES.includes(site) || site === 'email') {
    const needs = [`Open this posting in your own browser and apply there: ${applyUrl}`];
    parkStatus();
    updateJob(jobId, { needs });
    logEvent('apply.handoff', { ats: site, driven: false, url: applyUrl }, jobId);
    return { status: 'needs_you', needs };
  }

  let built: PackageBuild | null = null;
  try {
    built = buildApplyPackage(job, loadProfile());
  } catch {
    built = null; // invalid profile: still open the page, just don't pre-fill
  }

  try {
    return await withBrowser({ headless, profileDir: opts.profileDir, allowHosts: opts.allowHosts, blockHosts: NEVER_DRIVE_HOSTS }, async (page) => {
      const effective = await openPosting(page, applyUrl, site);
      const needs: string[] = [forced
        ? `No browser window on this server: open ${applyUrl} yourself, apply, then mark applied`
        : 'Opened in Chrome with fields pre-filled: review, submit it yourself, then mark applied'];
      let pre = await scanBlockers(page);
      const watching = Boolean(opts.watchMs && opts.watchMs > 0 && !headless);
      const deadline = Date.now() + (opts.watchMs ?? 0);
      const walled = ACCOUNT_WALL_SITES.includes(effective);
      if (watching && !walled && pre.blockers.includes('captcha')) {
        // The check sits in front of the form: show the window and wait for Kayzee to clear it, then fill.
        keepOpenForHandoff(page);
        while (Date.now() < deadline && !page.isClosed()) {
          await page.waitForTimeout(2_000).catch(() => undefined);
          pre = await scanBlockers(page).catch(() => pre);
          if (!pre.blockers.includes('captcha')) break;
        }
      }
      needs.push(...pre.blockers.map((b) => describeBlocker(b, effective)));
      let questions: ScreeningQuestion[] | undefined;
      if (walled) needs.push(accountWallNeed(effective, page.url()));
      if (built && !walled && !hardBlockers(pre.blockers).length) {
        const pkg: ApplyPackage = built.pkg;
        const bank = safeLoadBank();
        const fill = await adapterFill(page, pkg, adapterFor(effective), { bank, resolve: makeResolver({ pkg, bank }) });
        recordQuestionsSeen(jobId, fill.questionsSeen, fill.unanswered);
        questions = fill.unanswered;
        needs.push(...built.missing, ...needsFromFill(fill, effective).filter((n) => !needs.includes(n)));
        logEvent('apply.filled', { ats: effective, filled: fill.filled, unfilledRequired: fill.unfilledRequired, handoff: true }, jobId);
      }
      if (!headless) keepOpenForHandoff(page);
      if (watching && !walled && !page.isClosed() && Date.now() < deadline) {
        const adapter = adapterFor(effective);
        const baseline = await captureBaseline(page);
        const result = await waitForConfirmation(page, baseline, { timeoutMs: Math.max(0, deadline - Date.now()), human: true, pollMs: 1_500, successSelectors: adapter.successSelectors });
        if (result.confirmed || result.alreadyApplied) {
          const confirmation = result.evidence ?? (result.alreadyApplied ? `already applied: ${result.alreadyApplied}` : 'confirmed');
          const screenshotPath = await saveScreenshot(page, jobId, { confirmed: true, confirmation, via: 'handoff' });
          if (screenshotPath) {
            const app = addApplication({ jobId, method: 'manual', status: 'submitted', confirmation, screenshotPath });
            updateJob(jobId, { needs: undefined });
            setStatus(jobId, 'applied', { confirmation, screenshotPath, applicationId: app.id, via: 'handoff' });
            logEvent('apply.confirmed', { confirmation, screenshotPath, applicationId: app.id, via: 'handoff' }, jobId);
            return { status: 'applied' as const, confirmation, screenshotPath };
          }
          needs.unshift(`Confirmation seen (${confirmation}) but the screenshot failed: mark applied yourself`);
        } else {
          needs.unshift('Not finished in the Chrome window in time: reply GO on Telegram to try it again, or apply yourself');
        }
      }
      parkStatus();
      const unique = [...new Set(needs)];
      updateJob(jobId, { needs: unique });
      logEvent('apply.handoff', { ats: effective, driven: true, needs: unique, headless }, jobId);
      const outcome: ApplyOutcome = { status: 'needs_you' as const, needs: unique };
      if (questions?.length) outcome.questions = questions;
      if (pre.blockers.length || walled) outcome.blockedBy = [...new Set<Blocker>([...pre.blockers, ...(walled ? ['account_required' as const] : [])])];
      return outcome;
    });
  } catch (err) {
    const msg = errorText(err);
    logEvent('apply.failed', { error: msg, handoff: true }, jobId);
    return { status: 'failed', error: msg };
  }
}

// ───────────────────────────── Question scan ─────────────────────────────

/** Lists the questions on an already-open application page (for pre-answering next time). Never fills. */
export function scanQuestions(page: Page, ats: SiteKind | AtsKind): Promise<ScreeningQuestion[]> {
  return adapterScan(page, adapterFor(ats));
}

export { AUTOMATED_ATS, HANDOFF_ONLY_ATS };
