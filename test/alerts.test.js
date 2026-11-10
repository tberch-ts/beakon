// Why a client can be set up for alerts and still get nothing.
//
// These run with no SMTP configured, which is not a limitation of the test:
// it is the exact state that produced the bug. sendMail() logs and returns
// false, every caller carries on as if it had worked, and the client sits
// silent forever.
//
// Run: npm test   (uses a throwaway database, never data/beakon.db)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `beakon-alerts-test-${process.pid}.db`);
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;

const {
  createClient, getClient, updateAlertSettings, resendVerification, resendAllVerifications,
  listUnconfirmedAlertClients, effectiveAlertMode, verifyAlertToken,
} = await import('../src/clients.js');

const opts = { baseUrl: 'https://beakon.test' };

test('a confirmation that could not be sent is not recorded as sent', async () => {
  const c = createClient({ name: 'Unreachable Ltd', crmSlug: 'unreachable' });
  const r = await updateAlertSettings(c, { alertEmail: 'owner@unreachable.test' }, opts);

  assert.equal(r.verificationSent, false, 'no transport, so nothing went out');
  assert.equal(r.verificationPending, true);
  // The distinction the page needs: asked and ignored, or never asked.
  assert.equal(getClient(c.id).alert_verify_sent_at, null);
  assert.equal(effectiveAlertMode(getClient(c.id)), 'email_unverified');
});

test('an unconfirmed client is silent, and is listed as such', async () => {
  const c = createClient({ name: 'Silent Co', crmSlug: 'silent' });
  await updateAlertSettings(c, { alertEmail: 'owner@silent.test' }, opts);

  const names = listUnconfirmedAlertClients().map((x) => x.name);
  assert.ok(names.includes('Silent Co'));

  // ...and clicking the link takes it out again.
  const token = getClient(c.id).alert_verify_token;
  assert.ok(token);
  verifyAlertToken(token);
  assert.equal(effectiveAlertMode(getClient(c.id)), 'email');
  assert.ok(!listUnconfirmedAlertClients().some((x) => x.id === c.id));
});

test('marking an address verified needs no email at all', async () => {
  const c = createClient({ name: 'Known Good', crmSlug: 'known-good' });
  const r = await updateAlertSettings(c, { alertEmail: 'tom@talkstudio.space', markVerified: true }, opts);

  assert.equal(r.verificationPending, false);
  assert.equal(effectiveAlertMode(r.client), 'email');
  assert.ok(!listUnconfirmedAlertClients().some((x) => x.id === c.id));
});

test('changing the address starts again, however much the old one was told', async () => {
  const c = createClient({ name: 'Moved On', crmSlug: 'moved-on' });
  await updateAlertSettings(c, { alertEmail: 'old@moved.test', markVerified: true }, opts);
  assert.equal(effectiveAlertMode(getClient(c.id)), 'email');

  await updateAlertSettings(getClient(c.id), { alertEmail: 'new@moved.test' }, opts);
  const after = getClient(c.id);
  assert.equal(after.alert_email_verified_at, null, 'a new address is not covered by the old one being confirmed');
  assert.equal(after.alert_verify_sent_at, null);
  assert.equal(effectiveAlertMode(after), 'email_unverified');
});

test('alerts switched off are not counted as waiting on anybody', async () => {
  const c = createClient({ name: 'Opted Out', crmSlug: 'opted-out' });
  await updateAlertSettings(c, { alertEmail: 'owner@opted.test', alertsEnabled: 0 }, opts);
  assert.ok(!listUnconfirmedAlertClients().some((x) => x.id === c.id));
});

test('a resend to everybody reports what actually happened', async () => {
  const before = listUnconfirmedAlertClients().length;
  assert.ok(before > 0, 'the tests above left somebody unconfirmed');

  const { sent, failed, total } = await resendAllVerifications(opts);
  assert.equal(total, before);
  // No transport: every one of them fails, and the caller is told so rather
  // than seeing a cheerful count of attempts.
  assert.equal(sent.length, 0);
  assert.equal(failed.length, before);
  assert.ok(listUnconfirmedAlertClients().every((c) => c.alert_verify_sent_at === null));
});

test('a confirmed address is never re-asked', async () => {
  const c = createClient({ name: 'Already Done', crmSlug: 'already-done' });
  await updateAlertSettings(c, { alertEmail: 'done@done.test', markVerified: true }, opts);
  assert.equal(await resendVerification(getClient(c.id), opts), false);
});
