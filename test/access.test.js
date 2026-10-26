// Who may sign in and what they see: grants in src/clients.js, the sign-in
// mapping in src/auth.js, and the CRM's owners in src/crm.js.
// Run: npm test   (uses a throwaway database, never data/beakon.db)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `beakon-access-test-${process.pid}.db`);
const { db } = await import('../src/db.js');
const {
  createClient, grantAccess, revokeAccess, listClientsForUser, userCanAccess, listClientUsers, confirmAlertEmailBySignIn,
} = await import('../src/clients.js');
const { findOrCreateUserFromFirebase, isAdminUser } = await import('../src/auth.js');
const { upsertClientFromCrm } = await import('../src/crm.js');

test('a Google account sees exactly the clients its email was granted; admins see all', () => {
  const mine = createClient({ name: 'Ascend Prime Systems', crmSlug: 'ascend-prime' });
  const other = createClient({ name: 'Somebody Else', crmSlug: 'somebody-else' });
  // Granted before she has ever signed in, in whatever case it was typed.
  grantAccess(mine.id, ' Owner@Example.com ');
  assert.equal(listClientUsers(mine.id)[0].user_id, null);

  const owner = findOrCreateUserFromFirebase({ uid: 'u-owner', email: 'owner@example.com' });
  assert.equal(owner.role, 'customer');
  assert.equal(isAdminUser(owner), false);
  assert.deepEqual(listClientsForUser(owner).map((c) => c.id), [mine.id]);
  assert.equal(userCanAccess(owner, false, mine.id), true);
  assert.equal(userCanAccess(owner, false, other.id), false);
  // Signing in attached the user to the grant.
  assert.equal(listClientUsers(mine.id)[0].user_id, owner.id);

  const admin = findOrCreateUserFromFirebase({ uid: 'u-admin', email: 'admin@example.com', admin: true });
  assert.equal(isAdminUser(admin), true);
  assert.ok(listClientsForUser(admin, true).length >= 2);
  assert.equal(userCanAccess(admin, true, other.id), true);

  revokeAccess(mine.id, 'owner@example.com');
  assert.deepEqual(listClientsForUser(owner), []);
  assert.throws(() => grantAccess(mine.id, 'not-an-email'), /email/);
});

test('the owners the CRM sends at onboarding are granted, and re-sending adds without duplicating', async () => {
  const r1 = await upsertClientFromCrm({ slug: 'carols-table', name: "Carol's Table", owners: ['carol@example.com'], sites: [] }, { baseUrl: 'http://x' });
  assert.deepEqual(r1.owners, ['carol@example.com']);
  const r2 = await upsertClientFromCrm(
    { slug: 'carols-table', name: "Carol's Table", ownerEmail: 'carol@example.com', owners: ['Chef@Example.com', 'carol@example.com'], sites: [] },
    { baseUrl: 'http://x' },
  );
  assert.equal(r2.created, false);
  assert.deepEqual(r2.owners, ['carol@example.com', 'chef@example.com']);
  assert.deepEqual(listClientUsers(r1.client.id).map((u) => u.email), ['carol@example.com', 'chef@example.com']);
});

test('signing in with the alert address confirms it, and only it', () => {
  const mine = createClient({ name: 'Mine', alertEmail: 'tulika@example.com' });
  const theirs = createClient({ name: 'Theirs', alertEmail: 'other@example.com' });
  const verifiedAt = (id) => db.prepare('SELECT alert_email_verified_at AS v FROM clients WHERE id = ?').get(id).v;
  assert.equal(verifiedAt(mine.id), null);

  const user = findOrCreateUserFromFirebase({ uid: 'u-t', email: 'tulika@example.com' });
  assert.deepEqual(confirmAlertEmailBySignIn(user), [mine.id]);
  assert.ok(verifiedAt(mine.id));
  assert.equal(verifiedAt(theirs.id), null);
  // A second sign-in has nothing left to confirm.
  assert.deepEqual(confirmAlertEmailBySignIn(user), []);
});
