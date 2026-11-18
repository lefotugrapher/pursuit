// LinkedIn guest (logged-out) job page: is it Easy Apply (LinkedIn-only) or "Apply on company website"?
// Only /jobs-guest/ pages, plain fetch, ≥ 3 s apart (SPEC §0.4). The first 429/999/auth wall stops
// LinkedIn for the rest of the run. Logged out, LinkedIn does not reveal the external URL, but the
// description sometimes carries a careers link.

import { detailUrl, parseJobPosting } from '@/engine/sources/linkedinGuest';
import { htmlToText } from '@/engine/sources/normalize';
import type { ResolverHttp } from './http';
import { extractEmails, extractUrls } from './page';
import type { LinkedInApplyMode } from './types';

export interface LinkedInApplyInfo {
  mode: LinkedInApplyMode;
  closed: boolean;
  title?: string;
  company?: string;
  location?: string;
  /** linkedin.com/company/{slug} from the top card (a good board-slug candidate). */
  companySlug?: string;
  descriptionText: string;
  /** External links found in the description (LinkedIn links removed). */
  links: string[];
  emails: string[];
  /** Present only if LinkedIn embedded it (normally logged-in only). */
  externalApplyUrl?: string;
}

/** Easy Apply vs offsite from the top-card apply button markup. */
export function detectApplyMode(html: string): LinkedInApplyMode {
  if (/apply-button__offsite-apply-icon-svg|public_jobs_apply-link-offsite/i.test(html)) return 'offsite';
  if (/public_jobs_apply-link-onsite|apply-button--default/i.test(html)) return 'easy_apply';
  return 'unknown';
}

export function parseLinkedInApply(html: string): LinkedInApplyInfo {
  const detail = parseJobPosting(html);
  const descriptionText = htmlToText(detail.descriptionHtml ?? '');
  const hrefs = [...(detail.descriptionHtml ?? '').matchAll(/href="([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  const links = [...new Set([...hrefs, ...extractUrls(descriptionText)])].filter((u) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return (u.startsWith('http://') || u.startsWith('https://')) && !h.endsWith('linkedin.com') && h !== 'lnkd.in';
    } catch {
      return false;
    }
  });
  const companySlug = /topcard__org-name-link[^>]*href="https?:\/\/[a-z]{2,3}\.linkedin\.com\/company\/([^/?"]+)|href="https?:\/\/[a-z]{2,3}\.linkedin\.com\/company\/([^/?"]+)[^"]*"[^>]*topcard__org-name-link/i.exec(html);
  const info: LinkedInApplyInfo = {
    mode: detectApplyMode(html),
    closed: detail.closed,
    title: detail.title,
    company: detail.company,
    location: detail.location,
    descriptionText,
    links,
    emails: extractEmails(descriptionText, hrefs),
  };
  const slug = companySlug?.[1] ?? companySlug?.[2];
  if (slug) info.companySlug = decodeURIComponent(slug).toLowerCase();
  if (detail.applyUrl) info.externalApplyUrl = detail.applyUrl;
  return info;
}

/** LinkedIn job id of a job row (atsMeta.linkedinJobId, or /jobs/view/{id} in its URLs). */
export function linkedInJobId(job: { url?: string; applyUrl?: string; atsMeta?: Record<string, unknown>; source?: string; sourceId?: string }): string | undefined {
  const meta = job.atsMeta?.linkedinJobId;
  if (typeof meta === 'string' && /^\d+$/.test(meta)) return meta;
  for (const u of [job.url, job.applyUrl]) {
    const m = /linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/i.exec(u ?? '');
    if (m) return m[1];
  }
  if (job.source === 'linkedin_guest' && job.sourceId && /^\d+$/.test(job.sourceId)) return job.sourceId;
  return undefined;
}

export const MAX_LINKEDIN_REQUESTS_PER_RUN = 60;

export class LinkedInClient {
  private blocked: string | undefined;
  private requests = 0;
  constructor(private readonly http: ResolverHttp) {}

  get blockedReason(): string | undefined {
    return this.blocked;
  }

  async fetch(id: string): Promise<{ info?: LinkedInApplyInfo; blocked?: string; error?: string }> {
    if (this.blocked) return { blocked: this.blocked };
    if (this.requests >= MAX_LINKEDIN_REQUESTS_PER_RUN) return { blocked: 'per-run LinkedIn budget used' };
    this.requests++;
    const url = detailUrl(id);
    const res = await this.http.get(url, { minIntervalMs: 3_500 });
    if (res.status === 429 || res.status === 999 || res.status === 403 || /\/(authwall|login|checkpoint|uas\/login)/i.test(res.url)) {
      this.blocked = `HTTP ${res.status}${res.url !== url ? ' (redirected to sign-in)' : ''}`;
      this.http.park('www.linkedin.com', this.blocked);
      return { blocked: this.blocked };
    }
    // A 404 is not proof the job closed (LinkedIn glitches); only the visible notice counts.
    if (res.status < 200 || res.status >= 300) return { error: res.error ?? `HTTP ${res.status}` };
    return { info: parseLinkedInApply(res.text) };
  }
}
