import { connection } from 'next/server';
import { AboutForm } from '@/components/about/AboutForm';
import { PageHeader } from '@/components/settings/kit';
import { intakeQuestions, loadEvidence, loadIntake } from '@/engine/intake';
import { loadFacts } from '@/lib/config';
import { hasLLM } from '@/lib/env';

export const metadata = { title: 'About me' };

export default async function AboutPage() {
  await connection();
  const facts = loadFacts();
  return (
    <div className="space-y-6">
      <PageHeader
        title="About me"
        description="Tell Pursuit what you have really done, in your own words, and add documents that back it up. It suggests facts from what you write; nothing is used in a CV or letter until you approve it."
      />
      <AboutForm
        questions={intakeQuestions()}
        initial={{ entries: loadIntake(), docs: loadEvidence() }}
        llm={hasLLM()}
        counts={{ facts: facts.facts.length, skills: facts.skills.length, tools: facts.tools.length }}
      />
    </div>
  );
}
