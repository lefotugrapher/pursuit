import { connection } from 'next/server';
import { CoachChat } from '@/components/coach/CoachChat';
import { PageHeader } from '@/components/settings/kit';
import { Badge, Card, Section } from '@/components/ui';
import { coachFactsSince, loadThread, topGaps } from '@/engine/coach';
import { loadFacts } from '@/lib/config';
import { countByStatus, listEvents } from '@/lib/db';
import { hasLLM } from '@/lib/env';

export const metadata = { title: 'Coach' };

export default async function CoachPage() {
  await connection();
  const turns = loadThread();
  const facts = loadFacts();
  const gaps = topGaps(12);
  const ready = countByStatus().ready ?? 0;
  const lastRetailor = listEvents({ type: 'coach.retailor', limit: 1 })[0]?.ts ?? '1970-01-01T00:00:00.000Z';
  const newFacts = coachFactsSince(lastRetailor);
  const fromCoach = facts.facts.filter((f) => f.tags.includes('from-coach')).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coach"
        description="An AI that knows everything Pursuit knows about you and asks what it still needs, so your CVs and letters get stronger. Nothing it suggests is added until you approve it."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <CoachChat initialTurns={turns} llm={hasLLM()} readyCount={ready} newFacts={newFacts} />
        <aside className="space-y-4">
          <Card>
            <Section title="What it knows">
              <div className="space-y-1 text-[13px] text-dim">
                <div><span className="tabular text-fg">{facts.facts.length}</span> facts in your bank{fromCoach ? <> · <span className="text-good">{fromCoach} from Coach</span></> : null}</div>
                <div><span className="tabular text-fg">{facts.skills.length}</span> skills, <span className="tabular text-fg">{facts.tools.length}</span> tools</div>
              </div>
            </Section>
          </Card>
          <Card>
            <Section title="Employers keep asking for">
              {gaps.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {gaps.map((g) => <Badge key={g.term} title={`${g.jobs} jobs`}>{g.term} <span className="text-faint">{g.jobs}</span></Badge>)}
                </div>
              ) : <p className="text-[13px] text-faint">Nothing yet. Gaps appear once jobs are scored.</p>}
              <p className="mt-2 text-[12px] text-faint">Not in your facts, so never claimed. If you have done any of these, tell the coach.</p>
            </Section>
          </Card>
        </aside>
      </div>
    </div>
  );
}
