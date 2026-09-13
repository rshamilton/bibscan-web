/* The fetcher shared by every race-data client: GET /proxy/<host><path>?<query>,
   same-origin, so the browser never talks to a timing service directly. Used
   by athlinks.js and runsignup.js; server.mjs and the Cloudflare Worker are
   the actual relay (see relay_hosts.mjs for the hosts they'll speak to). */

export class NoProxyError extends Error {
  constructor() {
    super('Race lookups need the bibscan-web server: start it with `node server.mjs` and open the page it prints.');
  }
}

export function proxyFetcher(base = '') {
  return async (host, path, params) => {
    const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const r = await fetch(`${base}/proxy/${host}${path}${qs}`, { cache: 'no-store' });
    if (!r.headers.get('X-Bibscan-Proxy')) throw new NoProxyError();
    return { status: r.status, body: await r.text() };
  };
}
