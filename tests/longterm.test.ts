import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hardFilters, shortTermReason, SPONSOR_OFFERED } from '../src/engine/score';
import type { Profile } from '../src/lib/types';

const example = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'profile.example.json'), 'utf8')) as Profile;
const profile: Profile = {
  ...example,
  targets: { ...example.targets, locations: ['dublin', 'ireland', 'remote'], secondaryLocations: ['belfast', 'newry', 'northern ireland'], excludeTitleWords: [], maxYearsRequired: 2, salaryFloorEUR: 37000, permanentOnly: true, ukRightToWork: false },
  workAuth: { summary: 'Stamp 1G', needsSponsorship: true, confirm: false },
};
const job = (title: string, description = 'Join our communications team in Dublin.', extra: Record<string, unknown> = {}) =>
  ({ id: 'x', source: 'manual', sourceId: 'x', company: 'Acme', title, location: 'Dublin, Ireland', country: 'IE', remote: false, url: '', applyUrl: '', ats: 'unknown', atsMeta: {}, description, ...extra }) as never;

describe('long-term roles only', () => {
  test('short-term roles are rejected', () => {
    for (const t of ['Communications Executive (Fixed Term - 11 months)', 'Marketing Internship', 'Digital Marketing Executive-Contract', 'PR Assistant - Maternity Cover', 'Part-time Social Media Assistant', 'Temporary Events Coordinator']) {
      assert.ok(shortTermReason(job(t)), t);
      assert.equal(hardFilters(job(t), profile).pass, false, t);
    }
    assert.ok(shortTermReason(job('Content Executive', 'This is a 12-month fixed-term contract based in Dublin.')));
  });
  test('permanent roles and graduate programmes pass', () => {
    assert.equal(shortTermReason(job('PR & Communications Executive', 'A permanent, full-time role in Dublin.')), null);
    assert.equal(shortTermReason(job('Graduate Marketing Programme 2027', 'Our two-year graduate programme rotates you through marketing teams.')), null);
    assert.equal(shortTermReason(job('International Marketing Executive')), null, '"international" is not "intern"');
    assert.equal(shortTermReason(job('Marketing Executive', 'Permanent role. We started as a temporary project team in 2019.')), null);
  });
});

describe('work permit', () => {
  test("employers that say they can't sponsor are rejected", () => {
    const r = hardFilters(job('PR Executive', 'Applicants must have the right to work in Ireland without the need for sponsorship.'), profile);
    assert.equal(r.pass, false);
    assert.ok(r.rejected.some((x) => /sponsor/i.test(x)));
  });
  test('UK/NI roles are rejected unless they offer sponsorship', () => {
    const ni = { location: 'Belfast, Northern Ireland', country: 'GB-NIR' };
    assert.equal(hardFilters(job('PR Executive', 'Join us in Belfast.', ni), profile).pass, false);
    assert.equal(hardFilters(job('PR Executive', 'Join us in Belfast. Visa sponsorship is available for the right candidate.', ni), profile).rejected.some((x) => /UK/.test(x)), false);
  });
  test('sponsorship offers are recognised', () => {
    for (const t of ['Visa sponsorship is available', 'We can sponsor a Critical Skills Employment Permit', 'We are able to offer sponsorship', 'open to visa sponsorship']) assert.ok(SPONSOR_OFFERED.test(t), t);
    assert.equal(SPONSOR_OFFERED.test('We are unable to offer sponsorship'), false);
  });
});

describe('known sponsors (Department of Enterprise permits data)', async () => {
  const { setSponsorsForTests, sponsorRecord } = await import('../src/engine/sponsors');
  test('matches registered names cautiously', () => {
    setSponsorsForTests([
      { name: 'Ryanair DAC', permits: 6 }, { name: 'Ryanair Labs Limited', permits: 4 },
      { name: 'Stripe Technology Company Limited', permits: 34 }, { name: 'Stripe Payments Europe Limited', permits: 5 },
      { name: 'Accenture Limited', permits: 195 }, { name: 'Summit Scaffolding Ltd', permits: 9 }, { name: 'KPMG', permits: 44 },
    ]);
    assert.equal(sponsorRecord("Ryanair - Europe's Favourite Airline")?.permits, 6, 'exact registered name wins');
    assert.equal(sponsorRecord('Stripe')?.permits, 39, 'a few same-brand entities');
    assert.equal(sponsorRecord('Accenture UK & Ireland')?.permits, 195);
    assert.equal(sponsorRecord('KPMG Ireland')?.permits, 44);
    assert.equal(sponsorRecord('Summit Recruitment'), null, 'never borrows an unrelated firm');
    assert.equal(sponsorRecord('Recruiters'), null);
    assert.equal(sponsorRecord('Unknown Startup'), null);
    setSponsorsForTests(null);
  });
});
