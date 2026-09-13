/* Client for RunSignUp's public REST API - the second timing service,
   alongside Athlinks/ChronoTrack in athlinks.js.

   RunSignUp's race and results endpoints (api.runsignup.com) are genuinely
   public: no key, and CORS is wide open (checked live: `Access-Control-
   Allow-Origin: *`). Its *participant* endpoint is not - it answers
   "Permission Denied" without a race-granted API key, because the roster
   carries email/phone/address, not just a bib and a name. So unlike
   Athlinks, there is no anonymous pre-race roster here: a RunSignUp race is
   named as results are posted, not before the gun. iterRoster() below is a
   deliberate no-op for that reason, not an oversight.

   Requests still go through the same relay as Athlinks (see relay_hosts.mjs)
   rather than being fetched directly, so the app keeps one audited egress
   path and the page's strict connect-src 'self' stays true. */

import { NoProxyError, proxyFetcher } from './relay.js';

export const RUNSIGNUP_API_HOST = 'api.runsignup.com';
export const RUNSIGNUP_SITE_HOST = 'runsignup.com';
// Hosts a pasted link may name. www.runsignup.com redirects to runsignup.com
// (checked live), so it's only ever parsed, never fetched.
export const RUNSIGNUP_LINK_HOSTS = new Set([RUNSIGNUP_SITE_HOST, 'www.runsignup.com', RUNSIGNUP_API_HOST]);

export class ResolveError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* RunSignUp race and event ids are small integers that could coincide with
   an Athlinks event or course id (both are just auto-increment numbers from
   an unrelated database) - the races store is keyed on event_id, and the
   runners/sightings stores on [event_id, ...], so a collision would corrupt
   two races into one. This offset keeps every RunSignUp id in a range no
   Athlinks id will plausibly ever reach, without touching Athlinks' own ids
   (so anything already synced keeps working unchanged). */
export const ID_OFFSET = 9_000_000_000;
export const nsId = (native) => ID_OFFSET + Number(native);
export const nativeId = (id) => Number(id) - ID_OFFSET;

/* "17:20" or "1:17:20" -> milliseconds. RunSignUp gives clock strings where
   Athlinks gives milliseconds directly. */
export function parseClockToMs(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  let h = 0, m = 0, sec = 0;
  if (parts.length === 3) [h, m, sec] = parts;
  else if (parts.length === 2) [m, sec] = parts;
  else return null;
  return Math.round((h * 3600 + m * 60 + sec) * 1000);
}

/* Resolves a wall-clock time in an IANA zone to a Unix epoch (seconds),
   correct across DST, with no timezone library: format the UTC guess back
   through Intl in the target zone and correct by the difference. */
export function zonedTimeToEpoch(dateStr, timeStr, timeZone) {
  const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(dateStr ?? '').trim());
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(timeStr ?? '').trim());
  if (!dm || !tm) return null;
  const [, mo, da, yr] = dm;
  const [, hh, mi, ss] = tm;
  const utcGuess = Date.UTC(Number(yr), Number(mo) - 1, Number(da), Number(hh), Number(mi), Number(ss || 0));
  let parts;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    parts = Object.fromEntries(dtf.formatToParts(new Date(utcGuess)).map((p) => [p.type, p.value]));
  } catch {
    return Math.round(utcGuess / 1000); // unrecognised zone: treat the wall clock as UTC
  }
  const hour = Number(parts.hour) % 24; // Intl prints "24" for midnight
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return Math.round((utcGuess - (asIfUtc - utcGuess)) / 1000);
}

/* RunSignUp's own "M/D/YYYY HH:mm" (its API always renders 24h, no timezone). */
export function parseRunSignUpDateTime(s, timeZone) {
  const m = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)/.exec(String(s ?? '').trim());
  return m ? zonedTimeToEpoch(m[1], m[2], timeZone) : null;
}

function distanceToMeters(s) {
  s = String(s ?? '').trim();
  if (!s) return 0;
  if (/half\s*marathon/i.test(s)) return 21097.5;
  if (/marathon/i.test(s)) return 42195;
  let m = /^([\d.]+)\s*k(m)?$/i.exec(s);
  if (m) return Math.round(parseFloat(m[1]) * 1000);
  m = /^([\d.]+)\s*mi(les?)?$/i.exec(s);
  if (m) return Math.round(parseFloat(m[1]) * 1609.344);
  return 0;
}

/* RunSignUp reuses one race_id across every year it has run, with a fresh
   set of event_ids each time - so "the race" someone pastes a link to is
   really "the edition closest to now". Group events by their date and pick
   the soonest upcoming group, or the most recent past one if none remain. */
export function parseRace(d, raceId) {
  const timezone = d.timezone || 'UTC';
  const events = Array.isArray(d.events) ? d.events : [];
  const groups = new Map(); // "M/D/YYYY" -> events[]
  for (const e of events) {
    const day = String(e.start_time || '').trim().split(' ')[0];
    if (!day) continue;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(e);
  }
  const nowSec = Date.now() / 1000;
  let chosen = events, chosenEpoch = null, chosenIsFuture = false;
  for (const list of groups.values()) {
    const epoch = parseRunSignUpDateTime(list[0].start_time, timezone);
    const isFuture = epoch !== null && epoch >= nowSec;
    const better = chosenEpoch === null
      || (isFuture && (!chosenIsFuture || epoch < chosenEpoch))
      || (!isFuture && !chosenIsFuture && epoch > chosenEpoch);
    if (better) { chosen = list; chosenEpoch = epoch; chosenIsFuture = isFuture; }
  }
  const courses = chosen.map((e) => ({
    course_id: nsId(e.event_id),
    name: (e.distance && String(e.distance).trim()) || e.name || `event ${e.event_id}`,
    meters: distanceToMeters(e.distance),
    interval_id: null,
  }));
  const epochs = chosen.map((e) => parseRunSignUpDateTime(e.start_time, timezone)).filter((x) => x !== null);
  return {
    event_id: nsId(raceId),
    name: d.name || `RunSignUp race ${raceId}`,
    start_epoch: epochs.length ? Math.min(...epochs) : null,
    end_epoch: null,
    timezone,
    courses,
    roster_available: false,
  };
}

/* The first results list that carries individual bib rows - award-only or
   team-standing sets (no "bib" field) are skipped. */
function individualResults(d) {
  for (const set of (d && d.individual_results_sets) || []) {
    const rows = set && Array.isArray(set.results) ? set.results : [];
    if (rows.length && Object.hasOwn(rows[0], 'bib')) return rows;
  }
  return [];
}

/* Shapes a RunSignUp result row into the same fields athlinks.js's
   resultRow()/entrantRow() (public/js/core/index.js) already read off an
   Athlinks payload, so nothing downstream needs to know a second timing
   service exists. RunSignUp doesn't expose gender/division rank the way
   Athlinks does, so those are left null rather than guessed. */
function toCommonRow(r) {
  const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
  return {
    bib: r.bib,
    displayName: name || null,
    age: r.age ?? null,
    gender: r.gender ?? null,
    team: null,
    status: null,
    chipTimeInMillis: parseClockToMs(r.chip_time),
    gunTimeInMillis: parseClockToMs(r.clock_time),
    rankings: { overall: r.place ?? null, gender: null, primary: null },
    location: { locality: r.city ?? null, region: r.state ?? null, country: r.country_code ?? null },
  };
}

function toResultsPayload(d) {
  return { intervals: [{ results: individualResults(d).map(toCommonRow) }] };
}

function toBibPayload(r) {
  const row = toCommonRow(r);
  return {
    bib: String(r.bib ?? ''),
    displayName: row.displayName, age: row.age, gender: row.gender,
    location: row.location, status: row.status,
    intervals: [{ full: true, chipTimeInMillis: row.chipTimeInMillis, gunTimeInMillis: row.gunTimeInMillis,
      name: 'Results', divisions: [{ name: 'Overall', rank: row.rankings.overall }] }],
  };
}

const LOOKUP_PAGE_SIZE = 500;
const MAX_LOOKUP_PAGES = 20; // 10,000 finishers - generous for a single road race

export class RunSignUpClient {
  constructor({ fetcher, retries = 3, delay = 0.3, backoff = 0.5 } = {}) {
    this.fetcher = fetcher || proxyFetcher();
    this.retries = retries;
    this.delay = delay;
    this.backoff = backoff;
  }

  pause() {
    return this.delay > 0 ? sleep(this.delay * 1000) : Promise.resolve();
  }

  async fetchText(path, params, allowMissing = false) {
    const missing = allowMissing === true ? new Set([404]) : new Set(allowMissing || []);
    let last = null;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const r = await this.fetcher(RUNSIGNUP_API_HOST, path, params);
        if (missing.has(r.status)) return null;
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        return r.body;
      } catch (exc) {
        if (exc instanceof NoProxyError) throw exc;
        last = exc;
        if (attempt < this.retries - 1 && this.backoff > 0) await sleep(this.backoff * 1000 * (attempt + 1));
      }
    }
    throw new Error(`GET ${RUNSIGNUP_API_HOST}${path} failed after ${this.retries} tries: ${last && last.message}`);
  }

  async get(path, params = null, allowMissing = false) {
    const body = await this.fetchText(path, params, allowMissing);
    if (body === null) return null;
    let d;
    try {
      d = JSON.parse(body);
    } catch {
      throw new Error(`GET ${path}: response was not JSON`);
    }
    if (d && d.error) throw new Error(d.error.error_msg || `RunSignUp API error ${d.error.error_code}`);
    return d;
  }

  /* For scraping a race's own runsignup.com page (see resolveRunSignUpRace):
     the site, not the api host, and HTML rather than JSON. */
  async fetchSitePage(path) {
    let r;
    try {
      r = await this.fetcher(RUNSIGNUP_SITE_HOST, path, null);
    } catch (exc) {
      if (exc instanceof NoProxyError) throw exc;
      throw new ResolveError(`could not read the RunSignUp page: ${exc.message}`);
    }
    if (r.status < 200 || r.status >= 300) throw new ResolveError(`could not read the RunSignUp page (HTTP ${r.status})`);
    return r.body;
  }

  async race(raceId) {
    const d = await this.get(`/rest/race/${raceId}`, { format: 'json' });
    if (!d || !d.race) throw new ResolveError(`no RunSignUp race with id ${raceId}`);
    return parseRace(d.race, raceId);
  }

  /* No anonymous roster - see the file header. */
  async *iterRoster() {}

  async resultsPage(eventId, courseId, from, limit) {
    const raceId = nativeId(eventId), rsuEventId = nativeId(courseId);
    const page = Math.floor(from / limit) + 1;
    const d = await this.get(`/rest/race/${raceId}/results/get-results`, { event_id: rsuEventId, format: 'json', page, results_per_page: limit });
    return toResultsPayload(d);
  }

  async bibResult(eventId, courseId, bib) {
    bib = String(bib).trim();
    const raceId = nativeId(eventId), rsuEventId = nativeId(courseId);
    for (let page = 1; page <= MAX_LOOKUP_PAGES; page++) {
      const d = await this.get(`/rest/race/${raceId}/results/get-results`, { event_id: rsuEventId, format: 'json', page, results_per_page: LOOKUP_PAGE_SIZE });
      const rows = individualResults(d);
      const hit = rows.find((r) => String(r.bib ?? '').trim() === bib);
      if (hit) return toBibPayload(hit);
      if (rows.length < LOOKUP_PAGE_SIZE) return null;
      await this.pause();
    }
    return null;
  }
}

const RACEID_IN_HTML_RE = /raceId=(\d+)/i;
const RESULTS_PATH_RE = /\/Race\/Results\/(\d+)/i;

/* Turns a link or id into RunSignUp race metadata: {info, sourceUrl}. Mirrors
   resolveRace() in athlinks.js. */
export async function resolveRunSignUpRace(spec, client) {
  spec = String(spec || '').trim();
  if (!spec) throw new ResolveError('give a RunSignUp race URL or id');
  const sourceUrl = spec.startsWith('http') ? spec : null;

  for (const prefix of ['runsignup:', 'rsu:']) {
    if (spec.toLowerCase().startsWith(prefix)) { spec = spec.slice(prefix.length).trim(); break; }
  }

  let raceId;
  if (spec.startsWith('http')) {
    let url;
    try {
      url = new URL(spec);
    } catch {
      throw new ResolveError(`'${spec}' is not a valid URL`);
    }
    const host = url.hostname.toLowerCase();
    if (!RUNSIGNUP_LINK_HOSTS.has(host)) {
      throw new ResolveError(`don't know how to read '${host}'. Paste a RunSignUp race link, or its numeric race id.`);
    }
    const q = url.searchParams.get('raceId');
    let m;
    if (q && /^\d+$/.test(q)) {
      raceId = Number(q);
    } else if ((m = RESULTS_PATH_RE.exec(url.pathname))) {
      raceId = Number(m[1]);
    } else {
      // A friendly slug URL (runsignup.com/Race/ST/City/Name) carries no id
      // itself - it's only on the page, in a link like Register?raceId=NNN.
      const html = await client.fetchSitePage(url.pathname + url.search);
      const hm = RACEID_IN_HTML_RE.exec(html || '');
      if (!hm) throw new ResolveError(`could not find a race id on ${spec}`);
      raceId = Number(hm[1]);
    }
  } else if (/^\d+$/.test(spec)) {
    raceId = Number(spec);
  } else {
    throw new ResolveError(`'${spec}' is not a RunSignUp URL or race id`);
  }

  return { info: await client.race(raceId), sourceUrl };
}
