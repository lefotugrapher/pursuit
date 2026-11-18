// SmartRecruiters (Ryanair, Primark, Version 1, Keywords Studios...).
//
// Real flow (checked Nov 2026 on jobs.smartrecruiters.com/Primark/744000161476800): the job page
// jobs.smartrecruiters.com/{Company}/{postingId}-{slug} carries a OneTrust cookie banner and several
// "I'm interested" buttons (a.js-oneclick, no href); script sends the browser to
// /oneclick-ui/company/{Company}/publication/{uuid}?dcr_ci={Company}. That app is protected by
// DataDome (an automated client gets "Please enable JS and disable any ad blocker" + a
// captcha-delivery.com iframe) — a bot wall the runner hands off, never evades. When it loads, the
// application is built from web components with open shadow roots: personal information (name, email
// + confirm email, city autocomplete, phone with country picker), resume upload (parsed, pre-fills
// fields), "Message to the Hiring Team", links; "Next" leads to screening questions and the
// privacy-policy consent; "Submit" shows a thank-you screen. The scanner walks open shadow roots, so
// the shared filler handles the fields; this adapter only gets the form on screen.

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, clickApplyEntry, waitForFormOrWall, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FIELDS = 'input[type="email"], input[type="file"], input[autocomplete="given-name"], input[name*="firstName" i]';

async function formVisible(page: Page, timeoutMs: number): Promise<boolean> {
  return (await waitForFormOrWall(page, FIELDS, timeoutMs)) === 'form';
}

/** True for the application app (oneclick-ui) rather than the job description page. */
export function isOneclickUrl(url: string): boolean {
  return /\/oneclick-ui\//i.test(url);
}

export const adapter: AtsAdapter = {
  ats: 'smartrecruiters',
  formSelector: 'oc-oneclick-form, form[name="oneclick-form"], [data-test="application-form"]',
  submitSelectors: ['[data-test="footer-submit"]', 'button[data-test="footer-submit"]', 'spl-button[data-test="footer-submit"] button', 'button:has-text("Submit")'],
  nextSelectors: ['[data-test="footer-next"]', 'button[data-test="footer-next"]', 'spl-button[data-test="footer-next"] button', 'button:has-text("Next")'],
  successSelectors: ['[data-test="application-success"]', 'oc-application-success', '.application-success'],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    if (await formVisible(page, isOneclickUrl(page.url()) ? 12_000 : 1_500)) return true;
    const entry = page.locator('a.js-oneclick:visible, button.js-oneclick:visible, a[data-sr-track="apply"]:visible, #st-apply:visible').first();
    if (await entry.count().catch(() => 0)) {
      await entry.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
    } else {
      await clickApplyEntry(page);
    }
    return formVisible(page, 15_000);
  },
  // The whole oneclick page is the application, and its fields live in shadow roots: scan it all.
  async pickRoot(): Promise<string | null> {
    return null;
  },
};

export function fill(page: Page, pkg: ApplyPackage, opts?: AdapterFillOptions): Promise<FormFillResult> {
  return adapterFill(page, pkg, adapter, opts);
}

export function scan(page: Page): Promise<ScreeningQuestion[]> {
  return adapterScan(page, adapter);
}
