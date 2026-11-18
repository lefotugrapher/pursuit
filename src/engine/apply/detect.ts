// ATS / site detection from a URL or a live page, and blocker detection on a live page
// (SPEC §0.3: hand off, never bypass).

import type { Page } from 'playwright-core';
import type { AtsKind, Blocker } from '@/lib/types';
import { EMBEDDED_ATS_JS, PAGE_FACTS_JS, SITE_MARKERS_JS, type PageFacts } from './inpage';

/**
 * Finer-grained than AtsKind (which is part of the shared contract and can't grow here): every site
 * the apply runner knows how to drive, plus the account-wall ATSs it must hand off.
 */
export type SiteKind =
  | AtsKind
  | 'teamtailor' | 'personio' | 'recruitee' | 'bamboohr'
  | 'icims' | 'taleo' | 'successfactors' | 'oracle' | 'adp' | 'ukg' | 'brassring';

const HOST_RULES: { kind: SiteKind; test: (host: string, url: URL) => boolean }[] = [
  { kind: 'greenhouse', test: (h, u) => h.endsWith('greenhouse.io') || u.searchParams.has('gh_jid') },
  { kind: 'lever', test: (h) => h === 'lever.co' || h.endsWith('.lever.co') },
  { kind: 'ashby', test: (h) => h.endsWith('ashbyhq.com') },
  { kind: 'smartrecruiters', test: (h) => h.endsWith('smartrecruiters.com') },
  { kind: 'workable', test: (h) => h.endsWith('workable.com') },
  { kind: 'workday', test: (h) => h.endsWith('myworkdayjobs.com') || h.endsWith('myworkday.com') || h.includes('.workday.') || h.endsWith('workdayjobs.com') },
  { kind: 'linkedin', test: (h) => h === 'linkedin.com' || h.endsWith('.linkedin.com') || h === 'lnkd.in' },
  { kind: 'indeed', test: (h) => h === 'indeed.com' || h.endsWith('.indeed.com') || /(^|\.)indeed\.[a-z.]+$/.test(h) },
];

const SITE_RULES: { kind: SiteKind; test: (host: string, url: URL) => boolean }[] = [
  { kind: 'teamtailor', test: (h) => h.endsWith('.teamtailor.com') },
  { kind: 'personio', test: (h) => /\.jobs\.personio\.(de|com)$/.test(h) },
  { kind: 'recruitee', test: (h) => h.endsWith('.recruitee.com') },
  { kind: 'bamboohr', test: (h) => h.endsWith('.bamboohr.com') },
  { kind: 'icims', test: (h) => h.endsWith('.icims.com') },
  { kind: 'taleo', test: (h) => h.endsWith('.taleo.net') },
  { kind: 'successfactors', test: (h) => /(^|\.)(successfactors\.(com|eu)|sapsf\.(com|eu|cn))$/.test(h) || h.endsWith('.jobs2web.com') },
  { kind: 'oracle', test: (h, u) => h.endsWith('.oraclecloud.com') && /\/hcmui\//i.test(u.pathname) },
  { kind: 'adp', test: (h) => h === 'workforcenow.adp.com' || h === 'myjobs.adp.com' || h === 'recruiting.adp.com' },
  { kind: 'ukg', test: (h) => /^recruiting\d*\.ultipro\.com$/.test(h) || h.endsWith('.ukg.net') },
  { kind: 'brassring', test: (h) => h.endsWith('brassring.com') },
];

function parse(url: string): { host: string; parsed: URL } | null {
  try {
    const parsed = new URL((url ?? '').trim());
    return { host: parsed.hostname.toLowerCase().replace(/^www\./, ''), parsed };
  } catch {
    return null;
  }
}

/** Which applicant-tracking system a posting/apply URL belongs to (shared-contract kinds only). */
export function detectAts(url: string): AtsKind {
  const raw = (url ?? '').trim();
  if (/^mailto:/i.test(raw)) return 'email';
  const p = parse(raw);
  if (!p) return 'unknown';
  for (const rule of HOST_RULES) if (rule.test(p.host, p.parsed)) return rule.kind as AtsKind;
  return 'unknown';
}

/** Like detectAts, but also knows Teamtailor, Personio, Recruitee, BambooHR and the account-wall ATSs. */
export function detectSite(url: string): SiteKind {
  const ats = detectAts(url);
  if (ats !== 'unknown') return ats;
  const p = parse(url);
  if (!p) return 'unknown';
  for (const rule of SITE_RULES) if (rule.test(p.host, p.parsed)) return rule.kind;
  return 'unknown';
}

/** Human name for a site, for needs/messages. */
export function siteLabel(site: SiteKind | string | undefined): string {
  const names: Record<string, string> = {
    greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', smartrecruiters: 'SmartRecruiters', workable: 'Workable',
    workday: 'Workday', linkedin: 'LinkedIn', indeed: 'Indeed', email: 'Email', teamtailor: 'Teamtailor', personio: 'Personio',
    recruitee: 'Recruitee', bamboohr: 'BambooHR', icims: 'iCIMS', taleo: 'Taleo', successfactors: 'SuccessFactors',
    oracle: 'Oracle Recruiting', adp: 'ADP', ukg: 'UKG', brassring: 'BrassRing',
  };
  return (site && names[site]) || 'This site';
}

/** ATSs whose forms this runner fills and may submit. Everything else gets the universal filler or a handoff. */
export const AUTOMATED_ATS: readonly AtsKind[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'];
export const AUTOMATED_SITES: readonly SiteKind[] = [...AUTOMATED_ATS, 'teamtailor', 'personio', 'recruitee', 'bamboohr'];

/** ATSs that always want a candidate account (sign in / create account) before applying. */
export const ACCOUNT_WALL_SITES: readonly SiteKind[] = ['workday', 'icims', 'taleo', 'successfactors', 'oracle', 'adp', 'ukg', 'brassring'];

/** Sites the runner never drives (SPEC §0.4) — postings there are not resolved to an employer yet. */
export const NEVER_DRIVE_SITES: readonly SiteKind[] = ['linkedin', 'indeed'];

/** ATSs we never drive in the browser: account walls, or sites we must not automate (LinkedIn, SPEC §0.4). */
export const HANDOFF_ONLY_ATS: readonly AtsKind[] = ['linkedin', 'indeed', 'workday', 'email'];

export interface BlockerReport {
  blockers: Blocker[];
  details: string[];
  passiveCaptcha: string[];
}

const LOGIN_TEXT = [
  /\b(sign|log)\s?in to (apply|continue|your account|start your application|submit)\b/i,
  /\bplease (sign|log)\s?in\b/i,
  /\byou must be (signed|logged) in\b/i,
  /\b(sign|log)\s?in (or|and) (create|register)\b/i,
  /\bcandidate (sign|log)\s?in\b/i,
];
const ACCOUNT_TEXT = [
  /\bcreate (an |your )?(candidate )?account to (apply|continue)\b/i,
  /\bregister to apply\b/i,
  /\bconfirm (your )?password\b/i,
  /\bcreate (an |your )?(candidate )?account\b/i,
  /\bnew (user|candidate)\? ?(register|sign up|create)/i,
  /\balready have an account\??\s*(sign|log)\s?in\b/i,
  /\bverify (your )?(new )?password\b/i,
];
const MFA_TEXT = [
  /\btwo[- ]factor authentication\b/i,
  /\benter the (verification )?code (we|that we) sent\b/i,
  /\bone[- ]time (pass)?code\b/i,
  /\bverification code (has been )?sent\b/i,
];
const CLOSED_TEXT = [
  /\bno longer accepting applications\b/i,
  /\b(position|role|job|vacancy) has (already )?been filled\b/i,
  /\b(this )?(job|position|posting|vacancy|role) (is )?no longer (available|open|active)\b/i,
  /\bjob you are looking for is no longer\b/i,
  /\b(this )?(job|posting|vacancy) has (expired|been closed)\b/i,
  /\bapplications (for this (role|position|job) )?(are|have) (now )?closed\b/i,
];
const BOT_WALL_TEXT = [
  /\bverify (that )?you are (a )?human\b/i,
  /\bchecking (if the site connection is secure|your browser)\b/i,
  /\bare you a robot\b/i,
  /\bpress (and|&) hold\b/i,
  /\bplease enable js and disable any ad blocker\b/i,           // DataDome
  /\blet'?s confirm you are human\b/i,                          // AWS WAF
  /\bincapsula incident id\b/i,                                 // Imperva
  /\bunusual traffic from your (computer )?network\b/i,
  /\bcomplete the security check\b/i,
  /\bI'?m not a robot\b/i,
];

function firstMatch(patterns: RegExp[], text: string): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}

const SIGN_IN_BUTTON = /^(sign ?in|log ?in|login|candidate (sign ?in|log ?in))\b/i;
const CREATE_BUTTON = /^(create (an |your )?(candidate )?account|register|sign ?up|new (user|candidate))\b/i;

/** Pure decision logic over collected page facts (unit-testable without a browser). */
export function blockersFromFacts(facts: PageFacts): BlockerReport {
  const blockers = new Set<Blocker>();
  const details: string[] = [];
  const text = facts.text ?? '';

  if (facts.captchaVisible.length) {
    blockers.add('captcha');
    details.push(`captcha widget: ${facts.captchaVisible.slice(0, 3).join(', ')}`);
  }
  const wall = firstMatch(BOT_WALL_TEXT, `${facts.title} ${text}`);
  if (wall) {
    blockers.add('captcha');
    details.push(`bot check: "${wall}"`);
  }

  const account = firstMatch(ACCOUNT_TEXT, text);
  const login = firstMatch(LOGIN_TEXT, text);
  const authButtons = facts.authButtons ?? [];
  const signInButton = authButtons.some((t) => SIGN_IN_BUTTON.test(t));
  const createButton = authButtons.some((t) => CREATE_BUTTON.test(t));
  const noApplicationForm = (facts.fileInputs ?? 0) === 0 && facts.hasFormControls <= 6;
  const wallMarker = (facts.accountWallMarkers ?? [])[0];
  if (
    facts.passwordFields >= 2
    || (account && (facts.passwordFields > 0 || facts.hasFormControls <= 4))
    || (signInButton && createButton && noApplicationForm)
    || (wallMarker && noApplicationForm)
  ) {
    blockers.add('account_required');
    details.push(account ? `account wall: "${account}"` : wallMarker ? `account wall: ${wallMarker}` : signInButton && createButton ? 'account wall: sign in / create account' : 'account creation form (password + confirm)');
  } else if (facts.passwordFields > 0 || login) {
    blockers.add('login');
    details.push(login ? `login wall: "${login}"` : 'password field on page');
  }

  const mfa = firstMatch(MFA_TEXT, text);
  if (mfa) {
    blockers.add('mfa');
    details.push(`verification: "${mfa}"`);
  }

  const closed = firstMatch(CLOSED_TEXT, text);
  if (closed) {
    blockers.add('closed');
    details.push(`closed: "${closed}"`);
  }

  return { blockers: [...blockers], details, passiveCaptcha: facts.captchaPassive };
}

const CAPTCHA_FRAME_RE = /hcaptcha\.com|recaptcha|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha-delivery\.com|geetest|perimeterx|px-cloud|awswaf|friendlycaptcha/;

export async function collectPageFacts(page: Page): Promise<PageFacts> {
  const facts = (await page.evaluate(`(${PAGE_FACTS_JS})()`)) as PageFacts;
  // Captcha widgets often live in cross-origin child frames; their URLs are visible from Node.
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const u = frame.url().toLowerCase();
    if (!CAPTCHA_FRAME_RE.test(u)) continue;
    const invisible = /size=invisible|checkbox-invisible/.test(u);
    const el = await frame.frameElement().catch(() => null);
    const box = el ? await el.boundingBox().catch(() => null) : null;
    const big = !!box && box.width >= 40 && box.height >= 40;
    const visible = el ? await el.isVisible().catch(() => false) : false;
    const label = `frame[${u.slice(0, 80)}]`;
    if (/arkoselabs|funcaptcha/.test(u) || (!invisible && big && visible)) {
      if (!facts.captchaVisible.includes(label)) facts.captchaVisible.push(label);
    } else if (!facts.captchaPassive.includes(label)) facts.captchaPassive.push(label);
  }
  return facts;
}

/** Full blocker report for the current page. */
export async function scanBlockers(page: Page): Promise<BlockerReport> {
  return blockersFromFacts(await collectPageFacts(page));
}

/**
 * Blockers that stop an automated application (captcha, login/account walls, MFA, closed posting).
 * A passive/invisible captcha (e.g. Lever's invisible hCaptcha) is not a blocker by itself: we never
 * touch it, and if it escalates into a visible challenge after submit the runner hands off.
 */
export async function detectBlockers(page: Page): Promise<Blocker[]> {
  return (await scanBlockers(page)).blockers;
}

/** Blockers that mean "stop touching this page now" (never type into a login form or past a captcha). */
export const HARD_BLOCKERS: readonly Blocker[] = ['captcha', 'login', 'account_required', 'mfa', 'closed'];

export function hardBlockers(blockers: readonly Blocker[]): Blocker[] {
  return blockers.filter((b) => HARD_BLOCKERS.includes(b));
}

/** src of an embedded ATS iframe (Greenhouse, Lever, Ashby, SmartRecruiters, Workable...) on a company page. */
export async function findEmbeddedAtsUrl(page: Page): Promise<string | null> {
  const src = (await page.evaluate(`(${EMBEDDED_ATS_JS})()`).catch(() => null)) as string | null;
  return src && /^https?:/i.test(src) ? src : null;
}

/** Recognises ATS-hosted pages served from a company's own domain (custom career-site domains). */
export async function detectSiteFromPage(page: Page): Promise<SiteKind> {
  const fromUrl = detectSite(page.url());
  if (fromUrl !== 'unknown') return fromUrl;
  const marker = (await page.evaluate(`(${SITE_MARKERS_JS})()`).catch(() => null)) as string | null;
  return (marker as SiteKind | null) ?? 'unknown';
}

/** Human wording for a blocker, used in job.needs. */
export function describeBlocker(b: Blocker, ats?: SiteKind): string {
  const site = ats && ats !== 'unknown' ? siteLabel(ats) : 'This site';
  switch (b) {
    case 'captcha': return 'CAPTCHA or bot check on the page: complete it yourself';
    case 'login': return 'Login required: sign in yourself, then apply';
    case 'account_required': return `${site} wants you to sign in or create an account before applying: do that yourself`;
    case 'mfa': return 'A verification code / MFA step is waiting for you';
    case 'closed': return 'Posting looks closed (no longer accepting applications)';
    case 'unsupported': return `${ats && ats !== 'unknown' ? ats : 'This site'} applications are not automated: apply yourself`;
    case 'attestation': return 'A legal attestation / consent checkbox needs your decision';
    case 'unknown_required_field': return 'Required questions the answer bank cannot answer';
  }
}
