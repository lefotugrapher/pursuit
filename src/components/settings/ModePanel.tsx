// Settings: mode (review vs autopilot), the global pause switch, autopilot limits, caps + schedule.
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import { Checkbox, Field, Notice, TextInput } from '@/components/settings/kit';
import { Badge, Card, cx } from '@/components/ui';
import {
  saveAutopilotLimitsAction, saveCapsAction, setHandsFreeAction, setModeAction, setPausedAction,
} from '@/app/settings/actions';
import { AUTOPILOT_ATS, ATS_LABEL, autopilotActive, autopilotLimits } from '@/lib/server-more';
import type { Settings } from '@/lib/types';

function PauseCard({ paused }: { paused: boolean }) {
  return (
    <Card className={cx('flex flex-wrap items-center justify-between gap-3', paused && 'border-warn/40')}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
          Outbound actions {paused ? <Badge tone="warn">Paused</Badge> : <Badge tone="good">Running</Badge>}
        </div>
        <p className="mt-0.5 text-[12.5px] text-dim">
          Pause stops every submission and email immediately. Discovery, scoring and drafting keep going so the queue stays fresh.
        </p>
      </div>
      <ActionForm action={setPausedAction} className="flex flex-col items-end gap-1">
        <input type="hidden" name="paused" value={paused ? '0' : '1'} />
        <SubmitButton size="sm" variant={paused ? 'good' : 'danger'}>{paused ? 'Resume' : 'Pause everything'}</SubmitButton>
      </ActionForm>
    </Card>
  );
}

function ModeCards({ settings }: { settings: Settings }) {
  const auto = autopilotActive(settings);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Card className={cx('space-y-3', !auto && 'border-accent/50 shadow-[0_0_0_1px_var(--accent-soft)]')}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-fg">Review</h3>
          {!auto ? <Badge tone="accent">Active</Badge> : <Badge>Recommended</Badge>}
        </div>
        <p className="text-[13px] text-dim">
          Pursuit finds, scores and prepares everything, then waits. Nothing is submitted or sent until you approve it in the queue.
        </p>
        {auto && (
          <ActionForm action={setModeAction}>
            <input type="hidden" name="mode" value="review" />
            <SubmitButton size="sm" variant="primary">Switch to review</SubmitButton>
          </ActionForm>
        )}
      </Card>

      <Card className={cx('space-y-3', auto && 'border-warn/50')}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-semibold text-fg">Autopilot</h3>
          {auto ? <Badge tone="warn">Active</Badge> : <Badge>Off</Badge>}
        </div>
        <p className="text-[13px] text-dim">Submits on its own, but only when every one of these holds. Anything else stays in your queue:</p>
        <ul className="space-y-1 text-[12.5px] text-dim">
          {autopilotLimits(settings).map((l) => (
            <li key={l} className="flex gap-2"><span aria-hidden="true" className="text-faint">•</span><span>{l}</span></li>
          ))}
        </ul>
        {auto ? (
          <ActionForm action={setModeAction}>
            <input type="hidden" name="mode" value="review" />
            <SubmitButton size="sm" variant="secondary">Turn off autopilot</SubmitButton>
          </ActionForm>
        ) : (
          <ActionForm action={setModeAction} className="space-y-2">
            <input type="hidden" name="mode" value="autopilot" />
            <Field label={<>Type <span className="font-mono text-fg">AUTOPILOT</span> to turn it on</>}>
              <TextInput name="confirmText" autoComplete="off" spellCheck={false} placeholder="AUTOPILOT" className="font-mono" />
            </Field>
            <SubmitButton size="sm" variant="danger" confirm="Turn on autopilot? Pursuit will submit qualifying applications without asking.">
              Turn on autopilot
            </SubmitButton>
          </ActionForm>
        )}
      </Card>
    </div>
  );
}

function HandsFreeCard({ settings }: { settings: Settings }) {
  const on = settings.mode === 'autopilot' && settings.autopilot.enabled && Boolean(settings.autopilot.handsFree);
  return (
    <Card className={cx('space-y-3', on && 'border-good/50 shadow-[0_0_0_1px_var(--good-soft)]')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-fg">Hands-free</h3>
        {on ? <Badge tone="good">Active</Badge> : <Badge>Off</Badge>}
      </div>
      <p className="text-[13px] text-dim">
        Pursuit finds jobs, writes each application and submits it by itself, day and night. When a form asks something it
        doesn&apos;t know, it texts you on Telegram, remembers your answer and never asks again.
      </p>
      <ul className="space-y-1 text-[12.5px] text-dim">
        {[
          `Score ${Math.max(settings.minScore, 60)}+ jobs, up to ${Math.min(25, settings.dailyApplyCap)} a day, permanent roles that fit your visa needs`,
          'Every CV and letter still passes the truth check; nothing is made up',
          'CAPTCHAs and "create an account" sites are never bypassed: those jobs are skipped',
          'Emails still need one tap from you (your network blocks sending anyway)',
          'Pause in the sidebar stops everything instantly',
        ].map((l) => (
          <li key={l} className="flex gap-2"><span aria-hidden="true" className="text-faint">•</span><span>{l}</span></li>
        ))}
      </ul>
      {on ? (
        <ActionForm action={setHandsFreeAction}>
          <input type="hidden" name="on" value="0" />
          <SubmitButton size="sm" variant="secondary">Turn off hands-free</SubmitButton>
        </ActionForm>
      ) : (
        <ActionForm action={setHandsFreeAction} className="space-y-2">
          <input type="hidden" name="on" value="1" />
          <Field label={<>Type <span className="font-mono text-fg">HANDS-FREE</span> to turn it on</>}>
            <TextInput name="confirmText" autoComplete="off" spellCheck={false} placeholder="HANDS-FREE" className="font-mono" />
          </Field>
          <SubmitButton size="sm" variant="good" confirm="Turn on hands-free? Pursuit will submit applications in your name without asking first.">
            Turn on hands-free
          </SubmitButton>
        </ActionForm>
      )}
    </Card>
  );
}

function AutopilotLimitsForm({ settings }: { settings: Settings }) {
  const a = settings.autopilot;
  return (
    <Card>
      <h3 className="mb-3 text-[14px] font-semibold text-fg">Autopilot limits</h3>
      <ActionForm action={saveAutopilotLimitsAction} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Minimum score" hint={`At least your review minimum (${settings.minScore})`}>
            <TextInput name="minScore" type="number" min={settings.minScore} max={100} defaultValue={a.minScore} required />
          </Field>
          <Field label="Autopilot applications per day" hint={`Up to your overall cap (${settings.dailyApplyCap})`}>
            <TextInput name="dailyCap" type="number" min={0} max={settings.dailyApplyCap} step={1} defaultValue={a.dailyCap} required />
          </Field>
        </div>
        <fieldset className="space-y-1.5">
          <legend className="text-[12px] font-medium text-dim">Allowed ATSs</legend>
          <div className="flex flex-wrap gap-4">
            {AUTOPILOT_ATS.map((k) => (
              <Checkbox key={k} name="ats" value={k} defaultChecked={a.ats.includes(k)} label={ATS_LABEL[k]} />
            ))}
          </div>
          <p className="text-[11.5px] text-faint">Only ATSs with a dedicated, tested form filler can be used. Workday, LinkedIn and unknown forms always come to you.</p>
        </fieldset>
        <SubmitButton size="sm" variant="primary" pendingLabel="Saving…">Save limits</SubmitButton>
      </ActionForm>
    </Card>
  );
}

function CapsForm({ settings: s }: { settings: Settings }) {
  return (
    <Card>
      <h3 className="mb-3 text-[14px] font-semibold text-fg">Caps &amp; schedule</h3>
      <ActionForm action={saveCapsAction} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Applications per day"><TextInput name="dailyApplyCap" type="number" min={0} max={100} step={1} defaultValue={s.dailyApplyCap} required /></Field>
          <Field label="Emails per day"><TextInput name="dailyEmailCap" type="number" min={0} max={100} step={1} defaultValue={s.dailyEmailCap} required /></Field>
          <Field label="Tailored packs per day" hint="Each uses LLM calls"><TextInput name="dailyTailorCap" type="number" min={0} max={500} step={1} defaultValue={s.dailyTailorCap} required /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Minimum score to tailor" hint="Below this, jobs aren't prepared"><TextInput name="minScore" type="number" min={0} max={100} defaultValue={s.minScore} required /></Field>
          <Field label="Auto-skip below" hint="Skipped with the reason recorded"><TextInput name="autoSkipBelow" type="number" min={0} max={100} defaultValue={s.autoSkipBelow} required /></Field>
          <Field label="Follow up after (days)"><TextInput name="followUpDays" type="number" min={1} max={60} defaultValue={s.followUpDays} required /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Discovery every (hours)"><TextInput name="discoveryEveryHours" type="number" min={0.25} max={168} step={0.25} defaultValue={s.discoveryEveryHours} required /></Field>
          <Field label="Quiet hours start" hint="Europe/Dublin"><TextInput name="quietStart" type="time" defaultValue={s.quietHours.start} required /></Field>
          <Field label="Quiet hours end"><TextInput name="quietEnd" type="time" defaultValue={s.quietHours.end} required /></Field>
        </div>
        <SubmitButton size="sm" variant="primary" pendingLabel="Saving…">Save caps</SubmitButton>
      </ActionForm>
    </Card>
  );
}

export function ModePanel({ settings }: { settings: Settings }) {
  return (
    <div className="space-y-4">
      <PauseCard paused={settings.paused} />
      <HandsFreeCard settings={settings} />
      <ModeCards settings={settings} />
      {settings.mode === 'autopilot' && !settings.autopilot.enabled && (
        <Notice tone="warn">Mode is set to autopilot but autopilot itself is disabled, so everything still waits for review.</Notice>
      )}
      <AutopilotLimitsForm settings={settings} />
    </div>
  );
}

export function CapsPanel({ settings }: { settings: Settings }) {
  return <CapsForm settings={settings} />;
}
