// RunSignUp: id resolution, and adapting its JSON into the shape sync.js/
// index.js already expect from Athlinks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ID_OFFSET, nativeId, nsId, parseClockToMs, parseRace, parseRunSignUpDateTime,
  ResolveError, resolveRunSignUpRace, RunSignUpClient, zonedTimeToEpoch,
} from '../../public/js/core/runsignup.js';

/* Stands in for the network, shaped like RunSignUpClient's own surface so
   resolveRunSignUpRace can be tested without a fetcher. */
class FakeClient {
  constructor({ races = {}, pages = {} } = {}) {
    this.races = races; // raceId -> race()-shaped info
    this.pages = pages; // path -> html
    this.calls = [];
  }
  async race(raceId) {
    this.calls.push(['race', raceId]);
    if (!this.races[raceId]) throw new ResolveError(`no RunSignUp race with id ${raceId}`);
    return this.races[raceId];
  }
  async fetchSitePage(path) {
    this.calls.push(['page', path]);
    if (!(path in this.pages)) throw new ResolveError(`no such page ${path}`);
    return this.pages[path];
  }
}

test('id namespacing round-trips and stays clear of realistic Athlinks ids', () => {
  assert.equal(nativeId(nsId(80027)), 80027);
  assert.ok(nsId(1) > 1_000_000_000, 'namespaced ids should be far outside real Athlinks event ids');
  assert.equal(ID_OFFSET, 9_000_000_000);
});

test('clock strings to milliseconds', () => {
  assert.equal(parseClockToMs('17:20'), 17 * 60000 + 20000);
  assert.equal(parseClockToMs('1:17:20'), 3600000 + 17 * 60000 + 20000);
  assert.equal(parseClockToMs(''), null);
  assert.equal(parseClockToMs(null), null);
  assert.equal(parseClockToMs('garbage'), null);
});

test('zoned wall-clock time to epoch handles DST both ways, and unknown input', () => {
  assert.equal(zonedTimeToEpoch('9/26/2026', '07:30', 'America/New_York'), Date.UTC(2026, 8, 26, 11, 30, 0) / 1000); // EDT, UTC-4
  assert.equal(zonedTimeToEpoch('1/15/2026', '07:30', 'America/New_York'), Date.UTC(2026, 0, 15, 12, 30, 0) / 1000); // EST, UTC-5
  assert.equal(zonedTimeToEpoch('1/1/2026', '00:00', 'UTC'), Date.UTC(2026, 0, 1, 0, 0, 0) / 1000);
  assert.equal(zonedTimeToEpoch('not a date', '07:30', 'UTC'), null);
  assert.equal(parseRunSignUpDateTime('9/26/2026 07:30', 'America/New_York'), Date.UTC(2026, 8, 26, 11, 30, 0) / 1000);
  assert.equal(parseRunSignUpDateTime('', 'UTC'), null);
});

test('parseRace groups events by date and prefers the soonest upcoming edition', () => {
  const info = parseRace({
    name: 'Run for Research 5K', timezone: 'America/New_York',
    events: [
      { event_id: 985339, name: '5K Run/Walk', distance: '5K', start_time: '8/23/2025 08:00' }, // past
      { event_id: 1100976, name: '5K Run/Walk', distance: '5K', start_time: '9/26/2026 08:00' }, // upcoming
      { event_id: 1100977, name: '1K Run/Walk', distance: '1K', start_time: '9/26/2026 07:30' }, // same edition
    ],
  }, 84837);
  assert.equal(info.event_id, nsId(84837));
  assert.equal(info.roster_available, false);
  assert.deepEqual(info.courses.map((c) => c.course_id).sort(), [nsId(1100976), nsId(1100977)].sort());
  assert.ok(info.courses.some((c) => c.name === '5K' && c.meters === 5000));
  assert.equal(info.start_epoch, Date.UTC(2026, 8, 26, 11, 30, 0) / 1000); // the earlier of the two 9/26 events
});

test('parseRace falls back to the most recent past edition once nothing is upcoming', () => {
  const info = parseRace({
    name: 'Old Race', timezone: 'UTC',
    events: [
      { event_id: 1, distance: '5K', start_time: '1/1/2015 08:00' },
      { event_id: 2, distance: '5K', start_time: '1/1/2020 08:00' },
    ],
  }, 1);
  assert.deepEqual(info.courses.map((c) => c.course_id), [nsId(2)]);
});

test('bare id, prefixes, and a raceId query all resolve directly', async () => {
  const race = { event_id: nsId(80027), name: 'Gritty 5K', courses: [] };
  const client = new FakeClient({ races: { 80027: race } });
  for (const spec of ['80027', 'runsignup:80027', 'rsu:80027', 'https://runsignup.com/Race/Register?raceId=80027']) {
    const { info, sourceUrl } = await resolveRunSignUpRace(spec, client);
    assert.equal(info, race, spec);
    assert.equal(sourceUrl, spec.startsWith('http') ? spec : null, spec);
  }
});

test('a Race/Results/<id> URL resolves without a page fetch', async () => {
  const client = new FakeClient({ races: { 84837: { event_id: nsId(84837) } } });
  const { info } = await resolveRunSignUpRace('https://runsignup.com/Race/Results/84837?resultSetId=1', client);
  assert.equal(info.event_id, nsId(84837));
  assert.ok(!client.calls.some((c) => c[0] === 'page'), 'should not have needed to scrape a page');
});

test('a friendly slug URL is resolved by scraping its raceId out of the page', async () => {
  const client = new FakeClient({
    races: { 80027: { event_id: nsId(80027), name: 'Gritty 5K' } },
    pages: { '/Race/PA/Philadelphia/Gritty5K': '<a href="/Race/Register?raceId=80027">Register</a>' },
  });
  const { info, sourceUrl } = await resolveRunSignUpRace('https://runsignup.com/Race/PA/Philadelphia/Gritty5K', client);
  assert.equal(info.name, 'Gritty 5K');
  assert.equal(sourceUrl, 'https://runsignup.com/Race/PA/Philadelphia/Gritty5K');
});

test('a slug page with no discoverable raceId is refused clearly', async () => {
  const client = new FakeClient({ pages: { '/Race/X/Y/Z': '<html>nothing here</html>' } });
  await assert.rejects(resolveRunSignUpRace('https://runsignup.com/Race/X/Y/Z', client), /could not find a race id/);
});

for (const spec of ['', '   ', 'not-a-race', 'https://evil.example.com/Race/1']) {
  test(`junk input refused: ${JSON.stringify(spec)}`, async () => {
    await assert.rejects(resolveRunSignUpRace(spec, new FakeClient()), ResolveError);
  });
}

/* ------------------------------------------------------- the real client */

const RESULTS_PAGE_1 = {
  individual_results_sets: [{
    individual_result_set_name: '5K Overall', public_results: 'T',
    results: [
      { result_id: 1, place: 1, bib: 1613, first_name: 'Tyler', last_name: 'Talik', gender: 'M', city: 'Lilburn', state: 'GA', country_code: 'US', clock_time: '', chip_time: '17:20', age: 23 },
      { result_id: 2, place: 2, bib: 1610, first_name: 'Jeff', last_name: 'Morris', gender: 'M', city: 'Marietta', state: 'GA', country_code: 'US', clock_time: '17:40', chip_time: '17:35', age: 67 },
    ],
  }],
};
const RESULTS_PAGE_EMPTY = { individual_results_sets: [{ individual_result_set_name: '5K Overall', results: [] }] };

function fakeFetcher(routes) {
  return async (host, path, params) => {
    const hit = routes.find((r) => r.host === host && r.path === path);
    if (!hit) return { status: 404, body: '{"error":{"error_code":1,"error_msg":"not found"}}' };
    return { status: 200, body: JSON.stringify(typeof hit.body === 'function' ? hit.body(params) : hit.body) };
  };
}

test('resultsPage adapts RunSignUp rows into the shape resultRow() already understands', async () => {
  const client = new RunSignUpClient({
    fetcher: fakeFetcher([{ host: 'api.runsignup.com', path: '/rest/race/84837/results/get-results', body: RESULTS_PAGE_1 }]),
  });
  const payload = await client.resultsPage(nsId(84837), nsId(985339), 0, 500);
  const [a, b] = payload.intervals[0].results;
  assert.deepEqual(
    [a.bib, a.displayName, a.age, a.gender, a.chipTimeInMillis, a.gunTimeInMillis, a.rankings.overall, a.location.locality, a.location.region],
    [1613, 'Tyler Talik', 23, 'M', 1040000, null, 1, 'Lilburn', 'GA'],
  );
  assert.equal(b.gunTimeInMillis, 17 * 60000 + 40000);
});

test('resultsPage pages by request, not by an upstream total', async () => {
  const seen = [];
  const client = new RunSignUpClient({
    fetcher: fakeFetcher([{
      host: 'api.runsignup.com', path: '/rest/race/1/results/get-results',
      body: (params) => { seen.push(params.page); return params.page === 1 ? RESULTS_PAGE_1 : RESULTS_PAGE_EMPTY; },
    }]),
  });
  const first = await client.resultsPage(nsId(1), nsId(2), 0, 2);
  assert.equal(first.intervals[0].results.length, 2);
  const second = await client.resultsPage(nsId(1), nsId(2), 2, 2);
  assert.equal(second.intervals[0].results.length, 0);
  assert.deepEqual(seen, [1, 2]);
});

test('bibResult finds a runner by bib and shapes a parseInterval()-ready payload', async () => {
  const client = new RunSignUpClient({
    fetcher: fakeFetcher([{ host: 'api.runsignup.com', path: '/rest/race/84837/results/get-results', body: RESULTS_PAGE_1 }]),
  });
  const payload = await client.bibResult(nsId(84837), nsId(985339), '1610');
  assert.equal(payload.bib, '1610');
  assert.equal(payload.displayName, 'Jeff Morris');
  assert.equal(payload.intervals[0].chipTimeInMillis, 17 * 60000 + 35000);
  assert.deepEqual(payload.intervals[0].divisions[0], { name: 'Overall', rank: 2 });
});

test('bibResult gives up once a page comes back short, without inventing a match', async () => {
  const client = new RunSignUpClient({
    fetcher: fakeFetcher([{ host: 'api.runsignup.com', path: '/rest/race/1/results/get-results', body: RESULTS_PAGE_1 }]),
  });
  assert.equal(await client.bibResult(nsId(1), nsId(2), '9999'), null);
});

test('iterRoster is a deliberate no-op: RunSignUp will not give an anonymous roster', async () => {
  const client = new RunSignUpClient({ fetcher: fakeFetcher([]) });
  const seen = [];
  for await (const e of client.iterRoster(nsId(2))) seen.push(e);
  assert.deepEqual(seen, []);
});

test('get() surfaces RunSignUp\'s own error envelope as a normal rejection', async () => {
  const client = new RunSignUpClient({
    fetcher: async () => ({ status: 200, body: '{"error":{"error_code":7,"error_msg":"Permission Denied"}}' }),
  });
  await assert.rejects(client.get('/race/1/participants'), /Permission Denied/);
});

test('race() reports a clear error for an id RunSignUp does not have', async () => {
  const client = new RunSignUpClient({ fetcher: async () => ({ status: 200, body: '{"race":null}' }) });
  await assert.rejects(client.race(999999999), ResolveError);
});
