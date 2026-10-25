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
