import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../worker/src/index.mjs';

const env = { ALLOWED_ORIGINS: 'https://rshamilton.github.io' };
const req = (path, init = {}) => new Request(`https://relay.example${path}`, init);
const ok = async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });

test('relays an allowed host with CORS for an allowed origin', async () => {
  let seen;
  const r = await handle(req('/proxy/reignite-api.athlinks.com/event/1?x=2', { headers: { Origin: 'https://rshamilton.github.io' } }), env,
    async (url, init) => { seen = { url: String(url), init }; return ok(); });
  assert.equal(r.status, 200);
  assert.equal(seen.url, 'https://reignite-api.athlinks.com/event/1?x=2');
  assert.equal(seen.init.headers.Origin, 'https://www.athlinks.com');
  assert.equal(r.headers.get('X-Bibscan-Proxy'), '1');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://rshamilton.github.io');
  assert.equal(await r.text(), '{"a":1}');
});

test('RunSignUp is relayed too, on both the api and the site host', async () => {
  for (const host of ['api.runsignup.com', 'runsignup.com']) {
    const r = await handle(req(`/proxy/${host}/anything`), env, ok);
    assert.equal(r.status, 200, host);
  }
});

test('no CORS grant for other origins', async () => {
  const r = await handle(req('/proxy/sites.chronotrack.com/r/1', { headers: { Origin: 'https://evil.example' } }), env, ok);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('refuses other hosts, odd paths, redirects and non-GET', async () => {
  assert.equal((await handle(req('/proxy/example.com/'), env, ok)).status, 403);
  // URL parsing already folds %2e%2e, leaving an unknown "host": refused either way.
  assert.ok([400, 403].includes((await handle(req('/proxy/sites.chronotrack.com/%2e%2e/x'), env, ok)).status));
  assert.equal((await handle(req('/proxy/sites.chronotrack.com/a%5Cb'), env, ok)).status, 400);
  assert.equal((await handle(req('/proxy/sites.chronotrack.com/a', { method: 'POST' }), env, ok)).status, 405);
  const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://x' } });
  assert.equal((await handle(req('/proxy/sites.chronotrack.com/a'), env, redirect)).status, 502);
});

test('answers preflight', async () => {
  const r = await handle(req('/proxy/sites.chronotrack.com/a', { method: 'OPTIONS', headers: { Origin: 'https://rshamilton.github.io' } }), env, ok);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
});
