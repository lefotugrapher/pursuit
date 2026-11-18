// GET /api/artifact/[id]: serves an artifact's file (only from data/artifacts or data/screenshots)
// or its inline content as text. Used by the CV iframe and artifact links.

import fs from 'node:fs/promises';
import { getArtifact } from '@/lib/db';
import { ARTIFACTS_DIR, ROOT, SCREENSHOTS_DIR } from '@/lib/paths';
import { guardRequest } from '../../_lib/guard';
import { contentDisposition, inlineContentType, parseArtifactId, resolveServablePath, servedTypeFor } from '../../_lib/artifact';

const MAX_BYTES = 50 * 1024 * 1024;

const BASE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
// Text and JSON can't run anything, but a sandbox CSP makes sure of it if a browser ever sniffs.
const TEXT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function notFound(message = 'Artifact not found'): Response {
  return new Response(message, { status: 404, headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const blocked = guardRequest(req, { mutating: false });
  if (blocked) return blocked;

  const id = parseArtifactId((await ctx.params).id);
  if (id === null) return notFound('Bad artifact id');

  let artifact;
  try {
    artifact = getArtifact(id);
  } catch (err) {
    return new Response(`Database error: ${(err as Error).message}`, { status: 500, headers: BASE_HEADERS });
  }
  if (!artifact) return notFound();

  // A letter may have both content and a PDF path; ?as=text asks for the text explicitly.
  const wantText = new URL(req.url).searchParams.get('as') === 'text';

  if (artifact.path && !wantText) {
    const file = resolveServablePath(artifact.path, [ARTIFACTS_DIR, SCREENSHOTS_DIR], { base: ROOT });
    if (file) {
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) return notFound();
        if (stat.size > MAX_BYTES) return new Response('Artifact too large to preview', { status: 413, headers: BASE_HEADERS });
        const body = await fs.readFile(file);
        const type = servedTypeFor(file);
        const headers: Record<string, string> = {
          ...BASE_HEADERS,
          'content-type': type.contentType,
          'content-length': String(body.byteLength),
          'content-disposition': contentDisposition(file, type.inline),
        };
        if (type.contentType.startsWith('text/') || type.contentType.startsWith('application/json')) headers['content-security-policy'] = TEXT_CSP;
        return new Response(new Uint8Array(body), { status: 200, headers });
      } catch {
        return notFound('Artifact file is missing on disk');
      }
    }
    if (typeof artifact.content !== 'string') return notFound('Artifact file is missing or outside the data folder');
  }

  if (typeof artifact.content === 'string') {
    return new Response(artifact.content, {
      status: 200,
      headers: { ...BASE_HEADERS, 'content-type': inlineContentType(artifact), 'content-security-policy': TEXT_CSP },
    });
  }
  return notFound('Artifact has no content');
}
