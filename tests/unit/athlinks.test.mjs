// Turning whatever link you have into an Athlinks event, and the API client.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AmbiguousId, AmbiguousRace, NoProxyError, ReigniteClient, ResolveError,
  athlinksIdFromChronotrackPage, parseEvent, parseInterval, resolveRace,
} from '../../public/js/core/athlinks.js';

/* Stands in for the network. `events` and `masters` are the ids that exist. */
class FakeClient {
  constructor({ events = [1146036], masters = [19924], current = 1146036 } = {}) {
    this.events = new Set(events);
    this.masters = new Set(masters);
    this.current = current;
    this.calls = [];
  }
  async get(path) {
    this.calls.push(path);
    const n = Number(path.split('/')[2]);
    if (path.startsWith('/event/') && path.endsWith('/metadata')) return this.events.has(n) ? { id: n, name: `event ${n}` } : null;
    if (path.startsWith('/master/')) {
      if (!this.masters.has(n)) return null;
      return { name: `series ${n}`, currentEvent: { id: this.current }, events: [{ id: this.current, name: 'edition', start: { epoch: 0 } }] };
    }
    throw new Error(path);
  }
  async event(id) {
    return { event_id: id, name: `event ${id}`, courses: [] };
  }
}

test('bare event id', async () => {
  const { info, sourceUrl } = await resolveRace('1146036', new FakeClient());
  assert.equal(info.event_id, 1146036);
  assert.equal(sourceUrl, null);
});

test('Athlinks results URL', async () => {
  const { info, sourceUrl } = await resolveRace('https://www.athlinks.com/event/19924/results/Event/1146036/Results', new FakeClient());
  assert.equal(info.event_id, 1146036);
  assert.match(sourceUrl, /^https:\/\//);
});

test('series id resolves to the current edition', async () => {
  const { info } = await resolveRace('series:19924', new FakeClient({ events: [], masters: [19924] }));
  assert.equal(info.event_id, 1146036);
});

test('an id that is both an event and a series is refused', async () => {
  await assert.rejects(resolveRace('19924', new FakeClient({ events: [19924], masters: [19924] })), (e) => {
    assert.ok(e instanceof AmbiguousId);
    assert.match(e.message, /event:19924/);
    assert.match(e.message, /series:19924/);
    return true;
  });
});

test('an explicit prefix breaks the tie', async () => {
  const c = new FakeClient({ events: [19924], masters: [19924] });
  assert.equal((await resolveRace('event:19924', c)).info.event_id, 19924);
  assert.equal((await resolveRace('series:19924', c)).info.event_id, 1146036);
});

test('a series with no current edition lists its editions, newest first', async () => {
  class NoCurrent extends FakeClient {
    async get(path) {
      const d = await super.get(path);
      if (d && path.startsWith('/master/')) {
        d.currentEvent = null;
        d.events = [
          { id: 1, name: '2025', start: { epoch: 1757247000000 } },
          { id: 2, name: '2026', start: { epoch: 1788783000000 } },
        ];
      }
      return d;
    }
  }
  await assert.rejects(resolveRace('19924', new NoCurrent({ events: [], masters: [19924] })), (e) => {
    assert.ok(e instanceof AmbiguousRace);
    assert.equal(e.editions.length, 2);
    assert.equal(e.editions[0].event_id, 2);
    return true;
  });
});

test('unknown id', async () => {
  await assert.rejects(resolveRace('999999999', new FakeClient({ events: [], masters: [] })), /no Athlinks event/);
});

test('an event probe is made for a bare id', async () => {
  const c = new FakeClient({ events: [1146036], masters: [] });
  await resolveRace('1146036', c);
  assert.ok(c.calls.some((p) => p.startsWith('/event/')));
});

for (const spec of ['https://evil.example.com/event/1', 'https://google.com/x']) {
  test(`foreign host refused: ${spec}`, async () => {
    await assert.rejects(resolveRace(spec, new FakeClient()), (e) => e instanceof ResolveError && /don't know how to read/.test(e.message));
  });
}

for (const spec of ['', '   ', 'not-a-race', 'https://www.athlinks.com/athletes/5']) {
  test(`junk input refused: ${JSON.stringify(spec)}`, async () => {
    await assert.rejects(resolveRace(spec, new FakeClient()), ResolveError);
  });
}

test('ChronoTrack URL goes through the page lookup', async () => {
  const { info, sourceUrl } = await resolveRace('https://sites.chronotrack.com/event/93922/results', new FakeClient(), {
    ctLookup: async (client, id) => { assert.equal(id, 93922); return 1146036; },
  });
  assert.equal(info.event_id, 1146036);
  assert.match(sourceUrl, /chronotrack/);
});

test('reading the Athlinks id out of a ChronoTrack page', () => {
  const data = { props: { pageProps: { masterEventMetadata: { events: [{ eventId: 111, athlinksEventId: 5 }, { eventId: 93922, athlinksEventId: 1146036 }] } } } };
  const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
  assert.equal(athlinksIdFromChronotrackPage(html, 93922), 1146036);
  assert.throws(() => athlinksIdFromChronotrackPage('<html></html>', 1), /no event data/);
  assert.throws(() => athlinksIdFromChronotrackPage(html, 222), /no Athlinks results yet/);
});

test('event metadata parsing', () => {
  const info = parseEvent({
    id: 1146036, name: 'Road Race', isRosterAvailable: true,
    start: { epoch: 1788783000000, timeZone: 'America/New_York' }, end: { epoch: 1788789600000 },
    races: [{ id: 2706645, name: ' 5K ', distance: { meters: 5000 }, fullCourseIntervalId: 660710 }, { id: 7, name: '', distance: { meters: 21097.5 } }],
  }, 1146036);
  assert.equal(info.start_epoch, 1788783000);
  assert.equal(info.timezone, 'America/New_York');
  assert.deepEqual(info.courses.map((c) => c.name), ['5K', '21.098K']);
  assert.equal(info.courses[0].interval_id, 660710);
  assert.equal(info.roster_available, true);
});

test('a runner out on course has no result yet', () => {
  assert.deepEqual(parseInterval({ intervals: [] }).finished, false);
  const r = parseInterval({
    intervals: [{ full: true, chipTimeInMillis: 1469600, gunTimeInMillis: 1526070, name: 'Full Course',
      divisions: [{ name: 'Overall', rank: 540 }, { name: 'Male', rank: 428 }, { name: 'M 15-19', rank: 12 }] }],
  });
  assert.deepEqual([r.finished, r.chip_ms, r.overall_rank, r.gender_rank, r.division, r.division_rank], [true, 1469600, 540, 428, 'M 15-19', 12]);
});

test('client retries failures, then succeeds', async () => {
  let n = 0;
  const client = new ReigniteClient({ backoff: 0, fetcher: async () => (++n < 3 ? { status: 503, body: '' } : { status: 200, body: '{"ok":1}' }) });
  assert.deepEqual(await client.get('/event/1/metadata'), { ok: 1 });
  assert.equal(n, 3);
});

test('client gives up after its retries with the status in the message', async () => {
  const client = new ReigniteClient({ backoff: 0, fetcher: async () => ({ status: 403, body: '{"error":"blocked"}' }) });
  await assert.rejects(client.get('/event/1/metadata'), /HTTP 403 - blocked/);
});

test('allowMissing turns listed statuses into null without retrying', async () => {
  let n = 0;
  const client = new ReigniteClient({ backoff: 0, fetcher: async () => { n++; return { status: 500, body: '' }; } });
  assert.equal(await client.get('/master/1/metadata', null, [404, 500]), null);
  assert.equal(n, 1);
});

test('no relay available is reported at once, not retried', async () => {
  let n = 0;
  const client = new ReigniteClient({ fetcher: async () => { n++; throw new NoProxyError(); } });
  await assert.rejects(client.get('/event/1/metadata'), NoProxyError);
  assert.equal(n, 1);
});

test('client refuses odd paths before sending anything', async () => {
  const client = new ReigniteClient({ fetcher: async () => assert.fail('should not fetch') });
  await assert.rejects(client.get('/event/../../etc'), /odd API path/);
});

test('roster paging walks every page', async () => {
  const pages = { 1: { total: 5, results: [{ bib: 1 }, { bib: 2 }] }, 2: { total: 5, results: [{ bib: 3 }, { bib: 4 }] }, 3: { total: 5, results: [{ bib: 5 }] } };
  const client = new ReigniteClient({ delay: 0, fetcher: async (host, path, params) => ({ status: 200, body: JSON.stringify(pages[params.page]) }) });
  const bibs = [];
  for await (const e of client.iterRoster(9, 2)) bibs.push(e.bib);
  assert.deepEqual(bibs, [1, 2, 3, 4, 5]);
});
