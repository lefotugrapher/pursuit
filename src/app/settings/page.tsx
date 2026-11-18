import { connection } from 'next/server';
import { HEARTBEAT_KEY, workerHealth } from '@/app/api/_lib/status';
import { AnswersPanel, FactsPanel } from '@/components/settings/BanksPanel';
import { Notice, PageHeader, TabLinks, type TabItem } from '@/components/settings/kit';
import { CapsPanel, ModePanel } from '@/components/settings/ModePanel';
import { ProfilePanel, WorkAuthPanel } from '@/components/settings/ProfilePanel';
import { SystemPanel } from '@/components/settings/SystemPanel';
import { TelegramCard } from '@/components/telegram/TelegramCard';
import { Badge } from '@/components/ui';
import { loadAnswers, loadFacts, loadProfile } from '@/lib/config';
import { getSettings, kvGet } from '@/lib/db';
import { doctorChecks } from '@/lib/doctor';
import { CONFIG_DIR, DB_PATH } from '@/lib/paths';
import { autopilotActive, demoJobCount, seedScriptAvailable } from '@/lib/server-more';

export const metadata = { title: 'Settings' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const SECTIONS = ['mode', 'telegram', 'caps', 'profile', 'auth', 'facts', 'answers', 'system'] as const;
type SectionKey = (typeof SECTIONS)[number];
const LABEL: Record<SectionKey, string> = {
  mode: 'Mode', telegram: 'Telegram', caps: 'Caps & schedule', profile: 'Profile & targets', auth: 'Work authorisation',
  facts: 'Fact bank', answers: 'Answer bank', system: 'System',
};

/** Runs a config loader, turning a validation/IO failure into a message instead of a crashed page. */
function attempt<T>(fn: () => T): { value?: T; error?: string } {
  try {
    return { value: fn() };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function Panel({ section }: { section: SectionKey }) {
  switch (section) {
    case 'mode': return <ModePanel settings={getSettings()} />;
    case 'telegram': return <TelegramCard />;
    case 'caps': return <CapsPanel settings={getSettings()} />;
    case 'profile':
    case 'auth': {
      const { value: profile, error } = attempt(loadProfile);
      if (!profile) return <Notice tone="bad" title="config/profile.json can't be loaded">{error}</Notice>;
      return section === 'profile' ? <ProfilePanel profile={profile} /> : <WorkAuthPanel profile={profile} />;
    }
    case 'facts': {
      const { value, error } = attempt(loadFacts);
      return <FactsPanel bank={value} error={error} />;
    }
    case 'answers': {
      const { value, error } = attempt(loadAnswers);
      return <AnswersPanel bank={value} error={error} />;
    }
    case 'system': {
      const worker = workerHealth(kvGet(HEARTBEAT_KEY));
      return (
        <SystemPanel
          info={{
            checks: await doctorChecks(),
            dbPath: DB_PATH,
            configDir: CONFIG_DIR,
            worker: { online: worker.online, heartbeatAt: worker.heartbeatAt },
            seedAvailable: seedScriptAvailable(),
            demoJobs: demoJobCount(),
          }}
        />
      );
    }
  }
}

function unconfirmedAnswers(): number | undefined {
  const { value } = attempt(loadAnswers);
  return value?.entries.filter((e) => e.confirm).length;
}

export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  await connection();
  const sp = await searchParams;
  const raw = Array.isArray(sp.section) ? sp.section[0] : sp.section;
  const section: SectionKey = (SECTIONS as readonly string[]).includes(raw ?? '') ? (raw as SectionKey) : 'mode';
  const settings = getSettings();
  const pending = unconfirmedAnswers();
  const workAuthUnconfirmed = attempt(loadProfile).value?.workAuth.confirm;

  const tabs: TabItem[] = SECTIONS.map((key) => ({
    key,
    label: LABEL[key],
    href: `/settings?section=${key}`,
    count: key === 'answers' && pending ? pending : key === 'auth' && workAuthUnconfirmed ? 1 : undefined,
  }));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="How Pursuit behaves, what it targets, and the facts and answers it's allowed to use."
        actions={
          <>
            {settings.paused && <Badge tone="warn">Paused</Badge>}
            <Badge tone={autopilotActive(settings) ? 'warn' : 'accent'}>{autopilotActive(settings) ? 'Autopilot' : 'Review mode'}</Badge>
          </>
        }
      />
      <TabLinks tabs={tabs} active={section} label="Settings sections" />
      <Panel section={section} />
    </div>
  );
}
