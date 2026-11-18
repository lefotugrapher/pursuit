// Cookie / consent banners and nuisance pop-ups. Policy: always the most privacy-preserving choice
// (reject / necessary only); never "Accept all". If a banner offers no reject option it is left
// alone (it rarely blocks the form; if it does, the run hands off instead of accepting).

import type { Locator, Page } from 'playwright-core';

/** Reject buttons of the common consent platforms, most specific first. */
const REJECT_SELECTORS = [
  '#onetrust-reject-all-handler',                         // OneTrust (SmartRecruiters job pages)
  '#CybotCookiebotDialogBodyButtonDecline',               // Cookiebot
  '#didomi-notice-disagree-button',                       // Didomi
  '[data-testid="uc-deny-all-button"]',                   // Usercentrics (open shadow root)
  '.osano-cm-denyAll', '.cky-btn-reject', '.cmplz-deny', '.iubenda-cs-reject-btn', '.cm-btn-decline',
  '#truste-consent-required', '.qc-cmp2-summary-buttons button[mode="secondary"]', '#axeptio_btn_dismiss',
  '[data-ui="cookie-consent-decline"]',                   // Workable
  'button[data-action*="cookies--alert#disableAll"]',     // Teamtailor
];

const REJECT_TEXT = /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?|refuse( all)?|necessary (cookies )?only|only (strictly )?necessary( cookies)?|use (only )?(strictly )?necessary cookies( only)?|essential (cookies )?only|only essential( cookies)?|continue without accepting|reject (all )?(non-essential|optional)( cookies)?|decline (all )?(non-necessary|optional|non-essential) cookies|disagree|ablehnen|alle ablehnen|nur notwendige( cookies)?)$/i;
const BANNER_SCOPE = '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="gdpr" i], [class*="gdpr" i], [aria-label*="cookie" i], [aria-label*="consent" i], dialog[aria-label*="cookies" i]';

async function clickIfVisible(loc: Locator): Promise<boolean> {
  try {
    if (!(await loc.isVisible({ timeout: 250 }))) return false;
    await loc.click({ timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Dismisses cookie/consent banners by rejecting optional cookies. Returns a short description of
 * what was clicked (empty when nothing was found). Never clicks an accept button.
 */
export async function dismissConsentBanners(page: Page): Promise<string[]> {
  const clicked: string[] = [];
  for (const sel of REJECT_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await clickIfVisible(loc)) {
      clicked.push(sel);
      break;
    }
  }
  if (!clicked.length) {
    const scoped = page.locator(BANNER_SCOPE).locator('button, a[role="button"], [role="button"]').filter({ hasText: REJECT_TEXT });
    const n = Math.min(await scoped.count().catch(() => 0), 5);
    for (let i = 0; i < n; i++) {
      const loc = scoped.nth(i);
      const text = ((await loc.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!REJECT_TEXT.test(text)) continue;
      if (await clickIfVisible(loc)) {
        clicked.push(`button "${text}"`);
        break;
      }
    }
  }
  if (clicked.length) await page.waitForTimeout(250).catch(() => undefined);
  return clicked;
}

const NUISANCE_TEXT = /\b(newsletter|subscribe|job alerts?|talent (community|network|pool)|sign up for (updates|alerts))\b/i;
const CLOSE_NAME = /^(close|dismiss|no,? thanks|not now|maybe later|×|x)$/i;

/**
 * Closes pop-ups that cover the page and are clearly not the application (newsletter / job-alert /
 * talent-community prompts without file or application fields). The application's own modal is
 * never closed.
 */
export async function closeNuisanceModals(page: Page): Promise<number> {
  let closed = 0;
  const dialogs = page.locator('[role="dialog"]:visible, dialog[open]:visible, [aria-modal="true"]:visible');
  const n = Math.min(await dialogs.count().catch(() => 0), 4);
  for (let i = n - 1; i >= 0; i--) {
    const d = dialogs.nth(i);
    const text = ((await d.innerText().catch(() => '')) || '').slice(0, 2_000);
    if (!NUISANCE_TEXT.test(text)) continue;
    const hasApplicationFields = await d.locator('input[type="file"], textarea').count().catch(() => 0);
    if (hasApplicationFields) continue;
    const btn = d.getByRole('button', { name: CLOSE_NAME }).first();
    if (await clickIfVisible(btn)) closed++;
  }
  return closed;
}
