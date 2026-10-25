// Detection rules in src/search.js that decide whether a site passes.
// Run: npm test   (uses a throwaway database, never data/beakon.db)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `beakon-test-${process.pid}.db`);
const { countH1, isBotBlock, readHtml } = await import('../src/search.js');

test('one visible H1 is one, however many times the builder ships it', () => {
  assert.equal(countH1('<h1>Sharp Cuts</h1>'), 1);
  // Mobile and desktop headers with the same heading.
  assert.equal(countH1('<header class="m"><h1>Sharp Cuts</h1></header><header class="d"><h1> sharp  cuts </h1></header>'), 1);
  // Copies the visitor never sees.
  assert.equal(countH1('<h1>Home</h1><template><h1>Home</h1></template><noscript><h1>Other</h1></noscript><!-- <h1>old</h1> -->'), 1);
  assert.equal(readHtml('<html><body><h1>A</h1><script>"<h1>x</h1>"</script></body></html>', 'https://x.com/').h1Count, 1);
});

test('two different H1s and no H1 are still caught', () => {
  assert.equal(countH1('<h1>Haircuts</h1><h1>Beard trims</h1>'), 2);
  assert.equal(countH1('<h2>Nothing</h2>'), 0);
  assert.equal(countH1('<h1><img src="logo.png"></h1>'), 1);
});

test('bot protection is told apart from an outage', () => {
  assert.equal(isBotBlock({ status: 403, headers: { server: 'cloudflare' }, body: '<title>Just a moment...</title>' }), 'Cloudflare bot protection');
  assert.equal(isBotBlock({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '' }), 'Cloudflare bot protection');
  assert.equal(isBotBlock({ status: 429, headers: {}, body: '' }), 'rate limited');
  assert.equal(isBotBlock({ status: 403, headers: {}, body: 'Access Denied' }), 'HTTP 403 with a bot check');
  assert.equal(isBotBlock({ status: 500, headers: { server: 'cloudflare' }, body: 'Just a moment' }), null);
  assert.equal(isBotBlock({ status: 403, headers: {}, body: '<h1>Forbidden</h1>' }), null);
});

test('an attestation is read from its own scope, so a saved tick stays ticked', async () => {
  const { db } = await import('../src/db.js');
  const { setAttestations, listAttestations } = await import('../src/search.js');
  const t = Math.floor(Date.now() / 1000);
  // A stale row for a business attestation filed under the domain.
  db.prepare('INSERT OR REPLACE INTO search_attestations (client_id, scope_key, key, value, set_at) VALUES (?, ?, ?, 0, ?)').run(901, 'shop.com', 'gbp_verified', t);
  setAttestations(901, 'shop.com', { gbp_verified: true, gsc_verified: true });
  const a = listAttestations(901, 'shop.com');
  assert.equal(a.gbp_verified.value, true);
  assert.equal(a.gsc_verified.value, true);
  // A site attestation does not leak to the client's other site.
  assert.equal(listAttestations(901, 'other.com').gsc_verified, undefined);
  assert.equal(listAttestations(901, 'other.com').gbp_verified.value, true);
});

test('the overview counts what is in place on every rung, above the grade too', async () => {
  const { grade } = await import('../src/searchLadder.js');
  const { rungSummary } = await import('../src/search.js');
  const g = grade({ https_ok: { ok: true }, single_host: { ok: true }, indexable: { ok: true }, gbp_listed: { ok: true } }, { gsc_verified: true });
  const r = rungSummary(g.rungs);
  assert.equal(r.length, 10);
  assert.deepEqual(r[0], { rung: 1, name: 'On the map', cleared: false, done: 1, total: 2, failing: 0, missing: 1 });
  assert.equal(r[1].done, 4);
  assert.equal(r[1].cleared, true);
});

test('a site that asks not to be indexed is left off the ladder, unless it is the main one', async () => {
  const { splitAudits } = await import('../src/search.js');
  const main = { domain: 'gw.com', isPrimary: true, createdAt: 1, result: { noindex: false } };
  const app = { domain: 'app.gw.com', isPrimary: false, createdAt: 2, result: { noindex: true } };
  const oldApp = { domain: 'old.gw.com', isPrimary: false, createdAt: 3, result: {} };
  const r = splitAudits([main, app, oldApp]);
  assert.deepEqual(r.graded.map((a) => a.domain), ['gw.com', 'old.gw.com']);
  assert.deepEqual(r.skipped, [{ domain: 'app.gw.com', analyzedAt: 2, reason: 'noindex' }]);
  // The main site is graded even when it is noindex: that is the bug to fix.
  const hidden = { ...main, result: { noindex: true } };
  assert.deepEqual(splitAudits([hidden, app]).graded.map((a) => a.domain), ['gw.com']);
});
