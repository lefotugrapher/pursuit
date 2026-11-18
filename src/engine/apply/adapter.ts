// Common shape of an ATS adapter, plus the shared fill + submit plumbing they use: cookie banners,
// "Apply" entry buttons, multi-step (Next / Continue) forms, and the submit click.

import type { Locator, Page } from 'playwright-core';
import { loadAnswers } from '@/lib/config';
import type { AnswerBank, ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { closeNuisanceModals, dismissConsentBanners } from './banners';
import { hardBlockers, scanBlockers, type SiteKind } from './detect';
import { fillForm, scanFormQuestions, type FormFillResult, type QuestionResolver } from './fields';
import { STEP_SIGNATURE_JS, VALIDATION_ERRORS_JS } from './inpage';

export interface AtsAdapter {
  /** Site this adapter drives (an AtsKind or a finer SiteKind such as 'teamtailor'). */
  ats: SiteKind;
  /** CSS selector for the application form root (first match wins). */
  formSelector: string;
  /** Submit buttons, most specific first. Empty for adapters that must never submit. */
  submitSelectors: string[];
  /** Whether the runner may click submit for this ATS. */
  canSubmit: boolean;
  /** Gets the form on screen (clicks an "Apply" tab, follows /apply...). Resolves true when the form is present. */
  prepare(page: Page): Promise<boolean>;
  /** Multi-step forms: "Next" / "Continue" buttons, most specific first. */
  nextSelectors?: string[];
  /** Containers that only appear once the application went through (in addition to the generic patterns). */
  successSelectors?: string[];
  /** Resolves the form root dynamically (universal filler); overrides formSelector. */
  pickRoot?(page: Page): Promise<string | null>;
}

export interface AdapterFillOptions {
  /** Answer bank for questions the approved package does not cover. Loaded from config when omitted. */
  bank?: AnswerBank;
  /** Second-chance answering for unknown questions (see llmfill.makeResolver). */
  resolve?: QuestionResolver;
  /** Maximum Next/Continue steps to walk (default 8). 1 = fill the visible step only. */
  maxSteps?: number;
}

function safeLoadBank(): AnswerBank {
  try {
    return loadAnswers();
  } catch {
    return { entries: [] };
  }
}

/** Resolves the first selector in a comma list that matches, so scans stay inside the form. */
export async function resolveRoot(page: Page, selector: string): Promise<string | null> {
  for (const sel of selector.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (await page.locator(sel).count().catch(() => 0)) return sel;
  }
  return null;
}

/** Waits up to `timeoutMs` for any selector in the list to appear. */
export async function waitForAny(page: Page, selector: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'attached', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

const WALL_HINT = [
  'input[type="password"]', 'iframe[title*="DataDome" i]', 'iframe[src*="captcha-delivery.com"]', '#cmsg', '#challenge-stage',
  'iframe[src*="challenges.cloudflare.com"]', '#px-captcha', '#arkoseFrame', 'iframe[src*="arkoselabs"]',
].join(', ');

/**
 * Waits for the form (or for a login/captcha wall, so a walled page doesn't burn the whole timeout).
 * 'form' = form present, 'wall' = a wall is showing (the post-prepare blocker scan explains it).
 */
export async function waitForFormOrWall(page: Page, formSelector: string, timeoutMs: number): Promise<'form' | 'wall' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.locator(formSelector).count().catch(() => 0)) return 'form';
    if (await page.locator(WALL_HINT).count().catch(() => 0)) return 'wall';
    if (Date.now() >= deadline) return 'timeout';
    await page.waitForTimeout(300).catch(() => undefined);
  }
}

// ───────────────────────────── Buttons ─────────────────────────────

/** Never click these, whatever selector matched them (third-party sign-in, saving, going back...). */
export const NEVER_CLICK_TEXT = /linkedin|indeed|seek|xing|google|facebook|apple|apply with|sign ?in|log ?in|create (an )?account|register|save( for later| draft)?$|draft|cancel|back|previous|share|refer a friend/i;
const SUBMIT_TEXT = /^(submit|submit (my |your |the )?application|send( (my |your |the )?application)?|apply|apply now|complete( (my )?application)?|finish|confirm( (and|&) submit)?|submit and finish|bewerbung (absenden|senden)|absenden|senden)$/i;
const NEXT_TEXT = /^(next|continue|next step|save (and|&) continue|continue to (next step|review|questions)|proceed|review( application)?|weiter)$/i;
export const APPLY_ENTRY_TEXT = /^(apply|apply now|apply for (this|the) (job|position|role|vacancy)|apply online|apply here|i'?m interested|start (your |my )?application|submit (your |a )?(cv|application)|apply manually|fill (it )?in manually|apply without (an )?account|continue as (a )?guest|apply as (a )?guest)$/i;

async function buttonText(loc: Locator): Promise<string> {
  const t = (await loc.innerText({ timeout: 1_000 }).catch(() => '')) || (await loc.getAttribute('value', { timeout: 1_000 }).catch(() => '')) || (await loc.getAttribute('aria-label', { timeout: 1_000 }).catch(() => '')) || '';
  return t.replace(/\s+/g, ' ').trim();
}

/** First visible, clickable control among `selectors` whose text passes `ok`. */
async function firstButton(page: Page, selectors: string[], ok: (text: string) => boolean): Promise<{ loc: Locator; sel: string; text: string } | null> {
  for (const sel of selectors) {
    const all = page.locator(sel).filter({ visible: true });
    const n = Math.min(await all.count().catch(() => 0), 6);
    for (let i = 0; i < n; i++) {
      const loc = all.nth(i);
      const text = await buttonText(loc);
      if (NEVER_CLICK_TEXT.test(text) || !ok(text)) continue;
      return { loc, sel, text };
    }
  }
  return null;
}

const GENERIC_BUTTONS = ['button[type="submit"]', 'input[type="submit"]', 'button', '[role="button"]', 'a[role="button"]'];

/** The visible submit control for this form, if any. */
export async function findSubmit(page: Page, adapter: AtsAdapter): Promise<{ loc: Locator; sel: string; text: string } | null> {
  const specific = await firstButton(page, adapter.submitSelectors, (t) => !NEXT_TEXT.test(t));
  if (specific) return specific;
  return firstButton(page, GENERIC_BUTTONS, (t) => SUBMIT_TEXT.test(t));
}

async function findNext(page: Page, adapter: AtsAdapter): Promise<{ loc: Locator; sel: string; text: string } | null> {
  const specific = await firstButton(page, adapter.nextSelectors ?? [], (t) => !SUBMIT_TEXT.test(t) || NEXT_TEXT.test(t));
  if (specific) return specific;
  return firstButton(page, GENERIC_BUTTONS, (t) => NEXT_TEXT.test(t));
}

/** Clicks a visible "Apply" style entry button/link (never LinkedIn/Indeed/sign-in). True when something was clicked. */
export async function clickApplyEntry(page: Page): Promise<boolean> {
  const candidates = page.locator('a, button, [role="button"], input[type="submit"], input[type="button"]').filter({ visible: true });
  const n = Math.min(await candidates.count().catch(() => 0), 80);
  for (let i = 0; i < n; i++) {
    const loc = candidates.nth(i);
    const text = await buttonText(loc);
    if (!text || text.length > 40 || NEVER_CLICK_TEXT.test(text) || !APPLY_ENTRY_TEXT.test(text)) continue;
    const href = await loc.getAttribute('href', { timeout: 1_000 }).catch(() => null);
    const target = await loc.getAttribute('target', { timeout: 1_000 }).catch(() => null);
    if (href && /^https?:/i.test(href) && target === '_blank') {
      // Same tab: one page per run keeps the handoff and the screenshot in one place.
      await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    } else {
      await loc.click({ timeout: 5_000 }).catch(() => undefined);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(600).catch(() => undefined);
    return true;
  }
  return false;
}

async function stepSignature(page: Page): Promise<string> {
  return ((await page.evaluate(`(${STEP_SIGNATURE_JS})()`).catch(() => '')) as string) || '';
}

async function visibleErrors(page: Page): Promise<string[]> {
  return ((await page.evaluate(`(${VALIDATION_ERRORS_JS})()`).catch(() => [])) as string[]) ?? [];
}

// ───────────────────────────── Fill (multi-step) ─────────────────────────────

function emptyResult(): FormFillResult {
  return { filled: [], unfilledRequired: [], blockers: [], questionsSeen: [], reasons: {}, bankAnswered: [], failedFills: [], unanswered: [], resolved: [] };
}

function merge(into: FormFillResult, step: FormFillResult): FormFillResult {
  const uniq = <T>(xs: T[]) => [...new Set(xs)];
  return {
    filled: uniq([...into.filled, ...step.filled]),
    unfilledRequired: step.unfilledRequired,
    blockers: uniq([...step.blockers]),
    questionsSeen: [...into.questionsSeen, ...step.questionsSeen.filter((q) => !into.questionsSeen.some((p) => p.id === q.id && p.label === q.label))],
    reasons: step.reasons,
    bankAnswered: uniq([...into.bankAnswered, ...step.bankAnswered]),
    failedFills: uniq([...into.failedFills, ...step.failedFills]),
    unanswered: step.unanswered,
    resolved: [...into.resolved, ...step.resolved],
    kindsFilled: uniq([...(into.kindsFilled ?? []), ...(step.kindsFilled ?? [])]),
  };
}

const MAX_STEPS = 8;

/**
 * Gets the form on screen, then fills it step by step: fill the visible step; stop if anything
 * required is unanswered or a blocker shows up; stop (ready) when a submit button is on screen;
 * otherwise click Next / Continue and repeat. Never clicks submit.
 */
export async function adapterFill(page: Page, pkg: ApplyPackage, adapter: AtsAdapter, opts: AdapterFillOptions = {}): Promise<FormFillResult> {
  const bank = opts.bank ?? safeLoadBank();
  await dismissConsentBanners(page);
  const ready = await adapter.prepare(page);
  await dismissConsentBanners(page);
  await closeNuisanceModals(page);

  // Account walls and challenges often appear only after "Apply": never type into them.
  const gate = await scanBlockers(page).catch(() => null);
  const hard = gate ? hardBlockers(gate.blockers) : [];
  if (hard.length) {
    const out = emptyResult();
    out.blockers = hard;
    out.steps = 0;
    return out;
  }

  const maxSteps = Math.max(1, opts.maxSteps ?? MAX_STEPS);
  let combined = emptyResult();
  let step = 0;
  for (; step < maxSteps; step++) {
    const root = adapter.pickRoot ? await adapter.pickRoot(page) : ready ? await resolveRoot(page, adapter.formSelector) : null;
    const result = await fillForm(page, pkg, { ats: adapter.ats, bank, root, resolve: opts.resolve });
    combined = merge(combined, result);
    if (step === 0 && !ready && !result.filled.length) {
      combined.reasons['application form'] = 'Could not find the application form on the page';
      combined.unfilledRequired = [...combined.unfilledRequired, 'application form'];
      break;
    }
    if (result.unfilledRequired.length || hardBlockers(result.blockers).length) break;

    if (await findSubmit(page, adapter)) {
      combined.submitReady = true;
      break;
    }
    const next = await findNext(page, adapter);
    if (!next) break;
    const before = await stepSignature(page);
    await next.loc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
    await next.loc.click({ timeout: 5_000 });
    let changed = false;
    for (let i = 0; i < 20 && !changed; i++) {
      await page.waitForTimeout(250).catch(() => undefined);
      changed = (await stepSignature(page)) !== before;
    }
    if (!changed) {
      const errors = await visibleErrors(page);
      const why = errors.length ? `The form would not move past "${next.text}": ${errors.slice(0, 4).join(' | ')}` : `Clicking "${next.text}" did not open the next step`;
      combined.reasons['next step'] = why;
      combined.unfilledRequired = [...combined.unfilledRequired, 'next step'];
      break;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    await dismissConsentBanners(page);
    const mid = await scanBlockers(page).catch(() => null);
    const midHard = mid ? hardBlockers(mid.blockers) : [];
    if (midHard.length) {
      combined.blockers = [...new Set([...combined.blockers, ...midHard])];
      break;
    }
  }
  combined.steps = step + 1;
  return combined;
}

export async function adapterScan(page: Page, adapter: AtsAdapter): Promise<ScreeningQuestion[]> {
  await dismissConsentBanners(page);
  const ready = await adapter.prepare(page);
  const root = adapter.pickRoot ? await adapter.pickRoot(page) : ready ? await resolveRoot(page, adapter.formSelector) : null;
  return scanFormQuestions(page, root, adapter.ats);
}

/** Clicks the adapter's submit button. Throws when none is visible (the runner then hands off). */
export async function clickSubmit(page: Page, adapter: AtsAdapter): Promise<string> {
  if (!adapter.canSubmit) throw new Error(`${adapter.ats} adapter never submits`);
  const found = await findSubmit(page, adapter);
  if (!found) throw new Error('No visible submit button found');
  await found.loc.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
  // Some forms (Personio) keep the button disabled for a moment while they validate.
  for (let i = 0; i < 20 && (await found.loc.isDisabled().catch(() => false)); i++) await page.waitForTimeout(250).catch(() => undefined);
  await found.loc.click({ timeout: 10_000 });
  return found.sel;
}
