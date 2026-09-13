/* Client for Athlinks' "reignite" API - the one that backs live race results -
   and turning whatever race link you have into an Athlinks event id.

   The browser cannot call the API itself: CloudFront in front of it rejects
   unknown origins and user agents. So requests go through the local server's
   /proxy route, which is pinned to these hosts and adds the headers. */

import { localDate } from './format.js';

export const REIGNITE_HOST = 'reignite-api.athlinks.com';
export const CHRONOTRACK_HOST = 'sites.chronotrack.com';
// Hosts a pasted link may name. www.athlinks.com is only ever parsed, never fetched.
export const LINK_HOSTS = new Set([REIGNITE_HOST, 'www.athlinks.com', 'athlinks.com', CHRONOTRACK_HOST]);

const ATHLINKS_EVENT_RE = /\/event\/(\d+)\/results\/[Ee]vent\/(\d+)/;
const ATHLINKS_SIMPLE_RE = /athlinks\.com\/event\/(\d+)/;
const CHRONOTRACK_RE = /chronotrack\.com\/(?:event|r)\/(\d+)/;

export class ResolveError extends Error {}

export class NoProxyError extends Error {
  constructor() {
    super('Race lookups need the bibscan-web server: start it with `node server.mjs` and open the page it prints.');
  }
}

/* A bare number that is valid as both an event and a race series. Athlinks
   event ids and series ids share a number space, so guessing would quietly add
   the wrong race. */
export class AmbiguousId extends ResolveError {
  constructor(number, eventName, seriesName) {
    super(
      `${number} is ambiguous: it is both the event '${eventName}' and the race series '${seriesName}'.\n` +
        `    Use  event:${number}   for the event\n` +
        `    or   series:${number}  for the series`,
    );
  }
}

export class AmbiguousRace extends ResolveError {
  constructor(masterName, editions) {
    const listing = editions.slice(0, 12).map((e) => `    ${e.date}  ${e.event_id}  ${e.name}`).join('\n');
    super(`'${masterName}' is a recurring race with ${editions.length} editions. Add one by id:\n${listing}`);
    this.masterName = masterName;
    this.editions = editions;
  }
}

/* The fetcher used in the browser: GET /proxy/<host><path>?<query>. */
export function proxyFetcher(base = '') {
  return async (host, path, params) => {
    const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const r = await fetch(`${base}/proxy/${host}${path}${qs}`, { cache: 'no-store' });
    if (!r.headers.get('X-Bibscan-Proxy')) throw new NoProxyError();
    return { status: r.status, body: await r.text() };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ReigniteClient {
  constructor({ fetcher, retries = 3, delay = 0.3, backoff = 0.5 } = {}) {
    this.fetcher = fetcher || proxyFetcher();
    this.retries = retries;
    this.delay = delay;
    this.backoff = backoff;
  }

  pause() {
    return this.delay > 0 ? sleep(this.delay * 1000) : Promise.resolve();
  }

  static checkPath(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('..') || path.includes('//')) {
      throw new Error(`refusing odd API path: ${path}`);
    }
  }

  async fetchText(host, path, params, allowMissing = false) {
    ReigniteClient.checkPath(path);
    const missing = allowMissing === true ? new Set([404]) : new Set(allowMissing || []);
    let last = null;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const r = await this.fetcher(host, path, params);
        if (missing.has(r.status)) return null;
        if (r.status < 200 || r.status >= 300) {
          let detail = '';
          try { detail = JSON.parse(r.body).error || ''; } catch { /* not ours */ }
          throw new Error(`HTTP ${r.status}${detail ? ` - ${detail}` : ''}`);
        }
        return r.body;
      } catch (exc) {
        if (exc instanceof NoProxyError) throw exc;
        last = exc;
        if (attempt < this.retries - 1 && this.backoff > 0) await sleep(this.backoff * 1000 * (attempt + 1));
      }
    }
    throw new Error(`GET ${host}${path} failed after ${this.retries} tries: ${last && last.message}`);
  }

  /* GET and parse JSON. `allowMissing` turns 404 (or the given status codes)
     into null: probing whether an id is a series answers 500, not 404. */
  async get(path, params = null, allowMissing = false) {
    const body = await this.fetchText(REIGNITE_HOST, path, params, allowMissing);
    if (body === null) return null;
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`GET ${path}: response was not JSON`);
    }
  }

  async event(eventId) {
    const d = await this.get(`/event/${eventId}/metadata`);
    return parseEvent(d, eventId);
  }

  /* Every registered entrant on a course. Available before the gun. */
  async *iterRoster(courseId, pageSize = 500) {
    let page = 1;
    let seen = 0;
    for (;;) {
      const d = await this.get(`/race/${courseId}/roster`, { page, pageSize });
      const rows = (d && d.results) || [];
      if (!rows.length) return;
      yield* rows;
      seen += rows.length;
      const total = Number((d && d.total) || 0);
      if (seen >= total) return;
      page += 1;
      await this.pause();
    }
  }

  resultsPage(eventId, courseId, from, limit) {
    return this.get(`/event/${eventId}/race/${courseId}/results`, { from, limit });
  }

  /* Live result for one bib. `intervals == []` means started, not finished. */
  bibResult(eventId, courseId, bib) {
    return this.get(`/event/${eventId}/race/${courseId}/bib/${encodeURIComponent(bib)}/result`, null, true);
  }
}

export function parseEvent(d, eventId) {
  const courses = ((d && d.races) || []).map((r) => {
    const meters = Number((r.distance && r.distance.meters) || 0);
    return {
      course_id: Number(r.id),
      name: String(r.name || '').trim() || `${+(meters / 1000).toFixed(3)}K`,
      meters,
      virtual: !!r.virtual,
      hidden: !!r.hidden,
      interval_id: r.fullCourseIntervalId ?? null,
    };
  });
  const start = d && d.start && d.start.epoch;
  const end = d && d.end && d.end.epoch;
  return {
    event_id: Number((d && d.id) || eventId),
    name: (d && d.name) || `event ${eventId}`,
    start_epoch: start ? start / 1000 : null,
    end_epoch: end ? end / 1000 : null,
    timezone: (d && d.start && d.start.timeZone) || 'UTC',
    courses,
    roster_available: !!(d && d.isRosterAvailable),
  };
}

/* Pull finish state, times and ranks out of a per-bib result payload. A runner
   out on the course comes back finished=false with everything else null. */
export function parseInterval(payload) {
  const intervals = (payload && payload.intervals) || [];
  const full = intervals.find((i) => i.full) || intervals[0] || null;
  const out = {
    finished: !!full, chip_ms: null, gun_ms: null, overall_rank: null, gender_rank: null,
    division: null, division_rank: null, interval_name: null,
  };
  if (!full) return out;
  out.chip_ms = full.chipTimeInMillis ?? null;
  out.gun_ms = full.gunTimeInMillis ?? null;
  out.interval_name = full.name ?? null;
  for (const d of full.divisions || []) {
    const name = String(d.name || '').toLowerCase();
    const rank = d.rank ?? null;
    if (name === 'overall') out.overall_rank = rank;
    else if (['male', 'female', 'men', 'women', 'm', 'f'].includes(name)) out.gender_rank = rank;
    else if (out.division === null) { out.division = d.name ?? null; out.division_rank = rank; }
  }
  return out;
}

/* The ChronoTrack results page is a Next.js app and carries the Athlinks id in
   __NEXT_DATA__ under masterEventMetadata.events[].athlinksEventId. */
export function athlinksIdFromChronotrackPage(html, ctEventId) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html || '');
  if (!m) throw new ResolveError(`ChronoTrack event ${ctEventId}: no event data in page`);
  let events;
  try {
    events = JSON.parse(m[1]).props.pageProps.masterEventMetadata.events;
    if (!Array.isArray(events)) throw new Error('no events');
  } catch {
    throw new ResolveError(`ChronoTrack event ${ctEventId}: unexpected page shape`);
  }
  for (const e of events) {
    if (Number(e.eventId || 0) === Number(ctEventId) && e.athlinksEventId) return Number(e.athlinksEventId);
  }
  throw new ResolveError(
    `ChronoTrack event ${ctEventId} has no Athlinks results yet (the timer publishes them when the race goes live)`,
  );
}

export async function chronotrackToAthlinks(client, ctEventId) {
  let html;
  try {
    html = await client.fetchText(CHRONOTRACK_HOST, `/event/${ctEventId}/results`, null);
  } catch (exc) {
    if (exc instanceof NoProxyError) throw exc;
    throw new ResolveError(`ChronoTrack event ${ctEventId}: ${exc.message}`);
  }
  return athlinksIdFromChronotrackPage(html, ctEventId);
}

function editions(master) {
  return ((master && master.events) || [])
    .map((e) => ({
      event_id: Number(e.id),
      name: e.name || '',
      date: e.start && e.start.epoch ? localDate(e.start.epoch / 1000) : '?',
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/* Turn a link or id into event metadata: {info, sourceUrl}. */
export async function resolveRace(spec, client, { ctLookup = chronotrackToAthlinks } = {}) {
  spec = String(spec || '').trim();
  if (!spec) throw new ResolveError('give a race URL or Athlinks event id');
  const sourceUrl = spec.startsWith('http') ? spec : null;

  // Explicit disambiguation, e.g. "series:19924".
  let force = '';
  for (const prefix of ['event:', 'series:', 'master:']) {
    if (spec.toLowerCase().startsWith(prefix)) {
      force = prefix === 'event:' ? 'event' : 'series';
      spec = spec.slice(prefix.length).trim();
      break;
    }
  }

  if (spec.startsWith('http')) {
    let host = '';
    try { host = new URL(spec).hostname.toLowerCase(); } catch { /* reported below */ }
    if (!LINK_HOSTS.has(host)) {
      throw new ResolveError(
        `don't know how to read '${host || spec}'. Paste the ChronoTrack or Athlinks results link, or the Athlinks event id.`,
      );
    }
    let m;
    if ((m = CHRONOTRACK_RE.exec(spec))) {
      return { info: await client.event(await ctLookup(client, Number(m[1]))), sourceUrl };
    }
    if ((m = ATHLINKS_EVENT_RE.exec(spec))) {
      return { info: await client.event(Number(m[2])), sourceUrl }; // /event/<master>/results/Event/<id>
    }
    if ((m = ATHLINKS_SIMPLE_RE.exec(spec))) spec = m[1]; // bare id: may be master or event
    else throw new ResolveError(`no event id found in ${spec}`);
  }

  if (!/^\d+$/.test(spec)) throw new ResolveError(`'${spec}' is not a URL or an event id`);

  const number = Number(spec);
  // Probing an id that isn't a series answers 500, not 404.
  const absent = [404, 500];
  const asEvent = force === 'series' ? null : await client.get(`/event/${number}/metadata`, null, absent);
  const asSeries = force === 'event' ? null : await client.get(`/master/${number}/metadata`, null, absent);

  if (asEvent && asSeries) throw new AmbiguousId(number, asEvent.name || String(number), asSeries.name || String(number));
  if (asEvent) return { info: await client.event(number), sourceUrl };
  const master = asSeries;
  if (!master) throw new ResolveError(`no Athlinks event or race series with id ${number}`);

  // A series: prefer the edition Athlinks itself considers current or next.
  for (const key of ['currentEvent', 'nextEvent']) {
    const node = master[key];
    if (node && node.id) return { info: await client.event(Number(node.id)), sourceUrl };
  }
  const eds = editions(master);
  if (!eds.length) throw new ResolveError(`race series ${number} has no editions published`);
  throw new AmbiguousRace(master.name || `series ${number}`, eds);
}
