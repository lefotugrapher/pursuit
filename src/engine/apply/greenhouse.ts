// Greenhouse: job-boards.greenhouse.io (React form, react-select dropdowns) and the legacy
// boards.greenhouse.io / embed form (#application_form, native selects, #submit_app).

import type { Page } from 'playwright-core';
import type { ApplyPackage, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, waitForAny, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = '#application-form, form#application_form, #application_form, form[action*="greenhouse"]';

export const adapter: AtsAdapter = {
  ats: 'greenhouse',
  formSelector: FORM,
  submitSelectors: [
    '#application-form button[type="submit"]',
    '.application--submit button',
    '#submit_app',
    'form#application_form input[type="submit"]',
    'button:has-text("Submit application")',
  ],
  canSubmit: true,
  async prepare(page: Page): Promise<boolean> {
    if (await waitForAny(page, FORM, 8_000)) return true;
    // Some boards hide the form behind an "Apply" button.
    const apply = page.getByRole('button', { name: /^apply( now| for this job)?$/i }).first();
    if (await apply.count().catch(() => 0)) {
      await apply.click().catch(() => undefined);
      return waitForAny(page, FORM, 8_000);
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
