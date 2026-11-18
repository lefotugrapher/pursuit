// Shared plumbing for the watchlist (ATS board) adapters.

import type { RawJob, SourceContext, SourceId, WatchCompany } from '@/lib/types';
import { errorMessage } from './http';
import { locationAllowed, titleExcluded, titleMatches } from './normalize';

/**
 * Optional extras runDiscovery passes to adapters on top of the SourceContext contract.
 * Adapters must work without them (tests, other callers).
 */
export interface DiscoveryExtras {
  /** sourceIds already stored with a full description: adapters can skip expensive detail fetches. */
  haveDetail?: (source: SourceId) => ReadonlySet<string>;
}
export type AdapterContext = SourceContext & DiscoveryExtras;

/** Enabled watchlist companies for one ATS. */
export function companiesFor(ctx: SourceContext, ats: WatchCompany['ats']): WatchCompany[] {
  return ctx.sources.companies.filter((c) => c.enabled && c.ats === ats && c.token.trim());
}

/** True when a posting is worth ingesting: title fragment match, not a non-target role, Ireland/UK/remote-compatible location. */
export function passesPrefilter(ctx: SourceContext, title: string, location: string | undefined, remote = false): boolean {
  return titleMatches(title, ctx.sources.titleMustMatch) && !titleExcluded(title) && locationAllowed(location, remote);
}

/**
 * Runs `fetchCompany` for every enabled company of an ATS, one at a time (Http spaces requests per host).
 * One bad board token never sinks the run: failures are logged and skipped. If every company fails the
 * adapter throws, so the run report shows the source as broken rather than silently empty.
 */
export async function eachCompany(
  ctx: SourceContext,
  ats: WatchCompany['ats'],
  fetchCompany: (company: WatchCompany) => Promise<RawJob[]>,
): Promise<RawJob[]> {
  const companies = companiesFor(ctx, ats);
  const jobs: RawJob[] = [];
  const failures: string[] = [];
  for (const company of companies) {
    try {
      const found = await fetchCompany(company);
      jobs.push(...found);
    } catch (err) {
      const message = errorMessage(err);
      failures.push(`${company.name}: ${message}`);
      ctx.log.warn(`${ats}: ${company.name} (${company.token}) failed`, { error: message });
    }
  }
  if (companies.length > 0 && failures.length === companies.length) {
    throw new Error(`all ${companies.length} ${ats} boards failed; first: ${failures[0]}`);
  }
  return jobs;
}

/** Joins non-empty location parts, dropping duplicates (case-insensitive). */
export function joinLocations(parts: (string | undefined | null)[], sep = ' / '): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const p = (part ?? '').replace(/\s+/g, ' ').replace(/(,\s*)+/g, ', ').replace(/^,\s*|,\s*$/g, '').trim();
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out.join(sep);
}

/** "2026-11-10" | ms epoch | ISO → ISO string, or undefined. */
export function isoFrom(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
