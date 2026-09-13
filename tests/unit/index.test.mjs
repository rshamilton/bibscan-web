// The local index: races, the two-phase runner rows, sightings, and syncing into it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, RaceIndex, entrantRow, resultRow } from '../../public/js/core/index.js';
import { LiveUpdater, Syncer, refreshBib, syncEntrants, syncResults } from '../../public/js/core/sync.js';
import { raceState } from '../../public/js/core/format.js';

const INFO = {
  event_id: 1146036, name: 'Test Race', start_epoch: 1788783000, end_epoch: 1788789600, timezone: 'America/New_York',
  courses: [{ course_id: 2706645, name: '5K', meters: 5000, interval_id: 660710 }],
};
const ENTRANT = { bib: '3477', displayName: 'Ryan Hamilton', age: 15, gender: 'M', city: 'East Granby', region: 'CT', country: 'US', status: 'CONF' };
const RESULT = {
  bib: '3477', displayName: 'Ryan Hamilton', age: 15, gender: 'M', chipTimeInMillis: 1469600, gunTimeInMillis: 1526070,
  rankings: { overall: 540, gender: 428, primary: 152 }, location: { locality: 'East Granby', region: 'CT', country: 'US' }, status: 'CONF',
};

async function fresh() {
  const index = new RaceIndex(new MemoryBackend());
  await index.addRace(INFO);
  return index;
}

test('an added race becomes active', async () => {
  const index = await fresh();
  const race = await index.activeRace();
  assert.equal(race.event_id, 1146036);
  assert.equal(race.active, true);
  assert.deepEqual((await index.courses(1146036)).map((c) => c.name), ['5K']);
});

test('race state from the clock', () => {
  const now = Date.now() / 1000;
  assert.equal(raceState({ start_epoch: now + 3600, end_epoch: now + 3700 }), 'upcoming');
  assert.equal(raceState({ start_epoch: now - 10, end_epoch: now + 600 }), 'live');
  assert.equal(raceState({ start_epoch: 1, end_epoch: 2 }), 'finished');
  assert.equal(raceState({ start_epoch: null, end_epoch: null }), 'unknown');
});

test('an entrant gives a name with no result', async () => {
  const index = await fresh();
  await index.upsertEntrants(1146036, [entrantRow(1146036, 2706645, ENTRANT)]);
  const [r] = await index.lookup(1146036, '3477');
  assert.equal(r.display_name, 'Ryan Hamilton');
  assert.equal(r.course, '5K');
  assert.equal(r.finished, false);
  assert.equal(r.status_line, 'out on course');
  assert.equal(r.hometown, 'East Granby, CT');
});

test('a result fills in over the entrant, and a later roster pull keeps it', async () => {
  const index = await fresh();
  await index.upsertEntrants(1146036, [entrantRow(1146036, 2706645, ENTRANT)]);
  await index.upsertResults(1146036, [resultRow(1146036, 2706645, RESULT)]);
  let [r] = await index.lookup(1146036, '3477');
  assert.deepEqual([r.finished, r.finish_time, r.overall_rank, r.division_rank], [true, '24:30', 540, 152]);
  await index.upsertEntrants(1146036, [entrantRow(1146036, 2706645, { ...ENTRANT, displayName: null })]);
  [r] = await index.lookup(1146036, '3477');
  assert.equal(r.display_name, 'Ryan Hamilton');
  assert.equal(r.finish_time, '24:30');
});

test('entrants without a bib are skipped', () => {
  assert.equal(entrantRow(1, 2, { bib: 'None', displayName: 'X' }), null);
  assert.equal(entrantRow(1, 2, { bib: '', displayName: 'X' }), null);
});

test('counts and the bib set', async () => {
  const index = await fresh();
  await index.upsertEntrants(1146036, [entrantRow(1146036, 2706645, ENTRANT), entrantRow(1146036, 2706645, { ...ENTRANT, bib: '12', displayName: 'Other' })]);
  await index.upsertResults(1146036, [resultRow(1146036, 2706645, RESULT)]);
  assert.deepEqual(await index.counts(1146036), { total: 2, finished: 1, entrants: 2 });
  assert.deepEqual([...(await index.bibs(1146036))].sort(), ['12', '3477']);
});

test('sightings count hits and keep the best confidence', async () => {
  const index = await fresh();
  assert.equal(await index.recordSighting(1146036, '3477', 0.8, 3, true, 'camera', 100), 1);
  assert.equal(await index.recordSighting(1146036, '3477', 0.7, 1, true, 'camera', 110), 2);
  await index.recordSighting(1146036, '12', 0.9, 3, false, 'camera', 105);
  const rows = await index.sightings(1146036);
  assert.deepEqual(rows.map((s) => s.bib), ['3477', '12']);
  assert.deepEqual([rows[0].hits, rows[0].confidence, rows[0].first_seen, rows[0].last_seen], [2, 0.8, 100, 110]);
  assert.equal(await index.clearSightings(1146036), 2);
  assert.deepEqual(await index.sightings(1146036), []);
});

test('removing a race removes its runners and sightings', async () => {
  const index = await fresh();
  await index.addRace({ ...INFO, event_id: 5, name: 'Other', start_epoch: 1 }, { activate: false });
  await index.upsertEntrants(1146036, [entrantRow(1146036, 2706645, ENTRANT)]);
  await index.recordSighting(1146036, '3477', 0.9, 3, true);
  assert.equal(await index.removeRace(1146036), true);
  assert.deepEqual(await index.lookup(1146036, '3477'), []);
  assert.deepEqual(await index.sightings(1146036), []);
  assert.equal(await index.activeRaceId(), null);
  assert.deepEqual((await index.races()).map((r) => r.event_id), [5]);
});

test('re-adding a race keeps its sync state and course totals', async () => {
  const index = await fresh();
  await index.updateRace(1146036, { entrants_synced_at: 42 });
  await index.updateCourse(1146036, 2706645, { entrant_total: 7 });
  await index.addRace({ ...INFO, name: 'Renamed' });
  const race = await index.race(1146036);
  assert.equal(race.name, 'Renamed');
  assert.equal(race.entrants_synced_at, 42);
  assert.equal(race.courses[0].entrant_total, 7);
});

test('races are listed newest first, undated last', async () => {
  const index = new RaceIndex(new MemoryBackend());
  await index.addRace({ ...INFO, event_id: 1, start_epoch: 100 });
  await index.addRace({ ...INFO, event_id: 2, start_epoch: null });
  await index.addRace({ ...INFO, event_id: 3, start_epoch: 300 });
  assert.deepEqual((await index.races()).map((r) => [r.event_id, r.active]), [[3, true], [1, false], [2, false]]);
});

test('switching to a race that is not added is refused', async () => {
  const index = await fresh();
  await assert.rejects(index.setActive(999), /not added/);
});

test('backup export and import round-trip', async () => {
  const index = await fresh();
  await index.upsertEntrants(1146036, [entrantRow(1146036, 2706645, ENTRANT)]);
  await index.setSettings({ 'tracker.min_votes': 4 });
  const data = JSON.parse(JSON.stringify(await index.exportAll()));
  const other = new RaceIndex(new MemoryBackend());
  await other.importAll(data);
  assert.equal((await other.lookup(1146036, '3477'))[0].display_name, 'Ryan Hamilton');
  assert.deepEqual(await other.getSettings(), { 'tracker.min_votes': 4 });
  await assert.rejects(other.importAll({ format: 'something else' }), /not a bibscan-web backup/);
});

/* ------------------------------------------------------------------ syncing */

function fakeClient({ roster = [], results = [], bib = null, fail = null } = {}) {
  return {
    async *iterRoster() {
      if (fail) throw new Error(fail);
      yield* roster;
    },
    async resultsPage(eventId, courseId, from, limit) {
      const page = results.slice(from, from + limit);
      return { intervals: [{ results: page }], division: { totalAthletes: results.length } };
    },
    async bibResult(eventId, courseId, b) {
      return bib && String(bib.bib) === String(b) ? bib : null;
    },
    pause: async () => {},
  };
}

test('syncing entrants then results gives named runners with times', async () => {
  const index = await fresh();
  const roster = [ENTRANT, { ...ENTRANT, bib: '12', displayName: 'Pat Doe' }, { bib: 'none', displayName: 'Nobody' }];
  const progress = [];
  const stats = await syncEntrants(index, fakeClient({ roster }), 1146036, (...a) => progress.push(a));
  assert.equal(stats.total, 2);
  assert.deepEqual(progress.at(-1), ['5K', 2, 2]);
  const results = Array.from({ length: 3 }, (_, i) => ({ ...RESULT, bib: String(100 + i), displayName: `Finisher ${i}` })).concat([RESULT]);
  const rs = await syncResults(index, fakeClient({ results }), 1146036, null, 2);
  assert.equal(rs.total, 4);
  const race = await index.race(1146036);
  assert.ok(race.entrants_synced_at && race.results_synced_at);
  assert.equal(race.courses[0].entrant_total, 2);
  assert.equal(race.courses[0].result_total, 4);
  assert.deepEqual(await index.counts(1146036), { total: 5, finished: 4, entrants: 2 });
  assert.equal((await index.lookup(1146036, '12'))[0].status_line, 'out on course');
});

test('asking the timer about one bib folds the answer in', async () => {
  const index = await fresh();
  await index.upsertEntrants(1146036, [entrantRow(1146036, 2706645, ENTRANT)]);
  const client = fakeClient({ bib: { bib: '3477', displayName: 'Ryan Hamilton', intervals: [{ full: true, chipTimeInMillis: 1469600, divisions: [{ name: 'Overall', rank: 540 }] }] } });
  const [r] = await refreshBib(index, client, 1146036, '3477');
  assert.deepEqual([r.finished, r.finish_time, r.overall_rank, r.city], [true, '24:30', 540, 'East Granby']);
  assert.deepEqual(await refreshBib(index, client, 1146036, '9999'), []);
});

test('one sync at a time, and failures are reported rather than thrown', async () => {
  const index = await fresh();
  const syncer = new Syncer(index, fakeClient({ fail: 'HTTP 403' }));
  assert.equal(syncer.start({ eventId: 1146036 }), true);
  assert.equal(syncer.start({ eventId: 1146036 }), false);
  await syncer.promise;
  assert.equal(syncer.state.running, false);
  assert.equal(syncer.state.stage, 'failed');
  assert.match(syncer.state.error, /403/);
  assert.equal(syncer.state.race_name, 'Test Race');
});

test('the live updater pulls entrants once, then results on each tick', async () => {
  const index = await fresh();
  const calls = [];
  const syncer = { start: (o) => { calls.push(o); return true; } };
  const live = new LiveUpdater(syncer, { resultsEverySec: 0.02, entrantsEverySec: 3600 });
  live.start(1146036);
  await new Promise((r) => setTimeout(r, 70));
  live.stop();
  assert.ok(calls.length >= 2, `ticks: ${calls.length}`);
  assert.equal(calls[0].entrants, true);
  assert.ok(calls.slice(1).every((c) => c.entrants === false && c.results === true));
  assert.equal(live.running, false);
});
