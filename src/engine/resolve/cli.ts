// Manual runner: node --import tsx src/engine/resolve/cli.ts [--dry-run] [--limit N] [--job ID ...] [--force] [--no-crawl] [--json]
// Prints company | title | result | applyUrl | method | confidence for every job considered.

import { closeDb } from '@/lib/db';
import { resolveApplyTargets } from './index';
import type { ResolveDetail } from './types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cut = (s: string | undefined, n: number) => {
  const v = (s ?? '').replace(/\s+/g, ' ');
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

function row(d: ResolveDetail): string {
  return [cut(d.company, 34), cut(d.title, 48), d.result, cut(d.applyUrl ?? '', 90), d.method ?? '', d.confidence?.toFixed(2) ?? '', cut(d.reason, 70)].join(' | ');
}

async function main(): Promise<number> {
  process.env.PURSUIT_LOG_SILENT ??= '1';
  const dryRun = process.argv.includes('--dry-run');
  const limit = Number(arg('--limit') ?? 100);
  const jobIds = process.argv.flatMap((a, i) => (a === '--job' && process.argv[i + 1] ? [process.argv[i + 1]] : []));
  const json = process.argv.includes('--json');
  console.error(`resolve: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE (updates jobs)'}, limit ${limit}${jobIds.length ? `, jobs ${jobIds.join(',')}` : ''}`);
  const summary = await resolveApplyTargets({
    dryRun,
    limit,
    jobIds: jobIds.length ? jobIds : undefined,
    force: process.argv.includes('--force'),
    noCrawl: process.argv.includes('--no-crawl'),
    concurrency: Number(arg('--concurrency') ?? 4),
    onDetail: (d) => console.error(`  ${row(d)}`),
  });
  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log('company | title | result | applyUrl | method | confidence | reason');
    for (const d of summary.details) console.log(row(d));
    const { details: _details, ...counts } = summary;
    console.log(JSON.stringify(counts));
  }
  return 0;
}

main()
  .then((code) => {
    closeDb();
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error((err as Error)?.stack ?? String(err));
    closeDb();
    process.exit(1);
  });
