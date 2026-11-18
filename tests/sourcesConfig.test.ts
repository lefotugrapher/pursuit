// Validates the watchlist seed (config/sources.json) and the committed example against the
// SourcesConfig contract. Pure file checks: no network, never touches a real employer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import type { SourcesConfig } from '@/lib/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES_PATH = path.join(ROOT, 'config', 'sources.json');
const EXAMPLE_PATH = path.join(ROOT, 'config', 'sources.example.json');

const WATCH_ATS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'] as const;

/** Local mirror of SourcesConfig so this test does not depend on src/lib/config.ts being finished. */
const LocalSourcesSchema = z.object({
  companies: z.array(z.object({
    name: z.string().min(1),
    ats: z.enum(WATCH_ATS),
    token: z.string().min(1),
    enabled: z.boolean(),
    tags: z.array(z.string()).optional(),
    verifiedAt: z.string().optional(),
  }).strict()),
  linkedinGuest: z.object({
    enabled: z.boolean(),
    queries: z.array(z.object({ keywords: z.string().min(1), location: z.string().min(1) }).strict()),
    maxPerQuery: z.number().int().positive(),
    minIntervalMs: z.number().int().nonnegative(),
  }).strict(),
  adzuna: z.object({
    enabled: z.boolean(),
    queries: z.array(z.object({ what: z.string().min(1), where: z.string().min(1), country: z.enum(['ie', 'gb']) }).strict()),
  }).strict(),
  gmailAlerts: z.object({ enabled: z.boolean() }).strict(),
  boardSearch: z.object({ enabled: z.boolean(), queries: z.array(z.string().min(1)) }).strict().default({ enabled: true, queries: [] }),
  titleMustMatch: z.array(z.string().min(1)),
}).strict();

function loadJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function parseConfig(file: string): SourcesConfig {
  const result = LocalSourcesSchema.safeParse(loadJson(file));
  if (!result.success) assert.fail(`${path.basename(file)} does not match SourcesConfig:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Same rule the ATS adapters apply: lowercase title contains any rule. */
function titleMatches(title: string, rules: string[]): boolean {
  const t = title.toLowerCase();
  return rules.some((r) => t.includes(r));
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

test('sources.json matches the SourcesConfig shape', () => {
  parseConfig(SOURCES_PATH);
});

test('sources.example.json matches the SourcesConfig shape and stays small', () => {
  const example = parseConfig(EXAMPLE_PATH);
  assert.equal(example.companies.length, 3, 'example should carry exactly 3 public examples');
});

test('sources.json also passes the app SourcesSchema when config.ts is available', async (t) => {
  let schema: { safeParse(v: unknown): { success: boolean; error?: unknown } } | undefined;
  try {
    const mod = (await import('@/lib/config')) as Record<string, unknown>;
    schema = mod.SourcesSchema as typeof schema;
  } catch {
    schema = undefined;
  }
  if (!schema || typeof schema.safeParse !== 'function') {
    t.skip('src/lib/config.ts SourcesSchema not available yet');
    return;
  }
  for (const file of [SOURCES_PATH, EXAMPLE_PATH]) {
    const r = schema.safeParse(loadJson(file));
    assert.ok(r.success, `${path.basename(file)} rejected by SourcesSchema: ${String(r.error)}`);
  }
});

test('watchlist companies are verified, unique and well-formed', () => {
  const cfg = parseConfig(SOURCES_PATH);
  assert.ok(cfg.companies.length >= 60, `expected >= 60 verified companies, got ${cfg.companies.length}`);

  const seenBoards = new Set<string>();
  const seenNames = new Set<string>();
  for (const c of cfg.companies) {
    assert.match(c.token, TOKEN_RE, `${c.name}: token "${c.token}" has unsafe characters`);
    const board = `${c.ats}:${c.token.toLowerCase()}`;
    assert.ok(!seenBoards.has(board), `duplicate board ${board}`);
    seenBoards.add(board);
    const name = c.name.toLowerCase();
    assert.ok(!seenNames.has(name), `duplicate company name ${c.name}`);
    seenNames.add(name);
    assert.ok(c.verifiedAt && ISO_DATE_RE.test(c.verifiedAt), `${c.name}: verifiedAt must be YYYY-MM-DD`);
    assert.ok(c.tags && c.tags.length > 0, `${c.name}: tags should describe sector and Irish relevance`);
    for (const tag of c.tags ?? []) assert.match(tag, /^[a-z0-9-]+$/, `${c.name}: tag "${tag}" should be kebab-case`);
  }
});

test('every company has an Irish or Northern Irish relevance tag', () => {
  const cfg = parseConfig(SOURCES_PATH);
  const relevance = new Set(['ie-office', 'ni-office', 'remote-ie']);
  for (const c of cfg.companies) {
    assert.ok((c.tags ?? []).some((t) => relevance.has(t)), `${c.name}: missing ie-office / ni-office / remote-ie tag`);
  }
});

test('LinkedIn guest search respects SPEC §0.4 rate limit and stays focused', () => {
  const { linkedinGuest } = parseConfig(SOURCES_PATH);
  assert.ok(linkedinGuest.minIntervalMs >= 3000, 'LinkedIn guest pages must be <= 1 request / 3 s');
  assert.ok(linkedinGuest.maxPerQuery <= 100);
  assert.equal(linkedinGuest.queries.length, 24);
  const pairs = new Set(linkedinGuest.queries.map((q) => `${q.keywords.toLowerCase()}|${q.location.toLowerCase()}`));
  assert.equal(pairs.size, linkedinGuest.queries.length, 'duplicate LinkedIn query pair');
  const locations = new Set(linkedinGuest.queries.map((q) => q.location));
  for (const loc of ['Dublin, Ireland', 'Dundalk, Ireland', 'Ireland', 'Belfast, United Kingdom']) {
    assert.ok(locations.has(loc), `missing LinkedIn location ${loc}`);
  }
});

test('Adzuna stays off by default and only targets Ireland + UK', () => {
  const { adzuna, gmailAlerts } = parseConfig(SOURCES_PATH);
  assert.equal(adzuna.enabled, false, 'Adzuna needs API keys, so the seed keeps it off');
  assert.ok(adzuna.queries.some((q) => q.country === 'ie'));
  assert.ok(adzuna.queries.some((q) => q.country === 'gb'));
  assert.equal(gmailAlerts.enabled, true);
});

test('titleMustMatch rules are lowercase and untrimmed-safe', () => {
  const { titleMustMatch } = parseConfig(SOURCES_PATH);
  for (const rule of titleMustMatch) {
    assert.equal(rule, rule.toLowerCase(), `rule "${rule}" must be lowercase`);
    assert.equal(rule, rule.trim(), `rule "${rule}" must not rely on leading/trailing spaces`);
  }
  assert.equal(new Set(titleMustMatch).size, titleMustMatch.length, 'duplicate titleMustMatch rule');
});

test('titleMustMatch keeps target roles and drops obvious non-targets', () => {
  const { titleMustMatch } = parseConfig(SOURCES_PATH);
  const keep = [
    'Marketing Executive',
    'PR & Communications Executive',
    'PR Executive',
    'Digital PR Account Executive',
    'Social Media Executive',
    'Content Creator',
    'Digital Marketing Executive',
    'Graduate Programme 2026',
    'Events Coordinator',
    'Event Manager',
    'Internal Comms Specialist',
    'Communications Officer',
    'Community Manager, EMEA',
    'Brand Ambassador',
    'Copywriter',
    'Public Relations Assistant',
    'Partnerships Associate',
    'Marketing Internship (Summer 2027)',
    'Engagement Officer',
    'Press Officer',
    'Media Relations Executive',
    'Paid Media Executive',
    'Video Editor',
    'Editorial Assistant',
    'Speechwriter',
  ];
  const drop = [
    'Senior Software Engineer',
    'Account Executive, SMB',
    'International Tax Manager',
    'Fraud Prevention Analyst',
    'Head of Product',
    'Product Manager',
    'Project Manager',
    'Data Scientist',
    'Site Reliability Engineer',
    'Financial Controller',
    'HR Business Partner',
    'Sales Development Representative',
    'Engineering/Product Lead',
    'Procurement Specialist',
    'Intermediate Software Engineer',
    'Creditors Clerk',
    'Commercial Underwriter',
    'WordPress Developer',
    'Compression Engineer',
  ];
  for (const title of keep) assert.ok(titleMatches(title, titleMustMatch), `should keep "${title}"`);
  for (const title of drop) assert.ok(!titleMatches(title, titleMustMatch), `should drop "${title}"`);
});
