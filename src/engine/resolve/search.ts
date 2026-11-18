// Web search with pluggable backends: SearXNG (if SEARXNG_URL), DuckDuckGo HTML, Bing HTML.
// A backend that answers with a CAPTCHA / bot check is switched off for the rest of the run: we never
// try to solve or get around it. Results are cached per query for the run.

import { cleanInline, decodeEntities } from '@/engine/sources/normalize';
import { type ResolverHttp, jsonOf } from './http';

export type SearchBackendId = 'searxng' | 'duckduckgo' | 'bing';

export interface SearchResult { url: string; title: string; snippet: string; backend: SearchBackendId }

export class SearchBlockedError extends Error {
  constructor(readonly backend: SearchBackendId, readonly reason: string) {
    super(`${backend} blocked: ${reason}`);
    this.name = 'SearchBlockedError';
  }
}

export interface SearchBackend {
  id: SearchBackendId;
  host: string;
  search(http: ResolverHttp, query: string): Promise<SearchResult[]>;
}

const stripTags = (html: string) => cleanInline(decodeEntities(html.replace(/<[^>]+>/g, ' ')));

function cleanResultUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

// ───────────────────────────── DuckDuckGo ─────────────────────────────

/** DuckDuckGo's "anomaly" page (HTTP 202) is a CAPTCHA: stop, never solve. */
export function isDuckDuckGoBlocked(status: number, html: string): string | undefined {
  if (status === 403 || status === 429) return `HTTP ${status}`;
  if (/anomaly-modal|bots use DuckDuckGo too|complete the following challenge/i.test(html)) return 'bot check (anomaly page)';
  if (status === 202) return 'HTTP 202';
  return undefined;
}

/** Decodes //duckduckgo.com/l/?uddg=<url> redirect links; direct links pass through. */
export function decodeDuckDuckGoHref(href: string): string | undefined {
  const h = decodeEntities(href);
  try {
    const u = new URL(h, 'https://html.duckduckgo.com');
    if (/duckduckgo\.com$/i.test(u.hostname)) {
      const target = u.searchParams.get('uddg');
      return target ? cleanResultUrl(target) : undefined;
    }
    return cleanResultUrl(u.toString());
  } catch {
    return undefined;
  }
}

export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/.test(block.slice(0, 200))) continue;
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block) ?? /<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = decodeDuckDuckGoHref(a[1]);
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '';
    out.push({ url, title: stripTags(a[2]), snippet: stripTags(snippet), backend: 'duckduckgo' });
  }
  return out;
}

export const duckduckgoBackend: SearchBackend = {
  id: 'duckduckgo',
  host: 'html.duckduckgo.com',
  async search(http, query) {
    const res = await http.post('https://html.duckduckgo.com/html/', new URLSearchParams({ q: query, b: '', kl: 'ie-en' }).toString(), {
      contentType: 'application/x-www-form-urlencoded',
      headers: { Referer: 'https://html.duckduckgo.com/' },
      noCache: false,
    });
    if (res.status === 0) throw new Error(res.error ?? 'network error');
    const blocked = isDuckDuckGoBlocked(res.status, res.text);
    if (blocked) throw new SearchBlockedError('duckduckgo', blocked);
    return parseDuckDuckGoHtml(res.text);
  },
};

// ───────────────────────────── Bing ─────────────────────────────

/** Bing wraps results as bing.com/ck/a?...&u=a1<base64url(target)>. */
export function decodeBingHref(href: string): string | undefined {
  const h = decodeEntities(href);
  const m = /[?&]u=a1([^&]+)/.exec(h);
  if (!m) return cleanResultUrl(h);
  let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try {
    return cleanResultUrl(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function isBingBlocked(status: number, html: string): string | undefined {
  if (status === 403 || status === 429) return `HTTP ${status}`;
  const hasResults = /<li class="b_algo"/.test(html);
  if (!hasResults && /id="b_captcha"|solve the challenge|verify you are (a )?human|unusual traffic/i.test(html)) return 'bot check';
  return undefined;
}

export function parseBingHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = decodeBingHref(a[1]);
    if (!url) continue;
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '';
    out.push({ url, title: stripTags(a[2]), snippet: stripTags(snippet), backend: 'bing' });
  }
  return out;
}

export const bingBackend: SearchBackend = {
  id: 'bing',
  host: 'www.bing.com',
  async search(http, query) {
    const res = await http.get(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en-IE&cc=IE`);
    if (res.status === 0) throw new Error(res.error ?? 'network error');
    const blocked = isBingBlocked(res.status, res.text);
    if (blocked) throw new SearchBlockedError('bing', blocked);
    return parseBingHtml(res.text);
  },
};

// ───────────────────────────── SearXNG ─────────────────────────────

export function parseSearxngJson(data: unknown): SearchResult[] {
  const results = (data as { results?: { url?: string; title?: string; content?: string }[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r) => {
    const url = r.url ? cleanResultUrl(r.url) : undefined;
    return url ? [{ url, title: cleanInline(r.title ?? ''), snippet: cleanInline(r.content ?? ''), backend: 'searxng' as const }] : [];
  });
}

export function searxngBackend(baseUrl: string): SearchBackend {
  const base = baseUrl.replace(/\/+$/, '');
  let host = 'searxng';
  try {
    host = new URL(base).hostname;
  } catch {
    // invalid URL: requests fail and the backend is skipped
  }
  return {
    id: 'searxng',
    host,
    async search(http, query) {
      const res = await http.get(`${base}/search?q=${encodeURIComponent(query)}&format=json&language=en-IE&safesearch=0`, { headers: { Accept: 'application/json' }, minIntervalMs: 2_000 });
      if (res.status === 429 || res.status === 403) throw new SearchBlockedError('searxng', `HTTP ${res.status}`);
      if (res.status !== 200) throw new Error(res.error ?? `HTTP ${res.status}`);
      return parseSearxngJson(jsonOf(res));
    },
  };
}

/** SearXNG first when configured, then DuckDuckGo, then Bing. */
export function defaultBackends(env: NodeJS.ProcessEnv = process.env): SearchBackend[] {
  const list: SearchBackend[] = [];
  const sx = env.SEARXNG_URL?.trim();
  if (sx) list.push(searxngBackend(sx));
  list.push(duckduckgoBackend, bingBackend);
  return list;
}

// ───────────────────────────── Searcher ─────────────────────────────

export interface SearchOutcome { results: SearchResult[]; backend?: SearchBackendId; unavailable?: boolean }

export class Searcher {
  private readonly cache = new Map<string, SearchOutcome>();
  readonly blocked = new Map<SearchBackendId, string>();
  private count = 0;

  constructor(
    private readonly http: ResolverHttp,
    private readonly backends: SearchBackend[],
    private readonly maxQueries = 80,
  ) {}

  get queries(): number {
    return this.count;
  }

  /** False once every backend is blocked or the per-run query budget is spent. */
  available(): boolean {
    return this.count < this.maxQueries && this.backends.some((b) => !this.blocked.has(b.id));
  }

  async search(query: string): Promise<SearchOutcome> {
    const key = query.trim().toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (this.count >= this.maxQueries) return { results: [], unavailable: true };
    for (const b of this.backends) {
      if (this.blocked.has(b.id)) continue;
      this.count++;
      try {
        const results = await b.search(this.http, query);
        const outcome: SearchOutcome = { results, backend: b.id };
        this.cache.set(key, outcome);
        return outcome;
      } catch (err) {
        if (err instanceof SearchBlockedError) {
          this.blocked.set(b.id, err.reason);
          this.http.park(b.host, `${b.id}: ${err.reason}`);
        }
        // network error: try the next backend for this query
      }
    }
    return { results: [], unavailable: true };
  }
}
