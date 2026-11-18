// Headless careers-page reader for JS-rendered career sites: installed Chrome via playwright-core,
// a throwaway (non-persistent) browser, images/fonts/media blocked. It only reads pages and follows
// links; it never fills or submits anything, and it stops at bot checks.

import type { Browser, BrowserContext } from 'playwright-core';
import { buildPageInfo, type PageInfo, type RawPage } from './page';

export interface Crawler {
  /** Loads `url` and returns what is on it, or undefined (timeout, error, deadline passed). */
  open(url: string, deadline: number): Promise<PageInfo | undefined>;
  close(): Promise<void>;
}

const EXTRACT_JS = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const links = [];
  for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 2000)) {
    const href = a.href;
    if (!href || !/^(https?|mailto):/i.test(href)) continue;
    links.push({ href, text: clean(a.innerText || a.textContent || a.getAttribute('aria-label') || '') });
  }
  const meta = (k) => { const m = document.querySelector('meta[property="' + k + '"], meta[name="' + k + '"]'); return m ? clean(m.getAttribute('content')) : ''; };
  return {
    title: document.title || '',
    h1: Array.from(document.querySelectorAll('h1')).slice(0, 5).map((h) => clean(h.innerText)),
    ldBlocks: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent || ''),
    text: (document.body ? document.body.innerText : '').slice(0, 80000),
    links,
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter(Boolean),
    ogTitle: meta('og:title'),
    ogSiteName: meta('og:site_name'),
  };
})()`;

export function createChromeCrawler(): Crawler {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let failed = false;

  async function ensure(): Promise<BrowserContext | undefined> {
    if (context) return context;
    if (failed) return undefined;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      context = await browser.newContext({ locale: 'en-IE', timezoneId: 'Europe/Dublin', viewport: { width: 1280, height: 900 }, acceptDownloads: false });
      await context.route('**/*', (route) => {
        const type = route.request().resourceType();
        return type === 'image' || type === 'media' || type === 'font' ? route.abort() : route.continue();
      });
      return context;
    } catch {
      failed = true;
      return undefined;
    }
  }

  return {
    async open(url, deadline) {
      const remaining = deadline - Date.now();
      if (remaining < 3_000) return undefined;
      const ctx = await ensure();
      if (!ctx) return undefined;
      const page = await ctx.newPage();
      try {
        page.setDefaultTimeout(Math.min(10_000, remaining));
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(15_000, remaining) });
        await page.waitForLoadState('networkidle', { timeout: Math.max(1_000, Math.min(5_000, deadline - Date.now() - 1_000)) }).catch(() => undefined);
        const raw = (await page.evaluate(EXTRACT_JS)) as Omit<RawPage, 'url' | 'status'>;
        return buildPageInfo({ ...raw, url: page.url(), status: res?.status() });
      } catch {
        return undefined;
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async close() {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      context = undefined;
      browser = undefined;
    },
  };
}
