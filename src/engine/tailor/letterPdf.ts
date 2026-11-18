// Renders a cover letter to a one-page PDF with tectonic, using the same type as the CV
// (Source Sans Pro, Type 1, T1 encoding) so the pair looks like one document set. Server-only.
// Returns null (never throws) when tectonic is missing or the compile fails; the plain-text
// letter is always the primary artifact.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, jobArtifactDir } from '@/lib/paths';
import { log } from '@/lib/log';
import type { Profile } from '@/lib/types';

export const LETTER_PDF_NAME = 'Kshitiz_Mittal_Cover_Letter.pdf';
const COMPILE_TIMEOUT_MS = 180_000;

const LATEX_SPECIALS: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '#': '\\#',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  _: '\\_',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
  '<': '\\textless{}',
  '>': '\\textgreater{}',
  '|': '\\textbar{}',
};

/** Escapes text for LaTeX body copy and normalises quotes/dashes to ATS-safe forms. */
export function escapeLatex(text: string): string {
  return String(text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–‑]/g, '-')
    .replace(/[\\{}#$%&_^~<>|]/g, (ch) => LATEX_SPECIALS[ch] ?? ch)
    // Keep straight quotes literal: T1 would otherwise ligature `` and '' into curly quotes.
    .replace(/"/g, '\\textquotedbl{}')
    .replace(/-{2,}/g, (m) => m.split('').join('{}'));
}

function hrefSafe(url: string): string {
  return url.replace(/[\\{}%#]/g, (ch) => `\\${ch}`);
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}

function contactLine(profile: Profile): string {
  const parts = [escapeLatex(profile.location), escapeLatex(profile.phone)];
  if (profile.email) parts.push(`\\href{mailto:${hrefSafe(profile.email)}}{${escapeLatex(profile.email)}}`);
  if (profile.links.linkedin) parts.push(`\\href{${hrefSafe(profile.links.linkedin)}}{${escapeLatex(displayUrl(profile.links.linkedin))}}`);
  return parts.filter(Boolean).join(' \\enspace\\textbar\\enspace ');
}

function letterDate(date: Date): string {
  return new Intl.DateTimeFormat('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin' }).format(date);
}

/** Paragraphs separated by blank lines; single newlines inside a paragraph become line breaks. */
function bodyToLatex(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((para) =>
      para
        .split('\n')
        .map((line) => escapeLatex(line.trim()))
        .filter(Boolean)
        .join('\\\\\n'),
    )
    .filter(Boolean)
    .join('\n\n\\vspace{8pt}\n');
}

/** Full LaTeX source for the letter. `text` is the complete letter (greeting to signature). */
export function buildLetterTex(text: string, profile: Profile, date: Date = new Date()): string {
  return `\\documentclass[a4paper,10pt]{article}
\\usepackage{iftex}
\\usepackage[T1]{fontenc}
\\ifPDFTeX
  \\usepackage[utf8]{inputenc}
  \\input{glyphtounicode}
  \\pdfgentounicode=1
\\fi
\\usepackage[default,semibold,type1]{sourcesanspro}
\\usepackage[left=1in, right=1in, top=0.9in, bottom=0.9in]{geometry}
\\usepackage[hidelinks]{hyperref}
\\hypersetup{colorlinks=true, linkcolor=black, urlcolor=black}
\\renewcommand{\\normalsize}{\\fontsize{10.5}{15}\\selectfont}
\\normalsize
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{0pt}
\\hyphenpenalty=10000
\\exhyphenpenalty=10000
\\pagestyle{empty}
\\begin{document}
\\raggedright
{\\fontsize{20}{24}\\selectfont\\bfseries ${escapeLatex(profile.name.full)}}\\par
\\vspace{6pt}
${contactLine(profile)}\\par
\\vspace{18pt}
${escapeLatex(letterDate(date))}\\par
\\vspace{14pt}
${bodyToLatex(text)}\\par
\\end{document}
`;
}

function runTectonic(texPath: string, outDir: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'tectonic',
      ['-X', 'compile', '--outdir', outDir, '--keep-logs', texPath],
      { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        if (err) resolve({ ok: false, output: `${err.message}\n${output}`.slice(0, 4000) });
        else resolve({ ok: true, output });
      },
    );
  });
}

/**
 * Compiles the letter into data/artifacts/<jobId>/Kshitiz_Mittal_Cover_Letter.pdf.
 * Returns the absolute PDF path, or null when tectonic is unavailable or the compile fails.
 */
export async function renderLetterPdf(text: string, jobId: string, profile: Profile): Promise<string | null> {
  try {
    const dir = ensureDir(jobArtifactDir(jobId));
    const buildDir = ensureDir(path.join(dir, 'letter-build'));
    const texPath = path.join(buildDir, 'cover_letter.tex');
    fs.writeFileSync(texPath, buildLetterTex(text, profile), 'utf8');
    const result = await runTectonic(texPath, buildDir);
    const built = path.join(buildDir, 'cover_letter.pdf');
    if (!result.ok || !fs.existsSync(built)) {
      log.forJob('warn', jobId, 'letter.pdf', 'cover letter PDF compile failed', { output: result.output.slice(-1500) });
      return null;
    }
    const finalPath = path.join(dir, LETTER_PDF_NAME);
    fs.copyFileSync(built, finalPath);
    return finalPath;
  } catch (err) {
    log.forJob('warn', jobId, 'letter.pdf', 'cover letter PDF render error', err);
    return null;
  }
}
