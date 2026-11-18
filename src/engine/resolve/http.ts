// Polite HTTP for the resolver: GET + form/JSON POST, one request at a time per host with a
// per-host minimum interval, 15 s timeouts, no cookies, no retries. A host that rate-limits us (429) or
// shows a bot check is "parked" for the rest of the run: later calls to it return immediately.
//
// Never throws for HTTP/network problems: failures come back as { status: 0, error }.
// Optional on-disk response cache (PURSUIT_RESOLVE_CACHE_DIR) so a dry run and the real run that
// follows see the same pages without fetching everything twice.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MIN_INTERVAL_MS = 1_100;
const DEFAULT_MAX_CHARS = 8_000_000;
const DEFAULT_CACHE_TTL_MS = 12 * 3_600_000;

/** Per-host spacing (ms). LinkedIn ≥ 3 s (SPEC §0.4), search engines ≥ 2 s, Workable is touchy about volume. */
export function hostIntervalMs(host: string): number {
  const h = host.toLowerCase();
  const is = (d: string) => h === d || h.endsWith(`.${d}`);
  if (is('linkedin.com')) return 3_500;
  if (is('duckduckgo.com')) return 6_000;
  if (is('bing.com')) return 4_000;
  if (is('workable.com')) return 3_000;
  return DEFAULT_MIN_INTERVAL_MS;
}

export interface FetchResult {
  status: number;
  text: string;
  /** Final URL after redirects. */
  url: string;
  contentType: string;
  error?: string;
  fromCache?: boolean;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Raises (never lowers) the host's spacing for this call. */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Bypass the on-disk cache for this call. */
  noCache?: boolean;
}

export interface ResolverHttp {
  get(url: string, opts?: RequestOptions): Promise<FetchResult>;
  post(url: string, body: string, opts?: RequestOptions & { contentType?: string }): Promise<FetchResult>;
  /** Stop talking to `host` for the rest of this run. */
  park(host: string, reason: string): void;
  /** Why `host` is parked, or undefined. */
  parked(host: string): string | undefined;
  /** Network requests actually sent (cache hits excluded). */
  requestCount(): number;
}

export interface CreateResolverHttpOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  userAgent?: string;
  /** Override per-host spacing (tests use 0). */
  intervalFor?: (host: string) => number;
  cacheDir?: string;
  cacheTtlMs?: number;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

interface CacheEntry { status: number; url: string; text: string; contentType: string; at: number }

export function createResolverHttp(options: CreateResolverHttpOptions = {}): ResolverHttp {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const userAgent = options.userAgent ?? BROWSER_UA;
  const intervalFor = options.intervalFor ?? hostIntervalMs;
  const cacheDir = options.cacheDir?.trim() || undefined;
  const cacheTtl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  const lastAt = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  const parkedHosts = new Map<string, string>();
  let sent = 0;

  function serialised<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(host) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(host, next.catch(() => undefined));
    return next;
  }

  function cacheFile(key: string): string | undefined {
    if (!cacheDir) return undefined;
    return path.join(cacheDir, `${createHash('sha1').update(key).digest('hex')}.json`);
  }

  function readCache(key: string): FetchResult | undefined {
    const file = cacheFile(key);
    if (!file) return undefined;
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntry;
      if (now() - entry.at > cacheTtl) return undefined;
      return { status: entry.status, url: entry.url, text: entry.text, contentType: entry.contentType, fromCache: true };
    } catch {
      return undefined;
    }
  }

  function writeCache(key: string, res: FetchResult): void {
    const file = cacheFile(key);
    const cacheable = (res.status >= 200 && res.status < 300 && res.status !== 202) || res.status === 404 || res.status === 410;
    if (!file || !cacheable) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const entry: CacheEntry = { status: res.status, url: res.url, text: res.text, contentType: res.contentType, at: now() };
      fs.writeFileSync(file, JSON.stringify(entry));
    } catch {
      // the cache is best effort
    }
  }

  async function send(method: 'GET' | 'POST', url: string, body: string | undefined, opts: RequestOptions & { contentType?: string }): Promise<FetchResult> {
    const host = hostOf(url);
    if (!host) return { status: 0, text: '', url, contentType: '', error: 'invalid URL' };
    const key = `${method} ${url}\n${body ?? ''}`;
    if (!opts.noCache) {
      const cached = readCache(key);
      if (cached) return cached;
    }
    return serialised(host, async () => {
      const why = parkedHosts.get(host);
      if (why) return { status: 0, text: '', url, contentType: '', error: `parked: ${why}` };
      if (options.signal?.aborted) return { status: 0, text: '', url, contentType: '', error: 'aborted' };
      const spacing = Math.max(intervalFor(host), opts.minIntervalMs ?? 0);
      const last = lastAt.get(host);
      if (last !== undefined) {
        const wait = last + spacing - now();
        if (wait > 0) await sleep(wait);
      }
      lastAt.set(host, now());
      sent++;
      const headers: Record<string, string> = {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IE,en;q=0.9',
        ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
        ...opts.headers,
      };
      try {
        const response = await fetchImpl(url, {
          method,
          headers,
          body,
          redirect: 'follow',
          credentials: 'omit',
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        let text = await response.text();
        if (text.length > DEFAULT_MAX_CHARS) text = text.slice(0, DEFAULT_MAX_CHARS);
        const res: FetchResult = {
          status: response.status,
          text,
          url: response.url || url,
          contentType: response.headers?.get?.('content-type') ?? '',
        };
        if (response.status === 429) parkedHosts.set(host, 'HTTP 429 (rate limited)');
        writeCache(key, res);
        return res;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
        return { status: 0, text: '', url, contentType: '', error: timedOut ? 'timed out' : e.message.slice(0, 200) };
      }
    });
  }

  return {
    get: (url, opts = {}) => send('GET', url, undefined, opts),
    post: (url, body, opts = {}) => send('POST', url, body, opts),
    park: (host, reason) => {
      if (host && !parkedHosts.has(host.toLowerCase())) parkedHosts.set(host.toLowerCase(), reason);
    },
    parked: (host) => parkedHosts.get(host.toLowerCase()),
    requestCount: () => sent,
  };
}

/** JSON body of a 2xx response, or undefined. */
export function jsonOf<T>(res: FetchResult): T | undefined {
  if (res.status < 200 || res.status >= 300 || !res.text) return undefined;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return undefined;
  }
}
