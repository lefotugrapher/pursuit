// SmartRecruiters: https://api.smartrecruiters.com/v1/companies/{id}/postings (+ /postings/{pid} for detail).
//
// Big employers (Primark, H&M) list thousands of store jobs worldwide, so the list is queried per country
// (Ireland + UK) server-side, the title pre-filter runs on the list, and only matches get a detail fetch.

import type { RawJob, SourceAdapter, SourceContext, WatchCompany } from '@/lib/types';
import { type AdapterContext, eachCompany, isoFrom, joinLocations, passesPrefilter, str } from './common';
import { errorMessage } from './http';

interface SrLocation { city?: string; region?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string }
interface SrSummary {
  id: string;
  name?: string;
  uuid?: string;
  refNumber?: string;
  releasedDate?: string;
  location?: SrLocation;
  department?: { label?: string };
  function?: { label?: string };
  typeOfEmployment?: { label?: string };
  experienceLevel?: { id?: string; label?: string };
  company?: { identifier?: string; name?: string };
}
interface SrList { offset?: number; limit?: number; totalFound?: number; content?: SrSummary[] }
interface SrDetail extends SrSummary {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> };
}

export const SR_COUNTRIES = ['ie', 'gb'] as const;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_COUNTRY = 10;
const MAX_DETAILS_PER_COMPANY = 40;
const SECTION_ORDER = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation'];
const COUNTRY_NAMES: Record<string, string> = { ie: 'Ireland', gb: 'United Kingdom' };

function locationOf(loc: SrLocation | undefined): string {
  if (!loc) return '';
  const full = loc.fullLocation?.replace(/,\s*,/g, ',').trim();
  if (full) return joinLocations([full], '');
  return joinLocations([loc.city, loc.region, COUNTRY_NAMES[loc.country ?? ''] ?? loc.country], ', ');
}

function descriptionHtml(detail: SrDetail): string | undefined {
  const sections = detail.jobAd?.sections;
  if (!sections) return undefined;
  const keys = [...SECTION_ORDER, ...Object.keys(sections).filter((k) => !SECTION_ORDER.includes(k))];
  const html = keys
    .map((k) => sections[k])
    .filter((s): s is { title?: string; text?: string } => Boolean(s?.text?.trim()))
    .map((s) => `<h3>${s.title ?? ''}</h3>${s.text}`)
    .join('\n');
  return html || undefined;
}

export function publicPostingUrl(companyId: string, postingId: string): string {
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(companyId)}/${encodeURIComponent(postingId)}`;
}

export function mapSmartRecruitersPosting(summary: SrSummary, company: WatchCompany, detail?: SrDetail): RawJob | null {
  const title = str(summary.name);
  if (!title || !summary.id) return null;
  const fallbackUrl = publicPostingUrl(company.token, summary.id);
  const url = str(detail?.postingUrl) ?? fallbackUrl;
  return {
    source: 'smartrecruiters',
    sourceId: summary.id,
    company: str(summary.company?.name) ?? company.name,
    title,
    location: locationOf(detail?.location ?? summary.location),
    url,
    applyUrl: str(detail?.applyUrl) ?? url,
    descriptionHtml: detail ? descriptionHtml(detail) : undefined,
    postedAt: isoFrom(summary.releasedDate),
    employmentType: str(summary.typeOfEmployment?.label),
    department: str(summary.department?.label) ?? str(summary.function?.label),
    remote: summary.location?.remote === true ? true : undefined,
    atsMeta: {
      ats: 'smartrecruiters',
      companyIdentifier: company.token,
      postingId: summary.id,
      uuid: summary.uuid,
      refNumber: summary.refNumber,
      experienceLevel: summary.experienceLevel?.label,
      detailFetched: Boolean(detail),
      watchName: company.name,
    },
  };
}

async function listCountry(ctx: SourceContext, company: WatchCompany, country: string): Promise<SrSummary[]> {
  const out: SrSummary[] = [];
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.token)}/postings`;
  for (let page = 0; page < MAX_PAGES_PER_COUNTRY; page++) {
    const offset = page * PAGE_SIZE;
    const data = await ctx.http.json<SrList>(`${base}?limit=${PAGE_SIZE}&offset=${offset}&country=${country}`);
    const content = data.content ?? [];
    out.push(...content);
    const total = data.totalFound ?? 0;
    if (content.length < PAGE_SIZE || offset + content.length >= total) break;
  }
  return out;
}

export async function fetchSmartRecruitersCompany(ctx: SourceContext, company: WatchCompany): Promise<RawJob[]> {
  const seen = new Set<string>();
  const matches: SrSummary[] = [];
  for (const country of SR_COUNTRIES) {
    for (const s of await listCountry(ctx, company, country)) {
      if (!s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      if (passesPrefilter(ctx, s.name ?? '', locationOf(s.location), s.location?.remote === true)) matches.push(s);
    }
  }

  const known = (ctx as AdapterContext).haveDetail?.('smartrecruiters');
  const out: RawJob[] = [];
  let details = 0;
  for (const summary of matches) {
    let detail: SrDetail | undefined;
    if (!known?.has(summary.id) && details < MAX_DETAILS_PER_COMPANY) {
      details++;
      try {
        detail = await ctx.http.json<SrDetail>(
          `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.token)}/postings/${encodeURIComponent(summary.id)}`,
        );
      } catch (err) {
        ctx.log.warn(`smartrecruiters: detail failed for ${company.name} ${summary.id}`, { error: errorMessage(err) });
      }
    }
    const raw = mapSmartRecruitersPosting(summary, company, detail);
    if (raw) out.push(raw);
  }
  if (matches.length > MAX_DETAILS_PER_COMPANY) {
    ctx.log.info(`smartrecruiters: ${company.name} had ${matches.length} matches; fetched detail for the first ${MAX_DETAILS_PER_COMPANY}`);
  }
  return out;
}

export const smartrecruiters: SourceAdapter = {
  id: 'smartrecruiters',
  label: 'SmartRecruiters',
  fetch: (ctx) => eachCompany(ctx, 'smartrecruiters', (company) => fetchSmartRecruitersCompany(ctx, company)),
};
