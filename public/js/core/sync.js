/* Pulling rosters and results into the index, in the background. */

import { parseInterval } from './athlinks.js';
import { entrantRow, resultRow } from './index.js';
import { splitName } from './format.js';

const nowSec = () => Date.now() / 1000;

/* The registered-entrant roster: bib -> name, before the gun. */
export async function syncEntrants(index, client, eventId, progress = null) {
  const stats = { courses: [], total: 0 };
  for (const c of await index.courses(eventId)) {
    const rows = [];
    for await (const e of client.iterRoster(c.course_id)) {
      const row = entrantRow(eventId, c.course_id, e, nowSec());
      if (!row) continue; // entered but no bib assigned yet
      rows.push(row);
      if (progress && rows.length % 250 === 0) progress(c.name, rows.length, c.entrant_total || 0);
    }
    await index.upsertEntrants(eventId, rows);
    await index.updateCourse(eventId, c.course_id, { entrant_total: rows.length });
    stats.courses.push({ name: c.name, rows: rows.length });
    stats.total += rows.length;
    if (progress) progress(c.name, rows.length, rows.length);
  }
  await index.updateRace(eventId, { entrants_synced_at: nowSec() });
  index.invalidate(eventId);
  return stats;
}

/* Finisher results. Safe to re-run mid-race; it only adds. */
export async function syncResults(index, client, eventId, progress = null, pageSize = 500) {
  const stats = { courses: [], total: 0 };
  for (const c of await index.courses(eventId)) {
    const rows = [];
    let from = 0;
    for (;;) {
      const payload = await client.resultsPage(eventId, c.course_id, from, pageSize);
      const intervals = (payload && payload.intervals) || [];
      const results = (intervals[0] && intervals[0].results) || [];
      if (!results.length) break;
      for (const r of results) rows.push(resultRow(eventId, c.course_id, r, nowSec()));
      from += results.length;
      if (progress) progress(c.name, from, (payload.division && payload.division.totalAthletes) || 0);
      if (results.length < pageSize) break;
      await client.pause();
    }
    await index.upsertResults(eventId, rows);
    await index.updateCourse(eventId, c.course_id, { result_total: rows.length });
    stats.courses.push({ name: c.name, rows: rows.length });
    stats.total += rows.length;
  }
  await index.updateRace(eventId, { results_synced_at: nowSec() });
  index.invalidate(eventId);
  return stats;
}

/* Ask the timer about one bib right now. Works for a runner who has started
   but not finished, and is one request per course rather than a re-sync. */
export async function refreshBib(index, client, eventId, bib) {
  bib = String(bib).trim();
  for (const c of await index.courses(eventId)) {
    const payload = await client.bibResult(eventId, c.course_id, bib);
    if (!payload || String(payload.bib ?? '').trim() !== bib) continue;
    const iv = parseInterval(payload);
    const loc = payload.location || {};
    const [first, last] = splitName(payload.displayName);
    await index.applyBibResult(eventId, {
      event_id: eventId, course_id: c.course_id, bib,
      display_name: payload.displayName ?? null, first_name: first, last_name: last,
      age: payload.age ?? null, gender: payload.gender ?? null, city: loc.locality ?? null,
      region: loc.region ?? null, country: loc.country ?? null, status: payload.status ?? null,
      finished: iv.finished ? 1 : 0, chip_ms: iv.chip_ms, gun_ms: iv.gun_ms, overall_rank: iv.overall_rank,
      gender_rank: iv.gender_rank, division: iv.division, division_rank: iv.division_rank, result_at: nowSec(),
    });
    break;
  }
  index.invalidate(eventId);
  return index.lookup(eventId, bib);
}

/* One background sync at a time, with a status the UI can render. `clients`
   maps a race's `kind` (e.g. 'athlinks', 'runsignup') to the client that
   knows how to talk to that timing service. */
export class Syncer extends EventTarget {
  constructor(index, clients) {
    super();
    this.index = index;
    this.clients = clients;
    this.state = { running: false, stage: '', detail: '', error: null, event_id: null, race_name: '', finished_at: 0 };
    this.promise = null;
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.dispatchEvent(new Event('change'));
  }

  /* Returns false when a sync is already running. The race is always explicit. */
  start({ eventId, entrants = true, results = true, quiet = false }) {
    if (this.state.running) return false;
    // Claimed synchronously, so a second click cannot start a second sync.
    this.set({ running: true, stage: 'starting', detail: '', error: null, event_id: eventId, race_name: '', finished_at: 0, quiet });
    this.promise = this.run(eventId, entrants, results);
    return true;
  }

  async run(eventId, entrants, results) {
    const progress = (stage) => (label, done, total) => this.set({ stage, detail: `${label}: ${done}/${total || '?'}` });
    try {
      const race = await this.index.race(eventId);
      this.set({ race_name: race ? race.name : '' });
      const client = race && this.clients[race.kind];
      if (!client) throw new Error(race ? `no timing-service client for '${race.kind}' races` : 'race not found');
      if (entrants) await syncEntrants(this.index, client, eventId, progress('entrants'));
      if (results) await syncResults(this.index, client, eventId, progress('results'));
      this.set({ stage: 'done', detail: '' });
    } catch (exc) {
      this.set({ stage: 'failed', error: exc.message || String(exc) });
    } finally {
      this.set({ running: false, finished_at: nowSec() });
      this.dispatchEvent(new CustomEvent('finished', { detail: { eventId } }));
    }
  }
}

/* Keeps results fresh while a race runs: results every N seconds, entrants less often. */
export class LiveUpdater extends EventTarget {
  constructor(syncer, { resultsEverySec = 60, entrantsEverySec = 900 } = {}) {
    super();
    this.syncer = syncer;
    this.resultsEverySec = resultsEverySec;
    this.entrantsEverySec = entrantsEverySec;
    this.eventId = null;
    this.timer = null;
    this.lastEntrants = 0;
    this.lastRun = 0;
  }

  get running() {
    return this.timer !== null;
  }

  start(eventId) {
    this.stop();
    this.eventId = eventId;
    this.lastEntrants = 0;
    this.tick();
    this.dispatchEvent(new Event('change'));
  }

  stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dispatchEvent(new Event('change'));
  }

  tick() {
    const entrants = Date.now() / 1000 - this.lastEntrants >= this.entrantsEverySec;
    if (this.syncer.start({ eventId: this.eventId, entrants, results: true, quiet: true })) {
      this.lastRun = Date.now() / 1000;
      if (entrants) this.lastEntrants = this.lastRun;
    }
    this.timer = setTimeout(() => this.tick(), this.resultsEverySec * 1000);
  }
}
