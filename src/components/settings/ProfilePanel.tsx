// Settings: profile.json (contact, links, targets, cover-letter voice) and work authorisation.
import { ActionForm, SubmitButton } from '@/components/settings/ActionForm';
import { Checkbox, Field, Notice, Select, TextArea, TextInput } from '@/components/settings/kit';
import { Badge, Card } from '@/components/ui';
import { saveProfileAction, saveWorkAuthAction } from '@/app/settings/actions';
import type { Profile } from '@/lib/types';

const SENIORITY: { key: Profile['targets']['seniority'][number]; label: string }[] = [
  { key: 'intern', label: 'Internship' },
  { key: 'graduate', label: 'Graduate' },
  { key: 'junior', label: 'Junior' },
  { key: 'executive', label: 'Executive' },
  { key: 'mid', label: 'Mid-level' },
];

const joinLines = (xs: string[]) => xs.join('\n');
const joinComma = (xs: string[]) => xs.join(', ');

function SubHeading({ children }: { children: string }) {
  return <h4 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">{children}</h4>;
}

export function ProfilePanel({ profile: p }: { profile: Profile }) {
  const t = p.targets;
  return (
    <Card>
      <ActionForm action={saveProfileAction} className="space-y-6">
        <section className="space-y-3">
          <SubHeading>Contact</SubHeading>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="First name *"><TextInput name="first" defaultValue={p.name.first} required /></Field>
            <Field label="Last name"><TextInput name="last" defaultValue={p.name.last} /></Field>
            <Field label="Preferred name" hint="Used in sign-offs"><TextInput name="preferred" defaultValue={p.name.preferred} /></Field>
            <Field label="Full legal name *" hint="On the CV and under sign-offs"><TextInput name="full" defaultValue={p.name.full} required /></Field>
            <Field label="Email"><TextInput name="email" type="email" defaultValue={p.email} /></Field>
            <Field label="Phone"><TextInput name="phone" type="tel" defaultValue={p.phone} /></Field>
            <Field label="Location" className="sm:col-span-2"><TextInput name="location" defaultValue={p.location} /></Field>
          </div>
        </section>

        <section className="space-y-3">
          <SubHeading>Links</SubHeading>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['linkedin', 'portfolio', 'website', 'github'] as const).map((k) => (
              <Field key={k} label={k[0].toUpperCase() + k.slice(1)}>
                <TextInput name={`link_${k}`} type="url" defaultValue={p.links[k] ?? ''} placeholder="https://" />
              </Field>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <SubHeading>Targets</SubHeading>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Roles" hint="One per line: titles and role families to score against">
              <TextArea name="roles" defaultValue={joinLines(t.roles)} rows={8} />
            </Field>
            <Field label="Search keywords" hint="One per line: used for LinkedIn and Adzuna searches">
              <TextArea name="keywords" defaultValue={joinLines(t.keywords)} rows={8} />
            </Field>
            <Field label="Locations" hint="Comma separated, matched case-insensitively">
              <TextArea name="locations" defaultValue={joinComma(t.locations)} rows={2} />
            </Field>
            <Field label="Secondary locations" hint="Allowed but flagged (e.g. Northern Ireland: UK right-to-work differs)">
              <TextArea name="secondaryLocations" defaultValue={joinComma(t.secondaryLocations)} rows={2} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Checkbox name="remoteOk" defaultChecked={t.remoteOk} label="Remote roles are fine" />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-[12px] font-medium text-dim">Seniority</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {SENIORITY.map((s) => <Checkbox key={s.key} name="seniority" value={s.key} defaultChecked={t.seniority.includes(s.key)} label={s.label} />)}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Exclude title words" hint="Comma separated" className="sm:col-span-2">
              <TextInput name="excludeTitleWords" defaultValue={joinComma(t.excludeTitleWords)} />
            </Field>
            <Field label="Max years required" hint="Reject jobs asking for more">
              <TextInput name="maxYearsRequired" type="number" min={0} max={30} defaultValue={t.maxYearsRequired} required />
            </Field>
            <Field label="Salary floor (EUR / year)" hint="Only applied when a salary is listed">
              <TextInput name="salaryFloorEUR" type="number" min={0} step={100} defaultValue={t.salaryFloorEUR} required />
            </Field>
            <Field label="Blacklisted companies" hint="Comma separated" className="sm:col-span-2">
              <TextInput name="blacklistCompanies" defaultValue={joinComma(t.blacklistCompanies)} />
            </Field>
            <Field label="Working languages" hint="Comma separated" className="sm:col-span-2">
              <TextInput name="languages" defaultValue={joinComma(t.languages)} />
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <SubHeading>Cover letter voice</SubHeading>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field label="Sign-off" hint="Your full legal name is added underneath">
              <TextArea name="signOff" defaultValue={p.coverLetter.signOff} rows={3} />
            </Field>
            <Field label="Voice notes" hint="One per line: rules the writer follows">
              <TextArea name="voiceNotes" defaultValue={joinLines(p.coverLetter.voiceNotes)} rows={6} />
            </Field>
          </div>
        </section>

        <div className="flex items-center gap-3 border-t border-line pt-4">
          <SubmitButton variant="primary" size="sm" pendingLabel="Saving…">Save profile</SubmitButton>
          <span className="text-[12px] text-faint">Saved to config/profile.json</span>
        </div>
      </ActionForm>
    </Card>
  );
}

export function WorkAuthPanel({ profile }: { profile: Profile }) {
  const wa = profile.workAuth;
  const sponsorship = wa.needsSponsorship === true ? 'yes' : wa.needsSponsorship === false ? 'no' : 'unknown';
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-fg">Work authorisation</h3>
        {wa.confirm ? <Badge tone="warn">Unconfirmed</Badge> : <Badge tone="good">Confirmed</Badge>}
      </div>
      <Notice tone="neutral">
        Used only to answer application form questions from the answer bank. It never goes on your CV or in a cover letter, and
        autopilot won&apos;t use it until you confirm the wording.
      </Notice>
      <ActionForm action={saveWorkAuthAction} className="space-y-3">
        <Field label="Summary *" hint="Plain statement of your current status">
          <TextArea name="summary" defaultValue={wa.summary} rows={3} required />
        </Field>
        <Field label="Need sponsorship?" className="max-w-xs">
          <Select name="needsSponsorship" defaultValue={sponsorship}>
            <option value="unknown">Not sure yet (ask me each time)</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </Field>
        <Checkbox name="confirmAccurate" defaultChecked={!wa.confirm} label="I confirm this is accurate" />
        <div>
          <SubmitButton size="sm" variant="primary" pendingLabel="Saving…">Save</SubmitButton>
        </div>
      </ActionForm>
    </Card>
  );
}
