// The local server: static files with the right headers, and a relay that
// only ever talks to the two race-data hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHandler, parseArgs, PUBLIC_DIR } from '../../server.mjs';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// Sends the path byte for byte. fetch(), and http.request given a URL string,
// both normalise "%2e%2e" away before sending, which would hide the traversal
// attempts under test.
function get(url, headers = {}, method = 'GET') {
  const [, origin, rawPath = '/'] = /^(http:\/\/[^/]+)(\/.*)?$/.exec(url);
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

const site = fs.mkdtempSync(path.join(os.tmpdir(), 'bibscan-site-'));
fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>t</title>');
fs.mkdirSync(path.join(site, 'models'));
fs.writeFileSync(path.join(site, 'models', 'm.onnx'), Buffer.from([1, 2, 3]));
fs.writeFileSync(path.join(site, 'app.mjs'), 'export {}');
fs.writeFileSync(path.join(site, '.secret'), 'nope');
fs.writeFileSync(path.join(os.tmpdir(), 'bibscan-outside.txt'), 'outside');

const seen = [];
const upstream = await listen((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url.startsWith('/event/1146036/metadata')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ id: 1146036, name: 'Test Race' }));
  }
  if (req.url === '/moved') {
    res.writeHead(302, { Location: 'https://evil.example.com/' });
    return res.end();
  }
  if (req.url === '/event/1/results') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html>ct</html>');
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"message":"nope"}');
});
const hosts = { 'reignite-api.athlinks.com': upstream.url, 'sites.chronotrack.com': upstream.url };
const app = await listen(createHandler({ publicDir: site, upstream: hosts, info: { lan: false } }));
test.after(async () => { await app.close(); await upstream.close(); });

test('serves the page with cross-origin isolation and a strict CSP', async () => {
  const r = await get(`${app.url}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(r.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.match(r.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(r.headers['permissions-policy'], /camera=\(self\)/);
});

test('module scripts and models get usable content types', async () => {
  assert.match((await get(`${app.url}/app.mjs`)).headers['content-type'], /text\/javascript/);
  assert.equal((await get(`${app.url}/models/m.onnx`)).headers['content-type'], 'application/octet-stream');
});

test('ETag revalidation answers 304', async () => {
  const first = await get(`${app.url}/models/m.onnx`);
  const again = await get(`${app.url}/models/m.onnx`, { 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304);
});

test('HEAD sends headers only', async () => {
  const r = await get(`${app.url}/index.html`, {}, 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.body, '');
});

test('nothing outside the site directory is reachable', async () => {
  for (const p of ['/..%2fbibscan-outside.txt', '/%2e%2e/bibscan-outside.txt', '/models/..%2f..%2fbibscan-outside.txt']) {
    const r = await get(app.url + p);
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /outside/);
  }
});

test('dotfiles are not served', async () => {
  assert.equal((await get(`${app.url}/.secret`)).status, 404);
});

test('only GET and HEAD', async () => {
  assert.equal((await get(`${app.url}/index.html`, {}, 'POST')).status, 405);
  assert.equal((await get(`${app.url}/proxy/reignite-api.athlinks.com/event/1146036/metadata`, {}, 'POST')).status, 405);
});

test('relay passes a JSON answer through, marked as coming from the relay', async () => {
  const r = await get(`${app.url}/proxy/reignite-api.athlinks.com/event/1146036/metadata?x=1`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-bibscan-proxy'], '1');
  assert.deepEqual(JSON.parse(r.body), { id: 1146036, name: 'Test Race' });
  const last = seen[seen.length - 1];
  assert.equal(last.url, '/event/1146036/metadata?x=1');
  assert.match(last.headers['user-agent'], /Mozilla/);
  assert.equal(last.headers.origin, 'https://www.athlinks.com');
});

test('relay reaches ChronoTrack pages too', async () => {
  const r = await get(`${app.url}/proxy/sites.chronotrack.com/event/1/results`);
  assert.equal(r.status, 200);
  assert.equal(r.body, '<html>ct</html>');
});

test('relay keeps upstream status codes (404 means "no such thing")', async () => {
  const r = await get(`${app.url}/proxy/reignite-api.athlinks.com/master/5/metadata`);
  assert.equal(r.status, 404);
  assert.equal(r.headers['x-bibscan-proxy'], '1');
});

test('relay refuses every other host', async () => {
  for (const host of ['evil.example.com', 'localhost', '127.0.0.1', 'www.athlinks.com']) {
    const r = await get(`${app.url}/proxy/${host}/anything`);
    assert.equal(r.status, 403, host);
  }
});

test('relay does not follow redirects', async () => {
  const r = await get(`${app.url}/proxy/reignite-api.athlinks.com/moved`);
  assert.equal(r.status, 502);
  assert.match(JSON.parse(r.body).error, /redirect/);
});

test('relay refuses odd paths', async () => {
  for (const p of ['/proxy/reignite-api.athlinks.com/a/%2e%2e/b', '/proxy/reignite-api.athlinks.com//evil.example.com/x']) {
    const r = await get(app.url + p);
    assert.ok([400, 403].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('an unreachable upstream is a clear 502', async () => {
  const dead = await listen(createHandler({ publicDir: site, upstream: { 'reignite-api.athlinks.com': 'http://127.0.0.1:9' } }));
  const r = await get(`${dead.url}/proxy/reignite-api.athlinks.com/event/1/metadata`);
  await dead.close();
  assert.equal(r.status, 502);
  assert.match(JSON.parse(r.body).error, /could not reach/);
});

test('/api/info reports the relay', async () => {
  const j = JSON.parse((await get(`${app.url}/api/info`)).body);
  assert.equal(j.name, 'bibscan-web');
  assert.equal(j.proxy, true);
});

test('the real app directory has what the page needs', async () => {
  const real = await listen(createHandler({ publicDir: PUBLIC_DIR }));
  try {
    for (const [p, type] of [
      ['/', /text\/html/],
      ['/js/app.js', /javascript/],
      ['/js/engine.worker.js', /javascript/],
      ['/vendor/ort/ort-wasm-simd-threaded.wasm', /application\/wasm/],
      ['/vendor/ort/ort.wasm.min.mjs', /javascript/],
      ['/models/rec_keys.json', /json/],
      ['/sw.js', /javascript/],
      ['/manifest.webmanifest', /manifest/],
    ]) {
      const r = await get(real.url + p, {}, 'HEAD');
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], type, p);
    }
  } finally {
    await real.close();
  }
});

test('command line options', () => {
  assert.deepEqual(parseArgs([]), { port: 8780, host: '127.0.0.1', lan: false, httpsPort: 8781, cert: null, key: null, help: false });
  const lan = parseArgs(['--lan', '--port', '9000']);
  assert.equal(lan.host, '0.0.0.0');
  assert.equal(lan.httpsPort, 9001);
  assert.throws(() => parseArgs(['--port', 'abc']));
  assert.throws(() => parseArgs(['--cert', 'x.pem']));
  assert.throws(() => parseArgs(['--bogus']));
});
