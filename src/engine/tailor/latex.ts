// LaTeX helpers for the CV pipeline. Server-only.
//
// The CV model holds PLAIN text (what a reader sees); these helpers convert between plain text and
// LaTeX source that is safe under the master CV's setup (T1 fontenc + Type 1 Source Sans Pro on
// XeTeX/Tectonic). Non-ASCII characters are mapped to LaTeX commands rather than emitted raw, because
// raw Unicode on the Type 1 path can drop glyphs or extract badly for ATS parsers.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ───────────────────────────── Plain text → LaTeX ─────────────────────────────

const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

const UNICODE: Record<string, string> = {
  '–': '--',              // en dash
  '—': '---',             // em dash
  '‑': '-',               // non-breaking hyphen (would extract as U+2011)
  '‐': '-',
  '−': '-',
  '‘': '`',
  '’': "'",
  '“': '``',
  '”': "''",
  '…': '\\ldots{}',
  '•': '\\textbullet{}',
  ' ': '~',
  '€': '\\texteuro{}',
  '£': '\\pounds{}',
  '°': '\\textdegree{}',
  '×': '\\texttimes{}',
  'ß': '\\ss{}',
  'æ': '\\ae{}',
  'Æ': '\\AE{}',
  'ø': '\\o{}',
  'Ø': '\\O{}',
  'å': '\\aa{}',
  'Å': '\\AA{}',
};

// Combining marks (after NFD) → LaTeX accent command.
const ACCENTS: Record<string, string> = {
  '́': "'", '̀': '`', '̂': '^', '̈': '"', '̃': '~', '̄': '=', '̧': 'c', '̌': 'v',
};

const ZERO_WIDTH = /[​-‍﻿­]/g;

function accentChar(ch: string): string {
  const decomposed = ch.normalize('NFD');
  const base = decomposed[0];
  const mark = decomposed.slice(1);
  if (!base || !/^[A-Za-z]$/.test(base)) return '';
  if (mark.length === 1 && ACCENTS[mark]) {
    const cmd = ACCENTS[mark];
    // Letter accents (\c, \v) need a space or braces; symbol accents can be written directly.
    return /[a-z]/.test(cmd) ? `\\${cmd}{${base}}` : `\\${cmd}${base}`;
  }
  return base; // unknown or stacked accents: keep the bare letter rather than break the build
}

/** Escapes plain text for LaTeX: the ten specials plus typographic Unicode the T1 path can't take raw. */
export function escapeLatex(text: string): string {
  const input = String(text ?? '').replace(ZERO_WIDTH, '');
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '-' && input[i + 1] === '-') {
      out += '-{}'; // literal "--" in plain text must not become an en dash
      continue;
    }
    if (SPECIAL[ch] !== undefined) out += SPECIAL[ch];
    else if (UNICODE[ch] !== undefined) out += UNICODE[ch];
    else if (ch === '\n' || ch === '\r' || ch === '\t') out += ' ';
    else if (ch.charCodeAt(0) < 0x80) out += ch;
    else out += accentChar(ch);
  }
  return out;
}

// ───────────────────────────── LaTeX → plain text ─────────────────────────────

const ACCENT_TO_MARK: Record<string, string> = Object.fromEntries(Object.entries(ACCENTS).map(([mark, cmd]) => [cmd, mark]));

const NAMED: Record<string, string> = {
  textbar: '|', textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', ldots: '…', dots: '…',
  textbullet: '•', texteuro: '€', euro: '€', pounds: '£', textdegree: '°', texttimes: '×',
  ss: 'ß', ae: 'æ', AE: 'Æ', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å',
  enspace: ' ', quad: ' ', qquad: ' ', thinspace: ' ', space: ' ', newline: ' ', linebreak: ' ', par: ' ',
  textendash: '–', textemdash: '—', textquoteright: '’', textquoteleft: '‘', LaTeX: 'LaTeX', TeX: 'TeX',
};

/** Reads a balanced {...} group starting at `start` (which must be '{'). Returns content + index after '}'. */
export function readGroup(src: string, start: number): { content: string; end: number } | null {
  if (src[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      i++; // skip escaped char (\{ \} \\)
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { content: src.slice(start + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Removes `%` comments (not `\%`) line by line. */
export function stripComments(tex: string): string {
  return tex
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') {
          i++;
          continue;
        }
        if (line[i] === '%') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/**
 * Best-effort LaTeX → plain text for the subset the CV uses: escapes, accents, dashes, quotes,
 * \textbar, spacing commands; formatting macros (\textbf{x}, \emph{x}, \href{u}{x}) keep their last argument.
 */
export function latexToPlain(tex: string): string {
  const src = stripComments(tex);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1] ?? '';
      if ('&%$#_{}'.includes(next) && next !== '') {
        out += next;
        i += 2;
        continue;
      }
      if (next === '\\') {
        out += ' ';
        i += 2;
        continue;
      }
      if (next === ',' || next === ' ' || next === ';' || next === ':' || next === '!') {
        out += next === '!' ? '' : ' ';
        i += 2;
        continue;
      }
      if (ACCENT_TO_MARK[next] !== undefined && !/[a-zA-Z]/.test(next)) {
        // \'e, \'{e}, \"o
        let j = i + 2;
        let letter = src[j] ?? '';
        if (letter === '{') {
          const g = readGroup(src, j);
          letter = g ? g.content.trim() : '';
          j = g ? g.end : j + 1;
        } else j++;
        out += `${letter}${ACCENT_TO_MARK[next]}`.normalize('NFC');
        i = j;
        continue;
      }
      const m = /^[A-Za-z]+/.exec(src.slice(i + 1));
      if (!m) {
        i += 2;
        continue;
      }
      const name = m[0];
      let j = i + 1 + name.length;
      if (ACCENT_TO_MARK[name] !== undefined && name.length === 1) {
        // \c{c}, \v{s}
        while (src[j] === ' ') j++;
        const g = src[j] === '{' ? readGroup(src, j) : null;
        const letter = g ? g.content.trim() : (src[j] ?? '');
        out += `${letter}${ACCENT_TO_MARK[name]}`.normalize('NFC');
        i = g ? g.end : j + 1;
        continue;
      }
      if (NAMED[name] !== undefined) {
        out += NAMED[name];
        if (src[j] === '{' && src[j + 1] === '}') j += 2; // \textbar{}
        else if (/^[A-Za-z]/.test(name) && src[j] === ' ' && NAMED[name] !== ' ') j++; // control-word space
        i = j;
        continue;
      }
      // Generic macro: keep the text of its last brace argument (\textbf{x} → x, \href{u}{x} → x).
      const args: string[] = [];
      while (src[j] === '{' || (src[j] === '[' && args.length === 0)) {
        if (src[j] === '[') {
          const close = src.indexOf(']', j);
          if (close < 0) break;
          j = close + 1;
          continue;
        }
        const g = readGroup(src, j);
        if (!g) break;
        args.push(g.content);
        j = g.end;
      }
      if (args.length) out += latexToPlain(args[args.length - 1]);
      i = j;
      continue;
    }
    if (ch === '{' || ch === '}') {
      i++;
      continue;
    }
    if (ch === '~') {
      out += ' ';
      i++;
      continue;
    }
    if (ch === '-' && src.startsWith('---', i)) {
      out += '—';
      i += 3;
      continue;
    }
    if (ch === '-' && src.startsWith('--', i)) {
      out += '–';
      i += 2;
      continue;
    }
    if (src.startsWith('``', i)) {
      out += '“';
      i += 2;
      continue;
    }
    if (src.startsWith("''", i)) {
      out += '”';
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ───────────────────────────── Compile ─────────────────────────────

export interface CompileResult {
  ok: boolean;
  pdfPath: string | null;
  log: string;
  durationMs: number;
}

export const COMPILE_TIMEOUT_MS = 90_000;
const MAX_LOG_CHARS = 40_000;

interface ExecOutcome { code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException & { killed?: boolean } }

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        ...(err ? { error: err } : {}),
      });
    });
  });
}

function trimLog(text: string): string {
  return text.length > MAX_LOG_CHARS ? `…${text.slice(-MAX_LOG_CHARS)}` : text;
}

/**
 * Compiles `texPath` with Tectonic into `outDir`. Uses the V2 CLI (`tectonic -X compile`) with
 * `--untrusted` (the source contains LLM-edited text), falling back to the V1 form if the installed
 * build lacks `-X`. Never throws: a missing binary, a timeout or a TeX error all return ok=false.
 */
export async function compileTex(texPath: string, outDir: string, opts: { timeoutMs?: number; bin?: string } = {}): Promise<CompileResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? COMPILE_TIMEOUT_MS;
  const bin = opts.bin ?? process.env.PURSUIT_TECTONIC ?? 'tectonic';
  const absTex = path.resolve(texPath);
  const absOut = path.resolve(outDir);
  const pdfPath = path.join(absOut, `${path.basename(absTex, path.extname(absTex))}.pdf`);
  const done = (ok: boolean, log: string): CompileResult => ({ ok, pdfPath: ok ? pdfPath : null, log: trimLog(log), durationMs: Date.now() - started });

  if (!fs.existsSync(absTex)) return done(false, `TeX source not found: ${absTex}`);
  fs.mkdirSync(absOut, { recursive: true });
  fs.rmSync(pdfPath, { force: true }); // so a failed run can never leave a stale PDF looking fresh
  const cwd = path.dirname(absTex);

  let res = await run(bin, ['-X', 'compile', absTex, '--outdir', absOut, '--untrusted'], cwd, timeoutMs);
  if (res.error?.code === 'ENOENT') return done(false, `tectonic not found (looked for "${bin}"). Install it with: brew install tectonic`);
  if (res.error?.killed) return done(false, `tectonic timed out after ${Math.round(timeoutMs / 1000)}s\n${res.stderr}`);
  const combined = () => `${res.stdout}\n${res.stderr}`.trim();
  if (res.code !== 0 && /unrecognized|unexpected argument|invalid value|Found argument '-X'/i.test(res.stderr)) {
    res = await run(bin, [absTex, '--outdir', absOut, '--untrusted'], cwd, timeoutMs);
    if (res.error?.killed) return done(false, `tectonic timed out after ${Math.round(timeoutMs / 1000)}s\n${res.stderr}`);
  }
  if (res.code !== 0) return done(false, combined() || `tectonic exited with ${res.code}`);
  if (!fs.existsSync(pdfPath)) return done(false, `${combined()}\nNo PDF was written to ${pdfPath}`);
  return done(true, combined());
}
