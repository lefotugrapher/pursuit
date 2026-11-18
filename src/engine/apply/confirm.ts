// Submission confirmation (SPEC §0.5: "submitted means confirmed"). An application only counts once
// the ATS shows a visible success state: a confirmation text that was not on the page before submit,
// a success container, or a navigation to a confirmation/thank-you URL.

import type { Page } from 'playwright-core';
import { scanBlockers } from './detect';
import { VALIDATION_ERRORS_JS } from './inpage';

export const CONFIRM_PATTERNS: readonly RegExp[] = [
  /thank you for applying/i,
  /thanks for applying/i,
  /application (has been |was )?(successfully )?submitted/i,
  /application has been received/i,
  /we(?:'|’)?ve received your application/i,
  /we have received your application/i,
  /thank you for your application/i,
  /thanks for your application/i,
  /your application (has been|was) (successfully )?(sent|received)/i,
  /application (sent|received) successfully/i,
  /you(?:'|’)?ve successfully applied|you have successfully applied/i,
  /vielen dank für (deine|ihre) bewerbung/i,
  /wir haben (deine|ihre) bewerbung erhalten/i,
];

/** The site refused a duplicate: not a fresh confirmation, so never `applied`. */
export const ALREADY_APPLIED_PATTERNS: readonly RegExp[] = [
  /you(?:'|’)?ve already applied/i,
  /you have already applied/i,
  /already (submitted|received) (an |your )?application/i,
];

/** URL path segments that ATSs navigate to after a successful submit (Greenhouse /confirmation, Lever /thanks). */
export const CONFIRM_URL_PATTERN = /\/(confirmation|confirm|thank[-_]?you|thanks|application[-_]submitted|success)(?:[/?#]|$)/i;

/** Success containers rendered in place of the form (single-page ATSs such as Ashby). */
export const SUCCESS_SELECTORS = [
  '.ashby-application-form-success-container',
  '.application--confirmation',
  '[data-qa="application-confirmation"]',
  '.application-form > .application-content',          // Personio thank-you message
];

export interface ConfirmationMatch { confirmed: boolean; evidence?: string }

/** Text patterns present in `text`, as source strings. */
export function matchedPatterns(text: string): string[] {
  return CONFIRM_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}

/**
 * Pure check: confirmation text not already present before submit, or a navigation to a confirmation URL.
 * `baselinePatterns` are pattern sources that matched the pre-submit page (job descriptions sometimes say
 * "thank you for applying" and must not count).
 */
export function matchConfirmation(
  text: string,
  url: string,
  opts: { startUrl?: string; baselinePatterns?: string[] } = {},
): ConfirmationMatch {
  const baseline = new Set(opts.baselinePatterns ?? []);
  for (const p of CONFIRM_PATTERNS) {
    if (baseline.has(p.source)) continue;
    const m = p.exec(text);
    if (m) return { confirmed: true, evidence: `text: "${snippetAround(text, m.index, m[0].length)}"` };
  }
  const moved = !opts.startUrl || stripHash(opts.startUrl) !== stripHash(url);
  if (moved && CONFIRM_URL_PATTERN.test(safePath(url))) return { confirmed: true, evidence: `url: ${url}` };
  return { confirmed: false };
}

function stripHash(u: string): string {
  return u.split('#')[0];
}

function safePath(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return u;
  }
}

function snippetAround(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 40);
  return text.slice(start, index + len + 60).replace(/\s+/g, ' ').trim();
}

export interface ConfirmationBaseline { url: string; patterns: string[] }

/** Snapshot taken just before clicking submit. */
export async function captureBaseline(page: Page): Promise<ConfirmationBaseline> {
  const text = await pageText(page);
  return { url: page.url(), patterns: matchedPatterns(text) };
}

export interface WaitResult {
  confirmed: boolean;
  evidence?: string;
  /** A visible captcha appeared after submit (handoff). */
  captcha?: boolean;
  /** Visible validation errors that persisted after submit. */
  validationErrors?: string[];
  /** The site says this application already exists. */
  alreadyApplied?: string;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Validation errors must persist this long before we stop waiting early. */
  errorGraceMs?: number;
  /** Adapter-specific success containers, checked with the generic ones. */
  successSelectors?: string[];
  /**
   * Kayzee is finishing this by hand (handoff): a CAPTCHA or validation errors are expected while he works, so
   * neither ends the wait early. Only a confirmation, an "already applied" page, closing the tab or the timeout do.
   */
  human?: boolean;
}

async function pageText(page: Page): Promise<string> {
  try {
    return await page.evaluate('document.body ? document.body.innerText : ""') as string;
  } catch {
    return ''; // mid-navigation; the next poll retries
  }
}

async function successContainer(page: Page, extra: string[] = []): Promise<string | null> {
  for (const sel of [...extra, ...SUCCESS_SELECTORS]) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      const t = ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      return `${sel}: "${t.slice(0, 160)}"`;
    }
  }
  return null;
}

async function validationErrors(page: Page): Promise<string[]> {
  try {
    return (await page.evaluate(`(${VALIDATION_ERRORS_JS})()`)) as string[];
  } catch {
    return [];
  }
}

/** Polls for a success state after submit. Never returns confirmed=true without visible evidence. */
export async function waitForConfirmation(page: Page, baseline: ConfirmationBaseline, opts: WaitOptions = {}): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const pollMs = opts.pollMs ?? 500;
  const graceMs = opts.errorGraceMs ?? 5_000;
  const started = Date.now();
  let errorsSince: number | null = null;
  let lastErrors: string[] = [];

  while (Date.now() - started < timeoutMs) {
    if (page.isClosed()) return { confirmed: false };
    const container = await successContainer(page, opts.successSelectors);
    if (container) return { confirmed: true, evidence: container };
    const text = await pageText(page);
    const match = matchConfirmation(text, page.url(), { startUrl: baseline.url, baselinePatterns: baseline.patterns });
    if (match.confirmed) return match;
    const dup = ALREADY_APPLIED_PATTERNS.find((p) => p.test(text));
    if (dup) return { confirmed: false, alreadyApplied: dup.exec(text)?.[0] ?? 'already applied' };

    if (opts.human) {
      await page.waitForTimeout(pollMs).catch(() => undefined);
      continue;
    }
    const report = await scanBlockers(page).catch(() => null);
    if (report?.blockers.includes('captcha')) return { confirmed: false, captcha: true };

    const errors = await validationErrors(page);
    if (errors.length) {
      errorsSince ??= Date.now();
      lastErrors = errors;
      if (Date.now() - errorsSince >= graceMs) return { confirmed: false, validationErrors: errors };
    } else {
      errorsSince = null;
    }
    await page.waitForTimeout(pollMs).catch(() => undefined);
  }
  return lastErrors.length ? { confirmed: false, validationErrors: lastErrors } : { confirmed: false };
}
