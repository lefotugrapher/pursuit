// Environment health checks for `pnpm doctor` and the dashboard Settings page. Server-only.
// Every check is isolated: one failing (or throwing) never stops the rest. Secrets are reported as
// set / not set only.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { configStatus } from './config';
import { countJobs, db, schemaVersion, SCHEMA_VERSION } from './db';
import { env, envStatus, hasLLM, hasMail } from './env';
import { ARTIFACTS_DIR, CHROME_PROFILE_DIR, DATA_DIR, MASTER_CV_TEX, SCREENSHOTS_DIR, WORKER_LOCK } from './paths';

const execFileP = promisify(execFile);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Optional checks don't block core use (shown as warnings). */
  optional?: boolean;
}

export const CHROME_APP = '/Applications/Google Chrome.app';
const TECTONIC_FALLBACKS = ['/opt/homebrew/bin/tectonic', '/usr/local/bin/tectonic'];
const MIN_NODE_MAJOR = 24;

async function guard(name: string, fn: () => Promise<DoctorCheck | DoctorCheck[]> | DoctorCheck | DoctorCheck[]): Promise<DoctorCheck[]> {
  try {
    const result = await fn();
    return Array.isArray(result) ? result : [result];
  } catch (err) {
    return [{ name, ok: false, detail: `check crashed: ${(err as Error).message}` }];
  }
}

function checkNode(): DoctorCheck {
  const version = process.versions.node;
  const major = Number(version.split('.')[0]);
  return {
    name: 'Node.js',
    ok: major >= MIN_NODE_MAJOR,
    detail: major >= MIN_NODE_MAJOR ? `v${version}` : `v${version}: need ≥ ${MIN_NODE_MAJOR} for node:sqlite`,
  };
}

/** Finds tectonic on PATH, then in Homebrew locations (launchd and Next may run with a short PATH). */
export async function findTectonic(): Promise<{ bin: string; version: string } | null> {
  for (const bin of ['tectonic', ...TECTONIC_FALLBACKS]) {
    try {
      const { stdout } = await execFileP(bin, ['--version'], { timeout: 10_000 });
      return { bin, version: stdout.trim().split('\n')[0] ?? '' };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function checkTectonic(): Promise<DoctorCheck> {
  const found = await findTectonic();
  return found
    ? { name: 'tectonic (LaTeX → PDF)', ok: true, detail: `${found.version}${found.bin === 'tectonic' ? '' : ` at ${found.bin}`}` }
    : { name: 'tectonic (LaTeX → PDF)', ok: false, detail: 'not found: brew install tectonic (CV PDFs cannot compile without it)' };
}

function checkChrome(): DoctorCheck {
  const ok = fs.existsSync(CHROME_APP);
  return { name: 'Google Chrome', ok, detail: ok ? CHROME_APP : `not found at ${CHROME_APP} (needed to fill applications)` };
}

function checkMasterCv(): DoctorCheck {
  try {
    const stat = fs.statSync(MASTER_CV_TEX);
    fs.accessSync(MASTER_CV_TEX, fs.constants.R_OK);
    return { name: 'Master CV', ok: stat.size > 0, detail: `${MASTER_CV_TEX} (${(stat.size / 1024).toFixed(1)} KB)` };
  } catch {
    return { name: 'Master CV', ok: false, detail: `missing or unreadable: ${MASTER_CV_TEX}` };
  }
}

function checkConfigs(): DoctorCheck[] {
  return configStatus().map((s) => {
    const name = `config/${s.name}.json`;
    if (s.file === 'missing') return { name, ok: false, detail: `missing (no ${s.name}.json or ${s.name}.example.json)` };
    if (!s.valid) return { name, ok: false, detail: `invalid: ${(s.error ?? '').split('\n').slice(0, 4).join(' ')}` };
    return {
      name,
      ok: true,
      detail: s.file === 'real' ? 'valid' : `valid (using ${s.name}.example.json; copy to ${s.name}.json to customise)`,
    };
  });
}

function checkEnv(): DoctorCheck[] {
  const rows: DoctorCheck[] = envStatus().map((k) =>
    k.key === 'LLM_MODEL'
      ? { name: `env ${k.key}`, ok: true, detail: `${k.set ? 'set' : 'default'}: ${env.LLM_MODEL}`, optional: true }
      : { name: `env ${k.key}`, ok: k.set, detail: `${k.set ? 'set' : 'not set'}: ${k.purpose}`, optional: k.optional },
  );
  rows.push({ name: 'LLM', ok: hasLLM(), detail: hasLLM() ? 'on' : 'off: heuristics only (add OPENROUTER_API_KEY)', optional: true });
  rows.push({ name: 'Mail', ok: hasMail(), detail: hasMail() ? 'configured' : 'off: no inbox watching or sending', optional: true });
  return rows;
}

function checkDb(): DoctorCheck {
  db();
  const version = schemaVersion();
  const jobs = countJobs();
  return {
    name: 'Database',
    ok: version === SCHEMA_VERSION,
    detail: `schema v${version}${version === SCHEMA_VERSION ? '' : ` (expected v${SCHEMA_VERSION})`}, ${jobs} job${jobs === 1 ? '' : 's'}`,
  };
}

function checkWritable(dir: string): DoctorCheck {
  const name = `writable ${path.relative(path.dirname(DATA_DIR), dir) || dir}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { name, ok: true, detail: dir };
  } catch (err) {
    return { name, ok: false, detail: `${dir}: ${(err as Error).message}` };
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function checkWorker(): DoctorCheck {
  let text: string;
  try {
    text = fs.readFileSync(WORKER_LOCK, 'utf8');
  } catch {
    return { name: 'Worker', ok: false, detail: 'not running (start with pnpm worker)', optional: true };
  }
  const pid = Number(/\d+/.exec(text)?.[0]);
  if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) return { name: 'Worker', ok: true, detail: `running (pid ${pid})`, optional: true };
  return { name: 'Worker', ok: false, detail: 'stale lock file, worker not running', optional: true };
}

export async function doctorChecks(): Promise<DoctorCheck[]> {
  const groups = await Promise.all([
    guard('Node.js', checkNode),
    guard('tectonic (LaTeX → PDF)', checkTectonic),
    guard('Google Chrome', checkChrome),
    guard('Master CV', checkMasterCv),
    guard('Config', checkConfigs),
    guard('Environment', checkEnv),
    guard('Database', checkDb),
    guard('Data dirs', () => [DATA_DIR, ARTIFACTS_DIR, SCREENSHOTS_DIR, CHROME_PROFILE_DIR].map(checkWritable)),
    guard('Worker', checkWorker),
  ]);
  return groups.flat();
}
