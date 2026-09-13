// End-to-end checks of the whole app in headless Firefox, over WebDriver BiDi.
//
// Starts the real server, then drives the real page at phone and desktop size:
// the recognition engine loading in the browser, the demo race and demo
// camera, a camera (a canvas stream playing the parity fixtures), announcing
// runners by name, the highlight timing, view modes, resizing, the new-names
// pill, race switching, CSV roster import, settings persistence, the self-test,
// History and CSV export, adding a real race over the network, and finally
// working offline with the server stopped.
//
//   npm run test:ui                 everything
//   NETWORK=0 npm run test:ui       skip the one check that reaches Athlinks
//   OUT=dir npm run test:ui         where screenshots go (default tests/ui/shots)
//
// Firefox rather than Chromium: Chromium on a Raspberry Pi silently never
// completes requests to localhost.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP, Firefox, IPHONE, sleep } from './bidi.mjs';
import { demoRunners } from '../../public/js/core/demo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.OUT || path.join(ROOT, 'tests', 'ui', 'shots');
const NETWORK = process.env.NETWORK !== '0';
fs.mkdirSync(OUT, { recursive: true });

const NAMES = new Map(demoRunners().map((r) => [r.bib, r.display_name]));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const shot = async (page, name) => page.screenshot(path.join(OUT, `${name}.png`));
const allErrors = [];

const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'bibscan-downloads-'));
async function downloaded(pattern, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const hit = fs.readdirSync(DOWNLOADS).find((f) => pattern.test(f) && !f.endsWith('.part'));
    if (hit) {
      await sleep(300); // let the write finish
      return path.join(DOWNLOADS, hit);
    }
    await sleep(200);
  }
  return null;
}

/* ------------------------------------------------------------------ server */
let server = null;
function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch { /* not yet */ }
    await sleep(150);
  }
  return false;
}
startServer();
process.on('exit', () => { try { server && server.kill(); } catch { /* gone */ } });

/* ------------------------------------------------ a camera the page can't tell from real */
const fixture = (name) => `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'frames', `${name}.png`)).toString('base64')}`;
const CAM = {
  fps: 5, width: 1280, height: 720,
  images: ['signage', 'cross_1147_0', 'cross_1147_1', 'cross_1147_2', 'cross_1147_3'].map(fixture),
  // Empty street, runner 1147 crossing (each position held a second), empty street.
  timeline: [
    ...Array(10).fill({ img: 0, bib: false }),
    ...[1, 2, 3, 4].flatMap((img) => Array(5).fill({ img, bib: true })),
    ...Array(45).fill({ img: 0, bib: false }),
  ],
};
const preload = `() => {
  const CAM = ${JSON.stringify(CAM)};
  const imgs = CAM.images.map((src) => { const i = new Image(); i.src = src; return i; });
  const state = window.__fakeCam = { granted: false, frame: -1, bib: false, calls: 0 };
  const md = navigator.mediaDevices;
  if (!md) return;
  const devices = () => [
    { kind: 'videoinput', deviceId: state.granted ? 'fake-rear' : '', label: state.granted ? 'Fake Rear Camera' : '', groupId: 'g1', toJSON() { return this; } },
    { kind: 'videoinput', deviceId: state.granted ? 'fake-front' : '', label: state.granted ? 'Fake Front Camera' : '', groupId: 'g2', toJSON() { return this; } },
  ];
  md.enumerateDevices = async () => devices();
  md.getUserMedia = async () => {
    state.granted = true; state.calls++;
    const c = document.createElement('canvas');
    c.width = CAM.width; c.height = CAM.height;
    const x = c.getContext('2d');
    const t0 = performance.now();
    const tick = () => {
      const i = Math.floor((performance.now() - t0) / 1000 * CAM.fps) % CAM.timeline.length;
      const f = CAM.timeline[i];
      if (imgs[f.img].complete) x.drawImage(imgs[f.img], 0, 0, CAM.width, CAM.height);
      state.frame = i; state.bib = f.bib;
    };
    tick();
    setInterval(tick, 1000 / CAM.fps / 2);
    const stream = c.captureStream(CAM.fps);
    const track = stream.getVideoTracks()[0];
    const real = track.getSettings.bind(track);
    track.getSettings = () => ({ ...real(), deviceId: 'fake-rear' });
    Object.defineProperty(track, 'label', { value: 'Fake Rear Camera' });
    return stream;
  };
}`;

const select = (id, value) => `(() => { const s = document.getElementById('${id}'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return s.value; })()`;

let ff;
try {
  check('server starts', await waitForServer());
  ff = await Firefox.launch({ port: 9470, downloadDir: DOWNLOADS });

  /* ================================================== phone: first load */
  const page = await ff.newPage(IPHONE, { preload });
  await page.goto(`${BASE}/?nosw`, 1500);
  const ready = await page.waitFor(`window.bibscan && bibscan.engine.state === 'ready'`, 120000, 400);
  const boot = await page.eval(`(() => {
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    return {
      engine: bibscan.engine.state, error: bibscan.engine.error, info: bibscan.engine.info,
      isolated: self.crossOriginIsolated, persistent: bibscan.persistent,
      dupes: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))],
      pageScrolls: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1,
      barHeight: Math.round(document.querySelector('.bar').getBoundingClientRect().height),
      feed: document.getElementById('feed').textContent,
      races: [...document.getElementById('raceSelect').options].map((o) => o.textContent),
    };
  })()`);
  check('recognition engine loads in the browser', ready && boot.engine === 'ready', JSON.stringify(boot.info || boot.error));
  check('page is cross-origin isolated, so inference is multi-threaded', boot.isolated && boot.info.threads > 1, `threads ${boot.info && boot.info.threads}`);
  check('data is stored in IndexedDB', boot.persistent);
  check('no duplicate element ids', boot.dupes.length === 0, boot.dupes.join(','));
  check('page itself does not scroll or overflow sideways', !boot.pageScrolls);
  check('top bar fits on one line at phone width', boot.barHeight <= 64, `${boot.barHeight}px`);
  check('with no race, the feed says where to add one', /No race yet/.test(boot.feed) && /No races yet/.test(boot.races.join()));
  await shot(page, 'phone-first-run');

  /* ============================================ setup: the demo race */
  await page.eval(`location.hash = '#/setup'`);
  await page.waitFor(`!document.getElementById('setupView').hidden`, 5000);
  await page.eval(`document.getElementById('demoBtn').click()`);
  const demoAdded = await page.waitFor(`/demo race with 420/.test(document.getElementById('csvMsg').textContent)`, 20000);
  const demoState = await page.eval(`({ race: bibscan.race && bibscan.race.name, total: bibscan.counts.total, cards: document.querySelectorAll('#races .race').length })`);
  check('adding the demo race makes it active with its 420 runners', demoAdded && demoState.total === 420, JSON.stringify(demoState));
  await shot(page, 'phone-setup-demo');
  await page.eval(`location.hash = '#/'`);
  await page.waitFor(`document.getElementById('setupView').hidden`, 5000);
  check('Live shows the demo race', await page.waitFor(`/Demo 5K/.test(document.getElementById('raceTitle').textContent)`, 5000));

  /* ============================================ the demo camera */
  await page.eval(select('camSelect', 'demo'));
  await page.eval(`document.getElementById('goBtn').click()`);
  const demoCard = await page.waitFor(`document.querySelectorAll('#feed .card').length > 0`, 90000, 500);
  const firstCards = await page.eval(`[...document.querySelectorAll('#feed .card')].map((c) => ({ bib: c.dataset.bib, name: c.querySelector('.nm').textContent, recent: c.classList.contains('recent') }))`);
  check('demo runners are read off the demo camera', demoCard, JSON.stringify(firstCards));
  check('every announced demo runner is named correctly from the roster', firstCards.length && firstCards.every((c) => NAMES.get(c.bib) === c.name), JSON.stringify(firstCards));
  check('a just-read runner is highlighted', firstCards.some((c) => c.recent));
  const overlayDrawn = await page.eval(`document.getElementById('overlay').width > 0`);
  check('boxes are drawn over the picture', overlayDrawn);
  const sightings = await page.eval(`bibscan.index.sightings(-1).then((s) => s.map((x) => x.bib))`);
  check('sightings are recorded', sightings.length >= 1 && firstCards.every((c) => sightings.includes(c.bib)), sightings.join(','));
  await shot(page, 'phone-demo-scanning');
  await page.eval(`document.getElementById('goBtn').click()`);
  await sleep(600);

  /* ============================================ a real camera stream */
  const before = await page.eval(`[...document.getElementById('camSelect').options].map((o) => o.value + '=' + o.textContent)`);
  check('no phantom cameras before permission', before.some((v) => v.startsWith('ask=')) && !before.some((v) => /Fake/.test(v)), before.join(' | '));
  await page.eval(select('camSelect', 'ask'));
  await page.eval(`document.getElementById('goBtn').click()`);
  const camStarted = await page.waitFor(`window.__fakeCam.calls > 0 && document.getElementById('goBtn').textContent === 'Stop'`, 15000);
  check("Start opens this device's camera", camStarted);
  await sleep(1000);
  const pinned = await page.eval(`({ value: document.getElementById('camSelect').value, flip: !document.getElementById('flipBtn').hidden })`);
  check('selector stays on the camera that was opened', pinned.value === 'fake-rear', pinned.value);
  check('flip button offered with two cameras', pinned.flip);
  const named = await page.waitFor(`!!document.querySelector('.card[data-bib="1147"]')`, 90000, 300);
  const card = await page.eval(`(() => { const c = document.querySelector('.card[data-bib="1147"]'); return c && c.querySelector('.nm').textContent; })()`);
  check('runner 1147 is read from the camera and named', named && card === NAMES.get('1147'), `${card} (roster: ${NAMES.get('1147')})`);
  await shot(page, 'phone-camera-scanning');

  // Highlight lasts ~5s after the last frame that showed the runner.
  let lastBibFrameAt = null, offAt = null, sawOn = false;
  const until = Date.now() + 40000;
  while (Date.now() < until) {
    const s = await page.eval(`({ bib: window.__fakeCam.bib, recent: !!document.querySelector('.card[data-bib="1147"].recent') })`);
    const now = Date.now();
    if (s.bib) { lastBibFrameAt = now; offAt = null; }
    if (s.recent) sawOn = true;
    if (lastBibFrameAt && !s.bib && sawOn && !s.recent) { offAt = now; break; }
    await sleep(80);
  }
  const gap = offAt && lastBibFrameAt ? (offAt - lastBibFrameAt) / 1000 : null;
  check('highlight turns off about 5s after the runner was last in frame', gap !== null && gap >= 4 && gap <= 7.5, gap === null ? 'never turned off' : `${gap.toFixed(2)}s`);

  /* ============================================ view modes, resizing, feed */
  await page.eval(`document.querySelector('[data-mode="camera"]').click()`);
  const chip = await page.waitFor(`!document.getElementById('chips').hidden && !!document.querySelector('#chips .chip')`, 45000, 300);
  const camMode = await page.eval(`({ namesHidden: getComputedStyle(document.getElementById('namesPane')).display === 'none', camH: Math.round(document.getElementById('camPane').getBoundingClientRect().height) })`);
  check('Camera view: names hidden, camera fills the screen', camMode.namesHidden && camMode.camH > 600, `camera ${camMode.camH}px`);
  check('Camera view: runners in view float over the picture', chip);
  await shot(page, 'phone-camera-mode');

  await page.eval(`document.querySelector('[data-mode="names"]').click()`);
  await sleep(400);
  const namesMode = await page.eval(`({ camH: Math.round(document.getElementById('camPane').getBoundingClientRect().height), feedH: Math.round(document.getElementById('feed').getBoundingClientRect().height), scanning: bibscan.isScanning() })`);
  check('Names view: feed fills the screen and scanning continues', namesMode.camH <= 4 && namesMode.feedH > 600 && namesMode.scanning, JSON.stringify(namesMode));

  await page.eval(`document.querySelector('[data-mode="split"]').click()`);
  await sleep(300);
  const g = await page.eval(`(() => { const r = document.getElementById('grip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), camH: Math.round(document.getElementById('camPane').getBoundingClientRect().height) }; })()`);
  await ff.send('input.performActions', { context: page.context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', x: g.x, y: g.y }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', x: g.x, y: g.y - 150, duration: 250 }, { type: 'pointerUp', button: 0 },
  ] }] });
  await sleep(300);
  const g2 = await page.eval(`({ camH: Math.round(document.getElementById('camPane').getBoundingClientRect().height), saved: localStorage.getItem('bibscan.camShare') })`);
  check('dragging the grip resizes the camera and remembers it', g2.camH < g.camH - 100 && g2.saved, `${g.camH}px -> ${g2.camH}px`);

  await page.eval(`document.getElementById('goBtn').click()`);
  await sleep(500);
  await page.eval(`(() => {
    for (let i = 0; i < 30; i++) bibscan.feed.upsert({ bib: String(4000 + i), confidence: 0.99, votes: 3, repeat: 1, source: 'test', seen_ago: 30,
      runners: [{ name: 'Test Runner ' + i, course: '5K', finished: true, time: '25:' + String(10 + i), overall_rank: 100 + i, hometown: 'Somewhere, CT', age: 30, gender: 'M' }] });
  })()`);
  await sleep(600);
  const anchorBefore = await page.eval(`(() => { const f = document.getElementById('feed'); f.scrollTop = 520; const el = [...f.children].find((e) => e.offsetTop + e.offsetHeight > f.scrollTop); return { bib: el.dataset.bib, offset: el.offsetTop - f.scrollTop }; })()`);
  await page.eval(`['5001', '5002', '5003'].forEach((b) => bibscan.feed.upsert({ bib: b, confidence: 0.99, votes: 3, repeat: 1, source: 'test', seen_ago: 0, runners: [{ name: 'Late Runner ' + b, course: '5K', finished: true, time: '30:00', overall_rank: 999 }] }))`);
  await sleep(700);
  const anchorAfter = await page.eval(`(() => { const f = document.getElementById('feed'); const el = f.querySelector('.card[data-bib="${anchorBefore.bib}"]'); return { offset: el.offsetTop - f.scrollTop, pill: document.getElementById('newPill').hidden ? null : document.getElementById('newPill').textContent }; })()`);
  check('new names arriving while scrolled down do not move the card being read', Math.abs(anchorAfter.offset - anchorBefore.offset) <= 2, `moved ${anchorAfter.offset - anchorBefore.offset}px`);
  check('a "new" pill says how many arrived above', anchorAfter.pill === '↑ 3 new', String(anchorAfter.pill));
  await shot(page, 'phone-new-pill');

  await page.eval(`document.getElementById('menuBtn').click()`);
  await sleep(400);
  const menu = await page.eval(`({ open: !document.getElementById('drawer').hidden, runners: document.getElementById('statRunners').textContent, engine: document.getElementById('engineLine').textContent })`);
  check('menu opens with stats and engine status', menu.open && menu.runners === '420' && /Engine ready/.test(menu.engine), JSON.stringify(menu));
  await shot(page, 'phone-menu');
  await page.eval(`document.getElementById('menuBtn').click()`);

  /* ============================================ CSV roster import */
  await page.eval(`location.hash = '#/setup'`);
  await sleep(500);
  const csv = 'Bib,First Name,Last Name,Age,Sex,City,State,Race,Chip Time,Place\\n701,Test,Runner,40,F,Millbrook,CT,5K,21:05,1\\n702,Other,Person,33,M,Riverton,NY,5K,,\\n';
  await page.eval(`(() => {
    document.getElementById('csvName').value = 'UI Test Race';
    const dt = new DataTransfer();
    dt.items.add(new File(['${csv}'], 'roster.csv', { type: 'text/csv' }));
    const input = document.getElementById('csvFile');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  })()`);
  const imported = await page.waitFor(`/Imported/.test(document.getElementById('csvMsg').textContent)`, 10000);
  const csvState = await page.eval(`({ msg: document.getElementById('csvMsg').textContent, race: bibscan.race.name, total: bibscan.counts.total, kind: bibscan.race.kind })`);
  check('a roster CSV imports as a new active race', imported && csvState.race === 'UI Test Race' && csvState.total === 2 && csvState.kind === 'csv', JSON.stringify(csvState));
  const lookup = await page.eval(`bibscan.index.lookup(bibscan.race.event_id, '701').then((r) => r[0] && [r[0].display_name, r[0].finish_time, r[0].hometown])`);
  check('imported runners are named, with times', JSON.stringify(lookup) === JSON.stringify(['Test Runner', '21:05', 'Millbrook, CT']), JSON.stringify(lookup));

  // Switching back to the demo race from the Live menu clears the old names.
  await page.eval(`location.hash = '#/'`);
  await sleep(400);
  await page.eval(select('raceSelect', '-1'));
  const switched = await page.waitFor(`bibscan.race.event_id === -1 && !document.querySelector('#feed .card') && /Demo 5K/.test(document.getElementById('raceTitle').textContent)`, 10000);
  check('choosing a race in the menu switches to it and clears the old names', switched);

  /* ============================================ settings persist */
  await page.eval(`location.hash = '#/setup'`);
  await sleep(500);
  await page.eval(`(() => { document.getElementById('s_tracker_min_votes').value = '4'; document.getElementById('s_display_highlight_sec').value = '7'; document.getElementById('saveBtn').click(); })()`);
  const saved = await page.waitFor(`/Saved 2 settings/.test(document.getElementById('setMsg').textContent)`, 5000);
  check('settings save and apply', saved && (await page.eval(`bibscan.cfg.tracker.min_votes === 4 && bibscan.cfg.display.highlight_sec === 7`)));
  await page.eval(`(() => { document.getElementById('s_tracker_min_votes').value = '99'; document.getElementById('saveBtn').click(); })()`);
  await sleep(400);
  const refused = await page.eval(`({ msg: document.getElementById('setMsg').textContent, bad: !!document.querySelector('.set.bad[data-key="tracker.min_votes"]'), value: bibscan.cfg.tracker.min_votes })`);
  check('an out-of-range setting is refused and marked', /at most 15/.test(refused.msg) && refused.bad && refused.value === 4, JSON.stringify(refused));

  // A different query string: navigating to the identical URL-with-hash is an
  // in-page jump, not a reload.
  await page.goto(`${BASE}/?nosw&reload=1#/setup`, 1500);
  await page.waitFor(`window.bibscan && bibscan.booted && !document.getElementById('setupView').hidden`, 20000);
  await sleep(800);
  const persisted = await page.eval(`({ input: document.getElementById('s_tracker_min_votes').value, race: bibscan.race && bibscan.race.event_id })`);
  check('settings and the active race survive a reload', persisted.input === '4' && persisted.race === -1, JSON.stringify(persisted));
  await page.eval(`window.confirm = () => true; document.getElementById('resetBtn').click()`);
  check('reset restores the defaults', await page.waitFor(`document.getElementById('s_tracker_min_votes').value === '3' && bibscan.cfg.display.highlight_sec === 5`, 5000));

  /* ============================================ self-test */
  await page.waitFor(`bibscan.engine.state === 'ready'`, 120000, 500);
  await page.eval(`${select('stCount', '10')}; ${select('stFrames', '3')}; ${select('stDifficulty', 'easy')}; document.getElementById('stRun').click()`);
  const stDone = await page.waitFor(`!!document.getElementById('stSummary')`, 600000, 1000);
  const st = stDone ? await page.eval(`(() => { const s = document.getElementById('stSummary').dataset; return { runners: +s.runners, right: +s.right, wrong: +s.wrong, falseAlarms: +s.falseAlarms, text: document.getElementById('stOut').innerText }; })()`) : null;
  check('self-test: 10 synthetic runners, nobody announced wrong, no false alarms', st && st.runners === 10 && st.wrong === 0 && st.falseAlarms === 0, st && st.text.replace(/\s+/g, ' '));
  check('self-test: most runners announced', st && st.right >= 8, st && `${st.right}/10`);
  await page.eval(`document.getElementById('stOut').scrollIntoView({ block: 'center' })`);
  await shot(page, 'phone-selftest');

  /* ============================================ history */
  await page.eval(`bibscan.index.recordSighting(-1, '1147', 0.97, 3, true, 'test')`);
  await page.eval(`location.hash = '#/history'`);
  await page.waitFor(`/runner/.test(document.getElementById('histSub').textContent)`, 5000);
  const hist = await page.eval(`({ sub: document.getElementById('histSub').textContent, rows: [...document.querySelectorAll('#histRows tbody tr')].map((r) => [r.cells[0].textContent, r.cells[1].textContent]), fits: document.getElementById('historyView').scrollWidth <= innerWidth + 1 })`);
  check('History lists runners seen, by name', hist.rows.some(([b, n]) => b === '1147' && n.startsWith(NAMES.get('1147'))), JSON.stringify(hist.rows.slice(0, 4)));
  check('History fits the phone width', hist.fits);
  await page.eval(`(() => { const f = document.getElementById('histFind'); f.value = '1147'; f.dispatchEvent(new Event('input')); })()`);
  const filtered = await page.eval(`[...document.querySelectorAll('#histRows tbody tr')].map((r) => r.cells[0].textContent)`);
  check('History filter narrows the list', filtered.length === 1 && filtered[0] === '1147', filtered.join(','));
  await page.eval(`document.getElementById('histCsv').click()`);
  const csvFile = await downloaded(/\.csv$/);
  const csvText = csvFile ? fs.readFileSync(csvFile, 'utf8') : '';
  check('Download CSV saves a file with a header and the runner', /^bib,name,course,finished,time/.test(csvText) && csvText.includes(`1147,${NAMES.get('1147')}`), csvFile ? path.basename(csvFile) : 'nothing was downloaded');
  await page.eval(`(() => { document.getElementById('lookupBib').value = '1500'; document.getElementById('lookupForm').requestSubmit(); })()`);
  await page.waitFor(`/No runner|on course|:/.test(document.getElementById('lookupOut').textContent)`, 5000);
  await page.eval(`(() => { document.getElementById('lookupBib').value = '1203'; document.getElementById('lookupForm').requestSubmit(); })()`);
  const looked = await page.waitFor(`document.querySelector('#lookupOut .nm') && document.querySelector('#lookupOut .nm').textContent === ${JSON.stringify(NAMES.get('1203'))}`, 5000);
  check('looking up a bib by hand names the runner', looked);
  await shot(page, 'phone-history');

  /* ============================================ backup and restore */
  await page.eval(`location.hash = '#/setup'`);
  await sleep(500);
  await page.eval(`document.getElementById('exportBtn').click()`);
  const backupFile = await downloaded(/^bibscan-backup-.*\.json$/);
  let backup = null;
  try { backup = backupFile && JSON.parse(fs.readFileSync(backupFile, 'utf8')); } catch { /* checked below */ }
  check('Export backup saves every race, runner and sighting', backup && backup.format === 'bibscan-web-backup' && backup.races.some((r) => r.event_id === -1) && backup.runners.length >= 422 && backup.sightings.length >= 1,
    backup ? `${backup.races.length} races, ${backup.runners.length} runners, ${backup.sightings.length} sightings` : 'nothing was downloaded');
  if (backup) {
    await page.eval(`bibscan.index.clearAll().then(() => bibscan.reloadRace())`);
    const wiped = await page.eval(`bibscan.index.races().then((r) => r.length)`);
    await page.eval(`(() => {
      window.confirm = () => true;
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(JSON.stringify(backup))}], 'backup.json', { type: 'application/json' }));
      const input = document.getElementById('importFile');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    })()`);
    const restored = await page.waitFor(`/Backup restored/.test(document.getElementById('dataMsg').textContent)`, 20000);
    const after = await page.eval(`({ race: bibscan.race && bibscan.race.event_id, total: bibscan.counts.total })`);
    check('Import backup restores it all into an emptied browser', wiped === 0 && restored && after.race === -1 && after.total === 420, JSON.stringify(after));
  }

  /* ============================================ a real race, over the network */
  if (NETWORK) {
    await page.eval(`location.hash = '#/setup'`);
    await sleep(400);
    await page.eval(`(() => { document.getElementById('spec').value = 'https://sites.chronotrack.com/event/91384/results?raceId=242263&divisionId=2716428'; document.getElementById('addForm').requestSubmit(); })()`);
    const added = await page.waitFor(`/Added/.test(document.getElementById('addMsg').textContent) || /note bad/.test(document.getElementById('addMsg').className)`, 60000, 500);
    const addMsg = await page.eval(`document.getElementById('addMsg').textContent`);
    check('pasting a ChronoTrack link adds the race through the local relay', added && /Added .*Hartford/.test(addMsg) && /4 Miles/.test(addMsg), addMsg);
    const synced = await page.waitFor(`!bibscan.syncer.state.running && bibscan.syncer.state.finished_at > 0`, 180000, 1000);
    const net = await page.eval(`({ sync: bibscan.syncer.state, race: bibscan.race.name, total: bibscan.counts.total, finished: bibscan.counts.finished, msg: document.getElementById('syncMsg').textContent })`);
    check('its roster and results sync into the browser', synced && !net.sync.error && net.total > 100 && net.finished > 100 && /Hartford/.test(net.race), `${net.total} runners, ${net.finished} finished; ${net.msg}${net.sync.error ? ` ERROR ${net.sync.error}` : ''}`);
    await shot(page, 'phone-setup-network');
    await page.eval(select('raceSelect', '-1'));
  }

  allErrors.push(...page.errors.map((e) => `phone: ${e}`));

  /* ============================================ desktop + offline */
  const desk = await ff.newPage(DESKTOP);
  await desk.goto(`${BASE}/`, 1500);
  await desk.waitFor(`window.bibscan && bibscan.booted`, 20000);
  const layout = await desk.eval(`(() => { const c = document.getElementById('camPane').getBoundingClientRect(), n = document.getElementById('namesPane').getBoundingClientRect(); return { sideBySide: c.right <= n.left + 1 && Math.abs(c.top - n.top) < 2 }; })()`);
  check('wide screen shows camera and names side by side', layout.sideBySide);
  await desk.eval(select('camSelect', 'demo'));
  await desk.eval(`document.getElementById('goBtn').click()`);
  await desk.waitFor(`document.querySelectorAll('#feed .card').length >= 1`, 90000, 500);
  await shot(desk, 'desktop-demo');
  await desk.eval(`document.getElementById('goBtn').click()`);

  const cached = await desk.eval(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 240 && reg.active.state !== 'activated'; i++) await new Promise((r) => setTimeout(r, 250));
    for (let i = 0; i < 120; i++) {
      const keys = (await (await caches.open('bibscan-web-v1')).keys()).map((r) => new URL(r.url).pathname);
      if (['/models/rec.onnx', '/vendor/ort/ort-wasm-simd-threaded.wasm', '/js/app.js'].every((k) => keys.includes(k))) return { files: keys.length, state: reg.active.state };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { files: 0, state: reg.active.state };
  })()`);
  check('the service worker installs, activates, and caches the app, engine and models', cached.files >= 30 && cached.state === 'activated', JSON.stringify(cached));

  // The worker takes over from the next load. A page it controls must work
  // normally online - its API calls and the relay all pass through the worker.
  await desk.goto(`${BASE}/`, 1500, 'none');
  const controlled = await desk.waitFor(`window.bibscan && bibscan.booted && !!navigator.serviceWorker.controller && bibscan.engine.state === 'ready'`, 120000, 500);
  const through = await desk.eval(`Promise.race([
    Promise.all([
      fetch('/api/info').then((r) => r.status),
      fetch('/js/ui.js').then((r) => r.status),
      ${NETWORK ? `fetch('/proxy/reignite-api.athlinks.com/event/1136187/metadata').then((r) => r.status)` : 'Promise.resolve(200)'},
    ]),
    new Promise((r) => setTimeout(() => r('timed out'), 20000)),
  ])`);
  check('under the service worker, the page loads and its requests (API, code, relay) still work online', controlled && JSON.stringify(through) === '[200,200,200]', `controlled ${controlled}, ${JSON.stringify(through)}`);

  server.kill();
  await sleep(800);
  const serverDown = await fetch(`${BASE}/healthz`).then(() => false, () => true);
  await desk.goto(`${BASE}/`, 1500, 'none');
  const offline = await desk.waitFor(`window.bibscan && bibscan.booted && bibscan.engine.state === 'ready'`, 120000, 500);
  const offState = await desk.eval(`({ race: bibscan.race && bibscan.race.name, total: bibscan.counts.total, isolated: self.crossOriginIsolated, threads: bibscan.engine.info.threads, controlled: !!navigator.serviceWorker.controller })`);
  check('with the server stopped, the app still loads, the engine starts and the roster is there', serverDown && offline && offState.total === 420 && offState.controlled, JSON.stringify(offState));
  check('offline, the page is still cross-origin isolated (multi-threaded)', offState.isolated && offState.threads > 1, `threads ${offState.threads}`);
  await desk.eval(select('camSelect', 'demo'));
  await desk.eval(`document.getElementById('goBtn').click()`);
  const offlineScan = await desk.waitFor(`document.querySelectorAll('#feed .card').length >= 1`, 90000, 500);
  check('...and it still scans and names runners offline', offlineScan);
  await shot(desk, 'desktop-offline');
  allErrors.push(...desk.errors.map((e) => `desktop: ${e}`));

  const unexpected = allErrors.filter((e) => !/NetworkError|Failed to fetch|NS_ERROR|api\/info/.test(e));
  check('no errors in the page consoles', unexpected.length === 0, unexpected.slice(0, 5).join(' | '));
} catch (exc) {
  check('run completed', false, exc.stack || String(exc));
} finally {
  if (ff) await ff.close();
  if (server) server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`screenshots in ${path.relative(ROOT, OUT)}/`);
process.exit(failed.length ? 1 : 0);
