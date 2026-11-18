// Workable: apply.workable.com/{account}/j/{shortcode}/ (job page, "Overview" / "Application" tabs)
// and .../apply/ (the form). Checked Nov 2026 against the public form schema
// (apply.workable.com/api/v1/jobs/{shortcode}/form) and the candidate app bundle: form[data-ui=
// "application-form"] with sections Personal information / Profile / Details; resume upload ("Choose
// file or drag and drop here"; the "Autofill application" import is not used); boolean questions as
// Yes/No radios; dropdowns; required GDPR checkbox "I have read, understand and accept the content of
// the Privacy Notice and consent to the processing of my data as part of this application."; an
// optional SMS-contact consent (never ticked); cookie banner "Decline all"
// ([data-ui=cookie-consent-decline]); submit button[data-ui=apply-button] "Submit application";
// success "Thank you!" + "Your application has been submitted successfully.".
// jobs.workable.com/view/{id} (Workable's own job search) shows the same form in a dialog after
// [data-ui=overview-apply-now]; its submit is [data-ui=application-form-submit].

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, waitForAny, waitForFormOrWall, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = 'form[data-ui="application-form"], [data-ui="application-form"]';

/** Job URL → its /apply/ page (apply.workable.com/{account}/j/{code}/ or /j/{code}). */
export function workableApplyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/\/j\/[A-Z0-9]+\/?$/i.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/+$/, '')}/apply/`;
    return u.toString();
  } catch {
    return url;
  }
}

export const adapter: AtsAdapter = {
  ats: 'workable',
  formSelector: FORM,
  // jobs.workable.com's dialog has its own submit, plus a Cancel button that is ALSO type=submit.
  submitSelectors: [
    'button[data-ui="apply-button"]',
    'button[data-ui="application-form-submit"]',
    'form[data-ui="application-form"] button[type="submit"]:not([data-ui="application-form-cancel"])',
  ],
  successSelectors: [],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    const first = await waitForFormOrWall(page, FORM, 8_000);
    if (first === 'form') return true;
    if (first === 'wall') return false;
    // apply.workable.com: "Application" tab. jobs.workable.com (board search results): "Apply now" opens the form in a dialog.
    const tab = page.locator('[data-ui="application-form-tab"], [data-ui="overview-apply-now"], a:has-text("Apply for this job"), button:has-text("Apply for this job")').first();
    if (await tab.count().catch(() => 0)) {
      await tab.click({ timeout: 5_000 }).catch(() => undefined);
      if (await waitForAny(page, FORM, 10_000)) return true;
    }
    const target = workableApplyUrl(page.url());
    if (target !== page.url()) {
      await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
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
