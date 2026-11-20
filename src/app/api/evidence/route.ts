// Evidence files for the About-me page.
//   POST /api/evidence        multipart form, field "file" (one or more): stores each under data/evidence
//   GET  /api/evidence?id=…   serves one stored file back to him
// Local only: same Host/Origin/x-pursuit guard as every other API route.

import fs from 'node:fs/promises';
import { guardRequest } from '../_lib/guard';

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const MAX_FILES = 10;

export async function POST(req: Request): Promise<Response> {
  const blocked = guardRequest(req, { mutating: true });
  if (blocked) return blocked;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, error: 'Could not read the upload.' }, { status: 400, headers: NO_STORE });
  }
  const files = form.getAll('file').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f).slice(0, MAX_FILES);
  if (!files.length) return Response.json({ ok: false, error: 'No file was sent.' }, { status: 400, headers: NO_STORE });

  const { addEvidence, MAX_EVIDENCE_BYTES } = await import('@/engine/intake');
  const added: unknown[] = [];
  const errors: string[] = [];
  for (const file of files) {
    if (file.size > MAX_EVIDENCE_BYTES) {
      errors.push(`${file.name}: over 20 MB`);
      continue;
    }
    const r = await addEvidence(file.name, new Uint8Array(await file.arrayBuffer()));
    if (r.ok) added.push(r.doc);
    else errors.push(`${file.name}: ${r.message}`);
  }
  return Response.json({ ok: added.length > 0, added, errors }, { status: added.length ? 200 : 400, headers: NO_STORE });
}

export async function GET(req: Request): Promise<Response> {
  const blocked = guardRequest(req, { mutating: false });
  if (blocked) return blocked;

  const id = new URL(req.url).searchParams.get('id') ?? '';
  const { evidenceFile } = await import('@/engine/intake');
  const found = evidenceFile(id);
  if (!found) return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } });
  const body = await fs.readFile(found.path);
  // PDFs and images open in the tab; everything else downloads. The sandbox stops a crafted file from running script.
  const inline = /^(application\/pdf|image\/)/.test(found.doc.type);
  return new Response(new Uint8Array(body), {
    headers: {
      ...NO_STORE,
      'content-type': found.doc.type,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox",
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${found.doc.name.replace(/[^\w.() -]/g, '_')}"`,
    },
  });
}
