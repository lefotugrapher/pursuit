// Discovery: runs every source adapter, normalises what they return, upserts into `jobs`, records the run.
// Server-only. One adapter failing never stops the others; its error is reported in bySource.

import { loadProfile, loadSources } from '@/lib/config';
import { db, kvSet, logEvent, upsertJob } from '@/lib/db';
import { makeLogger } from '@/lib/log';
import { nowIso } from '@/lib/time';
import type { Http, Logger, NewJob, Profile, RawJob, SourceAdapter, SourceContext, SourceId, SourcesConfig } from '@/lib/types';
import { adzuna } from './adzuna';
import { ashby } from './ashby';
import { boardSearch } from './boardSearch';
import type { AdapterContext } from './common';
import { greenhouse } from './greenhouse';
import { createHttp, errorMessage } from './http';
import { lever } from './lever';
import { linkedinGuest } from './linkedinGuest';
import { normalizeJob } from './normalize';
import { smartrecruiters } from './smartrecruiters';
import { workable } from './workable';

export { detectAts, jobId, normalizeJob } from './normalize';
export { parseAlertEmail } from './gmailAlerts';
export { createHttp } from './http';

/** Pull-based adapters, in run order. Gmail alerts are not here: the inbox module feeds parseAlertEmail. */
export const ADAPTERS: SourceAdapter[] = [greenhouse, lever, ashby, smartrecruiters, workable, boardSearch, linkedinGuest, adzuna];

/** A stored description at least this long counts as "full": adapters may skip re-fetching detail pages. */
const FULL_DESCRIPTION_CHARS = 400;

export interface SourceRunStats { found: number; created: number; error?: string; skipped?: string; ms?: number }
export interface DiscoveryResult { found: number; created: number; bySource: Partial<Record<SourceId, SourceRunStats>> }

export interface DiscoveryOptions {
  /** Run only these sources (default: all ADAPTERS). */
  only?: SourceId[];
  /** Replace the adapter list (tests). */
  adapters?: SourceAdapter[];
}

export type DiscoveryContextInput = Partial<SourceContext> & Pick<AdapterContext, 'haveDetail'>;

/** Source ids already stored with a full description, so detail fetches can be skipped. */
export function storedDetailIds(source: SourceId): ReadonlySet<string> {
  try {
    const rows = db()
      .prepare('SELECT source_id FROM jobs WHERE source = ? AND length(description) >= ?')
      .all(source, FULL_DESCRIPTION_CHARS) as { source_id: string }[];
    return new Set(rows.map((r) => String(r.source_id)));
  } catch {
    return new Set();
  }
}

function buildContext(input: DiscoveryContextInput = {}): AdapterContext {
  const sources: SourcesConfig = input.sources ?? loadSources();
  const profile: Profile = input.profile ?? loadProfile();
  const http: Http = input.http ?? createHttp();
  const log: Logger = input.log ?? makeLogger('discovery');
  const cache = new Map<SourceId, ReadonlySet<string>>();
  const haveDetail = input.haveDetail ?? ((source: SourceId) => {
    let ids = cache.get(source);
    if (!ids) {
      ids = storedDetailIds(source);
      cache.set(source, ids);
    }
    return ids;
  });
  return { sources, profile, http, log, since: input.since, haveDetail };
}

/** Why an adapter has nothing to do this run, or undefined when it should run. */
function skipReason(adapter: SourceAdapter, sources: SourcesConfig): string | undefined {
  const hasCompanies = (ats: string) => sources.companies.some((c) => c.enabled && c.ats === ats && c.token.trim());
  switch (adapter.id) {
    case 'greenhouse': case 'lever': case 'ashby': case 'smartrecruiters': case 'workable':
      return hasCompanies(adapter.id) ? undefined : 'no enabled companies';
    case 'linkedin_guest':
      if (!sources.linkedinGuest.enabled) return 'disabled in sources.json';
      return sources.linkedinGuest.queries.length ? undefined : 'no queries';
    case 'adzuna':
      return sources.adzuna.enabled ? undefined : 'disabled in sources.json';
    case 'board_search':
      return sources.boardSearch?.enabled === false ? 'disabled in sources.json' : undefined;
    default:
      return undefined;
  }
}

function isTooOld(job: NewJob, since: string | undefined): boolean {
  return Boolean(since && job.postedAt && job.postedAt < since);
}

/** Normalises + upserts one adapter's results. Bad rows are logged and skipped. */
function ingest(raws: RawJob[], since: string | undefined, log: Logger, source: SourceId): { found: number; created: number } {
  let found = 0;
  let created = 0;
  for (const raw of raws) {
    let job: NewJob;
    try {
      job = normalizeJob(raw);
    } catch (err) {
      log.warn(`${source}: could not normalise ${raw.sourceId}`, { error: errorMessage(err) });
      continue;
    }
    if (!job.company || !job.title || !job.url || isTooOld(job, since)) continue;
    found++;
    try {
      if (upsertJob(job).created) created++;
    } catch (err) {
      log.warn(`${source}: could not store ${job.company} / ${job.title}`, { error: errorMessage(err) });
    }
  }
  return { found, created };
}

async function runAdapter(adapter: SourceAdapter, ctx: AdapterContext): Promise<SourceRunStats> {
  const started = Date.now();
  const skipped = skipReason(adapter, ctx.sources);
  let stats: SourceRunStats;
  if (skipped) {
    stats = { found: 0, created: 0, skipped };
  } else {
    try {
      const raws = await adapter.fetch(ctx);
      stats = ingest(raws, ctx.since, ctx.log, adapter.id);
    } catch (err) {
      stats = { found: 0, created: 0, error: errorMessage(err) };
      ctx.log.error(`${adapter.label} failed`, { error: stats.error });
    }
  }
  stats.ms = Date.now() - started;
  try {
    kvSet(`source.${adapter.id}.lastRun`, { at: nowIso(), ...stats });
  } catch {
    // A kv write failure must not lose the run result.
  }
  return stats;
}

/**
 * Runs discovery. With no arguments, builds the context from config/*.json, a polite Http and the
 * 'discovery' logger. Adapters run concurrently (they hit different hosts; Http spaces requests per host).
 */
export async function runDiscovery(input?: DiscoveryContextInput, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const started = Date.now();
  const ctx = buildContext(input);
  const adapters = (options.adapters ?? ADAPTERS).filter((a) => !options.only || options.only.includes(a.id));

  const results = await Promise.all(adapters.map(async (a) => [a.id, await runAdapter(a, ctx)] as const));
  const bySource: DiscoveryResult['bySource'] = {};
  let found = 0;
  let created = 0;
  for (const [id, stats] of results) {
    bySource[id] = stats;
    found += stats.found;
    created += stats.created;
  }

  const ms = Date.now() - started;
  const errors = results.filter(([, s]) => s.error).map(([id]) => id);
  logEvent('discovery.run', { found, created, ms, errors, bySource });
  ctx.log.info(`discovery: ${found} found, ${created} new in ${Math.round(ms / 1000)}s${errors.length ? ` (failed: ${errors.join(', ')})` : ''}`);
  return { found, created, bySource };
}
