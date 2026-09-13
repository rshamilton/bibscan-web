// CSV import/export, settings validation, and the demo roster.
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyCsv, mapHeaders, parseCsv, parseTime, rosterFromCsv, toCsv } from '../../public/js/core/csv.js';
import { BY_KEY, DEFAULTS, EDITABLE, build, coerce, describe, validate } from '../../public/js/core/settings.js';
import { DEMO_EVENT_ID, demoRace, demoRunners } from '../../public/js/core/demo.js';

test('CSV parsing handles quotes, embedded commas and newlines, CRLF and a BOM', () => {
  const rows = parseCsv('﻿bib,name\r\n1,"Doe, Jane"\r\n2,"say ""hi""\nthere"\n\n');
  assert.deepEqual(rows, [['bib', 'name'], ['1', 'Doe, Jane'], ['2', 'say "hi"\nthere']]);
});

test('CSV parsing detects semicolons and tabs', () => {
  assert.deepEqual(parseCsv('bib;name\n7;Al'), [['bib', 'name'], ['7', 'Al']]);
  assert.deepEqual(parseCsv('bib\tname\n7\tAl'), [['bib', 'name'], ['7', 'Al']]);
});

test('header names are matched loosely', () => {
  const col = mapHeaders(['Bib #', 'First Name', 'LAST_NAME', 'Sex', 'State', 'Chip Time', 'Race']);
  assert.deepEqual(col, { bib: 0, first_name: 1, last_name: 2, gender: 3, region: 4, time: 5, course: 6 });
});

test('finish times', () => {
  assert.equal(parseTime('24:30'), 1470000);
  assert.equal(parseTime('1:02:03'), 3723000);
  assert.equal(parseTime('24:30.4'), 1470400);
  assert.equal(parseTime('95'), 95000);
  assert.equal(parseTime('DNF'), null);
  assert.equal(parseTime(''), null);
});

test('a roster from a timing spreadsheet', () => {
  const csv = [
    'Bib,First Name,Last Name,Age,Gender,City,State,Race,Chip Time,Place',
    '101,Avery,Stone,34,F,Millbrook,CT,5K,22:10,3',
    '102,Jordan,Vale,41,M,Riverton,NY,10K,,',
    ',No,Bib,1,M,,,5K,,',
    '#103,Quinn,Rook,,F,,,5K,25:00,9',
  ].join('\n');
  const r = rosterFromCsv(csv, { eventId: -5, at: 10 });
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.courses.map((c) => [c.course_id, c.name]), [[1, '5K'], [2, '10K']]);
  const [a, b, c] = r.rows;
  assert.deepEqual([a.bib, a.display_name, a.age, a.finished, a.chip_ms, a.overall_rank, a.course_id], ['101', 'Avery Stone', 34, 1, 1330000, 3, 1]);
  assert.deepEqual([b.finished, b.chip_ms, b.course_id, b.region], [0, null, 2, 'NY']);
  assert.equal(c.bib, '103');
  assert.equal(a.event_id, -5);
});

test('a single name column works too, and no course column means one course', () => {
  const r = rosterFromCsv('number,runner\n5,Sam Lee\n6,Kim', { eventId: -1 });
  assert.deepEqual(r.rows.map((x) => [x.bib, x.first_name, x.last_name, x.course_id]), [['5', 'Sam', 'Lee', 1], ['6', 'Kim', '', 1]]);
  assert.deepEqual(r.courses.map((c) => c.name), ['All runners']);
});

test('a roster CSV without a bib or name column is refused with a useful message', () => {
  assert.throws(() => rosterFromCsv('name,age\nA,1'), /no bib column found.*name, age/);
  assert.throws(() => rosterFromCsv('bib,age\n1,1'), /no name column/);
  assert.throws(() => rosterFromCsv('bib,name'), /at least one runner/);
});

test('CSV output quotes only what needs quoting', () => {
  assert.equal(toCsv([['a', 'b,c', 'say "x"', null, 3]]), 'a,"b,c","say ""x""",,3\r\n');
});

test('history export', () => {
  const runners = new Map([['3477', [{ display_name: 'Ryan Hamilton', course: '5K', finished: true, chip_ms: 1469600, overall_rank: 540, hometown: 'East Granby, CT' }]]]);
  const out = historyCsv([
    { bib: '3477', first_seen: 0, last_seen: 0, hits: 2, confidence: 0.98765 },
    { bib: '99', first_seen: 0, last_seen: 0, hits: 1, confidence: 0.7 },
  ], runners);
  const lines = out.trim().split('\r\n');
  assert.equal(lines[0], 'bib,name,course,finished,time,overall_rank,hometown,first_seen,last_seen,hits,confidence');
  assert.equal(lines[1], '3477,Ryan Hamilton,5K,yes,24:30,540,"East Granby, CT",,,2,0.988');
  assert.equal(lines[2], '99,,,,,,,,,1,0.7');
});

test('settings: every editable key has a default, and the list is complete', () => {
  for (const s of EDITABLE) assert.ok(s.name in DEFAULTS[s.section], `${s.section}.${s.name}`);
  assert.equal(BY_KEY.size, EDITABLE.length);
  assert.equal(describe(build()).length, EDITABLE.length);
});

test('settings: values are coerced and bounded', () => {
  const s = (k) => BY_KEY.get(k);
  assert.equal(coerce(s('tracker.fuzzy_match'), 'off'), false);
  assert.equal(coerce(s('tracker.fuzzy_match'), 'yes'), true);
  assert.equal(coerce(s('tracker.min_votes'), '4'), 4);
  assert.throws(() => coerce(s('tracker.min_votes'), '3.5'), /whole number/);
  assert.throws(() => coerce(s('tracker.min_votes'), 99), /at most 15/);
  assert.throws(() => coerce(s('tracker.window_sec'), ''), /not a number/);
  assert.equal(coerce(s('tracker.window_sec'), '2.5'), 2.5);
  assert.throws(() => coerce(s('capture.roi'), '1,2'), /bad roi/);
  assert.equal(coerce(s('capture.roi'), ' 0.1,0.2,0.8,0.7 '), '0.1,0.2,0.8,0.7');
  assert.throws(() => coerce(s('ocr.charset'), 'latin'), /ascii, digits, all/);
});

test('settings: saved junk is ignored, a bad batch is refused', () => {
  const cfg = build({ 'tracker.min_votes': 5, 'tracker.window_sec': 'nope', 'no.such': 1 });
  assert.equal(cfg.tracker.min_votes, 5);
  assert.equal(cfg.tracker.window_sec, DEFAULTS.tracker.window_sec);
  assert.throws(() => validate({ 'no.such': 1 }), /unknown setting/);
  assert.deepEqual(validate({ 'ocr.threads': '2', 'capture.width': 1280 }), { cleaned: { 'ocr.threads': 2, 'capture.width': 1280 }, applies: ['engine', 'camera'] });
});

test('demo roster is deterministic, unique and consistent', () => {
  const a = demoRunners(1000), b = demoRunners(1000);
  assert.deepEqual(a, b);
  const keys = new Set(a.map((r) => `${r.course_id}/${r.bib}`));
  assert.equal(keys.size, a.length);
  assert.equal(new Set(a.map((r) => r.bib)).size, a.length);
  assert.ok(a.every((r) => r.event_id === DEMO_EVENT_ID && r.display_name && /^\d{4}$/.test(r.bib)));
  const finished5k = a.filter((r) => r.course_id === 1 && r.finished).sort((x, y) => x.overall_rank - y.overall_rank);
  assert.ok(finished5k.length > 100);
  for (let i = 1; i < finished5k.length; i++) assert.ok(finished5k[i].chip_ms >= finished5k[i - 1].chip_ms);
  assert.ok(a.filter((r) => !r.finished).every((r) => r.chip_ms === null && r.overall_rank === null));
  assert.deepEqual(demoRace(0).courses.map((c) => c.course_id).sort(), [1, 2]);
});
