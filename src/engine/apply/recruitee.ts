// Recruitee: {company}.recruitee.com/o/{slug} (and custom domains such as jobs.<company>.com); the
// form lives at /o/{slug}/c/new. Real markup (Nov 2026): form#offer-application-form, "My information"
// (candidate.name, candidate.email, candidate.phone with a country-calling-code picker and a
// pre-filled dial code), "CV or resume" file input, cover letter file input + "Write it here instead",
// open questions (text, radio, Yes/No), "Your personal data" agreements (required data-processing
// checkbox; optional future-opportunity agreements are never ticked), invisible hCaptcha,
// button[data-testid=submit-application-form-button] "Send"; success "All done!" /
// "Your application has been successfully submitted!". v2: not fixture-tested yet.

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, waitForAny, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = 'form#offer-application-form';

/** /o/{slug} → /o/{slug}/c/new. */
export function recruiteeApplyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/\/o\/[^/]+\/?$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/c/new`;
    return u.toString();
  } catch {
    return url;
  }
}

export const adapter: AtsAdapter = {
  ats: 'recruitee',
  formSelector: FORM,
  submitSelectors: ['button[data-testid="submit-application-form-button"]', 'form#offer-application-form button[type="submit"]'],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    if (await waitForAny(page, FORM, 4_000)) return true;
    const target = recruiteeApplyUrl(page.url());
    if (target !== page.url()) await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    return waitForAny(page, FORM, 10_000);
  },
};

export function fill(page: Page, pkg: ApplyPackage, opts?: AdapterFillOptions): Promise<FormFillResult> {
  return adapterFill(page, pkg, adapter, opts);
}

export function scan(page: Page): Promise<ScreeningQuestion[]> {
  return adapterScan(page, adapter);
}
