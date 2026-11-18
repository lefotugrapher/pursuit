// Polite HTTP client for discovery. Server-only.
//
// - One request at a time per host, spaced by at least `minIntervalMs` (default 1 req/s per host, SPEC §0.6).
// - Retries 429 / 5xx / network errors / timeouts with exponential backoff.
// - A 429 whose Retry-After is longer than we are willing to wait parks the host for the rest of the
//   process (or until Retry-After passes): further requests to it fail fast instead of hammering it.
// - Never sends cookies, never follows anything but plain redirects, 20 s timeout.

import { redactSecrets } from '@/lib/env';
import type { Http } from '@/lib/types';

export const USER_AGENT = 'Pursuit/1.0 (personal job search)';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MIN_INTERVAL_MS = 1_000;
export const DEFAULT_RETRIES = 2;
/** Longest Retry-After we will sleep through before giving up on a host for now. */
export const MAX_RETRY_AFTER_MS = 30_000;
const MAX_BACKOFF_MS = 15_000;
const MAX_BODY_CHARS = 25_000_000;

type BaseGetOptions = NonNullable<Parameters<Http['get']>[1]>;

/** Extra knobs our own Http honours. Other Http implementations (test stubs) simply ignore them. */
export interface PoliteGetOptions extends BaseGetOptions {
  /** Retries after the first attempt (default 2). 0 = fail/return on the first 429/5xx. */
  retries?: number;
  timeoutMs?: number;
}

export interface HttpResponse { status: number; text: string; url: string }

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, url: string, retryAfterMs?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface CreateHttpOptions {
  userAgent?: string;
  timeoutMs?: number;
  retries?: number;
  defaultMinIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PoliteHttp extends Http {
  /** Hosts currently parked after a long 429, with the time (ms epoch) they become usable again. */
  blockedHosts(): { host: string; until: number }[];
}

const SENSITIVE_PARAMS = /^(app_id|app_key|api_key|apikey|key|token|access_token|password|secret)$/i;

/** URL safe for logs and error messages: credentials in the query string are masked. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const name of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAMS.test(name)) u.searchParams.set(name, 'REDACTED');
    }
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    return redactSecrets(u.toString());
  } catch {
    return redactSecrets(raw);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    throw new HttpError(`Invalid URL: ${redactUrl(url)}`, 0, redactUrl(url));
  }
}

/** Retry-After as milliseconds (seconds or an HTTP date). */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const isRetryableStatus = (status: number): boolean => status === 429 || status === 408 || status >= 500;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

export function createHttp(options: CreateHttpOptions = {}): PoliteHttp {
  const userAgent = options.userAgent ?? USER_AGENT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const defaultInterval = options.defaultMinIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const defaultRetries = options.retries ?? DEFAULT_RETRIES;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const lastRequestAt = new Map<string, number>();
  const hostQueue = new Map<string, Promise<unknown>>();
  const blockedUntil = new Map<string, number>();

  /** Runs `task` after every earlier task for the same host has settled. */
  function serialised<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = hostQueue.get(host) ?? Promise.resolve();
    const next = previous.then(task, task);
    hostQueue.set(host, next.catch(() => undefined));
    return next;
  }

  async function waitForSlot(host: string, minIntervalMs: number): Promise<void> {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, now());
  }

  function assertNotBlocked(host: string, url: string): void {
    const until = blockedUntil.get(host);
    if (until === undefined) return;
    if (until > now()) {
      throw new HttpError(`${host} is rate-limiting us; paused until ${new Date(until).toISOString()}`, 429, redactUrl(url), until - now());
    }
    blockedUntil.delete(host);
  }

  async function attempt(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ res?: HttpResponse; retryAfterMs?: number; error?: Error }> {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      });
      let text = await response.text();
      if (text.length > MAX_BODY_CHARS) text = text.slice(0, MAX_BODY_CHARS);
      return {
        res: { status: response.status, text, url: response.url || url },
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      return { error: new Error(timedOut ? `timed out after ${timeoutMs} ms` : e.message) };
    }
  }

  async function get(url: string, opts: PoliteGetOptions = {}): Promise<HttpResponse> {
    const host = hostOf(url);
    const minInterval = Math.max(defaultInterval, opts.minIntervalMs ?? 0);
    const retries = Math.max(0, opts.retries ?? defaultRetries);
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'application/json, text/html;q=0.9, */*;q=0.5',
      'Accept-Language': 'en-IE,en;q=0.9',
      ...opts.headers,
    };

    return serialised(host, async () => {
      let lastError: Error | undefined;
      let lastResponse: HttpResponse | undefined;
      for (let i = 0; i <= retries; i++) {
        assertNotBlocked(host, url);
        await waitForSlot(host, minInterval);
        const { res, retryAfterMs, error } = await attempt(url, headers, timeoutMs);
        if (res) {
          lastResponse = res;
          lastError = undefined;
          if (!isRetryableStatus(res.status)) return res;
          if (res.status === 429 && retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
            blockedUntil.set(host, now() + retryAfterMs);
            return res; // caller sees the 429; later calls to this host fail fast
          }
          if (i < retries) await sleep(Math.max(backoffMs(i), Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS)));
        } else {
          lastError = error;
          if (i < retries) await sleep(backoffMs(i));
        }
      }
      if (lastResponse) return lastResponse;
      throw new HttpError(`GET ${redactUrl(url)} failed: ${lastError?.message ?? 'unknown error'}`, 0, redactUrl(url));
    });
  }

  async function json<T = unknown>(url: string, opts: PoliteGetOptions = {}): Promise<T> {
    const res = await get(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
    if (res.status < 200 || res.status >= 300) {
      const snippet = res.text.slice(0, 160).replace(/\s+/g, ' ').trim();
      throw new HttpError(`GET ${redactUrl(url)} → HTTP ${res.status}${snippet ? `: ${redactSecrets(snippet)}` : ''}`, res.status, redactUrl(url));
    }
    try {
      return JSON.parse(res.text) as T;
    } catch {
      throw new HttpError(`GET ${redactUrl(url)} returned invalid JSON`, res.status, redactUrl(url));
    }
  }

  return {
    get,
    json,
    blockedHosts: () => [...blockedUntil.entries()].filter(([, until]) => until > now()).map(([host, until]) => ({ host, until })),
  };
}

/** Status of an error thrown by Http.json (0 when it was not an HTTP status error). */
export function errorStatus(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  return 0;
}

export function errorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}
