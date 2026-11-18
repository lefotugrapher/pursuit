// Personio: {company}.jobs.personio.de/job/{id} ("Apply for this job" → /job/{id}/apply).
// Real markup (Nov 2026, personio-jobs Next.js app): form.DynamicForm_formContainer… with a "Name*"
// role=group (inputs first_name / last_name labelled "First" / "Last"), email, phone (text),
// custom_attribute_* fields (text, select), documents group "CV*" (hidden input#doc-input-cv behind
// "Add file", aria-label "Upload CV"), "Submit Application" (disabled until valid). On success the
// form is replaced by the company's own thank-you HTML (.application-form .application-content).
// v2: modelled from live markup but not fixture-tested yet.

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, waitForAny, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = 'form[class*="DynamicForm_formContainer"], .apply-form-container form';

/** /job/{id} → /job/{id}/apply (language kept). */
export function personioApplyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/\/job\/\d+\/?$/.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/apply`;
    return u.toString();
  } catch {
    return url;
  }
}

export const adapter: AtsAdapter = {
  ats: 'personio',
  formSelector: FORM,
  submitSelectors: ['button.career-submit-application-btn', `${FORM.split(',')[0]} button[type="submit"]`],
  successSelectors: ['.application-form > .application-content', '[class*="applicationContent"]'],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    if (await waitForAny(page, FORM, 4_000)) return true;
    const link = page.locator('a[href*="/apply"]:visible').first();
    if (await link.count().catch(() => 0)) await link.click({ timeout: 5_000 }).catch(() => undefined);
    else if (personioApplyUrl(page.url()) !== page.url()) await page.goto(personioApplyUrl(page.url()), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    return waitForAny(page, FORM, 10_000);
  },
};

export function fill(page: Page, pkg: ApplyPackage, opts?: AdapterFillOptions): Promise<FormFillResult> {
  return adapterFill(page, pkg, adapter, opts);
}

export function scan(page: Page): Promise<ScreeningQuestion[]> {
  return adapterScan(page, adapter);
}
