// resolveApplyTargets: for LinkedIn / job-board postings, find the SAME job on the employer's own site
// and point applyUrl there. Easy-Apply-only LinkedIn jobs are skipped quietly; closed postings are
// skipped; everything else that can't be matched confidently is left alone (retried ≤ 3×, ≥ 12 h apart).
// Never applies, never submits a form, never logs in anywhere.

import { loadSources } from '@/lib/config';
import { getJob, listJobs, logEvent, setStatus, tx, updateJob } from '@/lib/db';
import { nowIso } from '@/lib/time';
import type { Job, JobStatus, WatchCompany } from '@/lib/types';
import { BoardProber, classifyUrl, postingKey } from './ats';
import { createChromeCrawler, type Crawler } from './crawl';
import { createResolverHttp, hostOf, type ResolverHttp } from './http';
import { LinkedInClient } from './linkedin';
import { type JobResolution, Resolver, type ResolverDeps } from './resolver';
import { Searcher, defaultBackends, type SearchBackend } from './search';
import type { ResolveDetail, ResolveSummary } from './types';

export type { ResolveDetail, ResolveSummary } from './types';

export const RESOLVE_STATUSES: JobStatus[] = ['scored', 'ready', 'needs_you', 'approved'];
export const MAX_ATTEMPTS = 3;
export const RETRY_AFTER_MS = 12 * 3_600_000;
const BOARD_HOST_RE = /(^|\.)(linkedin\.com|indeed\.[a-z.]+|irishjobs\.ie|jobs\.ie|glassdoor\.[a-z.]+)$/i;
const ACTIVE_STATUSES = new Set<JobStatus>(['scored', 'tailoring', 'ready', 'approved', 'applying', 'needs_you', 'applied', 'replied', 'interview', 'offer']);

export interface ResolveOptions {
  limit?: number;
  jobIds?: string[];
  dryRun?: boolean;
  /** Ignore the attempt cap / 12 h spacing (manual re-runs). */
  force?: boolean;
  /** Disable the headless Chrome crawl. */
  noCrawl?: boolean;
  /** Jobs resolved at once (default 3, max 6). Per-host request spacing is shared, so this stays polite. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Progress callback (CLI). */
  onDetail?: (d: ResolveDetail) => void;
}

export interface ResolveDepsOverride {
  http?: ResolverHttp;
  backends?: SearchBackend[];
  crawler?: Crawler | null;
  watchlist?: WatchCompany[];
  now?: () => Date;
  maxSearches?: number;
}

const meta = (job: Job) => job.atsMeta ?? {};

/**
 * Board identifiers in the same atsMeta keys the ATS discovery adapters use, so the apply runner can
 * build e.g. https://job-boards.greenhouse.io/embed/job_app?for={boardToken}&token={jobId}.
 */
export function atsIdentifiers(kind: string, slug?: string, postingId?: string): Record<string, unknown> {
  if (!slug && !postingId) return {};
  const ids: Record<string, unknown> = (() => {
    switch (kind) {
      case 'greenhouse': return { boardToken: slug, jobId: postingId && /^\d+$/.test(postingId) ? Number(postingId) : postingId };
      case 'lever': return { company: slug, postingId };
      case 'ashby': return { jobBoardName: slug, jobPostingId: postingId, org: slug, jobId: postingId };
      case 'smartrecruiters': return { companyIdentifier: slug, companyId: slug, postingId };
      case 'workable': return { account: slug, shortcode: postingId };
      default: return { atsSlug: slug, atsPostingId: postingId };
    }
  })();
  return Object.fromEntries(Object.entries(ids).filter(([, v]) => v !== undefined && v !== ''));
}

/** Jobs whose apply target is still a job board and that are due for a (re)try. */
export function selectJobs(opts: Pick<ResolveOptions, 'jobIds' | 'force' | 'limit'>, now: Date): Job[] {
  const pool = opts.jobIds?.length
    ? opts.jobIds.map((id) => getJob(id)).filter((j): j is Job => Boolean(j))
    : listJobs({ status: RESOLVE_STATUSES, orderBy: 'score', dir: 'desc' });
  const due = pool.filter((job) => {
    if (!RESOLVE_STATUSES.includes(job.status)) return false;
    const m = meta(job);
    if (m.demo === true || m.resolvedAt) return false;
    const boardish = ['linkedin', 'indeed', 'unknown'].includes(job.ats) || BOARD_HOST_RE.test(hostOf(job.applyUrl));
    if (!boardish) return false;
    if (opts.force) return true;
    const attempts = typeof m.resolveAttempts === 'number' ? m.resolveAttempts : 0;
    if (attempts >= MAX_ATTEMPTS) return false;
    const failedAt = typeof m.resolveFailedAt === 'string' ? Date.parse(m.resolveFailedAt) : NaN;
    return !(Number.isFinite(failedAt) && now.getTime() - failedAt < RETRY_AFTER_MS);
  });
  return opts.limit !== undefined ? due.slice(0, Math.max(0, opts.limit)) : due;
}

/** posting key → job id for every live job, so two rows never point at one employer posting. */
function knownPostings(): Map<string, { id: string; status: JobStatus }> {
  const map = new Map<string, { id: string; status: JobStatus }>();
  for (const job of listJobs({})) {
    if (!ACTIVE_STATUSES.has(job.status)) continue;
    const m = meta(job);
    const urls = [job.applyUrl, job.url, m.hostedUrl, m.resolvedUrl].filter((u): u is string => typeof u === 'string' && Boolean(u));
    for (const u of urls) {
      const kind = classifyUrl(u).kind;
      if (kind === 'linkedin' || kind === 'indeed' || kind === 'board') continue;
      map.set(postingKey(u), { id: job.id, status: job.status });
    }
  }
  return map;
}

function defaultDeps(opts: ResolveOptions, override: ResolveDepsOverride): ResolverDeps {
  const http = override.http ?? createResolverHttp({ cacheDir: process.env.PURSUIT_RESOLVE_CACHE_DIR, signal: opts.signal });
  let watchlist = override.watchlist;
  if (!watchlist) {
    try {
      watchlist = loadSources().companies;
    } catch {
      watchlist = [];
    }
  }
  const crawler = override.crawler === null || opts.noCrawl || process.env.PURSUIT_RESOLVE_NO_CRAWL === '1' ? undefined : override.crawler ?? createChromeCrawler();
  const maxSearches = override.maxSearches ?? (Number(process.env.PURSUIT_RESOLVE_MAX_SEARCHES) || 80);
  return {
    http,
    prober: new BoardProber(http),
    linkedin: new LinkedInClient(http),
    searcher: new Searcher(http, override.backends ?? defaultBackends(), maxSearches),
    crawler,
    watchlist,
    now: override.now ?? (() => new Date()),
  };
}

function applyOutcome(job: Job, r: JobResolution, dup: { id: string } | undefined, at: string): void {
  tx(() => {
    const fresh = getJob(job.id);
    if (!fresh) return;
    const m = { ...fresh.atsMeta, linkedinApplyMode: r.linkedinMode, resolveCheckedAt: at };
    if (dup && r.target) {
      updateJob(job.id, { atsMeta: { ...m, resolvedUrl: r.target.postingUrl, duplicateOf: dup.id, resolveOutcome: 'duplicate' } });
      setStatus(job.id, 'skipped', { reason: 'duplicate_posting', duplicateOf: dup.id, url: r.target.postingUrl });
      logEvent('resolve.duplicate', { duplicateOf: dup.id, url: r.target.postingUrl }, job.id);
      return;
    }
    switch (r.outcome) {
      case 'resolved': {
        const t = r.target!;
        const next: Record<string, unknown> = {
          ...m,
          resolvedAt: at,
          resolvedFrom: t.method,
          resolverConfidence: t.confidence,
          originalUrl: fresh.applyUrl,
          resolvedUrl: t.postingUrl,
          resolvedAts: t.kind,
          resolvedTitle: t.title,
          resolvedLocation: t.location,
          resolvedCompanyEvidence: t.companyEvidence,
          resolveOutcome: 'resolved',
          ...atsIdentifiers(t.kind, t.slug, t.postingId),
        };
        if (t.applyEmail) next.applyEmail = t.applyEmail;
        updateJob(job.id, { applyUrl: t.applyUrl, ats: t.ats, atsMeta: next });
        logEvent('resolve.resolved', { url: t.applyUrl, ats: t.kind, method: t.method, confidence: t.confidence, via: t.via, title: t.title, location: t.location }, job.id);
        break;
      }
      case 'easy_apply_only':
        updateJob(job.id, { atsMeta: { ...m, resolveOutcome: 'easy_apply_only' } });
        setStatus(job.id, 'skipped', { reason: 'linkedin_easy_apply_only' });
        logEvent('resolve.easy_apply_only', { reason: r.reason }, job.id);
        break;
      case 'closed':
        updateJob(job.id, { atsMeta: { ...m, resolveOutcome: 'closed', closedUrl: r.closedUrl } });
        setStatus(job.id, 'skipped', { reason: 'closed', where: r.closedWhere, url: r.closedUrl, detail: r.reason });
        logEvent('resolve.closed', { where: r.closedWhere, url: r.closedUrl, reason: r.reason }, job.id);
        break;
      case 'unresolved': {
        const attempts = (typeof fresh.atsMeta.resolveAttempts === 'number' ? fresh.atsMeta.resolveAttempts : 0) + 1;
        updateJob(job.id, { atsMeta: { ...m, resolveAttempts: attempts, resolveFailedAt: at, resolveLastReason: r.reason, resolveOutcome: 'unresolved' } });
        logEvent('resolve.unresolved', { attempts, reason: r.reason, trace: r.trace.slice(-12) }, job.id);
        // Approved but the employer's own page can't be found: don't leave it silently parked in the apply queue.
        if (fresh.status === 'approved' && attempts >= MAX_ATTEMPTS) {
          updateJob(job.id, { needs: [`Pursuit couldn't find this on the employer's own site, so it can't apply for you. Apply here yourself, then mark applied: ${fresh.url}`] });
          setStatus(job.id, 'needs_you', { reason: 'resolve_exhausted', attempts });
        }
        break;
      }
      case 'deferred':
        logEvent('resolve.deferred', { reason: r.reason }, job.id);
        break;
    }
  });
}

/**
 * Resolves employer apply targets for LinkedIn/board jobs. dryRun computes everything but writes nothing.
 */
export async function resolveApplyTargets(opts: ResolveOptions = {}, override: ResolveDepsOverride = {}): Promise<ResolveSummary> {
  const deps = defaultDeps(opts, override);
  const resolver = new Resolver(deps);
  const now = deps.now();
  const jobs = selectJobs({ jobIds: opts.jobIds, force: opts.force, limit: opts.limit ?? 10 }, now);
  const known = knownPostings();
  const summary: ResolveSummary = { considered: jobs.length, resolved: 0, easyApplyOnly: 0, unresolved: 0, closed: 0, duplicates: 0, details: [] };
  // A few jobs at a time: the HTTP layer keeps per-host spacing global, so this only overlaps waits on
  // different hosts. Everything after a resolution (duplicate check, DB write) runs without awaiting.
  const queue = [...jobs];
  const finish = (job: Job, r: JobResolution) => {
      let dup: { id: string } | undefined;
      if (r.outcome === 'resolved' && r.target) {
        for (const key of [postingKey(r.target.postingUrl), postingKey(r.target.applyUrl)]) {
          const other = known.get(key);
          if (other && other.id !== job.id) {
            dup = other;
            break;
          }
        }
        if (!dup) {
          known.set(postingKey(r.target.postingUrl), { id: job.id, status: job.status });
          known.set(postingKey(r.target.applyUrl), { id: job.id, status: job.status });
        }
      }
      const detail: ResolveDetail = {
        jobId: job.id,
        company: job.company,
        title: job.title,
        result: dup ? 'duplicate' : r.outcome,
        reason: r.reason,
        linkedinApplyMode: r.linkedinMode,
      };
      if (r.outcome !== 'resolved' && r.trace.length) detail.notes = r.trace.slice(-4);
      if (r.target) {
        detail.applyUrl = r.target.applyUrl;
        detail.ats = r.target.kind;
        detail.method = r.target.method;
        detail.confidence = r.target.confidence;
        detail.targetTitle = r.target.title;
        detail.targetLocation = r.target.location;
        detail.companyEvidence = r.target.companyEvidence;
        if (r.target.applyEmail) detail.applyEmail = r.target.applyEmail;
      }
      if (dup) detail.duplicateOf = dup.id;
      if (dup) summary.duplicates++;
      else if (r.outcome === 'resolved') summary.resolved++;
      else if (r.outcome === 'easy_apply_only') summary.easyApplyOnly++;
      else if (r.outcome === 'closed') summary.closed++;
      else summary.unresolved++;
      summary.details.push(detail);
      opts.onDetail?.(detail);
      if (!opts.dryRun) applyOutcome(job, r, dup, nowIso());
  };
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (opts.signal?.aborted) return;
      let r: JobResolution;
      try {
        r = await resolver.resolve(job);
      } catch (err) {
        r = { outcome: 'deferred', linkedinMode: 'unknown', reason: `error: ${(err as Error).message?.slice(0, 200)}`, trace: [] };
      }
      finish(job, r);
    }
  };
  try {
    const n = Math.max(1, Math.min(opts.concurrency ?? 3, 6));
    await Promise.all(Array.from({ length: n }, worker));
  } finally {
    await deps.crawler?.close();
  }
  return summary;
}
