/* A built-in demo race with made-up runners, so the whole app - scanning,
   announcing, history, self-test - works with no network and no roster. */

export const DEMO_EVENT_ID = -1;

const FIRST = [
  'Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Quinn', 'Rowan', 'Harper', 'Emerson', 'Finley',
  'Sage', 'Parker', 'Reese', 'Dakota', 'Hayden', 'Skyler', 'Elliot', 'Jamie', 'Blake', 'Cameron',
  'Maya', 'Nora', 'Leah', 'Iris', 'Clara', 'Hazel', 'Ruby', 'Stella', 'Violet', 'Lucy',
  'Owen', 'Miles', 'Felix', 'Theo', 'Jonah', 'Silas', 'Declan', 'Emmett', 'Graham', 'Wesley',
];
const LAST = [
  'Alder', 'Brook', 'Calder', 'Dunmore', 'Ellery', 'Fairbanks', 'Garrow', 'Hollis', 'Ingram', 'Jarvis',
  'Kettle', 'Lindqvist', 'Marlowe', 'Northcott', 'Oakes', 'Pendry', 'Quarry', 'Rook', 'Stroud', 'Thorne',
  'Upton', 'Vale', 'Winslow', 'Yardley', 'Ashford', 'Birch', 'Colby', 'Drake', 'Everly', 'Frost',
  'Gale', 'Hartley', 'Ives', 'Keats', 'Lowell', 'Merritt', 'Nash', 'Orton', 'Prescott', 'Radley',
];
const TOWNS = [
  ['Millbrook', 'CT'], ['Cedar Falls', 'MA'], ['Riverton', 'NY'], ['Oak Hollow', 'RI'], ['Pinecrest', 'VT'],
  ['Harbor View', 'ME'], ['Stonebridge', 'NH'], ['Maple Grove', 'CT'], ['Westfield Park', 'NJ'], ['Brightwater', 'PA'],
];

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoRace(at = Date.now() / 1000) {
  return {
    event_id: DEMO_EVENT_ID,
    name: 'Demo 5K & 10K (made-up runners)',
    start_epoch: at - 40 * 60,
    end_epoch: at + 3 * 3600,
    timezone: 'UTC',
    courses: [
      { course_id: 2, name: '10K', meters: 10000, interval_id: null },
      { course_id: 1, name: '5K', meters: 5000, interval_id: null },
    ],
  };
}

/* 5K bibs 1001-1300, 10K bibs 1501-1620. Deterministic, so tests can rely on names. */
export function demoRunners(at = Date.now() / 1000) {
  const rng = mulberry32(20260913);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const rows = [];
  const courses = [
    { course_id: 1, first: 1001, count: 300, base: 19 * 60, spread: 26 * 60 },
    { course_id: 2, first: 1501, count: 120, base: 38 * 60, spread: 40 * 60 },
  ];
  for (const c of courses) {
    const finishers = [];
    for (let i = 0; i < c.count; i++) {
      const bib = String(c.first + i);
      const first = pick(FIRST);
      const last = pick(LAST);
      const [city, region] = pick(TOWNS);
      const gender = rng() < 0.5 ? 'F' : 'M';
      const age = 14 + Math.floor(rng() * 55);
      const finished = rng() < 0.55;
      const chip = finished ? Math.round((c.base + rng() * c.spread) * 1000) : null;
      const row = {
        event_id: DEMO_EVENT_ID, course_id: c.course_id, bib,
        display_name: `${first} ${last}`, first_name: first, last_name: last,
        age, gender, city, region, country: 'US', team: null, status: null, private: 0,
        finished: finished ? 1 : 0, chip_ms: chip, gun_ms: chip ? chip + Math.round(rng() * 40000) : null,
        overall_rank: null, gender_rank: null, division: null, division_rank: null,
        entrant_at: at, result_at: finished ? at : null,
      };
      rows.push(row);
      if (finished) finishers.push(row);
    }
    finishers.sort((a, b) => a.chip_ms - b.chip_ms).forEach((r, i) => { r.overall_rank = i + 1; });
    for (const g of ['F', 'M']) {
      finishers.filter((r) => r.gender === g).forEach((r, i) => { r.gender_rank = i + 1; });
    }
  }
  return rows;
}
