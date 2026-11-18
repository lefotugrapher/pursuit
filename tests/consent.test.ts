import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConsent } from '../src/engine/apply/fields';

test('real marketing opt-ins are still never ticked', () => {
  for (const t of [
    'I would like to receive marketing communications from Acme', 'Sign up for our newsletter', 'Keep me informed about future opportunities',
    'Add me to your talent pool', 'Do you opt-in to receive WhatsApp messages from Stripe Recruiting?', 'I agree to receive promotional emails',
    'Marketing preferences', 'Send me updates by SMS',
  ]) assert.equal(classifyConsent(t), 'marketing', t);
});

test('questions about his marketing experience are NOT opt-ins (Focus Ireland bug)', () => {
  for (const t of [
    'Do you have experience working in fundraising, marketing or relevant discipline? Please briefly outline your work experience below',
    'Do you have third level qualification in fundraising/marketing/communications/multimedia or related discipline? Please briefly outline your qualification below',
    'How many years of marketing experience do you have?', 'Describe a promotional campaign you ran', 'Which marketing tools have you used?',
  ]) assert.notEqual(classifyConsent(t), 'marketing', t);
});

test('an unmarked data-processing consent box (Workable name="gdpr") is never silently skipped', async () => {
  const { decide, CONSENT_BANK_ID } = await import('../src/engine/apply/fields');
  const label = 'I have read, understand and accept the content of the Privacy Notice and consent to the processing of my data as part of this application.';
  const field = {
    idx: 0, kind: 'checkbox' as const, label, rawLabel: label, required: false, options: [label], optionDomIndex: [0],
    name: 'gdpr', id: '', type: 'checkbox', autocomplete: '', placeholder: '', hasValue: false, eeoSection: false, hasManualToggle: false,
  };
  const pkg = { job: { title: 'Digital Marketer', company: 'Acme' }, profile: {}, cvPdfPath: '/tmp/cv.pdf', answers: [] } as never;
  // No recorded OK: it becomes a question for Kayzee instead of being skipped (which made the submit fail).
  assert.equal(decide(field, pkg, { ats: 'workable', bank: { entries: [] } }).action, 'need');
  // With his recorded OK on file it is ticked.
  const bank = { entries: [{ id: CONSENT_BANK_ID, patterns: ['consent to the processing of my data'], answer: 'Yes', type: 'yesno' as const, confirm: false }] };
  assert.equal(decide(field, pkg, { ats: 'workable', bank }).action, 'fill');
});
