// Lever: jobs.lever.co/<company>/<id>/apply. Single static form; resume upload triggers parsing that
// pre-fills fields, custom questions live in cards[...] fields, cover letter goes in "Additional information".
// Lever pages carry an invisible hCaptcha; it is never touched, and a visible challenge means handoff.

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, waitForAny, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = '#application-form, form.application-form, form[action*="/apply"]';

/** Posting URL → its /apply page. */
export function leverApplyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!/\/apply\/?$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/apply`;
    return u.toString();
  } catch {
    return url;
  }
}

export const adapter: AtsAdapter = {
  ats: 'lever',
  formSelector: FORM,
  submitSelectors: ['#btn-submit', 'button[data-qa="btn-submit"]', 'button.template-btn-submit', 'button:has-text("Submit application")'],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    if (await waitForAny(page, FORM, 6_000)) return true;
    const link = page.locator('a[href$="/apply"], a.postings-btn:has-text("Apply")').first();
    if (await link.count().catch(() => 0)) {
      await link.click().catch(() => undefined);
    } else {
      const target = leverApplyUrl(page.url());
      if (target !== page.url()) await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    return waitForAny(page, FORM, 8_000);
  },
};

export function fill(page: Page, pkg: ApplyPackage, opts?: AdapterFillOptions): Promise<FormFillResult> {
  return adapterFill(page, pkg, adapter, opts);
}

export function scan(page: Page): Promise<ScreeningQuestion[]> {
  return adapterScan(page, adapter);
}
