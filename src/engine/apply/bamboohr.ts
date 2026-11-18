// BambooHR: {company}.bamboohr.com/careers/{id}. Checked Nov 2026 against the public form schema
// (/careers/{id}/detail → formFields: firstName, lastName, email, phone, linkedinUrl, desiredPay,
// websiteUrl, resumeFileId, customQuestions yes_no/short/long, US EEO fields). The careers page is a
// React app; "Apply for This Job" reveals the form, "Submit Application" sends it. Required labels are
// marked by a CSS class (fab-Label--required), which the scanner reads. v2: not fixture-tested yet.

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, clickApplyEntry, waitForAny, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = 'form:has(input[name="firstName"]), form:has(#firstName)';

export const adapter: AtsAdapter = {
  ats: 'bamboohr',
  formSelector: FORM,
  submitSelectors: ['button[type="submit"]:has-text("Submit Application")', 'button:has-text("Submit Application")'],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    if (await waitForAny(page, FORM, 4_000)) return true;
    const open = page.locator('button:has-text("Apply for This Job"):visible, a:has-text("Apply for This Job"):visible').first();
    if (await open.count().catch(() => 0)) await open.click({ timeout: 5_000 }).catch(() => undefined);
    else await clickApplyEntry(page);
    return waitForAny(page, FORM, 10_000);
  },
};

export function fill(page: Page, pkg: ApplyPackage, opts?: AdapterFillOptions): Promise<FormFillResult> {
  return adapterFill(page, pkg, adapter, opts);
}

export function scan(page: Page): Promise<ScreeningQuestion[]> {
  return adapterScan(page, adapter);
}
