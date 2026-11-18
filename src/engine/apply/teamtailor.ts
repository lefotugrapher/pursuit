// Teamtailor: {company}.teamtailor.com/jobs/{id}-{slug} (and custom career domains).
// Real markup (Nov 2026): cookie <dialog> with "Decline all non-necessary cookies"; "Apply now" opens
// an overlay whose turbo-frame#application_form loads /jobs/{id}-{slug}/applications/new:
// form#job-application-form (screening questions first, then first/last name, email, phone with IE
// default, required "Address" Google-Places combobox, "Upload CV" dropzone, cover letter textarea),
// "Apply with LinkedIn" (never clicked), consent by submitting (privacy text, no checkbox),
// input[type=submit][name=commit] "Submit application".
// v2: modelled from live markup but not fixture-tested yet; the shared filler does the fields.

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, waitForAny, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = 'form#job-application-form';

export const adapter: AtsAdapter = {
  ats: 'teamtailor',
  formSelector: FORM,
  submitSelectors: ['form#job-application-form input[type="submit"][name="commit"]', 'form#job-application-form button[type="submit"]'],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    if (await waitForAny(page, FORM, 2_000)) return true;
    const open = page.locator('button[data-action*="form-overlay#showFormOverlay"]:visible, a:has-text("Apply now"):visible, button:has-text("Apply now"):visible').first();
    if (await open.count().catch(() => 0)) await open.click({ timeout: 5_000 }).catch(() => undefined);
    if (await waitForAny(page, FORM, 10_000)) return true;
    const frameSrc = await page.locator('turbo-frame#application_form[src]').first().getAttribute('src').catch(() => null);
    if (frameSrc) {
      await page.goto(new URL(frameSrc, page.url()).toString(), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
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
