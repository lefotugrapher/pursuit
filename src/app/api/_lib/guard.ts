// Request guard for the local API. Pure (no DB): unit-tested in tests/api.test.ts.
//
// The dashboard only ever runs on this Mac, so every API request must carry a local Host header
// (blocks DNS-rebinding pages from reading CVs or triggering tasks). Mutating requests must also
// send `x-pursuit: 1`, which a cross-site form or <img> can't add (simple CSRF guard).
//
// PURSUIT_ALLOWED_HOSTS (comma-separated hostnames, e.g. "kayzees-mac.local,192.168.1.20") lets
// Kayzee open the dashboard from his phone on the home network.

export const CSRF_HEADER = 'x-pursuit';
export const CSRF_VALUE = '1';

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];

/** Hostname from a Host header value ("localhost:7020" → "localhost", "[::1]:7020" → "::1"). */
export function hostnameOf(host: string | null | undefined): string | null {
  const value = host?.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 1 ? value.slice(1, end) : null;
  }
  const colons = value.split(':').length - 1;
  if (colons > 1) return value; // bare IPv6 without brackets
  return value.split(':')[0] || null;
}

export function allowedHostnames(extra: string | undefined = process.env.PURSUIT_ALLOWED_HOSTS): Set<string> {
  const hosts = new Set(LOCAL_HOSTNAMES);
  for (const h of (extra ?? '').split(',')) {
    const name = hostnameOf(h);
    if (name) hosts.add(name);
  }
  return hosts;
}

export function isAllowedHost(host: string | null | undefined, extra?: string): boolean {
  const name = hostnameOf(host);
  return name !== null && allowedHostnames(extra).has(name);
}

/** Origin header must be absent or point at an allowed host. */
export function isAllowedOrigin(origin: string | null | undefined, extra?: string): boolean {
  if (!origin || origin === 'null') return !origin; // "null" origin (sandboxed iframe, file://) is rejected
  try {
    return isAllowedHost(new URL(origin).host, extra);
  } catch {
    return false;
  }
}

export interface GuardInput {
  host: string | null;
  origin: string | null;
  csrf: string | null;
}

export type GuardVerdict = { ok: true } | { ok: false; status: 403; error: string };

export function checkGuard(input: GuardInput, opts: { mutating: boolean; extraHosts?: string }): GuardVerdict {
  if (!isAllowedHost(input.host, opts.extraHosts)) {
    return { ok: false, status: 403, error: 'Forbidden: Pursuit only answers on localhost (set PURSUIT_ALLOWED_HOSTS to add hosts).' };
  }
  if (opts.mutating) {
    if (!isAllowedOrigin(input.origin, opts.extraHosts)) return { ok: false, status: 403, error: 'Forbidden: cross-origin request.' };
    if (input.csrf !== CSRF_VALUE) return { ok: false, status: 403, error: `Forbidden: missing ${CSRF_HEADER} header.` };
  }
  return { ok: true };
}

/** Route-handler helper: returns a 403 Response when the request fails the guard, else null. */
export function guardRequest(req: Request, opts: { mutating: boolean }): Response | null {
  const verdict = checkGuard(
    { host: req.headers.get('host'), origin: req.headers.get('origin'), csrf: req.headers.get(CSRF_HEADER) },
    opts,
  );
  return verdict.ok ? null : Response.json({ ok: false, error: verdict.error }, { status: verdict.status });
}
