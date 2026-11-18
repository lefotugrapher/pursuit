// User-editable JSON config (config/*.json, falling back to config/*.example.json), validated with zod.
// Server-only.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR } from './paths';
import type { AnswerBank, AtsKind, FactBank, Profile, Settings, SourcesConfig } from './types';

// ───────────────────────────── Schemas ─────────────────────────────

const str = z.string();
const strList = z.array(z.string());

export const ProfileSchema = z.object({
  name: z.object({ first: str.min(1), last: str.min(1), preferred: str, full: str.min(1) }),
  email: str,
  phone: str,
  location: str,
  links: z.object({ linkedin: str.optional(), portfolio: str.optional(), website: str.optional(), github: str.optional() }),
  targets: z.object({
    roles: strList,
    keywords: strList,
    locations: strList,
    secondaryLocations: strList.default([]),
    remoteOk: z.boolean(),
    seniority: z.array(z.enum(['intern', 'graduate', 'junior', 'executive', 'mid'])),
    excludeTitleWords: strList.default([]),
    maxYearsRequired: z.number().min(0),
    salaryFloorEUR: z.number().min(0),
    blacklistCompanies: strList.default([]),
    languages: strList.default(['English']),
    permanentOnly: z.boolean().optional(),
    ukRightToWork: z.boolean().optional(),
  }),
  workAuth: z.object({ summary: str, needsSponsorship: z.boolean().nullable(), confirm: z.boolean() }),
  coverLetter: z.object({ signOff: str, voiceNotes: strList.default([]) }),
});

const FactSchema = z.object({
  id: str.min(1),
  kind: z.enum(['role', 'achievement', 'education', 'project', 'skill', 'tool', 'award', 'summary', 'other']),
  text: str.min(1),
  org: str.optional(),
  title: str.optional(),
  start: str.optional(),
  end: str.nullable().optional(),
  tags: strList.default([]),
  numbers: strList.optional(),
  cvSection: str.optional(),
  cvBullet: str.optional(),
});

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

export const FactBankSchema = z
  .object({
    version: z.number().int().min(1),
    summaries: z.record(z.string(), z.string()).default({}),
    facts: z.array(FactSchema),
    skills: strList.default([]),
    tools: strList.default([]),
    doNotClaim: strList.default([]),
  })
  .superRefine((bank, ctx) => {
    const dup = duplicates(bank.facts.map((f) => f.id));
    if (dup.length) ctx.addIssue({ code: 'custom', path: ['facts'], message: `Duplicate fact ids: ${dup.join(', ')}` });
  });

const AnswerEntrySchema = z.object({
  id: str.min(1),
  patterns: z.array(str.min(1)).min(1),
  answer: str,
  type: z.enum(['text', 'select', 'yesno', 'number', 'url']).optional(),
  confirm: z.boolean().optional(),
  notes: str.optional(),
});

export const AnswerBankSchema = z
  .object({ entries: z.array(AnswerEntrySchema) })
  .superRefine((bank, ctx) => {
    const dup = duplicates(bank.entries.map((e) => e.id));
    if (dup.length) ctx.addIssue({ code: 'custom', path: ['entries'], message: `Duplicate answer ids: ${dup.join(', ')}` });
  });

const WatchCompanySchema = z.object({
  name: str.min(1),
  ats: z.enum(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']),
  token: str.min(1),
  enabled: z.boolean(),
  tags: strList.optional(),
  verifiedAt: str.optional(),
});

export const SourcesSchema = z.object({
  companies: z.array(WatchCompanySchema),
  linkedinGuest: z
    .object({
      enabled: z.boolean(),
      queries: z.array(z.object({ keywords: str, location: str })),
      maxPerQuery: z.number().int().min(1),
      minIntervalMs: z.number().int().min(3000), // SPEC §0.4: at most 1 request / 3 s
    })
    .default({ enabled: false, queries: [], maxPerQuery: 25, minIntervalMs: 3000 }),
  adzuna: z
    .object({ enabled: z.boolean(), queries: z.array(z.object({ what: str, where: str, country: z.enum(['ie', 'gb']) })) })
    .default({ enabled: false, queries: [] }),
  gmailAlerts: z.object({ enabled: z.boolean() }).default({ enabled: true }),
  boardSearch: z.object({ enabled: z.boolean(), queries: strList }).default({ enabled: true, queries: [] }),
  titleMustMatch: strList.default([]),
});

export const ATS_KINDS = [
  'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'workday', 'linkedin', 'indeed', 'email', 'unknown',
] as const satisfies readonly AtsKind[];

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24h HH:MM');
const score = z.number().min(0).max(100);
const cap = (max: number) => z.number().int().min(0).max(max);

/** Validation for Settings writes (db.updateSettings). Bounds are sanity limits, not policy. */
export const SettingsSchema = z.object({
  mode: z.enum(['review', 'autopilot']),
  paused: z.boolean(),
  minScore: score,
  autoSkipBelow: score,
  dailyApplyCap: cap(100),
  dailyEmailCap: cap(100),
  dailyTailorCap: cap(500),
  followUpDays: z.number().min(1).max(60),
  discoveryEveryHours: z.number().min(0.25).max(168),
  quietHours: z.object({ start: HHMM, end: HHMM }),
  autopilot: z.object({
    enabled: z.boolean(),
    minScore: score,
    dailyCap: cap(100),
    ats: z.array(z.enum(ATS_KINDS)),
    requireAllAnswers: z.boolean(),
    handsFree: z.boolean().optional(),
  }),
});

// Compile-time guarantee that each schema's output is exactly the shared contract type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type _ProfileOk = Assert<Same<z.infer<typeof ProfileSchema>, Profile>>;
export type _FactsOk = Assert<Same<z.infer<typeof FactBankSchema>, FactBank>>;
export type _AnswersOk = Assert<Same<z.infer<typeof AnswerBankSchema>, AnswerBank>>;
export type _SourcesOk = Assert<Same<z.infer<typeof SourcesSchema>, SourcesConfig>>;
export type _SettingsOk = Assert<Same<z.infer<typeof SettingsSchema>, Settings>>;

// ───────────────────────────── Load / save ─────────────────────────────

export type ConfigName = 'profile' | 'facts' | 'answers' | 'sources';

const SCHEMAS = {
  profile: ProfileSchema,
  facts: FactBankSchema,
  answers: AnswerBankSchema,
  sources: SourcesSchema,
} as const;

interface ConfigTypes { profile: Profile; facts: FactBank; answers: AnswerBank; sources: SourcesConfig }

export class ConfigError extends Error {
  constructor(message: string, readonly file?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Read at call time so tests can point PURSUIT_CONFIG_DIR at a temp dir. */
export function configDir(): string {
  const override = process.env.PURSUIT_CONFIG_DIR?.trim();
  return override ? path.resolve(override) : CONFIG_DIR;
}

export function configPaths(name: ConfigName): { real: string; example: string } {
  const dir = configDir();
  return { real: path.join(dir, `${name}.json`), example: path.join(dir, `${name}.example.json`) };
}

interface CacheEntry { mtimeMs: number; size: number; value: unknown }
const cache = new Map<string, CacheEntry>();

function resolveFile(name: ConfigName): string {
  const { real, example } = configPaths(name);
  if (fs.existsSync(real)) return real;
  if (fs.existsSync(example)) return example;
  throw new ConfigError(
    `Missing config: neither ${path.relative(process.cwd(), real) || real} nor ${name}.example.json exists in ${configDir()}`,
  );
}

function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error);
}

function readValidated<N extends ConfigName>(name: N): ConfigTypes[N] {
  const file = resolveFile(name);
  const stat = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return structuredClone(hit.value) as ConfigTypes[N];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(err as Error).message}`, file);
  }
  const parsed = SCHEMAS[name].safeParse(raw);
  if (!parsed.success) throw new ConfigError(`Invalid ${path.basename(file)}:\n${formatZodError(parsed.error)}`, file);
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value: parsed.data });
  return structuredClone(parsed.data) as ConfigTypes[N];
}

/** Atomic write: temp file in the same dir, then rename. */
function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function saveValidated<N extends ConfigName>(name: N, value: unknown): ConfigTypes[N] {
  const parsed = SCHEMAS[name].safeParse(value);
  if (!parsed.success) throw new ConfigError(`Refusing to save invalid ${name}.json:\n${formatZodError(parsed.error)}`);
  const { real } = configPaths(name);
  writeJsonAtomic(real, parsed.data);
  cache.delete(real);
  return structuredClone(parsed.data) as ConfigTypes[N];
}

export const loadProfile = (): Profile => readValidated('profile');
export const loadFacts = (): FactBank => readValidated('facts');
export const loadAnswers = (): AnswerBank => readValidated('answers');
export const loadSources = (): SourcesConfig => readValidated('sources');

export const saveProfile = (p: Profile): Profile => saveValidated('profile', p);
export const saveFacts = (f: FactBank): FactBank => saveValidated('facts', f);
export const saveAnswers = (a: AnswerBank): AnswerBank => saveValidated('answers', a);
export const saveSources = (s: SourcesConfig): SourcesConfig => saveValidated('sources', s);

export interface ConfigFileStatus {
  name: ConfigName;
  file: 'real' | 'example' | 'missing';
  path: string | null;
  valid: boolean;
  error?: string;
}

/** For doctor/settings: which file each config resolves to and whether it validates. */
export function configStatus(): ConfigFileStatus[] {
  return (Object.keys(SCHEMAS) as ConfigName[]).map((name) => {
    const { real, example } = configPaths(name);
    const file = fs.existsSync(real) ? 'real' : fs.existsSync(example) ? 'example' : 'missing';
    const resolved = file === 'real' ? real : file === 'example' ? example : null;
    if (!resolved) return { name, file, path: null, valid: false, error: 'not found' };
    try {
      readValidated(name);
      return { name, file, path: resolved, valid: true };
    } catch (err) {
      return { name, file, path: resolved, valid: false, error: (err as Error).message };
    }
  });
}

/** Validates arbitrary JSON text against a config schema without saving (settings editors). */
export function validateConfigJson(name: ConfigName, text: string): { ok: true } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
  const parsed = SCHEMAS[name].safeParse(raw);
  return parsed.success ? { ok: true } : { ok: false, error: formatZodError(parsed.error) };
}
