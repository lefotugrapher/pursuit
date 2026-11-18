// Settings: environment health (doctor), DB location, worker status and demo data controls.
// Secrets are reported as set / not set only; values are never read into the page.
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import { KeyValue, Notice } from '@/components/settings/kit';
import { Badge, Card, cx, timeAgo } from '@/components/ui';
import { demoDataAction, rerunDoctorAction } from '@/app/settings/actions';
import type { DoctorCheck } from '@/lib/doctor';

export interface SystemInfo {
  checks: DoctorCheck[];
  dbPath: string;
  configDir: string;
  worker: { online: boolean; heartbeatAt: string | null };
  seedAvailable: boolean;
  demoJobs: number;
}

function CheckIcon({ check }: { check: DoctorCheck }) {
  const state = check.ok ? 'ok' : check.optional ? 'warn' : 'bad';
  const cls = { ok: 'bg-good-soft text-good', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad' }[state];
  const label = { ok: 'OK', warn: 'Optional, not set up', bad: 'Problem' }[state];
  return (
    <span role="img" aria-label={label} className={cx('mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold', cls)}>
      {state === 'ok' ? '✓' : state === 'warn' ? '!' : '×'}
    </span>
  );
}

export function SystemPanel({ info }: { info: SystemInfo }) {
  const problems = info.checks.filter((c) => !c.ok && !c.optional).length;
  const warnings = info.checks.filter((c) => !c.ok && c.optional).length;
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[14px] font-semibold text-fg">Health checks</h3>
            {problems ? <Badge tone="bad">{problems} problem{problems === 1 ? '' : 's'}</Badge> : <Badge tone="good">Core OK</Badge>}
            {warnings > 0 && <Badge tone="warn">{warnings} optional</Badge>}
          </div>
          <ActionForm action={rerunDoctorAction} hideSuccess>
            <SubmitButton size="sm" pendingLabel="Checking…">Run doctor</SubmitButton>
          </ActionForm>
        </div>
        <ul className="divide-y divide-line">
          {info.checks.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex items-start gap-2.5 py-1.5 text-[13px]">
              <CheckIcon check={c} />
              <span className="w-48 shrink-0 text-fg">{c.name}</span>
              <span className="min-w-0 flex-1 break-words text-[12.5px] text-dim">{c.detail}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11.5px] text-faint">API keys and passwords show only whether they&apos;re set. Values stay in .env.local and never reach this page.</p>
      </Card>

      <Card>
        <h3 className="mb-3 text-[14px] font-semibold text-fg">Where things live</h3>
        <KeyValue
          rows={[
            ['Database', <span key="db" className="font-mono text-[12px]">{info.dbPath}</span>],
            ['Config', <span key="cfg" className="font-mono text-[12px]">{info.configDir}</span>],
            [
              'Worker',
              <span key="w" className="inline-flex items-center gap-2">
                <span className={cx('size-2 rounded-full', info.worker.online ? 'bg-good' : 'bg-faint')} aria-hidden="true" />
                {info.worker.online ? 'Online' : 'Offline'}
                <span className="text-faint">
                  {info.worker.heartbeatAt ? `last heartbeat ${timeAgo(info.worker.heartbeatAt)}` : 'never seen: start it with pnpm worker'}
                </span>
              </span>,
            ],
          ]}
        />
      </Card>

      {info.seedAvailable && (
        <Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold text-fg">Demo data</h3>
            {info.demoJobs > 0 && <Badge tone="info">{info.demoJobs} demo job{info.demoJobs === 1 ? '' : 's'} loaded</Badge>}
          </div>
          <p className="text-[12.5px] text-dim">
            Fills every page with clearly labelled example jobs at example.com so you can try the dashboard. Demo jobs are never applied to,
            and clearing removes only them.
          </p>
          <ActionForm action={demoDataAction} className="flex flex-wrap items-center gap-2" messageClassName="basis-full">
            <SubmitButton name="intent" value="seed" size="sm" pendingLabel="Working…">{info.demoJobs ? 'Reload demo data' : 'Seed demo data'}</SubmitButton>
            <SubmitButton name="intent" value="clear" size="sm" variant="ghost" disabled={!info.demoJobs} confirm="Remove all demo jobs?">Clear demo data</SubmitButton>
          </ActionForm>
        </Card>
      )}
      {!info.seedAvailable && <Notice tone="neutral">Demo data tools are unavailable (scripts/seed.ts not found).</Notice>}
    </div>
  );
}
