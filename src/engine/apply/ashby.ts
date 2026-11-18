// Ashby: jobs.ashbyhq.com/<org>/<id>/application. Client-rendered form with stable
// `ashby-application-form-*` class names, "Upload File" resume dropzone, Yes/No button questions,
// "Submit Application" button, and an in-place success container.

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, waitForAny, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = '.ashby-application-form-container, form[class*="application-form"]';

export const adapter: AtsAdapter = {
  ats: 'ashby',
  formSelector: FORM,
  submitSelectors: ['.ashby-application-form-submit-button', 'button:has-text("Submit Application")'],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    if (await waitForAny(page, FORM, 10_000)) return true;
    // Posting page: the form sits behind the "Application" tab.
    const tab = page.locator('a[href$="/application"], [role="tab"]:has-text("Application"), a:has-text("Apply for this Job")').first();
    if (await tab.count().catch(() => 0)) {
      await tab.click().catch(() => undefined);
      return waitForAny(page, FORM, 10_000);
    }
    return false;
  },
};

export function fill(page: Page, pkg: ApplyPackage, opts?: AdapterFillOptions): Promise<FormFillResult> {
  return adapterFill(page, pkg, adapter, opts);
}

export function scan(page: Page): Promise<ScreeningQuestion[]> {
  return adapterScan(page, adapter);
}
