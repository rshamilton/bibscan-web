#!/usr/bin/env node
/* bibscan-web local server.

   Everything that matters runs in the browser: the OCR models, matching,
   voting, the roster and the history all live on the device. This server does
   three small jobs and has no dependencies:

   1. Serves the app, with the headers that let the browser use multi-threaded
      WebAssembly (cross-origin isolation) and the camera.
   2. Relays race-data requests to Athlinks and ChronoTrack. Their API rejects
      browsers calling it from any other site, so the page cannot fetch rosters
      directly. The relay is pinned to those two hosts, GET only, no redirects.
   3. Optionally serves HTTPS on your network, because phones only share their
      camera with a secure page.

     node server.mjs                 http://localhost:8780, this computer only
     node server.mjs --lan           also https://<your-ip>:8781 for phones
     node server.mjs --port 9000 --host 0.0.0.0 --cert c.pem --key k.pem
*/

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROXY_HOSTS } from './relay_hosts.mjs';

export { PROXY_HOSTS };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, 'public');
const DATA_DIR = path.join(HERE, 'data');
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/* Applied to every response. COOP + COEP make the page cross-origin isolated,
   which is what unlocks SharedArrayBuffer and so multi-threaded inference. */
export const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Length': buf.length, ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

/* ----------------------------------------------------------------- relay */

async function relay(req, res, url, { upstream, fetchImpl }) {
  const tag = { 'X-Bibscan-Proxy': '1', 'Cache-Control': 'no-store' };
  // /proxy/<host>/<path...>
  const rest = url.pathname.slice('/proxy/'.length);
  const slash = rest.indexOf('/');
  const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  const upstreamPath = slash < 0 ? '/' : rest.slice(slash);
  if (!Object.hasOwn(PROXY_HOSTS, host)) {
    return sendJson(res, 403, { error: `the relay only talks to ${Object.keys(PROXY_HOSTS).join(' and ')}` }, tag);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'GET only' }, tag);
  let decoded;
  try {
    decoded = decodeURIComponent(upstreamPath);
  } catch {
    return sendJson(res, 400, { error: 'bad path' }, tag);
  }
  // Checked decoded: URL parsing would quietly turn %2e%2e into "..".
  if (decoded.includes('..') || decoded.includes('//') || /[\s\\]/.test(decoded)) {
    return sendJson(res, 400, { error: 'odd path refused' }, tag);
  }
  const base = upstream[host] || `https://${host}`;
  let target;
  try {
    target = new URL(upstreamPath + url.search, base);
  } catch {
    return sendJson(res, 400, { error: 'bad path' }, tag);
  }
  // Re-check after parsing: the request must still be going where we think.
  if (target.origin !== new URL(base).origin) return sendJson(res, 400, { error: 'refusing to leave the allowed host' }, tag);

  let r;
  try {
    r = await fetchImpl(target, { headers: PROXY_HOSTS[host], redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (exc) {
    const reason = exc && exc.name === 'TimeoutError' ? 'timed out' : (exc && exc.cause && exc.cause.code) || (exc && exc.message) || 'failed';
    return sendJson(res, 502, { error: `could not reach ${host}: ${reason}` }, tag);
  }
  if (r.status >= 300 && r.status < 400) {
    return sendJson(res, 502, { error: `${host} answered with a redirect, which the relay does not follow` }, tag);
  }
  const declared = Number(r.headers.get('content-length') || 0);
  if (declared > MAX_UPSTREAM_BYTES) return sendJson(res, 502, { error: 'upstream response too large' }, tag);
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > MAX_UPSTREAM_BYTES) return sendJson(res, 502, { error: 'upstream response too large' }, tag);
  send(res, r.status, body, { ...tag, 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' });
}

/* ----------------------------------------------------------------- static */

function serveStatic(req, res, url, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed\n', { 'Content-Type': 'text/plain' });
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'bad path\n', { 'Content-Type': 'text/plain' });
  }
  if (rel.includes('\0')) return send(res, 400, 'bad path\n', { 'Content-Type': 'text/plain' });
  let file = path.join(publicDir, path.normalize(rel));
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) return send(res, 403, 'forbidden\n', { 'Content-Type': 'text/plain' });
  let st;
  try {
    st = fs.statSync(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = fs.statSync(file);
    }
  } catch {
    return send(res, 404, 'not found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  // Dotfiles are never served.
  if (path.relative(publicDir, file).split(path.sep).some((p) => p.startsWith('.'))) {
    return send(res, 404, 'not found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
    return res.end();
  }
  res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/* ------------------------------------------------------------------- app */

export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/* The request handler. `upstream` maps an allowed host to a different base URL
   (tests point it at a local fake); `info` is reported at /api/info. */
export function createHandler({ publicDir = PUBLIC_DIR, upstream = {}, fetchImpl = globalThis.fetch, info = {} } = {}) {
  return (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, 'bad request\n');
    }
    // Refuse "..", literal or encoded, before URL parsing quietly resolves it away.
    let rawPath;
    try {
      rawPath = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      return send(res, 400, 'bad request\n', { 'Content-Type': 'text/plain' });
    }
    if (/(^|[/\\])\.\.([/\\]|$)/.test(rawPath) || rawPath.includes('\0')) {
      return send(res, 400, 'bad request\n', { 'Content-Type': 'text/plain' });
    }
    if (url.pathname === '/healthz') return send(res, 200, 'ok\n', { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    if (url.pathname === '/api/info') return sendJson(res, 200, { name: 'bibscan-web', version: VERSION, proxy: true, ...info });
    if (url.pathname.startsWith('/proxy/')) {
      return relay(req, res, url, { upstream, fetchImpl }).catch((exc) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(exc && exc.message) }, { 'X-Bibscan-Proxy': '1' });
        else res.destroy();
      });
    }
    return serveStatic(req, res, url, publicDir);
  };
}

/* A self-signed certificate for the LAN address, made with openssl. */
export function ensureCert(dir, names) {
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const stamp = path.join(dir, 'names.txt');
  const wanted = [...new Set(names)].sort().join(',');
  if (fs.existsSync(cert) && fs.existsSync(key) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === wanted) return { cert, key };
  fs.mkdirSync(dir, { recursive: true });
  const san = [...new Set(names)].map((n) => (/^[\d.]+$/.test(n) || n.includes(':') ? `IP:${n}` : `DNS:${n}`)).join(',');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-keyout', key, '-out', cert, '-subj', '/CN=bibscan-web', '-addext', `subjectAltName=${san}`], { stdio: 'pipe' });
  } catch (exc) {
    throw new Error(`could not create a certificate with openssl (${exc.message.split('\n')[0]}). Install openssl, or pass --cert and --key.`);
  }
  fs.chmodSync(key, 0o600);
  fs.writeFileSync(stamp, wanted);
  return { cert, key };
}

export function parseArgs(argv) {
  const opts = { port: 8780, host: '127.0.0.1', lan: false, httpsPort: null, cert: null, key: null, help: false };
  const value = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan') opts.lan = true;
    else if (a === '--port') opts.port = Number(value(i++, a));
    else if (a === '--https-port') opts.httpsPort = Number(value(i++, a));
    else if (a === '--host') opts.host = value(i++, a);
    else if (a === '--cert') opts.cert = value(i++, a);
    else if (a === '--key') opts.key = value(i++, a);
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  for (const k of ['port', 'httpsPort']) {
    if (opts[k] !== null && !(Number.isInteger(opts[k]) && opts[k] > 0 && opts[k] < 65536)) throw new Error(`bad ${k}`);
  }
  if (opts.lan && opts.host === '127.0.0.1') opts.host = '0.0.0.0';
  if (opts.httpsPort === null) opts.httpsPort = opts.port + 1;
  if ((opts.cert && !opts.key) || (!opts.cert && opts.key)) throw new Error('--cert and --key go together');
  return opts;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export async function start(opts) {
  const lan = lanAddresses();
  const wantsTls = opts.lan || !!opts.cert;
  const httpsUrls = [];
  if (wantsTls) {
    const names = ['localhost', '127.0.0.1', os.hostname(), ...lan];
    httpsUrls.push(...lan.map((ip) => `https://${ip}:${opts.httpsPort}/`));
  }
  const exposed = opts.host !== '127.0.0.1' && opts.host !== 'localhost';
  const info = {
    lan: exposed,
    https_urls: httpsUrls,
    http_urls: exposed ? lan.map((ip) => `http://${ip}:${opts.port}/`) : [],
  };
  const handler = createHandler({ info });
  const servers = [await listen(http.createServer(handler), opts.port, opts.host)];
  if (wantsTls) {
    const { cert, key } = opts.cert ? { cert: opts.cert, key: opts.key } : ensureCert(path.join(DATA_DIR, 'tls'), ['localhost', '127.0.0.1', os.hostname(), ...lan]);
    const tls = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler);
    servers.push(await listen(tls, opts.httpsPort, opts.host));
  }
  return { servers, info };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (exc) {
    console.error(`server.mjs: ${exc.message}. Try --help.`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\s?/, ''));
    return;
  }
  let started;
  try {
    started = await start(opts);
  } catch (exc) {
    if (exc.code === 'EADDRINUSE') console.error(`server.mjs: port ${exc.port} is already in use. Pick another with --port.`);
    else console.error(`server.mjs: ${exc.message}`);
    process.exit(1);
  }
  const { info } = started;
  console.log(`bibscan-web ${VERSION}`);
  console.log(`\n  Open            http://localhost:${opts.port}/`);
  for (const u of info.http_urls) console.log(`  On your network ${u}   (viewing; cameras need https)`);
  for (const u of info.https_urls) console.log(`  Phone camera    ${u}   (accept the certificate warning once)`);
  if (!info.lan) console.log('\n  Only this computer can reach it. Add --lan to use a phone as the camera.');
  console.log('\nCtrl+C to stop.');
  const stop = () => {
    for (const s of started.servers) s.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
