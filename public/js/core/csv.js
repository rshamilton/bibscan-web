/* CSV in and out: importing a roster from any timing spreadsheet, and exporting
   the runners seen. No network needed for either. */

import { formatMillis, localStamp, splitName } from './format.js';

export function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES = {
  bib: ['bib', 'bib number', 'bib #', 'bib#', 'bib no', 'bibno', 'bibnumber', 'number', 'no', 'race number', 'race no'],
  display_name: ['name', 'full name', 'fullname', 'display name', 'displayname', 'runner', 'athlete', 'participant', 'runner name', 'athlete name'],
  first_name: ['first', 'first name', 'firstname', 'given name', 'fname'],
  last_name: ['last', 'last name', 'lastname', 'surname', 'family name', 'lname'],
  age: ['age'],
  gender: ['gender', 'sex', 'g', 'm/f'],
  city: ['city', 'town', 'hometown', 'locality'],
  region: ['state', 'region', 'province', 'st', 'state/province'],
  country: ['country', 'nation', 'nationality'],
  team: ['team', 'club', 'affiliation'],
  course: ['course', 'race', 'distance', 'event', 'race name'],
  time: ['time', 'chip time', 'chiptime', 'finish time', 'net time', 'nettime', 'result', 'chip'],
  gun_time: ['gun time', 'guntime', 'clock time', 'gun'],
  overall_rank: ['overall', 'place', 'overall place', 'rank', 'overall rank', 'pos', 'position', 'oa place'],
  gender_rank: ['gender place', 'sex place', 'gender rank', 'sex rank'],
  division: ['division', 'age group', 'agegroup', 'category', 'ag', 'div'],
  division_rank: ['division place', 'div place', 'age group place', 'ag place', 'category place', 'division rank'],
};

const normHeader = (h) => String(h).toLowerCase().replace(/[_.:]+/g, ' ').replace(/\s+/g, ' ').trim();

export function mapHeaders(header) {
  const found = {};
  header.forEach((h, i) => {
    const n = normHeader(h);
    for (const [field, names] of Object.entries(ALIASES)) {
      if (found[field] === undefined && names.includes(n)) found[field] = i;
    }
  });
  return found;
}

/* "1:02:03", "24:30", "24:30.4" or plain seconds -> milliseconds. */
export function parseTime(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return Math.round(((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000);
}

const intOrNull = (v) => {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
};
const textOrNull = (v) => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};

/* A roster from a CSV: {courses, rows, columns, skipped}. Throws when there is
   no bib column, because without one there is nothing to match against. */
export function rosterFromCsv(text, { eventId, at = Date.now() / 1000 } = {}) {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('the CSV needs a header row and at least one runner');
  const header = table[0];
  const col = mapHeaders(header);
  if (col.bib === undefined) {
    throw new Error(`no bib column found. Name one of the columns "bib" (headers seen: ${header.map((h) => h.trim()).filter(Boolean).join(', ')})`);
  }
  if (col.display_name === undefined && col.first_name === undefined && col.last_name === undefined) {
    throw new Error('no name column found. Use "name", or "first name" and "last name"');
  }
  const get = (r, f) => (col[f] === undefined ? '' : r[col[f]] ?? '');
  const courseIds = new Map();
  const rows = [];
  let skipped = 0;
  for (const r of table.slice(1)) {
    const bib = String(get(r, 'bib')).trim().replace(/^#/, '');
    if (!bib) { skipped++; continue; }
    let name = textOrNull(get(r, 'display_name'));
    let [first, last] = [textOrNull(get(r, 'first_name')), textOrNull(get(r, 'last_name'))];
    if (!name) name = [first, last].filter(Boolean).join(' ') || null;
    if (!name) { skipped++; continue; }
    if (!first && !last) [first, last] = splitName(name);
    const courseName = textOrNull(get(r, 'course')) || 'All runners';
    if (!courseIds.has(courseName)) courseIds.set(courseName, courseIds.size + 1);
    const chip = parseTime(get(r, 'time'));
    const gun = parseTime(get(r, 'gun_time'));
    const finished = chip !== null || gun !== null;
    rows.push({
      event_id: eventId, course_id: courseIds.get(courseName), bib,
      display_name: name, first_name: first, last_name: last,
      age: intOrNull(get(r, 'age')), gender: textOrNull(get(r, 'gender')),
      city: textOrNull(get(r, 'city')), region: textOrNull(get(r, 'region')),
      country: textOrNull(get(r, 'country')), team: textOrNull(get(r, 'team')), status: null, private: 0,
      finished: finished ? 1 : 0, chip_ms: chip, gun_ms: gun,
      overall_rank: intOrNull(get(r, 'overall_rank')), gender_rank: intOrNull(get(r, 'gender_rank')),
      division: textOrNull(get(r, 'division')), division_rank: intOrNull(get(r, 'division_rank')),
      entrant_at: at, result_at: finished ? at : null,
    });
  }
  if (!rows.length) throw new Error('no runners with both a bib and a name were found');
  const columns = Object.fromEntries(Object.entries(col).map(([f, i]) => [f, header[i].trim()]));
  return {
    courses: [...courseIds].map(([name, id]) => ({ course_id: id, name, meters: null, interval_id: null })),
    rows,
    columns,
    skipped,
  };
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/* Everyone seen, one row per bib, in the same columns bibscan exports. */
export function historyCsv(sightings, runnersByBib) {
  const rows = [['bib', 'name', 'course', 'finished', 'time', 'overall_rank', 'hometown', 'first_seen', 'last_seen', 'hits', 'confidence']];
  for (const s of sightings) {
    const r = (runnersByBib.get(s.bib) || [])[0] || null;
    rows.push([
      s.bib, r ? r.display_name : '', r ? r.course : '', r ? (r.finished ? 'yes' : 'no') : '',
      r && r.finished ? formatMillis(r.chip_ms || r.gun_ms) : '', r ? r.overall_rank ?? '' : '',
      r ? r.hometown : '', localStamp(s.first_seen), localStamp(s.last_seen), s.hits,
      (Math.round((s.confidence || 0) * 1000) / 1000).toString(),
    ]);
  }
  return toCsv(rows);
}
