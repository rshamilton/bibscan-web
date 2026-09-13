/* bibscan relay as a Cloudflare Worker: the same job as relay() in server.mjs,
   for when the page is hosted statically (GitHub Pages). GET /proxy/<host><path>,
   pinned to PROXY_HOSTS, no redirects, CORS limited to ALLOWED_ORIGINS. */

import { PROXY_HOSTS } from '../../relay_hosts.mjs';

const MAX_UPSTREAM_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30000;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'X-Bibscan-Proxy': '1', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    Object.assign(h, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Expose-Headers': 'X-Bibscan-Proxy',
      'Access-Control-Max-Age': '86400',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
  }
  return h;
}

const json = (status, obj, headers) =>
  new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const tag = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: tag });
  if (url.pathname === '/healthz') return json(200, { ok: true }, tag);
  if (!url.pathname.startsWith('/proxy/')) return json(404, { error: 'not found' }, tag);

  const rest = url.pathname.slice('/proxy/'.length);
  const slash = rest.indexOf('/');
  const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase();
  const upstreamPath = slash < 0 ? '/' : rest.slice(slash);
  if (!Object.hasOwn(PROXY_HOSTS, host)) {
    return json(403, { error: `the relay only talks to ${Object.keys(PROXY_HOSTS).join(' and ')}` }, tag);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'GET only' }, tag);
  let decoded;
  try {
    decoded = decodeURIComponent(upstreamPath);
  } catch {
    return json(400, { error: 'bad path' }, tag);
  }
  if (decoded.includes('..') || decoded.includes('//') || /[\s\\]/.test(decoded)) {
    return json(400, { error: 'odd path refused' }, tag);
  }
  const base = `https://${host}`;
  let target;
  try {
    target = new URL(upstreamPath + url.search, base);
  } catch {
    return json(400, { error: 'bad path' }, tag);
  }
  if (target.origin !== base) return json(400, { error: 'refusing to leave the allowed host' }, tag);

  let r;
  try {
    r = await fetchImpl(target, { headers: PROXY_HOSTS[host], redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (exc) {
    const reason = exc && exc.name === 'TimeoutError' ? 'timed out' : (exc && exc.message) || 'failed';
    return json(502, { error: `could not reach ${host}: ${reason}` }, tag);
  }
  if (r.status >= 300 && r.status < 400) {
    return json(502, { error: `${host} answered with a redirect, which the relay does not follow` }, tag);
  }
  if (Number(r.headers.get('content-length') || 0) > MAX_UPSTREAM_BYTES) return json(502, { error: 'upstream response too large' }, tag);
  const body = await r.arrayBuffer();
  if (body.byteLength > MAX_UPSTREAM_BYTES) return json(502, { error: 'upstream response too large' }, tag);
  return new Response(request.method === 'HEAD' ? null : body, {
    status: r.status,
    headers: { ...tag, 'Content-Type': r.headers.get('content-type') || 'application/octet-stream' },
  });
}

export default { fetch: (request, env) => handle(request, env) };
