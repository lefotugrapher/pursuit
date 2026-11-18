// Browser lifecycle for the apply runner: playwright-core driving installed Google Chrome by default,
// with a persistent profile at data/chrome-profile (separate from Kayzee's own Chrome).
//
// Environment (for Docker / Linux servers without Chrome or a display):
//   PURSUIT_BROWSER_CHANNEL  default 'chrome'; '' or 'chromium' = playwright-core's bundled Chromium (no channel)
//   PURSUIT_CHROMIUM_PATH    executablePath for a specific Chromium/Chrome binary (wins over the channel)
//   PURSUIT_FORCE_HEADLESS=1 headless everywhere; a "headed handoff" then degrades to headless + needs_you
//
// Chrome allows one process per profile directory, so a context left open for a handoff is kept in
// a per-profile registry and reused by the next run in this process instead of relaunching.

import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { CHROME_PROFILE_DIR, ensureDir } from '@/lib/paths';

export interface BrowserOptions {
  headless: boolean;
  /** Defaults to CHROME_PROFILE_DIR. Tests pass a temp directory. */
  profileDir?: string;
  /**
   * When set, every request to a host not in this list is aborted (tests use ['127.0.0.1'] so a
   * fixture can never reach the internet). Production runs leave it unset.
   */
  allowHosts?: string[];
  /** Hosts (and their subdomains) that are never requested, e.g. linkedin.com (SPEC §0.4). */
  blockHosts?: readonly string[];
  /** Default timeout for page actions (ms). */
  actionTimeoutMs?: number;
}

/** Sites the apply runner must never load, whatever a page links or redirects to (SPEC §0.4). */
export const NEVER_DRIVE_HOSTS: readonly string[] = ['linkedin.com', 'lnkd.in', 'indeed.com'];

export class ProfileInUseError extends Error {
  constructor(profileDir: string, cause?: unknown) {
    super(`Chrome profile ${profileDir} is already in use (probably an open handoff window or another Pursuit process). Close that Chrome window and retry.`);
    this.name = 'ProfileInUseError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

// ───────────────────────────── Launch configuration ─────────────────────────────

export interface BrowserLaunchConfig {
  /** Playwright channel ('chrome', 'msedge'...); undefined = bundled Chromium. */
  channel?: string;
  /** Explicit browser binary; when set the channel is ignored. */
  executablePath?: string;
  /** PURSUIT_FORCE_HEADLESS=1: never open a window. */
  forceHeadless: boolean;
}

type EnvLike = Record<string, string | undefined>;

/** Pure: how to launch the browser for this environment (unit-tested). */
export function resolveBrowserLaunch(env: EnvLike = process.env): BrowserLaunchConfig {
  const forceHeadless = /^(1|true|yes)$/i.test((env.PURSUIT_FORCE_HEADLESS ?? '').trim());
  const executablePath = env.PURSUIT_CHROMIUM_PATH?.trim() || undefined;
  if (executablePath) return { executablePath, forceHeadless };
  const raw = env.PURSUIT_BROWSER_CHANNEL;
  const channel = raw === undefined ? 'chrome' : raw.trim();
  if (!channel || channel.toLowerCase() === 'chromium') return { forceHeadless };
  return { channel, forceHeadless };
}

/** True when this process may never open a visible window (servers, Docker). */
export function isForcedHeadless(env: EnvLike = process.env): boolean {
  return resolveBrowserLaunch(env).forceHeadless;
}

/** The effective headless flag for a requested mode. */
export function effectiveHeadless(requested: boolean, env: EnvLike = process.env): boolean {
  return requested || isForcedHeadless(env);
}

/**
 * Options for chromium.launch / launchPersistentContext, shared by every module that starts a
 * browser (the resolver should use this too, so Docker/Linux settings apply everywhere).
 */
export function launchOptions(opts: { headless?: boolean } = {}, env: EnvLike = process.env): {
  headless: boolean;
  channel?: string;
  executablePath?: string;
  args?: string[];
} {
  const cfg = resolveBrowserLaunch(env);
  const headless = effectiveHeadless(opts.headless ?? true, env);
  const out: { headless: boolean; channel?: string; executablePath?: string; args?: string[] } = { headless };
  if (cfg.executablePath) out.executablePath = cfg.executablePath;
  else if (cfg.channel) out.channel = cfg.channel;
  // Bundled Chromium in containers usually runs as root without a user namespace sandbox.
  if (!cfg.channel && process.platform === 'linux') out.args = ['--no-sandbox', '--disable-dev-shm-usage'];
  return out;
}

interface Session { context: BrowserContext; headless: boolean }

const g = globalThis as typeof globalThis & { __pursuitBrowsers?: Map<string, Session>; __pursuitKeep?: WeakSet<Page> };
const sessions: Map<string, Session> = (g.__pursuitBrowsers ??= new Map());
const keptPages: WeakSet<Page> = (g.__pursuitKeep ??= new WeakSet());

function isProfileLockError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ProcessSingleton|SingletonLock|profile (appears to be|is) in use|user data directory is already in use/i.test(msg);
}

async function launch(profileDir: string, headless: boolean): Promise<BrowserContext> {
  ensureDir(profileDir);
  try {
    return await chromium.launchPersistentContext(profileDir, {
      ...launchOptions({ headless }),
      viewport: headless ? { width: 1280, height: 900 } : null,
      acceptDownloads: false,
      locale: 'en-IE',
      timezoneId: 'Europe/Dublin',
    });
  } catch (err) {
    if (isProfileLockError(err)) throw new ProfileInUseError(profileDir, err);
    throw err;
  }
}

const closedContexts = new WeakSet<BrowserContext>();

function contextAlive(context: BrowserContext): boolean {
  return !closedContexts.has(context);
}

async function acquire(profileDir: string, headless: boolean): Promise<{ context: BrowserContext; owned: boolean }> {
  const existing = sessions.get(profileDir);
  if (existing && contextAlive(existing.context)) return { context: existing.context, owned: false };
  sessions.delete(profileDir);
  const context = await launch(profileDir, headless);
  context.on('close', () => {
    closedContexts.add(context);
    if (sessions.get(profileDir)?.context === context) sessions.delete(profileDir);
  });
  return { context, owned: true };
}

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

async function guardRequests(page: Page, allowHosts: string[] | undefined, blockHosts: readonly string[]): Promise<void> {
  const allowed = allowHosts?.length ? new Set(allowHosts.map((h) => h.toLowerCase())) : null;
  if (!allowed && !blockHosts.length) return;
  await page.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).hostname.toLowerCase();
    } catch {
      // data:, blob: and about: URLs have no host and never leave the machine
    }
    if (!host) return route.continue();
    if (hostMatches(host, blockHosts)) return route.abort('blockedbyclient');
    if (allowed && !allowed.has(host)) return route.abort('blockedbyclient');
    return route.continue();
  });
}

/**
 * Marks a page to stay open after withBrowser's callback returns, so Kayzee can finish by hand.
 * Only meaningful in headed mode; headless pages (including PURSUIT_FORCE_HEADLESS) are always closed.
 */
export function keepOpenForHandoff(page: Page): void {
  keptPages.add(page);
  void page.bringToFront().catch(() => undefined);
}

export function isKeptOpen(page: Page): boolean {
  return keptPages.has(page);
}

/**
 * Runs `fn` with a fresh page in the persistent Chrome profile. The page (and the context, if this
 * call launched it) is closed afterwards unless the page was marked with keepOpenForHandoff in a
 * headed session; the context then stays registered for reuse until the window is closed.
 */
export async function withBrowser<T>(opts: BrowserOptions, fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
  const profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
  const headless = effectiveHeadless(opts.headless);
  const { context, owned } = await acquire(profileDir, headless);
  const page = await context.newPage();
  page.setDefaultTimeout(opts.actionTimeoutMs ?? 10_000);
  page.setDefaultNavigationTimeout(45_000);
  await guardRequests(page, opts.allowHosts, opts.blockHosts ?? []);

  const headed = !headless || (!owned && sessions.get(profileDir)?.headless === false);
  try {
    return await fn(page, context);
  } finally {
    const keep = headed && keptPages.has(page) && !page.isClosed();
    if (keep) {
      if (owned) sessions.set(profileDir, { context, headless: false });
    } else {
      await page.close().catch(() => undefined);
      const reusedOrKept = !owned || context.pages().some((p) => keptPages.has(p) && !p.isClosed());
      if (!reusedOrKept) await context.close().catch(() => undefined);
    }
  }
}

/** Closes every registered handoff context (graceful shutdown, tests). */
export async function closeAllBrowsers(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.context.close().catch(() => undefined)));
}
