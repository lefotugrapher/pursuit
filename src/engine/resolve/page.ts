// DOM-less analysis of a fetched (or browser-rendered) page: titles, schema.org JobPosting JSON-LD,
// visible text, links, iframes, visible e-mail addresses, "closed" notices and bot walls.
// Page content is data: nothing here is ever executed or followed blindly.

import { cleanInline, decodeEntities, htmlToText } from '@/engine/sources/normalize';

export interface JobPostingLd {
  title?: string;
  hiringOrganization?: string;
  location?: string;
  remote?: boolean;
  validThrough?: string;
  url?: string;
  datePosted?: string;
}

export interface PageLink { href: string; text: string }

export interface PageInfo {
  url: string;
  status?: number;
  title: string;
  ogTitle?: string;
  ogSiteName?: string;
  h1: string[];
  jsonLd: JobPostingLd[];
  text: string;
  links: PageLink[];
  iframes: string[];
  emails: string[];
  /** Matched "no longer accepting applications" style notice. */
  closed?: string;
  /** Matched bot-check / CAPTCHA wall (we never try to get past it). */
  botWall?: string;
}

const MAX_TEXT = 80_000;
const MAX_LINKS = 2_000;

// ───────────────────────────── Closed + bot walls ─────────────────────────────

export const CLOSED_PATTERNS: RegExp[] = [
  /\bno longer accepting applications\b/i,
  /\b(position|role|job|vacancy) has (already )?been filled\b/i,
  /\b(this )?(job|position|posting|vacancy|role|advert) (is )?no longer (available|open|active|live)\b/i,
  /\bjob you are looking for is no longer\b/i,
  /\b(this )?(job|posting|vacancy|advert|position) has (now )?(expired|been closed|closed)\b/i,
  /\bapplications (for this (role|position|job|vacancy) )?(are|have) (now )?closed\b/i,
  /\b(this )?vacancy (is|has) (now )?closed\b/i,
  /\bthe closing date (for (this|applications) (role|job|vacancy)? ?)?has (now )?passed\b/i,
  /\bthis job (is )?(closed|expired)\b/i,
];

const BOT_TITLE = /^(just a moment|attention required|access denied|pardon our interruption|are you a robot|security check|verify you are human|one more step|request unsuccessful)/i;
const BOT_TEXT: RegExp[] = [
  /\bverify (that )?you are (a )?human\b/i,
  /\bchecking (if the site connection is secure|your browser)\b/i,
  /\benable javascript and cookies to continue\b/i,
  /\bunusual traffic from your (computer|network)\b/i,
  /\bplease complete the (security check|following challenge)\b/i,
  /\bpress (and|&) hold\b/i,
];

export function findClosedNotice(text: string): string | undefined {
  const head = text.slice(0, 30_000);
  for (const re of CLOSED_PATTERNS) {
    const m = re.exec(head);
    if (m) return m[0];
  }
  return undefined;
}

export function findBotWall(title: string, text: string): string | undefined {
  if (BOT_TITLE.test(title.trim())) return title.trim().slice(0, 80);
  const head = text.slice(0, 5_000);
  for (const re of BOT_TEXT) {
    const m = re.exec(head);
    if (m) return m[0];
  }
  return undefined;
}

// ───────────────────────────── E-mails + URLs ─────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const JUNK_LOCAL = /^(no-?reply|donotreply|do-not-reply|privacy|gdpr|data-?protection|dpo|unsubscribe|abuse|postmaster|webmaster|press|media|accounts?|invoices?|billing|legal|compliance|security|support|sales|marketing|example|test|your\.?name|name|firstname|first\.last|email|user)$/i;
const JUNK_DOMAIN = /(example\.(com|org|net)|sentry|wixpress|domain\.com|email\.com|yourcompany|company\.com|mysite|godaddy)/i;

/** E-mail addresses written on the page (and mailto: links). Never guessed or completed. */
export function extractEmails(text: string, hrefs: string[] = []): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const e = raw.trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:]+$/, '').toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(e)) return;
    const [local, domain] = e.split('@');
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) || /@\dx\b/.test(e)) return;
    if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(domain)) return;
    if (!found.includes(e)) found.push(e);
  };
  for (const h of hrefs) if (/^mailto:/i.test(h)) add(decodeURIComponent(h));
  for (const m of text.matchAll(EMAIL_RE)) add(m[0]);
  return found;
}

/** http(s) URLs written as plain text ("Apply at https://..." / "www.company.ie/careers"). */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"'()]+/gi)) {
    let u = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (/^www\./i.test(u)) u = `https://${u}`;
    try {
      const parsed = new URL(u);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') out.push(parsed.toString());
    } catch {
      // not a URL
    }
  }
  return [...new Set(out)];
}

// ───────────────────────────── JSON-LD ─────────────────────────────

function asText(v: unknown): string | undefined {
  if (typeof v === 'string') return cleanInline(decodeEntities(v)) || undefined;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && 'name' in v) return asText((v as { name?: unknown }).name);
  return undefined;
}

function addressText(loc: unknown): string | undefined {
  if (!loc || typeof loc !== 'object') return asText(loc);
  const o = loc as Record<string, unknown>;
  const addr = (o.address ?? o) as Record<string, unknown> | string;
  if (typeof addr === 'string') return cleanInline(addr);
  if (!addr || typeof addr !== 'object') return asText(o.name);
  const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].map(asText).filter(Boolean);
  return parts.length ? parts.join(', ') : asText(o.name);
}

function isJobPosting(o: Record<string, unknown>): boolean {
  const t = o['@type'];
  return t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
}

function toPosting(o: Record<string, unknown>): JobPostingLd {
  const locs = Array.isArray(o.jobLocation) ? o.jobLocation : o.jobLocation ? [o.jobLocation] : [];
  const location = locs.map(addressText).filter(Boolean).join(' / ');
  const req = Array.isArray(o.applicantLocationRequirements) ? o.applicantLocationRequirements : o.applicantLocationRequirements ? [o.applicantLocationRequirements] : [];
  const reqText = req.map(asText).filter(Boolean).join(' / ');
  const remote = typeof o.jobLocationType === 'string' && /telecommute/i.test(o.jobLocationType);
  const p: JobPostingLd = {
    title: asText(o.title) ?? asText(o.name),
    hiringOrganization: asText(o.hiringOrganization),
    location: [location, remote && reqText ? reqText : ''].filter(Boolean).join(' / ') || undefined,
    validThrough: asText(o.validThrough),
    url: asText(o.url),
    datePosted: asText(o.datePosted),
  };
  if (remote) p.remote = true;
  return p;
}

/** schema.org JobPosting objects from <script type="application/ld+json"> blocks (any nesting/@graph). */
export function parseJobPostingLd(blocks: string[]): JobPostingLd[] {
  const out: JobPostingLd[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (isJobPosting(o)) out.push(toPosting(o));
    if (o['@graph']) walk(o['@graph'], depth + 1);
  };
  for (const raw of blocks) {
    const body = raw.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').replace(/^\s*<!--|-->\s*$/g, '').trim();
    if (!body) continue;
    try {
      walk(JSON.parse(body), 0);
    } catch {
      // malformed JSON-LD is common; ignore the block
    }
  }
  return out;
}

// ───────────────────────────── HTML → PageInfo ─────────────────────────────

const stripTags = (html: string) => cleanInline(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '));

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
}

function absolutize(href: string, base: string): string | undefined {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function metaContent(html: string, key: string): string | undefined {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const prop = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (prop === key) {
      const c = attr(tag, 'content');
      if (c) return cleanInline(c);
    }
  }
  return undefined;
}

export function analyzeHtml(html: string, baseUrl: string, status?: number): PageInfo {
  const src = html ?? '';
  const title = stripTags(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] ?? '');
  const h1 = [...src.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])).filter(Boolean).slice(0, 5);
  const ldBlocks = [...src.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const links: PageLink[] = [];
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= MAX_LINKS) break;
    const href = attr(m[1], 'href');
    if (!href || /^(javascript:|#|tel:)/i.test(href)) continue;
    const abs = absolutize(href, baseUrl);
    if (!abs) continue;
    const text = stripTags(m[2]) || attr(m[1], 'aria-label') || attr(m[1], 'title') || '';
    links.push({ href: abs, text });
  }
  const iframes: string[] = [];
  for (const m of src.matchAll(/<iframe\b([^>]*)>/gi)) {
    const s = attr(m[1], 'src') ?? attr(m[1], 'data-src');
    const abs = s ? absolutize(s, baseUrl) : undefined;
    if (abs) iframes.push(abs);
  }
  let text = htmlToText(src);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  return buildPageInfo({
    url: baseUrl, status, title, h1, ldBlocks, text, links, iframes,
    ogTitle: metaContent(src, 'og:title'), ogSiteName: metaContent(src, 'og:site_name'),
  });
}

export interface RawPage {
  url: string;
  status?: number;
  title: string;
  h1: string[];
  ldBlocks: string[];
  text: string;
  links: PageLink[];
  iframes: string[];
  ogTitle?: string;
  ogSiteName?: string;
}

/** Shared by the HTTP analyser and the headless crawler (which extracts the same raw pieces in-page). */
export function buildPageInfo(raw: RawPage): PageInfo {
  const text = raw.text.length > MAX_TEXT ? raw.text.slice(0, MAX_TEXT) : raw.text;
  const info: PageInfo = {
    url: raw.url,
    status: raw.status,
    title: cleanInline(raw.title),
    h1: raw.h1.map((h) => cleanInline(h)).filter(Boolean),
    jsonLd: parseJobPostingLd(raw.ldBlocks),
    text,
    links: raw.links.slice(0, MAX_LINKS),
    iframes: raw.iframes,
    emails: extractEmails(text, raw.links.map((l) => l.href)),
  };
  if (raw.ogTitle) info.ogTitle = raw.ogTitle;
  if (raw.ogSiteName) info.ogSiteName = raw.ogSiteName;
  const closed = findClosedNotice(text);
  if (closed) info.closed = closed;
  const wall = findBotWall(info.title, text);
  if (wall) info.botWall = wall;
  return info;
}

/** Title candidates in priority order: JSON-LD, og:title, h1, <title> (site names split off). */
export function pageTitles(info: PageInfo): string[] {
  const out: string[] = [];
  const add = (t?: string) => {
    const v = cleanInline(t ?? '');
    if (v && v.length <= 200 && !out.includes(v)) out.push(v);
  };
  for (const p of info.jsonLd) add(p.title);
  add(info.ogTitle);
  for (const h of info.h1) add(h);
  add(info.title);
  for (const t of [info.ogTitle, info.title]) {
    for (const part of (t ?? '').split(/\s+[|•·]\s+|\s+[-–—]\s+(?=[^-–—]*$)/)) add(part);
  }
  return out;
}

/** JSON-LD validThrough in the past → closed. */
export function expiredByLd(info: PageInfo, now: Date): string | undefined {
  for (const p of info.jsonLd) {
    if (!p.validThrough) continue;
    const t = Date.parse(p.validThrough);
    if (Number.isFinite(t) && t < now.getTime() - 86_400_000) return `validThrough ${p.validThrough}`;
  }
  return undefined;
}
