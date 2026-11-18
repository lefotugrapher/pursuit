// Artifact file serving rules. Pure apart from an injectable realpath: unit-tested in tests/api.test.ts.

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '@/lib/paths';
import type { Artifact } from '@/lib/types';

export interface ServedType {
  contentType: string;
  /** false → served as an attachment (unknown or active content never renders inline). */
  inline: boolean;
}

const TYPES: Record<string, ServedType> = {
  '.pdf': { contentType: 'application/pdf', inline: true },
  '.png': { contentType: 'image/png', inline: true },
  '.jpg': { contentType: 'image/jpeg', inline: true },
  '.jpeg': { contentType: 'image/jpeg', inline: true },
  '.webp': { contentType: 'image/webp', inline: true },
  '.gif': { contentType: 'image/gif', inline: true },
  '.json': { contentType: 'application/json; charset=utf-8', inline: true },
  // Text-like formats are served as plain text so nothing in them can execute (HTML included).
  '.txt': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.log': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.tex': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.md': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.csv': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.html': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.htm': { contentType: 'text/plain; charset=utf-8', inline: true },
  '.ics': { contentType: 'text/calendar; charset=utf-8', inline: false },
};

const FALLBACK: ServedType = { contentType: 'application/octet-stream', inline: false };

export function servedTypeFor(filePath: string): ServedType {
  return TYPES[path.extname(filePath).toLowerCase()] ?? FALLBACK;
}

/** Content type for artifacts stored inline (no file). */
export function inlineContentType(artifact: Pick<Artifact, 'kind' | 'content'>): string {
  if (artifact.kind === 'answers' || artifact.kind === 'ats_report') {
    try {
      JSON.parse(artifact.content ?? '');
      return 'application/json; charset=utf-8';
    } catch {
      // not JSON after all: fall through to text
    }
  }
  return 'text/plain; charset=utf-8';
}

export interface ResolveOptions {
  /** Base for relative artifact paths (the project root). */
  base: string;
  /** Injected for tests; defaults to fs.realpathSync (resolves symlinks so they can't escape). */
  realpath?: (p: string) => string;
}

/**
 * Absolute real path of `filePath` when it lies inside one of `roots` (after resolving `..` and
 * symlinks on both sides); null otherwise, or when the file doesn't exist.
 */
export function resolveServablePath(filePath: string | undefined | null, roots: string[], opts: ResolveOptions): string | null {
  if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) return null;
  const realpath = opts.realpath ?? ((p: string) => fs.realpathSync(p));
  const absolute = path.resolve(opts.base, filePath);
  let real: string;
  try {
    real = realpath(absolute);
  } catch {
    return null;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpath(root);
    } catch {
      continue;
    }
    if (real !== realRoot && isInside(realRoot, real)) return real;
  }
  return null;
}

/** RFC 6266 filename for Content-Disposition (ASCII fallback + UTF-8 form). */
export function contentDisposition(filePath: string, inline: boolean): string {
  const name = path.basename(filePath);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Parses the [id] route segment; null for anything but a positive integer. */
export function parseArtifactId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
