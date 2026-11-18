// Finds people to contact about a job: emails written in the JD, hiring-manager names, contact
// emails published on the company's own site, and a LinkedIn people-search URL (never fetched).
// Addresses are never guessed: only addresses seen verbatim are stored, and those are verified.

import { upsertContact } from '@/lib/db';
import { log } from '@/lib/log';
import type { Contact, Job, NewContact } from '@/lib/types';
import { domainLabel } from '@/engine/inbox/classify';
import { normalizeEmail } from './text';

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const EXCLUDED_LOCAL = /^(?:no-?reply|do-?not-?reply|donotreply|noreply|privacy|gdpr|dpo|data-?protection|dataprotection|unsubscribe|mailer-daemon|postmaster|abuse|webmaster|example|test|your(?:name|email)?|name|email|user)(?:[._+-].*)?$/i;
const FILE_TLD = /\.(?:png|jpe?g|gif|svg|webp|avif|css|js|ico|pdf)$/i;
const FREE_MAIL = /^(?:gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|aol|eircom|msn)\./i;

const PLATFORM_HOST = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|linkedin\.com|indeed\.[a-z.]+|irishjobs\.ie|jobs\.ie|glassdoor\.[a-z.]+|adzuna\.[a-z.]+|bamboohr\.com|teamtailor\.com|recruitee\.com|personio\.[a-z]+|pinpointhq\.com|rippling\.com|breezy\.hr|jazzhr\.com|applytojob\.com|icims\.com|taleo\.net|successfactors\.[a-z]+|jobvite\.com|hibob\.com|join\.com|occupop\.com|hirehive\.[a-z]+|eploy\.[a-z.]+|publicjobs\.ie|gradireland\.com|totaljobs\.com|reed\.co\.uk|nijobs\.com|google\.com|goo\.gl|bit\.ly)$/i;
const MULTI_PART_SUFFIX = /\.(?:co|com|org|net|ac|gov|ltd|plc)\.[a-z]{2}$/i;

export const CONTACT_FETCH = { timeoutMs: 10_000, delayMs: 1_000, maxBytes: 1_000_000 };
const USER_AGENT = 'Pursuit/1.0 (personal job search)';

// ───────────────────────────── Pure extraction ─────────────────────────────

/** Distinct, contactable addresses in free text (no-reply/privacy/GDPR and image names excluded). */
export function extractEmails(text: string): string[] {
  const out = new Set<string>();
  const decoded = String(text ?? '').replace(/&#64;|%40|\s\[at\]\s|\s\(at\)\s/gi, '@');
  for (const m of decoded.matchAll(EMAIL_IN_TEXT)) {
    const email = normalizeEmail(m[0]);
    if (!email || FILE_TLD.test(email)) continue;
    if (EXCLUDED_LOCAL.test(email.split('@')[0])) continue;
    out.add(email);
  }
  return [...out];
}

const ROLE_WORDS = /^(?:head|manager|director|lead|team|department|chief|vp|vice|senior|our|the|a|an|hr|human|people|talent|recruitment|recruiting|hiring|marketing|communications|comms|digital|content|social|brand|ceo|cmo|coo|cfo|founder|co-founder|partner|officer|executive|coordinator|us|me|him|her|them)$/i;
const NAME = "([A-Z][a-zà-ÿ'’-]+(?:\\s+(?:[A-Z]\\.|[A-Z][a-zà-ÿ'’-]+)){1,2})";

export interface HiringMention { name?: string; role?: string; email?: string }

function isPersonName(candidate: string): boolean {
  const words = candidate.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 3 && !words.some((w) => ROLE_WORDS.test(w.replace(/[.,]$/, '')));
}

function cleanRole(role: string): string | undefined {
  const r = role.replace(/^(?:the|our|a|an)\s+/i, '').replace(/[.,;:]+$/, '').replace(/\s+/g, ' ').trim();
  if (r.length < 4 || r.length > 80) return undefined;
  return /\b(?:head|manager|director|lead|officer|chief|vp|vice president|coordinator|executive|partner|founder)\b/i.test(r) ? r : undefined;
}

/** "reporting to Jane Smith", "contact Jane Smith (jane@x.ie)", "reporting to the Head of Comms". */
export function extractHiringManagers(text: string): HiringMention[] {
  const src = String(text ?? '').replace(/\s+/g, ' ');
  const out: HiringMention[] = [];
  const add = (m: HiringMention) => {
    const key = `${m.name ?? ''}|${m.role ?? ''}`.toLowerCase();
    if (key === '|' || out.some((o) => `${o.name ?? ''}|${o.role ?? ''}`.toLowerCase() === key)) return;
    out.push(m);
  };

  const nameRes = [
    new RegExp(`\\breport(?:s|ing)?\\s+(?:directly\\s+)?(?:in\\s+)?to\\s+${NAME}`, 'g'),
    new RegExp(`\\b(?:please\\s+)?(?:contact|email|e-mail|reach out to|send (?:your )?(?:cv|application)s? to|queries to|questions to)\\s+${NAME}`, 'gi'),
    new RegExp(`\\bhiring manager\\s*(?:is|:|-|–)\\s*${NAME}`, 'gi'),
  ];
  for (const re of nameRes) {
    for (const m of src.matchAll(re)) {
      const name = m[1].trim();
      if (!isPersonName(name)) continue;
      const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 80);
      const email = extractEmails(tail.split(/[.;]\s/)[0] ?? '')[0];
      const role = /^\s*,\s*(?:our\s+|the\s+)?([^,.(]{4,60})/.exec(tail)?.[1];
      add({ name, role: role ? cleanRole(role) : undefined, email });
    }
  }
  for (const m of src.matchAll(/\breport(?:s|ing)?\s+(?:directly\s+)?(?:in\s+)?to\s+((?:the|our)\s+[A-Za-z&,' -]{3,70}?)(?=[.;(]|\s+(?:and|who|you|in|on|within|as)\b|$)/gi)) {
    const role = cleanRole(m[1]);
    if (role) add({ role });
  }
  return out;
}

function registrable(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  const keep = MULTI_PART_SUFFIX.test(h) ? 3 : 2;
  return parts.slice(-keep).join('.');
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The company's own domain: from a JD email on a non-free-mail domain, else the apply/posting URL
 * when it isn't an ATS or job board. Undefined when it can't be known (then nothing is fetched).
 */
export function companyDomain(job: Pick<Job, 'applyUrl' | 'url' | 'description' | 'company'>): string | undefined {
  const companyCompact = job.company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const emailDomains = extractEmails(job.description).map((e) => e.split('@')[1]).filter((d) => !FREE_MAIL.test(d) && !PLATFORM_HOST.test(d));
  // Prefer a JD email domain that looks like the company's name.
  const named = emailDomains.find((d) => {
    const label = domainLabel(d);
    return label.length >= 3 && (companyCompact.includes(label) || label.includes(companyCompact.slice(0, 5)));
  });
  if (named) return registrable(named);
  if (emailDomains[0]) return registrable(emailDomains[0]);
  for (const url of [job.applyUrl, job.url]) {
    const host = hostOf(url);
    if (host && !PLATFORM_HOST.test(host)) return registrable(host);
  }
  return undefined;
}

/** LinkedIn people-search URL (opened by Kayzee in his own browser; never fetched by Pursuit). */
export function linkedinPeopleSearch(keywords: string): string {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords.replace(/\s+/g, ' ').trim())}`;
}

/** "recruiter OR talent OR hiring [OR department] Company" people search. */
export function linkedinSearchUrl(company: string, department?: string): string {
  const terms = ['recruiter', 'talent', 'hiring', department?.trim()].filter(Boolean).join(' OR ');
  return linkedinPeopleSearch(`${terms} ${company}`);
}

function roleFromLocal(email: string): string | undefined {
  const local = email.split('@')[0];
  if (/^(?:careers?|jobs?|recruit\w*|talent\w*|hiring|hr|people|vacancies|apply|applications?)$/i.test(local)) return 'Recruitment inbox';
  if (/^(?:info|hello|contact|enquiries|office|admin|team|mail)$/i.test(local)) return 'General inbox';
  if (/^(?:press|media|pr|comms|communications|marketing)$/i.test(local)) return 'Press / marketing inbox';
  return undefined;
}

// ───────────────────────────── Company site ─────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FindContactsOptions {
  /** Fetch the company homepage/contact/careers pages (default true). */
  fetchSite?: boolean;
  fetchImpl?: FetchLike;
  /** Persist with upsertContact (default true). */
  save?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchPage(url: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(CONTACT_FETCH.timeoutMs),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || (type && !/html|text\/plain/i.test(type))) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await res.text();
    return text.slice(0, CONTACT_FETCH.maxBytes);
  } catch {
    return null;
  }
}

/** Emails on `domain` (or its subdomains) published on the homepage, /contact and /careers. */
export async function siteEmails(domain: string, fetchImpl: FetchLike = globalThis.fetch, delayMs = CONTACT_FETCH.delayMs): Promise<{ email: string; page: string }[]> {
  const pages = [`https://${domain}/`, `https://${domain}/contact`, `https://${domain}/careers`];
  const found = new Map<string, string>();
  for (const [i, page] of pages.entries()) {
    if (i > 0 && delayMs > 0) await sleep(delayMs); // ≤1 request/second to the employer's site
    const html = await fetchPage(page, fetchImpl);
    if (!html) continue;
    for (const email of extractEmails(html)) {
      const host = email.split('@')[1];
      if ((host === domain || host.endsWith(`.${domain}`)) && !found.has(email)) found.set(email, page);
    }
  }
  return [...found].map(([email, page]) => ({ email, page }));
}

// ───────────────────────────── Public API ─────────────────────────────

/** Gathers and stores contacts for a job. Returns the stored contacts (with ids) when saving. */
export async function findContacts(job: Job, opts: FindContactsOptions = {}): Promise<(Contact | NewContact)[]> {
  const found: NewContact[] = [];
  const base = { jobId: job.id, company: job.company };
  const mentions = extractHiringManagers(job.description);
  const mentionByEmail = new Map(mentions.filter((m) => m.email).map((m) => [m.email!, m]));

  for (const email of extractEmails(job.description)) {
    const mention = mentionByEmail.get(email);
    found.push({ ...base, email, emailVerified: true, name: mention?.name, role: mention?.role ?? roleFromLocal(email), source: 'jd', confidence: 0.9 });
  }
  for (const m of mentions) {
    if (m.email) continue;
    found.push({
      ...base,
      name: m.name,
      role: m.role ?? (m.name ? 'Hiring manager (named in JD)' : undefined),
      emailVerified: false,
      linkedinUrl: linkedinPeopleSearch(`${m.name ?? m.role ?? ''} ${job.company}`),
      source: 'jd',
      confidence: m.name ? 0.6 : 0.4,
    });
  }

  if (opts.fetchSite !== false) {
    const domain = companyDomain(job);
    if (domain) {
      try {
        const known = new Set(found.map((c) => c.email).filter(Boolean));
        for (const { email } of await siteEmails(domain, opts.fetchImpl ?? globalThis.fetch)) {
          if (known.has(email)) continue;
          found.push({ ...base, email, emailVerified: true, role: roleFromLocal(email), source: 'company_site', confidence: roleFromLocal(email) === 'Recruitment inbox' ? 0.75 : 0.6 });
        }
      } catch (err) {
        log.warn('outreach', `company site lookup failed for ${domain}`, { error: (err as Error).message });
      }
    }
  }

  found.push({
    ...base,
    role: 'Recruiters / talent team (LinkedIn search)',
    emailVerified: false,
    linkedinUrl: linkedinSearchUrl(job.company, job.department),
    source: 'linkedin_search',
    confidence: 0.3,
  });

  if (opts.save === false) return found;
  return found.map((c) => upsertContact(c));
}
