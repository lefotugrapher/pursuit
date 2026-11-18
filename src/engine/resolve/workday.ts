// Workday career sites ({tenant}.wdN.myworkdayjobs.com/{site} and wdN.myworkdaysite.com/recruiting/{tenant}/{site}):
// the public JSON endpoints the career site itself uses (/wday/cxs/{tenant}/{site}/jobs search + job detail).

import { type ResolverHttp, jsonOf } from './http';
import { cleanTitle, titleSimilarity } from './match';
import type { Posting } from './types';

export interface WorkdaySite { origin: string; tenant: string; site: string; publicBase: string }

/** Parses any Workday career-site URL into its tenant/site, or undefined. */
export function parseWorkdayUrl(raw: string): WorkdaySite | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg[0] === 'wday' && seg[1] === 'cxs' && seg[2] && seg[3]) {
    return { origin: u.origin, tenant: seg[2], site: seg[3], publicBase: host.endsWith('myworkdaysite.com') ? `${u.origin}/recruiting/${seg[2]}/${seg[3]}` : `${u.origin}/${seg[3]}` };
  }
  const rest = /^[a-z]{2}-[A-Z]{2}$/.test(seg[0] ?? '') ? seg.slice(1) : seg;
  if (/\.myworkdayjobs\.com$/.test(host)) {
    const tenant = host.split('.')[0];
    const site = rest[0];
    if (!tenant || !site || site === 'job' || site === 'wday') return undefined;
    return { origin: u.origin, tenant, site, publicBase: `${u.origin}/${site}` };
  }
  if (/(^|\.)myworkdaysite\.com$/.test(host) && rest[0] === 'recruiting' && rest[1] && rest[2]) {
    return { origin: u.origin, tenant: rest[1], site: rest[2], publicBase: `${u.origin}/recruiting/${rest[1]}/${rest[2]}` };
  }
  return undefined;
}

interface CxsList { total?: number; jobPostings?: { title?: string; externalPath?: string; locationsText?: string }[] }
interface CxsDetail {
  jobPostingInfo?: {
    title?: string; location?: string; additionalLocations?: string[]; country?: { descriptor?: string }; externalUrl?: string;
    canApply?: boolean; jobDescription?: string; remoteType?: string;
  };
  hiringOrganization?: { name?: string };
}

export interface WorkdayPosting extends Posting { description?: string }

export function parseWorkdayList(data: unknown): { title: string; externalPath: string; locationsText: string }[] {
  const list = (data as CxsList)?.jobPostings;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => (p.title && p.externalPath ? [{ title: p.title, externalPath: p.externalPath, locationsText: p.locationsText ?? '' }] : []));
}

export function parseWorkdayDetail(data: unknown, site: WorkdaySite, externalPath: string): WorkdayPosting | undefined {
  const info = (data as CxsDetail)?.jobPostingInfo;
  if (!info?.title) return undefined;
  const location = [info.location, ...(info.additionalLocations ?? []), info.country?.descriptor].filter(Boolean).join(' / ');
  const url = info.externalUrl || `${site.publicBase}${externalPath}`;
  const p: WorkdayPosting = { kind: 'workday', slug: site.tenant, title: info.title, location, url, applyUrl: url };
  const org = (data as CxsDetail).hiringOrganization?.name;
  if (org) p.company = org;
  if (info.canApply === false) p.closed = true;
  if (/remote/i.test(info.remoteType ?? '')) p.remote = true;
  if (info.jobDescription) p.description = info.jobDescription.replace(/<[^>]+>/g, ' ').slice(0, 20_000);
  return p;
}

/** Searches a Workday site for the title; returns detailed postings for the closest few. */
export async function searchWorkday(http: ResolverHttp, site: WorkdaySite, title: string, company?: string): Promise<WorkdayPosting[]> {
  const cxs = `${site.origin}/wday/cxs/${site.tenant}/${site.site}`;
  const body = JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: cleanTitle(title, company) });
  const res = await http.post(`${cxs}/jobs`, body, { contentType: 'application/json', headers: { Accept: 'application/json' } });
  const list = parseWorkdayList(jsonOf(res));
  const close = list
    .map((p) => ({ p, s: titleSimilarity(title, p.title, company) }))
    .filter((x) => !x.s.seniorityMismatch && x.s.score >= 0.6)
    .sort((a, b) => b.s.score - a.s.score)
    .slice(0, 3);
  const out: WorkdayPosting[] = [];
  for (const { p } of close) {
    const detail = await http.get(`${cxs}${p.externalPath}`, { headers: { Accept: 'application/json' } });
    const parsed = parseWorkdayDetail(jsonOf(detail), site, p.externalPath);
    if (parsed) out.push(parsed);
  }
  return out;
}
