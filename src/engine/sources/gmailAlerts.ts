// Job-alert emails → RawJob[] (pure; the inbox module calls parseAlertEmail for 'job_alert' mail).
// Supports LinkedIn, Indeed, IrishJobs.ie, Jobs.ie and Glassdoor alerts in HTML or plain-text form.
// Email content is untrusted data: we only read titles/companies/locations/ids out of it.

import type { InboundEmail, RawJob } from '@/lib/types';
import { cleanInline, decodeEntities, detectCountry, htmlToText, parseSalary } from './normalize';

export type AlertProvider = 'linkedin' | 'indeed' | 'irishjobs' | 'jobsie' | 'glassdoor';

interface JobRef { provider: AlertProvider; id: string; url: string }

interface ProviderSpec {
  id: AlertProvider;
  sender: RegExp;
  /** Splits "Company - Location" lines (Indeed-style). */
  dashSplit: boolean;
  /** Card layout puts the company on the line above the job title (Glassdoor). */
  companyBeforeTitle?: boolean;
  parse(u: URL): JobRef | null;
}

const host = (u: URL) => u.hostname.toLowerCase();
const onDomain = (u: URL, domain: string) => host(u) === domain || host(u).endsWith(`.${domain}`);

/** Job-board ids: "/job/marketing-executive/acme-job105012345", "/Jobs/Marketing-Exec-9876543.aspx", "?id=123456". */
function boardJobId(u: URL): string | undefined {
  const param = u.searchParams.get('id') ?? u.searchParams.get('jobid') ?? u.searchParams.get('JobId') ?? u.searchParams.get('Id');
  if (param && /^\d{5,}$/.test(param)) return param;
  return /job-?(\d{5,})(?:\.aspx)?\/?$/i.exec(u.pathname)?.[1] ?? /-(\d{5,})(?:\.aspx)?\/?$/i.exec(u.pathname)?.[1];
}

const PROVIDERS: ProviderSpec[] = [
  {
    id: 'linkedin',
    sender: /(^|[@.])linkedin\.com$/i,
    dashSplit: false,
    parse(u) {
      if (!onDomain(u, 'linkedin.com')) return null;
      const id = /\/(?:comm\/)?jobs\/view\/(?:[^/?#]*?-)?(\d{6,})/i.exec(u.pathname)?.[1] ?? u.searchParams.get('currentJobId') ?? undefined;
      if (!id || !/^\d{6,}$/.test(id)) return null;
      return { provider: 'linkedin', id, url: `https://www.linkedin.com/jobs/view/${id}` };
    },
  },
  {
    id: 'indeed',
    sender: /(^|[@.])indeed\.[a-z.]+$/i,
    dashSplit: true,
    parse(u) {
      if (!/(^|\.)indeed\.[a-z.]+$/.test(host(u))) return null;
      const jk = u.searchParams.get('jk') ?? u.searchParams.get('vjk');
      if (!jk || !/^[a-z0-9]{8,24}$/i.test(jk)) return null;
      // Tracking hosts (cts.indeed.com, engage.indeed.com) do not serve job pages; country sites do.
      const site = /^(www\.|[a-z]{2}\.)?indeed\.[a-z.]+$/.test(host(u)) && !/^(cts|engage|click)\./.test(host(u)) ? host(u) : 'ie.indeed.com';
      return { provider: 'indeed', id: jk, url: `https://${site}/viewjob?jk=${jk}` };
    },
  },
  {
    id: 'irishjobs',
    sender: /(^|[@.])irishjobs\.ie$/i,
    dashSplit: true,
    parse(u) {
      if (!onDomain(u, 'irishjobs.ie')) return null;
      const id = boardJobId(u);
      return id ? { provider: 'irishjobs', id, url: `https://www.irishjobs.ie${u.pathname}` } : null;
    },
  },
  {
    id: 'jobsie',
    sender: /(^|[@.])jobs\.ie$/i,
    dashSplit: true,
    parse(u) {
      if (!onDomain(u, 'jobs.ie') || onDomain(u, 'irishjobs.ie')) return null;
      const id = boardJobId(u);
      if (!id) return null;
      const keepQuery = /\.aspx$/i.test(u.pathname) && !/\d{5,}/.test(u.pathname);
      return { provider: 'jobsie', id, url: `https://www.jobs.ie${u.pathname}${keepQuery ? `?id=${id}` : ''}` };
    },
  },
  {
    id: 'glassdoor',
    sender: /(^|[@.])glassdoor\.[a-z.]+$/i,
    dashSplit: true,
    companyBeforeTitle: true,
    parse(u) {
      if (!/(^|\.)glassdoor\.[a-z.]+$/.test(host(u))) return null;
      const id = u.searchParams.get('jl') ?? u.searchParams.get('jobListingId');
      if (!id || !/^\d{6,}$/.test(id)) return null;
      const path = /^\/job-listing\//i.test(u.pathname) ? u.pathname : '/job-listing/j';
      return { provider: 'glassdoor', id, url: `https://${host(u)}${path}?jl=${id}` };
    },
  },
];

const WRAPPER_PARAMS = ['url', 'u', 'redirect', 'redirect_url', 'dest', 'destination', 'target', 'link'];

/** Recognises a job link, unwrapping click-tracking redirects that carry the real URL in a parameter. */
export function parseJobLink(href: string, only?: AlertProvider): JobRef | null {
  const candidates: string[] = [decodeEntities(href).trim()];
  for (let depth = 0; depth < 3 && candidates.length; depth++) {
    const current = candidates.shift() as string;
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    for (const p of PROVIDERS) {
      if (only && p.id !== only) continue;
      const ref = p.parse(u);
      if (ref) return ref;
    }
    for (const name of WRAPPER_PARAMS) {
      const inner = u.searchParams.get(name);
      if (inner && /^https?:\/\//i.test(inner)) candidates.push(inner);
    }
  }
  return null;
}

export function providerForSender(fromAddress: string): AlertProvider | undefined {
  const domain = fromAddress.toLowerCase().split('@').pop() ?? '';
  return PROVIDERS.find((p) => p.sender.test(domain))?.id;
}

// ───────────────────────────── Linearising the email ─────────────────────────────

const MARK = '\u0001';
const MARK_END = '\u0002';

interface Line { text: string; ref?: string } // ref = provider:id

const GENERIC_LINK_TEXT = /^(view( this)? job|view jobs?|view details|details|apply( now)?|easy apply|easily apply|see (all|more)( jobs)?|view all|show more|more|learn more|here|click here|unsubscribe|manage alerts?|see jobs?|search jobs)\b[.:!]*$/i;

const NOISE_LINE = new RegExp(
  [
    'easy apply', 'easily apply', 'apply now', 'view job:?', 'view jobs?', 'see (all|more) jobs', 'actively recruiting', 'promoted',
    'be an early applicant', 'early applicant', 'new', 'new!', 'just posted', 'today', 'urgently hiring', 'responsive employer',
    'hiring multiple candidates', 'top applicant', "you('re| are) a top applicant", 'in your network', 'company alumni',
    '\\d+\\+? (connections?|alumni|school alumni|applicants?|benefits?)', '\\d+ (minutes?|hours?|days?|weeks?|months?) ago',
    'posted .*', 'reposted .*', 'job alert', 'unsubscribe', 'manage (job )?alerts?', 'response insights?', 'medical insurance',
    'vision insurance', 'dental insurance', '401\\(k\\)', 'pension', 'quick apply', 'new job', 'featured', 'sponsored', 'save job',
  ].map((p) => `^(${p})$`).join('|'),
  'i',
);
const WORKPLACE_LINE = /^\(?(remote|hybrid|on-site|onsite|in office)\)?$/i;
const SEPARATOR_LINE = /^[-_=*·•]{3,}$/;

function stripTags(html: string): string {
  return cleanInline(html.replace(/<[^>]+>/g, ' '));
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : undefined;
}

function linesFromHtml(html: string, refs: Map<string, JobRef>, provider?: AlertProvider): Line[] {
  const marked = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
    const href = attr(attrs, 'href');
    const ref = href ? parseJobLink(href, provider) : null;
    if (!ref) return inner;
    const key = `${ref.provider}:${ref.id}`;
    if (!refs.has(key)) refs.set(key, ref);
    return `<br>${MARK}${key}${MARK_END}${stripTags(inner)}<br>`;
  });
  return toLines(htmlToText(marked));
}

function linesFromText(text: string, refs: Map<string, JobRef>, provider?: AlertProvider): Line[] {
  const out: Line[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = rawLine;
    let refKey: string | undefined;
    for (const m of rawLine.matchAll(/<?(https?:\/\/[^\s<>"')\]]+)>?/g)) {
      const ref = parseJobLink(m[1], provider);
      if (ref && !refKey) {
        refKey = `${ref.provider}:${ref.id}`;
        if (!refs.has(refKey)) refs.set(refKey, ref);
      }
      line = line.replace(m[0], ' ');
    }
    const text = cleanInline(line).replace(/[:\-–]+$/, '').trim();
    out.push(refKey ? { text, ref: refKey } : { text });
  }
  return out;
}

function toLines(text: string): Line[] {
  return text.split('\n').map((raw) => {
    const m = new RegExp(`^${MARK}([^${MARK_END}]+)${MARK_END}(.*)$`).exec(raw.trim());
    if (m) return { text: cleanInline(m[2]), ref: m[1] };
    return { text: cleanInline(raw.split(MARK).join('').split(MARK_END).join('')) };
  });
}

// ───────────────────────────── Interpreting job blocks ─────────────────────────────

const isMeaningfulTitle = (t: string) => t.length >= 3 && t.length <= 150 && !GENERIC_LINK_TEXT.test(t) && !/^https?:/i.test(t) && /[a-z]/i.test(t);

interface Parsed { title: string; company?: string; location?: string; salaryText?: string; remote?: boolean }

const ESTIMATE_SALARY = /\b(glassdoor|indeed)\s+est\b|\bestimated\b/i;
const RATING_SUFFIX = /\s+\d(?:[.,]\d)?\s*[★☆*]?\s*$/;

function interpretDetails(title: string, details: string[], dashSplit: boolean, company?: string): Parsed {
  const parsed: Parsed = company ? { title, company } : { title };
  for (const raw of details) {
    const line = raw.trim();
    if (!line || NOISE_LINE.test(line) || SEPARATOR_LINE.test(line)) continue;
    if (WORKPLACE_LINE.test(line)) {
      if (/remote/i.test(line)) parsed.remote = true;
      continue;
    }
    if (/[€£$]|\b(EUR|GBP)\b/.test(line) && parseSalary(line, { requireCurrency: true })) {
      // Board estimates ("Glassdoor est.") are not the employer's figure, so they are never stored.
      if (!parsed.salaryText && !ESTIMATE_SALARY.test(line)) parsed.salaryText = line;
      continue;
    }
    if (!parsed.company) {
      const dot = line.split(/\s+[·•|]\s+/);
      if (dot.length >= 2) {
        parsed.company = dot[0].trim();
        parsed.location = dot.slice(1).join(', ').trim();
        continue;
      }
      if (dashSplit) {
        const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(line);
        if (m && (detectCountry(m[2]) !== undefined || m[2].includes(','))) {
          parsed.company = m[1].trim();
          parsed.location = m[2].trim();
          continue;
        }
      }
      if (line.length <= 100) parsed.company = line;
      continue;
    }
    if (!parsed.location && line.length <= 80 && (detectCountry(line) !== undefined || /,/.test(line))) {
      parsed.location = line;
    }
  }
  if (parsed.location) {
    const wp = /\s*\((remote|hybrid|on-site|onsite)\)\s*$/i.exec(parsed.location);
    if (wp) {
      if (/remote/i.test(wp[1])) parsed.remote = true;
      parsed.location = parsed.location.slice(0, wp.index).trim();
    }
  }
  return parsed;
}

const MAX_DETAIL_LINES = 6;

/** Nearest plain line above the title (the company in Glassdoor cards), rating stripped. */
function companyAbove(lines: Line[], at: number): string | undefined {
  for (let i = at - 1; i >= 0 && i >= at - 4; i--) {
    const l = lines[i];
    if (l.ref && isMeaningfulTitle(l.text)) return undefined; // previous job's title
    const text = l.text.replace(RATING_SUFFIX, '').trim();
    if (l.ref || !text || NOISE_LINE.test(text) || SEPARATOR_LINE.test(text) || /^\d(?:[.,]\d)?\s*[★☆*]?$/.test(text)) continue;
    return text.length <= 100 ? text : undefined;
  }
  return undefined;
}

/** HTML-style block: the job link's anchor text is the title; details follow it. */
function parseAnchorStyle(lines: Line[], key: string, spec: ProviderSpec): Parsed | null {
  const at = lines.findIndex((l) => l.ref === key && isMeaningfulTitle(l.text));
  if (at < 0) return null;
  const details: string[] = [];
  for (let i = at + 1; i < lines.length && details.length < MAX_DETAIL_LINES; i++) {
    const l = lines[i];
    if (l.ref && l.ref !== key && isMeaningfulTitle(l.text)) break; // next job's title
    if (l.ref || !l.text) continue;
    if (SEPARATOR_LINE.test(l.text)) break;
    details.push(l.text);
  }
  const company = spec.companyBeforeTitle ? companyAbove(lines, at) : undefined;
  return interpretDetails(lines[at].text, details, spec.dashSplit, company);
}

/** Text-style block: details come first ("Title / Company / Location / View job: URL"). */
function parseTrailingLinkStyle(lines: Line[], key: string, dashSplit: boolean): Parsed | null {
  const at = lines.findIndex((l) => l.ref === key);
  if (at < 0) return null;
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && block.length < MAX_DETAIL_LINES + 1; i--) {
    const l = lines[i];
    if (l.ref || SEPARATOR_LINE.test(l.text)) break;
    if (!l.text) {
      if (block.length) break; // the block is the contiguous run right above the link
      continue;
    }
    block.unshift(l.text);
  }
  const meaningful = block.filter((t) => !NOISE_LINE.test(t));
  const title = meaningful.find(isMeaningfulTitle);
  if (!title) return null;
  return interpretDetails(title, meaningful.slice(meaningful.indexOf(title) + 1), dashSplit);
}

function parseLines(lines: Line[], refs: Map<string, JobRef>, msg: InboundEmail): RawJob[] {
  const jobs: RawJob[] = [];
  for (const [key, ref] of refs) {
    const spec = PROVIDERS.find((p) => p.id === ref.provider) as ProviderSpec;
    const parsed = parseAnchorStyle(lines, key, spec) ?? parseTrailingLinkStyle(lines, key, spec.dashSplit);
    // Indeed/Glassdoor print the star rating right after the name ("Costa Coffee 3.5"); it breaks employer search.
    const company = parsed?.company?.replace(RATING_SUFFIX, '').trim();
    if (!parsed || !company) continue; // without a company we cannot identify the posting reliably
    const job: RawJob = {
      source: 'gmail_alert',
      sourceId: key,
      company,
      title: parsed.title,
      location: parsed.location ?? '',
      url: ref.url,
      postedAt: msg.date || undefined,
      salaryText: parsed.salaryText,
      atsMeta: { alertProvider: ref.provider, providerJobId: ref.id, alertMessageId: msg.messageId, alertSubject: cleanInline(msg.subject).slice(0, 200) },
    };
    if (parsed.remote) job.remote = true;
    jobs.push(job);
  }
  return jobs;
}

/**
 * Extracts jobs from a job-alert email. Returns [] for mail that is not a recognised alert or has no job
 * links. Each job: source 'gmail_alert', sourceId '<provider>:<jobId>', canonical (tracking-free) URL.
 */
export function parseAlertEmail(msg: InboundEmail): RawJob[] {
  const provider = providerForSender(msg.fromAddress ?? '');
  const attempts: (() => { lines: Line[]; refs: Map<string, JobRef> })[] = [];
  if (msg.html?.trim()) attempts.push(() => { const refs = new Map<string, JobRef>(); return { lines: linesFromHtml(msg.html as string, refs, provider), refs }; });
  if (msg.text?.trim()) attempts.push(() => { const refs = new Map<string, JobRef>(); return { lines: linesFromText(msg.text, refs, provider), refs }; });
  if (!msg.html && msg.links?.length) {
    const pseudo = msg.links.map((l) => `<p><a href="${l.href.replace(/"/g, '&quot;')}">${l.text.replace(/</g, '&lt;')}</a></p>`).join('');
    attempts.push(() => { const refs = new Map<string, JobRef>(); return { lines: linesFromHtml(pseudo, refs, provider), refs }; });
  }
  for (const attempt of attempts) {
    try {
      const { lines, refs } = attempt();
      if (!refs.size) continue;
      const jobs = parseLines(lines, refs, msg);
      if (jobs.length) return jobs;
    } catch {
      // Malformed mail: try the next representation.
    }
  }
  return [];
}
