// Environment access. Server-only. Values are never logged; use envStatus() to report presence.
//
// .env.local is parsed once, lazily, and only fills keys that are absent from process.env
// (an explicitly empty value in process.env wins, which lets tests switch features off).
// Set PURSUIT_SKIP_ENV_FILE=1 to skip the file entirely.

import fs from 'node:fs';
import { ENV_FILE } from './paths';

let fileLoaded = false;

/** Minimal KEY=VALUE parser: comments, blank lines, `export ` prefix, single/double quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFileOnce(): void {
  if (fileLoaded) return;
  fileLoaded = true;
  if (process.env.PURSUIT_SKIP_ENV_FILE === '1') return;
  let text: string;
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    return; // no .env.local: everything optional degrades gracefully
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function read(key: string): string | undefined {
  loadEnvFileOnce();
  const v = process.env[key]?.trim();
  return v ? v : undefined;
}

export const DEFAULT_LLM_MODEL = 'google/gemma-4-31b-it:free';
/** Tried in order when a model is rate limited. All free. */
export const DEFAULT_LLM_MODELS = 'google/gemma-4-31b-it:free,nvidia/nemotron-3.5-lightning:free,dots-studio/dots-3-note-preview:free,cohere/north-mini-code:free';

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
export const DEFAULT_ORCAROUTER_MODELS = ['deepseek/deepseek-v4.1-flash-free', 'z-ai/glm-5.3-flash-free', 'deepseek/deepseek-v4-flash-free', 'tencent/hy4-preview-free'];
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3-14b-abl:latest';

/** Live view of the environment (getters re-read process.env, so tests can toggle keys). */
export const env = {
  get OPENROUTER_API_KEY() { return read('OPENROUTER_API_KEY'); },
  get LLM_MODEL() { return read('LLM_MODEL') ?? DEFAULT_LLM_MODEL; },
  get LLM_MODELS() { return read('LLM_MODELS') ?? DEFAULT_LLM_MODELS; },
  get LLM_ALLOW_PAID(): boolean { return read('LLM_ALLOW_PAID') === '1'; },
  get GEMINI_API_KEY() { return read('GEMINI_API_KEY'); },
  get GEMINI_MODEL() { return read('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL; },
  get GROQ_API_KEY() { return read('GROQ_API_KEY'); },
  get ORCAROUTER_API_KEY() { return read('ORCAROUTER_API_KEY'); },
  get ORCAROUTER_MODELS(): string[] {
    const list = (read('ORCAROUTER_MODELS') ?? '').split(',').map((m) => m.trim()).filter(Boolean);
    return list.length ? list : DEFAULT_ORCAROUTER_MODELS;
  },
  get GROQ_MODEL() { return read('GROQ_MODEL') ?? DEFAULT_GROQ_MODEL; },
  get OLLAMA_URL() { return (read('OLLAMA_URL') ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, ''); },
  get OLLAMA_MODEL() { return read('OLLAMA_MODEL') ?? DEFAULT_OLLAMA_MODEL; },
  /** '1' = always use local Ollama, '0' = never, undefined = auto (on when Ollama answers /api/tags). */
  get LLM_LOCAL(): '1' | '0' | undefined {
    const v = read('LLM_LOCAL');
    return v === '1' ? '1' : v === '0' ? '0' : undefined;
  },
  get GMAIL_USER() { return read('GMAIL_USER'); },
  get GMAIL_APP_PASSWORD() { return read('GMAIL_APP_PASSWORD'); },
  get IMAP_HOST() { return read('IMAP_HOST') ?? 'imap.gmail.com'; },
  get SMTP_HOST() { return read('SMTP_HOST') ?? 'smtp.gmail.com'; },
  get ADZUNA_APP_ID() { return read('ADZUNA_APP_ID'); },
  get ADZUNA_APP_KEY() { return read('ADZUNA_APP_KEY'); },
  get NTFY_TOPIC() { return read('NTFY_TOPIC'); },
  get TELEGRAM_BOT_TOKEN() { return read('TELEGRAM_BOT_TOKEN'); },
  get TELEGRAM_CHAT_ID() { return read('TELEGRAM_CHAT_ID'); },
  get SEARXNG_URL() { return read('SEARXNG_URL'); },
  get NTFY_URL() { return read('NTFY_URL'); },
};

export type EnvKey = keyof typeof env;

// Auto-detection of local Ollama. hasLLM() must stay synchronous, so it reports the last probe result and
// refreshes it in the background. Auto-probing is skipped when PURSUIT_SKIP_ENV_FILE=1 (test mode).
const PROBE_TTL_MS = 60_000;
let localProbe = { up: false, at: 0, running: false };

/** Probes Ollama's /api/tags and caches the answer. Never throws. */
export async function refreshLocalProbe(): Promise<boolean> {
  if (localProbe.running) return localProbe.up;
  localProbe.running = true;
  let up = false;
  try {
    const res = await globalThis.fetch(`${env.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    up = res.ok;
    await res.body?.cancel().catch(() => undefined);
  } catch {
    up = false;
  }
  localProbe = { up, at: Date.now(), running: false };
  return up;
}

/**
 * True when local Ollama should be part of the chain. OFF unless LLM_LOCAL=1: Kayzee (2026-11-16) doesn't want his
 * laptop's compute used while free online providers exist.
 */
export function localLLMEnabled(): boolean {
  return env.LLM_LOCAL === '1';
}

export function hasLLM(): boolean {
  return Boolean(env.OPENROUTER_API_KEY || env.GEMINI_API_KEY || env.GROQ_API_KEY || env.ORCAROUTER_API_KEY) || localLLMEnabled();
}

export function hasMail(): boolean {
  return Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD);
}

export function hasAdzuna(): boolean {
  return Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY);
}

export interface EnvKeyStatus { key: EnvKey; set: boolean; purpose: string; optional: boolean }

const ENV_META: { key: EnvKey; purpose: string; optional: boolean }[] = [
  { key: 'OPENROUTER_API_KEY', purpose: 'LLM features (heuristics used when missing)', optional: true },
  { key: 'LLM_MODEL', purpose: 'OpenRouter model id', optional: true },
  { key: 'GEMINI_API_KEY', purpose: 'Free Gemini fallback when OpenRouter hits its daily cap', optional: true },
  { key: 'GROQ_API_KEY', purpose: 'Free Groq fallback when OpenRouter hits its daily cap', optional: true },
  { key: 'ORCAROUTER_API_KEY', purpose: 'OrcaRouter free models (-free only) when OpenRouter hits its daily cap', optional: true },
  { key: 'GMAIL_USER', purpose: 'Inbox watching + sending approved email', optional: true },
  { key: 'GMAIL_APP_PASSWORD', purpose: 'Gmail app password for IMAP/SMTP', optional: true },
  { key: 'ADZUNA_APP_ID', purpose: 'Adzuna discovery source', optional: true },
  { key: 'ADZUNA_APP_KEY', purpose: 'Adzuna discovery source', optional: true },
  { key: 'NTFY_URL', purpose: 'Phone push notifications', optional: true },
  { key: 'NTFY_TOPIC', purpose: 'Phone push notifications', optional: true },
  { key: 'TELEGRAM_BOT_TOKEN', purpose: 'Telegram: questions, updates and approvals on your phone', optional: true },
  { key: 'SEARXNG_URL', purpose: 'Private web search for finding employer careers pages', optional: true },
];

/** Which keys are configured. Never includes values. */
export function envStatus(): EnvKeyStatus[] {
  return ENV_META.map((m) => ({ ...m, set: m.key === 'LLM_MODEL' ? Boolean(read('LLM_MODEL')) : Boolean(env[m.key]) }));
}

const SECRET_KEYS: EnvKey[] = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'ORCAROUTER_API_KEY', 'GMAIL_APP_PASSWORD', 'ADZUNA_APP_KEY', 'NTFY_TOPIC', 'TELEGRAM_BOT_TOKEN'];

function secretValues(): string[] {
  const values = new Set<string>();
  for (const key of SECRET_KEYS) {
    const v = env[key];
    if (typeof v !== 'string' || v.length < 6) continue;
    values.add(v);
    const compact = v.replace(/\s+/g, ''); // Gmail app passwords are often written with spaces
    if (compact.length >= 6) values.add(compact);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Replaces any configured secret value appearing in `text` with [redacted]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secretValues()) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** Test hook: forget that .env.local was read so the next access re-reads it. */
export function resetEnvCache(): void {
  fileLoaded = false;
}
