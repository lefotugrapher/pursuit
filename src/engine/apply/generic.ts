// Generic label-matching filler for forms we don't have an adapter for (company career sites,
// SmartRecruiters, Workable...). It fills what it can recognise and NEVER submits: the runner always
// hands these off to Kayzee.

import type { Page } from 'playwright-core';
import type { ApplyPackage, AtsKind, ScreeningQuestion } from '@/lib/types';
import { adapterFill, adapterScan, type AdapterFillOptions, type AtsAdapter } from './adapter';
import type { FormFillResult } from './fields';

const FORM = 'form:has(input[type="email"]), form:has(input[type="file"]), form:has(textarea), main, body';
const APPLY_TEXT = /^(apply|apply now|apply for this (job|position|role)|start application)$/i;

async function hasVisibleFields(page: Page): Promise<boolean> {
  const n = await page.locator('input[type="email"]:visible, input[type="file"], textarea:visible').count().catch(() => 0);
  return n > 0;
}

export function makeGenericAdapter(ats: AtsKind = 'unknown'): AtsAdapter {
  return {
    ats,
    formSelector: FORM,
    submitSelectors: [],
    canSubmit: false,
    async prepare(page: Page): Promise<boolean> {
      if (await hasVisibleFields(page)) return true;
      const apply = page.getByRole('link', { name: APPLY_TEXT }).or(page.getByRole('button', { name: APPLY_TEXT })).first();
      if (await apply.count().catch(() => 0)) {
        await apply.click().catch(() => undefined);
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await page.waitForTimeout(1_000).catch(() => undefined);
      }
      return hasVisibleFields(page);
    },
  };
}

export const adapter: AtsAdapter = makeGenericAdapter();

export function fill(page: Page, pkg: ApplyPackage, opts?: AdapterFillOptions): Promise<FormFillResult> {
  return adapterFill(page, pkg, makeGenericAdapter(pkg.job.ats), opts);
}

export function scan(page: Page): Promise<ScreeningQuestion[]> {
  return adapterScan(page, adapter);
}
