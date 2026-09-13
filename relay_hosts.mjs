/* The only hosts the relay will talk to, and the headers each needs. The API
   sits behind CloudFront, which blocks unknown user agents and origins, so
   these are required rather than cosmetic. Shared by server.mjs and the
   Cloudflare Worker in worker/. */

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const PROXY_HOSTS = {
  'reignite-api.athlinks.com': {
    'User-Agent': BROWSER_UA,
    Origin: 'https://www.athlinks.com',
    Referer: 'https://www.athlinks.com/',
    Accept: 'application/json',
  },
  'sites.chronotrack.com': {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml',
  },
};
