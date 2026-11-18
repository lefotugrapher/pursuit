// `pnpm doctor`: prints a health checklist. Always exits 0 (it reports; it never blocks).

import { doctorChecks, type DoctorCheck } from '@/lib/doctor';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

function tag(check: DoctorCheck): string {
  if (check.ok) return green('PASS');
  return check.optional ? yellow('WARN') : red('FAIL');
}

async function main(): Promise<void> {
  process.env.PURSUIT_LOG_SILENT ??= '1';
  console.log(bold('\nPursuit doctor\n'));
  let checks: DoctorCheck[];
  try {
    checks = await doctorChecks();
  } catch (err) {
    console.log(`${red('FAIL')} doctor crashed: ${(err as Error).message}`);
    return;
  }
  const width = Math.min(34, Math.max(...checks.map((c) => c.name.length)));
  for (const check of checks) {
    console.log(`  ${tag(check)}  ${check.name.padEnd(width)}  ${dim(check.detail)}`);
  }
  const failed = checks.filter((c) => !c.ok && !c.optional).length;
  const warned = checks.filter((c) => !c.ok && c.optional).length;
  const summary = failed
    ? red(`${failed} required check${failed === 1 ? '' : 's'} failed`)
    : green('All required checks passed');
  console.log(`\n${summary}${warned ? yellow(`, ${warned} optional item${warned === 1 ? '' : 's'} not set up`) : ''}\n`);
}

main()
  .catch((err) => console.error(err))
  .finally(() => process.exit(0));
