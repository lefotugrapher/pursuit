// Shared types for the apply-target resolver (LinkedIn/board posting → the same job on the employer's own site).

import type { AtsKind } from '@/lib/types';

/**
 * Finer-grained ATS / site kind than AtsKind. Everything that is not an AtsKind is stored as
 * ats 'unknown' on the job, with the precise kind in atsMeta.resolvedAts.
 */
export type SiteKind =
  | 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'workday'
  | 'teamtailor' | 'personio' | 'recruitee' | 'bamboohr' | 'icims' | 'taleo' | 'successfactors'
  | 'jobvite' | 'pinpoint' | 'breezy' | 'rippling' | 'jazzhr' | 'zoho' | 'phenom' | 'avature' | 'hirehive'
  | 'company' | 'agency' | 'linkedin' | 'indeed' | 'board' | 'unknown';

/** Slug-probeable boards (public JSON/HTML endpoints keyed by a company slug). */
export type ProbeKind =
  | 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'teamtailor' | 'personio' | 'recruitee' | 'bamboohr';

export const PROBE_KINDS: readonly ProbeKind[] = [
  'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'teamtailor', 'personio', 'recruitee', 'bamboohr',
];

/** One open posting on an employer board / careers site. */
export interface Posting {
  kind: SiteKind;
  slug?: string;
  postingId?: string;
  title: string;
  location: string;
  remote?: boolean;
  /** Human posting page. */
  url: string;
  /** Direct application URL when the board exposes one. */
  applyUrl?: string;
  /** Employer name as the board reports it (when it does). */
  company?: string;
  closed?: boolean;
}

export type ResolveMethod = 'linkedin_description' | 'ats_probe' | 'watchlist' | 'search' | 'crawl' | 'agency' | 'direct';

/** How we know the target belongs to the same company. */
export type CompanyEvidence = 'api_name' | 'jsonld_org' | 'domain' | 'slug' | 'page_text' | 'agency_site';

export type LocationVerdict = 'compatible' | 'unknown' | 'incompatible';

export interface MatchVerdict {
  ok: boolean;
  titleScore: number;
  location: LocationVerdict;
  company?: CompanyEvidence;
  confidence: number;
  reason?: string;
}

/** A verified employer posting for a job. */
export interface Target {
  applyUrl: string;
  postingUrl: string;
  kind: SiteKind;
  ats: AtsKind;
  method: ResolveMethod;
  confidence: number;
  title: string;
  location: string;
  company?: string;
  companyEvidence: CompanyEvidence;
  locationVerdict: LocationVerdict;
  titleScore: number;
  applyEmail?: string;
  closed?: boolean;
  /** Where the candidate URL came from (search query, board slug, crawl path...). */
  via?: string;
  /** Board identifiers (Greenhouse board token / Lever company / Ashby board / SR company id / Workable account). */
  slug?: string;
  /** Posting id on that board (Greenhouse job id, Lever/Ashby uuid, SR posting id, Workable shortcode). */
  postingId?: string;
}

export type LinkedInApplyMode = 'easy_apply' | 'offsite' | 'unknown';

export type ResolveOutcome = 'resolved' | 'easy_apply_only' | 'closed' | 'unresolved' | 'deferred' | 'duplicate' | 'error';

export interface ResolveDetail {
  jobId: string;
  company: string;
  title: string;
  result: ResolveOutcome;
  applyUrl?: string;
  ats?: string;
  method?: ResolveMethod;
  confidence?: number;
  reason?: string;
  linkedinApplyMode?: LinkedInApplyMode;
  applyEmail?: string;
  duplicateOf?: string;
  /** What the employer posting itself says (for eyeballing matches). */
  targetTitle?: string;
  targetLocation?: string;
  companyEvidence?: string;
  /** Last steps tried (why it did not resolve). */
  notes?: string[];
}

export interface ResolveSummary {
  considered: number;
  resolved: number;
  easyApplyOnly: number;
  unresolved: number;
  /** Closed on LinkedIn or on the employer site (also counted nowhere else). */
  closed: number;
  /** Same employer posting as another job (skipped; counted nowhere else). */
  duplicates: number;
  details: ResolveDetail[];
}
