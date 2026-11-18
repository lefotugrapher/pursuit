import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isJobRelated, mayUseLLM } from '../src/engine/inbox/privacy';
import type { InboundEmail, Job } from '../src/lib/types';

const mail = (fromAddress: string, subject: string, text = 'hello'): InboundEmail => ({ messageId: `<${subject}>`, from: fromAddress, fromAddress, subject, date: '2026-11-16T10:00:00Z', text });
const jobs = [{ id: 'j1', company: 'Acme Comms Ltd', title: 'PR Executive', status: 'applied' } as unknown as Job];

describe('personal inbox privacy gate', () => {
  test('personal mail is never stored or sent to the AI', () => {
    for (const m of [
      mail('alerts@aib.ie', 'Your statement is ready'),
      mail('mum@gmail.com', 'Dinner Sunday?'),
      mail('no-reply@emails.tesco.ie', 'Your Christmas slots are here', 'schedule your delivery slot'),
      mail('orders@amazon.co.uk', 'Your order has shipped'),
      mail('friend@outlook.com', 'Photos', 'loved your interview tips'), // recruiting word only in the body
    ]) {
      assert.equal(isJobRelated(m, jobs), false, m.fromAddress);
      assert.equal(mayUseLLM(m, jobs), false, m.fromAddress);
    }
  });
  test('employer, platform and alert mail is let through', () => {
    assert.ok(isJobRelated(mail('sarah@acmecomms.ie', 'Hello'), jobs));
    assert.ok(isJobRelated(mail('no-reply@greenhouse.io', 'Thanks'), jobs));
    assert.ok(isJobRelated(mail('jobalerts-noreply@linkedin.com', '10 new jobs'), jobs));
    assert.ok(isJobRelated(mail('anna@somefirm.ie', 'Your application for Marketing Executive'), jobs));
  });
  test('only employers he applied to and recruiting platforms may reach the AI', () => {
    assert.ok(mayUseLLM(mail('sarah@acmecomms.ie', 'Hello'), jobs));
    assert.ok(mayUseLLM(mail('no-reply@lever.co', 'Update'), jobs));
    assert.equal(mayUseLLM(mail('anna@somefirm.ie', 'Your application for Marketing Executive'), jobs), false);
    assert.equal(mayUseLLM(mail('messages-noreply@linkedin.com', 'Sean sent you a message'), jobs), false, 'LinkedIn DMs never go to the AI');
  });
});
