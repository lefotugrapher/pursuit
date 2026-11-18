// Keyword extraction, JD section weighting, lexicon synonyms and fact-bank coverage (SPEC §5.3).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FactBank, Keyword } from '@/lib/types';
import { classifyHeading, coverage, extractKeywords, isDoNotClaim, splitJdLines, textMentions } from '@/engine/keywords';
import { findLexiconEntry, LEXICON, normalizePhrase, stemToken, tokenize } from '@/engine/lexicon';

const FACTS: FactBank = {
  version: 1,
  summaries: { general: 'PR and content graduate.' },
  facts: [
    { id: 'press-releases', kind: 'achievement', text: 'Wrote press releases and promotional material for a charity fashion event.', tags: ['pr', 'press-releases', 'events'] },
    { id: 'social-content', kind: 'achievement', text: 'Produced Students Union communications and social media content for the student body.', tags: ['comms', 'social', 'content'] },
    { id: 'orientation', kind: 'achievement', text: 'Organised orientation and welcome events for incoming international students.', tags: ['events', 'community'] },
    { id: 'canva-claim', kind: 'achievement', text: 'Designed posters in Canva and handled media monitoring for the union.', tags: ['design'] },
    { id: 'presented', kind: 'achievement', text: 'Presented research findings to a national panel in Dublin.', tags: ['research', 'presentation'] },
    { id: 'interests', kind: 'other', text: 'Interests: photography, crisis communication, running.', tags: ['interests'] },
  ],
  skills: ['public relations', 'media relations', 'stakeholder engagement', 'copywriting'],
  tools: ['Google Analytics', 'Instagram'],
  doNotClaim: ['media monitoring', 'Canva', 'Microsoft Office', 'media coverage'],
};

const PR_JD = `About the Role
We are hiring a Graduate PR Executive to join our Dublin team.

Key Responsibilities
- Draft press releases and pitch stories to journalists
- Managing social channels for our clients and building the content calendar
- Liaise with stakeholders and support client events
- Monitor media coverage and compile coverage reports

Requirements
- Excellent written communication skills
- Experience with Google Analytics
- Experience with Muck Rack and Prowly

Nice to have
- Canva and Adobe Photoshop skills
- Experience with Microsoft Office

About Us
We are a marketing agency working with retail, hospitality and sustainability brands. We offer a generous benefits package.`;

const term = (kws: Keyword[], t: string) => kws.find((k) => k.term === t);

describe('lexicon normalisation', () => {
  it('stems plurals and verb forms consistently on both sides', () => {
    assert.equal(normalizePhrase('press release'), normalizePhrase('press releases'));
    assert.equal(normalizePhrase('organise events'), normalizePhrase('organising events'));
    assert.equal(normalizePhrase('organize events'), normalizePhrase('organising events'));
    assert.equal(stemToken('planning'), stemToken('plan'));
    assert.deepEqual(tokenize('E-mail marketing & P.R.'), tokenize('email marketing and pr'));
  });

  it('maps synonyms to one canonical entry', () => {
    assert.equal(findLexiconEntry('managing social channels')?.entry.term, 'social media management');
    assert.equal(findLexiconEntry('press release')?.entry.term, 'press releases');
    assert.equal(findLexiconEntry('stakeholder management')?.entry.term, 'stakeholder engagement');
    assert.equal(findLexiconEntry('GA4')?.entry.term, 'Google Analytics');
    assert.equal(findLexiconEntry('nonexistent thing'), undefined);
  });

  it('has unique canonical terms', () => {
    const terms = LEXICON.map((e) => normalizePhrase(e.term));
    assert.equal(new Set(terms).size, terms.length);
  });
});

describe('JD sections', () => {
  it('classifies common headings', () => {
    assert.equal(classifyHeading('Requirements'), 'requirements');
    assert.equal(classifyHeading('Essential Criteria'), 'requirements');
    assert.equal(classifyHeading('What you’ll bring'), 'requirements');
    assert.equal(classifyHeading('Nice to have'), 'desirable');
    assert.equal(classifyHeading('Desirable'), 'desirable');
    assert.equal(classifyHeading('Key Responsibilities'), 'responsibilities');
    assert.equal(classifyHeading('About Us'), 'about');
    assert.equal(classifyHeading('Benefits'), 'about');
  });

  it('recognises sentence-case headings without letting bullets switch section', () => {
    const lines = splitJdLines('Nice to have\n- Excellent communication skills\n- Canva');
    assert.ok(lines.every((l) => l.section === 'desirable'), JSON.stringify(lines));
    const bring = splitJdLines('What you’ll bring\n- Copywriting');
    assert.equal(bring.at(-1)?.section, 'requirements');
  });

  it('tags lines with their section and splits inline headings', () => {
    const lines = splitJdLines('Great team. Requirements: strong copywriting. Desirable: Canva skills.');
    const req = lines.find((l) => /copywriting/.test(l.text));
    const des = lines.find((l) => /Canva/.test(l.text));
    assert.equal(req?.section, 'requirements');
    assert.equal(des?.section, 'desirable');
    assert.equal(des?.optional, true);
  });
});

describe('extractKeywords', () => {
  const kws = extractKeywords(PR_JD);

  it('finds skills, duties and tools through synonyms', () => {
    for (const t of ['press releases', 'media pitching', 'social media management', 'content strategy', 'stakeholder engagement', 'event management', 'Google Analytics', 'written communication']) {
      assert.ok(term(kws, t), `missing ${t}: ${kws.map((k) => k.term).join(', ')}`);
    }
  });

  it('picks up unknown tool names after "experience with" cues', () => {
    assert.ok(term(kws, 'Muck Rack'), 'lexicon tool');
    assert.ok(term(kws, 'Prowly'), 'lexicon tool');
  });

  it('weights requirements above desirable above about-us', () => {
    const ga = term(kws, 'Google Analytics')!;
    const canva = term(kws, 'Canva')!;
    assert.ok(ga && canva);
    assert.ok(ga.weight > canva.weight, `${ga.weight} vs ${canva.weight}`);
    const retail = term(kws, 'retail');
    if (retail) assert.ok(retail.weight < canva.weight, 'about-us domains weigh least');
    const sameKind = extractKeywords('Requirements\n- Experience with Hootsuite\n\nDesirable\n- Experience with Hootsuite and Mailchimp');
    assert.ok(term(sameKind, 'Hootsuite')!.weight > term(sameKind, 'Mailchimp')!.weight);
  });

  it('returns weights in 0-1, sorted desc, capped at ~30', () => {
    for (let i = 1; i < kws.length; i++) assert.ok(kws[i - 1].weight >= kws[i].weight);
    for (const k of kws) assert.ok(k.weight > 0 && k.weight <= 1);
    const long = extractKeywords(LEXICON.map((e) => `Requirements: ${e.term}.`).join('\n'));
    assert.equal(long.length, 30);
    assert.equal(extractKeywords(PR_JD, { limit: 5 }).length, 5);
  });

  it('is deterministic and tolerates empty input', () => {
    assert.deepEqual(extractKeywords(PR_JD), extractKeywords(PR_JD));
    assert.deepEqual(extractKeywords(''), []);
  });

  it('prefers the longest match ("Google Analytics" not "analytics")', () => {
    const k = extractKeywords('Requirements: Google Analytics reporting.');
    assert.ok(term(k, 'Google Analytics'));
    assert.ok(!term(k, 'analytics and reporting') || term(k, 'analytics and reporting')!.weight > 0);
  });
});

describe('coverage', () => {
  const kws = extractKeywords(PR_JD);
  const cov = coverage(kws, FACTS);
  const matched = new Map(cov.matched.map((m) => [m.term, m.factIds]));

  it('matches keywords backed by fact text with fact ids', () => {
    assert.deepEqual(matched.get('press releases'), ['press-releases']);
    assert.ok(matched.get('event management')?.includes('orientation'));
  });

  it('matches keywords backed only by the claimable skills/tools lists', () => {
    assert.ok(matched.has('Google Analytics'));
    assert.ok(matched.has('stakeholder engagement'));
  });

  it('never matches doNotClaim terms, even when a fact mentions them', () => {
    assert.ok(!matched.has('Canva'));
    assert.ok(cov.gaps.includes('Canva'));
    assert.ok(!matched.has('media monitoring'));
    assert.ok(!matched.has('coverage reporting'), 'coverage reporting phrasings include "media coverage"');
    assert.ok(!matched.has('Microsoft Office'));
  });

  it('ignores interest-only facts as evidence', () => {
    const c = coverage([{ term: 'crisis communications', kind: 'skill', weight: 1 }], FACTS);
    assert.deepEqual(c.matched, []);
    assert.deepEqual(c.gaps, ['crisis communications']);
  });

  it('uses evidence phrases for soft skills honestly', () => {
    assert.ok(matched.has('written communication'), 'press releases prove written communication');
  });

  it('computes a weighted pct and partitions every keyword', () => {
    assert.equal(cov.matched.length + cov.gaps.length, kws.length);
    const total = kws.reduce((s, k) => s + k.weight, 0);
    const hit = kws.filter((k) => matched.has(k.term)).reduce((s, k) => s + k.weight, 0);
    assert.equal(cov.pct, Math.round((hit / total) * 100));
    assert.equal(coverage([], FACTS).pct, 0);
    const weighted = coverage(
      [
        { term: 'press releases', kind: 'skill', weight: 0.9 },
        { term: 'Canva', kind: 'tool', weight: 0.1 },
      ],
      FACTS,
    );
    assert.equal(weighted.pct, 90);
  });

  it('isDoNotClaim catches synonyms and case', () => {
    const dnc = FACTS.doNotClaim.map(normalizePhrase);
    assert.equal(isDoNotClaim('canva', dnc), true);
    assert.equal(isDoNotClaim('coverage reporting', dnc), true);
    assert.equal(isDoNotClaim('press releases', dnc), false);
  });
});

describe('textMentions', () => {
  it('finds any phrasing of a keyword in free text', () => {
    assert.equal(textMentions('I wrote a press release for the launch.', 'press releases'), true);
    assert.equal(textMentions('Managed social media accounts for a café.', 'social media management'), true);
    assert.equal(textMentions('Built spreadsheets.', 'press releases'), false);
  });
});
