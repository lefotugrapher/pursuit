// Filesystem layout. Server-only.
//
// Overrides (mainly for tests and unusual installs):
//   PURSUIT_ROOT        project root (default: nearest package.json named "pursuit")
//   PURSUIT_DATA_DIR    data directory (default: <root>/data)
//   PURSUIT_CONFIG_DIR  config directory (default: <root>/config)
//   PURSUIT_DB_PATH     SQLite file (default: <data>/pursuit.db)
//   PURSUIT_MASTER_CV   master CV .tex (default: ~/skill/cv/Kshitiz_Mittal_CV.tex)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'pursuit';

function isPursuitRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
    return pkg.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

function findUp(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (isPursuitRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function moduleDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null; // bundlers may rewrite import.meta.url to something non-file
  }
}

function resolveRoot(): string {
  const fromEnv = process.env.PURSUIT_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const here = moduleDir();
  return (here && findUp(here)) ?? findUp(process.cwd()) ?? process.cwd();
}

function envPath(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? path.resolve(v) : undefined;
}

export const ROOT = resolveRoot();
export const DATA_DIR = envPath('PURSUIT_DATA_DIR') ?? path.join(ROOT, 'data');
export const ARTIFACTS_DIR = path.join(DATA_DIR, 'artifacts');
export const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');
/** Files Kayzee uploads on the About-me page as evidence. Inside data/, so never in git. */
export const EVIDENCE_DIR = path.join(DATA_DIR, 'evidence');
/**
 * Pursuit's own Chrome profile lives OUTSIDE the project folder: Chrome keeps lock links in it while running, and
 * the dashboard build (Turbopack) trips over them if the folder sits inside the project. Override with
 * PURSUIT_CHROME_PROFILE (Docker sets it under /app/data).
 */
export const CHROME_PROFILE_DIR = envPath('PURSUIT_CHROME_PROFILE')
  ?? path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Application Support/Pursuit' : '.local/share/pursuit', 'chrome-profile');
export const CONFIG_DIR = envPath('PURSUIT_CONFIG_DIR') ?? path.join(ROOT, 'config');
export const DB_PATH = envPath('PURSUIT_DB_PATH') ?? path.join(DATA_DIR, 'pursuit.db');
/** Master CV: env override, else the Mac master in ~/skill/cv, else the portable copy bundled in config/cv/. */
export const MASTER_CV_TEX = envPath('PURSUIT_MASTER_CV') ?? (() => {
  const home = path.join(os.homedir(), 'skill', 'cv', 'Kshitiz_Mittal_CV.tex');
  return fs.existsSync(home) ? home : path.join(CONFIG_DIR, 'cv', 'Kshitiz_Mittal_CV.tex');
})();
export const ENV_FILE = path.join(ROOT, '.env.local');
export const WORKER_LOCK = path.join(DATA_DIR, 'worker.lock');

/** Turns any id into a single safe path segment (no separators, no dot-dot). */
export function safeSegment(id: string): string {
  const cleaned = String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  if (!cleaned || /^_+$/.test(cleaned)) throw new Error(`Unsafe or empty path segment: ${JSON.stringify(id)}`);
  return cleaned;
}

/** data/artifacts/<jobId> (not created; call ensureDir when writing). */
export function jobArtifactDir(jobId: string): string {
  return path.join(ARTIFACTS_DIR, safeSegment(jobId));
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** True when `child` resolves inside `parent` (used to keep file serving inside data dirs). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
