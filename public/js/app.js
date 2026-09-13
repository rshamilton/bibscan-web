/* bibscan-web: the page.

   Everything runs here, on this device: the recognition engine in a worker,
   the roster and history in IndexedDB, voting in the engine. The only thing
   that ever leaves the browser is a race-data request, through the local
   server's relay, when you add or sync a race from Athlinks/ChronoTrack or
   RunSignUp (see core/races.js for how a pasted link picks one).

   Layout is mobile-first. The live page itself never scrolls; the camera and
   the names are panes inside a fixed frame, and only the names pane scrolls.
   History and Setup slide over it, so scanning carries on while you use them. */

import { MemoryBackend, RaceIndex } from './core/index.js';
import { ReigniteClient, proxyFetcher } from './core/athlinks.js';
import { RunSignUpClient } from './core/runsignup.js';
import { LiveUpdater, Syncer } from './core/sync.js';
import { build, validate } from './core/settings.js';
import { esc, localDate, raceState } from './core/format.js';
import { IDBBackend } from './store-idb.js';
import { EngineClient } from './engine.js';
import { DemoCamera } from './synth.js';
import { $, sleep, store } from './ui.js';
import { mountHistory } from './views/history.js';
import { mountSetup } from './views/setup.js';

/* ================================================================ context */

const ctx = new EventTarget();
window.bibscan = ctx; // handy from the console, and what the end-to-end tests drive

Object.assign(ctx, {
  index: null,
  persistent: true,
  storageError: null,
  info: null,
  // Empty when served by server.mjs (same-origin /proxy/); the Pages deploy
  // fills in the Cloudflare Worker's URL. One relay base, one client per
  // timing service, keyed by the race 'kind' that resolveAnyRace() returns.
  clients: (() => {
    const fetcher = proxyFetcher(document.querySelector('meta[name="bibscan-relay"]')?.content.replace(/\/+$/, '') || '');
    return { athlinks: new ReigniteClient({ fetcher }), runsignup: new RunSignUpClient({ fetcher }) };
  })(),
  engine: new EngineClient(),
  cfg: build(),
  saved: {},
  race: null,
  counts: { total: 0, finished: 0, entrants: 0 },
  bibs: new Set(),
  channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('bibscan-web') : null,

  emit(type, detail) {
    ctx.dispatchEvent(new CustomEvent(type, { detail }));
  },

  /* Tell other bibscan tabs in this browser that something changed. */
  broadcast(type) {
    try { ctx.channel && ctx.channel.postMessage({ type }); } catch { /* closed */ }
  },

  /* Re-read the active race, its bibs and counts. Emits 'race' when the race
     changed, 'roster' when only its runners did. */
  async reloadRace() {
    const previous = ctx.race ? ctx.race.event_id : null;
    ctx.race = await ctx.index.activeRace();
    const id = ctx.race ? ctx.race.event_id : null;
    ctx.bibs = id === null ? new Set() : await ctx.index.bibs(id);
    ctx.counts = id === null ? { total: 0, finished: 0, entrants: 0 } : await ctx.index.counts(id);
    ctx.engine.setBibs(ctx.bibs);
    ctx.emit(previous !== id ? 'race' : 'roster', { previous });
  },

  async setActiveRace(id) {
    await ctx.index.setActive(id);
    await ctx.reloadRace();
    ctx.broadcast('race');
  },

  async reloadSettings() {
    const threads = ctx.cfg.ocr.threads;
    ctx.saved = await ctx.index.getSettings();
    ctx.cfg = build(ctx.saved);
    ctx.applyConfig(threads !== ctx.cfg.ocr.threads);
  },

  /* Validate, store and apply settings. Only pass the values that changed. */
  async saveSettings(values) {
    const { cleaned, applies } = validate(values);
    const threads = ctx.cfg.ocr.threads;
    ctx.saved = await ctx.index.setSettings(cleaned);
    ctx.cfg = build(ctx.saved);
    const restarted = threads !== ctx.cfg.ocr.threads;
    ctx.applyConfig(restarted);
    ctx.broadcast('settings');
    return { applies, restarted };
  },

  async resetSettings() {
    await ctx.index.setMeta('settings', {});
    await ctx.reloadSettings();
    ctx.broadcast('settings');
  },

  applyConfig(restartEngine) {
    ctx.engine.setConfig(ctx.cfg);
    ctx.live.resultsEverySec = ctx.cfg.live.results_every_sec;
    ctx.live.entrantsEverySec = ctx.cfg.live.entrants_every_sec;
    if (restartEngine) ctx.startEngine();
    ctx.emit('settings');
  },

  startEngine() {
    return ctx.engine.start(ctx.cfg, ctx.bibs).catch(() => { /* shown from engine state */ });
  },
});

ctx.syncer = new Syncer(null, ctx.clients);
ctx.live = new LiveUpdater(ctx.syncer);

/* ============================================================== live view */

const app = $('app'), stage = $('stage'), feed = $('feed');
const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
const camSel = $('camSelect'), raceSel = $('raceSelect'), goBtn = $('goBtn');
const camInfo = $('camInfo'), camIdle = $('camIdle'), banner = $('banner');
const drawer = $('drawer'), menuBtn = $('menuBtn'), grip = $('grip');
const cap = document.createElement('canvas');
const cctx = cap.getContext('2d', { willReadFrequently: true });
const highlightMs = () => ctx.cfg.display.highlight_sec * 1000;

function setConn(state, label) {
  const d = $('connDot');
  d.className = `dot ${state}`;
  d.setAttribute('aria-label', label);
  d.title = label;
}

/* ------------------------------------------------------------- view mode */
const MODES = ['split', 'names', 'camera'];
let mode = store.get('bibscan.view', 'split');
if (!MODES.includes(mode)) mode = 'split';
let camShare = Number(store.get('bibscan.camShare', '42')) || 42;

function setMode(m) {
  mode = m;
  store.set('bibscan.view', m);
  MODES.forEach((x) => app.classList.toggle(`mode-${x}`, x === m));
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  renderChips();
}
const applyShare = () => app.style.setProperty('--cam', camShare);
const saveShare = () => store.set('bibscan.camShare', camShare);
document.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
document.querySelectorAll('[data-size]').forEach((b) => {
  b.onclick = () => { camShare = Number(b.dataset.size); applyShare(); saveShare(); if (mode !== 'split') setMode('split'); };
});

/* Drag the grip to resize. A row divider on a phone, a column divider on a
   wide screen, so the axis is decided when the drag starts. */
const wide = () => matchMedia('(min-width: 900px) and (min-aspect-ratio: 1/1)').matches;
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  grip.classList.add('drag');
  const box = stage.getBoundingClientRect();
  const sideways = wide();
  const move = (ev) => {
    const pct = sideways ? ((ev.clientX - box.left) / box.width) * 100 : ((ev.clientY - box.top) / box.height) * 100;
    camShare = Math.max(15, Math.min(85, Math.round(pct)));
    applyShare();
  };
  const up = () => {
    grip.classList.remove('drag');
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    saveShare();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});
grip.addEventListener('keydown', (e) => {
  const less = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
  const more = e.key === 'ArrowDown' || e.key === 'ArrowRight';
  if (!less && !more) return;
  e.preventDefault();
  camShare = Math.max(15, Math.min(85, camShare + (more ? 5 : -5)));
  applyShare();
  saveShare();
});

/* Fit shows exactly the frame being scanned; Fill crops it to use the whole
   pane. The button names what it will do. Tapping the picture does the same. */
function setFill(on) {
  app.classList.toggle('fill', on);
  store.set('bibscan.fill', on ? '1' : '0');
  $('fitBtn').textContent = on ? 'Fit' : 'Fill';
}
$('fitBtn').onclick = (e) => { e.stopPropagation(); setFill(!app.classList.contains('fill')); };
$('camPane').addEventListener('click', (e) => {
  if (e.target === video || e.target === overlay) setFill(!app.classList.contains('fill'));
});

/* ------------------------------------------------------------------ menu */
function openDrawer(open) {
  drawer.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
}
menuBtn.onclick = () => openDrawer(drawer.hidden);
document.addEventListener('pointerdown', (e) => {
  if (!drawer.hidden && !drawer.contains(e.target) && !menuBtn.contains(e.target)) openDrawer(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openDrawer(false); });

/* ------------------------------------------------------------------ feed
   One card per bib. Order is by when a runner was last *announced*, so runners
   in shot together settle once instead of swapping places every time one is
   re-read. The highlight is by when a runner was last *seen*: every read of a
   runner already on the board refreshes it, so green means "read in the last
   few seconds", independent of any cooldown. */
const cards = new Map(); // bib -> {data, announced, lastSeen, el, open}
const MAX_CARDS = 80;
let total = 0, newAbove = 0, renderTimer = null;
const moved = new Set();

function upsert(a) {
  const now = Date.now();
  const seenAt = now - Math.max(0, Number(a.seen_ago) || 0) * 1000;
  let c = cards.get(a.bib);
  if (!c) {
    c = { data: a, announced: now, lastSeen: seenAt, el: document.createElement('article'), open: false };
    c.el.className = 'card';
    c.el.dataset.bib = a.bib;
    c.el.addEventListener('click', () => { c.open = !c.open; paint(c); });
    cards.set(a.bib, c);
    total++;
    $('statSeen').textContent = total;
  } else {
    c.data = a;
    c.announced = now;
    c.lastSeen = Math.max(c.lastSeen, seenAt);
  }
  paint(c);
  moved.add(a.bib);
  if (!renderTimer) renderTimer = setTimeout(render, 250);
  renderChips();
  renderBanner();
}

/* `at` is when the frame that read the bib was captured, not when reading it finished. */
function markSeen(bib, at = Date.now()) {
  const c = cards.get(bib);
  if (!c) return;
  c.lastSeen = Math.max(c.lastSeen, at);
  refreshHighlights();
}

function paint(c) {
  const a = c.data, r = (a.runners || [])[0];
  let right = '';
  const meta = [];
  if (r) {
    right = r.finished ? esc(r.time || '') : '<span class="out">on course</span>';
    if (r.course) meta.push(esc(r.course));
    if (r.finished && r.overall_rank) meta.push(`#${r.overall_rank} overall`);
    if (r.gender && r.age) meta.push(esc(r.gender) + r.age);
    if (r.hometown) meta.push(esc(r.hometown));
  }
  const details = c.open
    ? `<div class="row3">${new Date(c.announced).toLocaleTimeString()} · confidence ${Number(a.confidence).toFixed(2)} · ${a.votes} frame${a.votes === 1 ? '' : 's'}${a.repeat > 1 ? ` · seen ×${a.repeat}` : ''}${a.source ? ` · ${esc(a.source)}` : ''}</div>`
    : '';
  c.el.classList.toggle('miss', !r);
  c.el.classList.toggle('open', c.open);
  c.el.innerHTML =
    `<div class="row1"><span class="bibtag">${esc(a.bib)}</span><span class="nm">${r ? esc(r.name) : 'Not in roster'}</span><span class="rt">${right}</span></div>` +
    `<div class="row2">${r ? meta.join(' · ') : 'No entrant with this number'}</div>${details}`;
  c.el.classList.toggle('recent', Date.now() - c.lastSeen < highlightMs());
}

function render() {
  renderTimer = null;
  let order = [...cards.values()].sort((x, y) => y.announced - x.announced);
  for (const c of order.slice(MAX_CARDS)) { c.el.remove(); cards.delete(c.data.bib); }
  order = order.slice(0, MAX_CARDS);
  const empty = feed.querySelector('.empty');
  if (empty && order.length) empty.remove();

  // If you have scrolled down to read, keep what you are reading exactly where
  // it is: anchor on the first visible card that is not itself moving, and
  // restore its on-screen position after the reorder. (Safari has no
  // overflow-anchor, so this is done by hand.)
  const atTop = feed.scrollTop <= 4;
  let anchor = null;
  if (!atTop) {
    for (const el of feed.children) {
      if (el.offsetTop + el.offsetHeight > feed.scrollTop && !moved.has(el.dataset.bib)) {
        anchor = { el, delta: el.offsetTop - feed.scrollTop };
        break;
      }
    }
  }
  order.forEach((c, i) => { if (feed.children[i] !== c.el) feed.insertBefore(c.el, feed.children[i] || null); });
  if (anchor) {
    feed.scrollTop = anchor.el.offsetTop - anchor.delta;
    newAbove += moved.size;
    showNewPill();
  } else if (atTop) {
    feed.scrollTop = 0;
  }
  moved.clear();
  refreshHighlights();
}

function showNewPill() {
  const pill = $('newPill');
  if (newAbove > 0 && feed.scrollTop > 4) {
    pill.textContent = `↑ ${newAbove} new`;
    pill.hidden = false;
  } else {
    newAbove = 0;
    pill.hidden = true;
  }
}
feed.addEventListener('scroll', () => { if (feed.scrollTop <= 4) showNewPill(); }, { passive: true });
$('newPill').onclick = () => { feed.scrollTo({ top: 0, behavior: 'smooth' }); newAbove = 0; $('newPill').hidden = true; };

function refreshHighlights() {
  const now = Date.now();
  cards.forEach((c) => c.el.classList.toggle('recent', now - c.lastSeen < highlightMs()));
  renderChips();
}
setInterval(refreshHighlights, 250);

/* In camera-only mode, the runners read in the last few seconds float over the picture. */
function renderChips() {
  const box = $('chips');
  if (mode !== 'camera') { if (!box.hidden) box.hidden = true; return; }
  const now = Date.now();
  const inView = [...cards.values()].filter((c) => now - c.lastSeen < highlightMs()).sort((x, y) => y.lastSeen - x.lastSeen).slice(0, 4);
  const html = inView.map((c) => {
    const r = (c.data.runners || [])[0];
    return `<div class="chip"><b>${esc(c.data.bib)}</b>${r ? esc(r.name) : 'not in roster'}${r && r.finished && r.time ? `<span>${esc(r.time)}</span>` : ''}</div>`;
  }).join('');
  if (box.innerHTML !== html) box.innerHTML = html;
  box.hidden = !inView.length;
}

function clearFeed(message) {
  cards.forEach((c) => c.el.remove());
  cards.clear();
  total = 0;
  newAbove = 0;
  $('statSeen').textContent = '0';
  $('newPill').hidden = true;
  feed.innerHTML = `<div class="empty">${message}</div>`;
  renderChips();
}

const cardRunner = (r) => ({
  name: r.display_name, course: r.course, finished: r.finished, time: r.finished ? r.finish_time : null,
  overall_rank: r.overall_rank, hometown: r.hometown, age: r.age, gender: r.gender,
});

/* Results arrived for runners already on the board: "on course" becomes a time. */
async function refreshCards() {
  if (!ctx.race) return;
  for (const c of cards.values()) {
    const runners = await ctx.index.lookup(ctx.race.event_id, c.data.bib);
    c.data = { ...c.data, runners: runners.map(cardRunner) };
    paint(c);
  }
  renderChips();
}

/* ------------------------------------------------------------------ races */
function renderHeader() {
  const r = ctx.race, c = ctx.counts;
  $('raceTitle').textContent = r ? r.name : 'bibscan';
  $('raceSub').textContent = r ? `${raceState(r)} · ${c.total} runners` : 'no race yet — add one in Setup';
  $('statRunners').textContent = r ? c.total : '–';
  $('statFinished').textContent = r ? c.finished : '–';
  $('statState').textContent = r ? ({ finished: 'done', live: 'LIVE', upcoming: 'soon' })[raceState(r)] || '–' : '–';
  if (location.hash.length < 3) document.title = r ? `${r.name} · bibscan` : 'bibscan';
}

async function loadRaces() {
  const races = await ctx.index.races();
  if (!races.length) {
    raceSel.innerHTML = '<option value="">No races yet — add one in Setup</option>';
    return;
  }
  const counts = await Promise.all(races.map((r) => ctx.index.counts(r.event_id)));
  raceSel.innerHTML = races.map((r, i) =>
    `<option value="${r.event_id}"${r.active ? ' selected' : ''}>${esc(r.name)}${r.start_epoch ? ` · ${esc(localDate(r.start_epoch))}` : ''} · ${counts[i].total} runners</option>`,
  ).join('');
}

raceSel.onchange = async () => {
  if (!raceSel.value) return;
  const id = Number(raceSel.value);
  if (ctx.race && id === ctx.race.event_id) return;
  raceSel.disabled = true;
  try {
    await ctx.setActiveRace(id);
  } catch (e) {
    showBannerText(`<b>Could not switch race.</b> ${esc(e.message)}`, 'bad');
    await loadRaces();
  }
  raceSel.disabled = false;
};

/* ----------------------------------------------------------------- banner */
let bannerOverride = null;
let held = [];

function showBannerText(html, cls) {
  bannerOverride = { html, cls, until: Date.now() + 6000 };
  renderBanner();
}

function renderBanner() {
  if (bannerOverride && Date.now() < bannerOverride.until) {
    banner.className = `note banner ${bannerOverride.cls || ''}`;
    banner.innerHTML = bannerOverride.html;
    banner.hidden = false;
    return;
  }
  bannerOverride = null;
  const e = ctx.engine, sy = ctx.syncer.state;
  let html = '', cls = '';
  if (e.state === 'error') {
    html = `<b>The scanner could not start.</b> ${esc(e.error)}`;
    cls = 'bad';
  } else if (running && e.state === 'loading') {
    html = `<b>Loading the recognition models…</b> ${esc(e.detail || '')}`;
  } else if (sy.running && !sy.quiet) {
    html = `<b>Syncing ${esc(sy.race_name || 'roster')}…</b> ${esc(sy.detail || sy.stage || '')}`;
  } else if (sy.error) {
    html = sy.quiet ? `<b>Results refresh failed</b> — will retry. ${esc(sy.error)}` : `<b>Sync failed.</b> ${esc(sy.error)}`;
    cls = sy.quiet ? '' : 'bad';
  } else if (running && !ctx.race) {
    html = '<b>No race selected</b> — bibs are read but cannot be named. Add one in <a href="#/setup">Setup</a>.';
  } else if (running && !ctx.counts.total) {
    html = '<b>This race has no runners yet.</b> Sync its roster in <a href="#/setup">Setup</a>.';
  } else if (held.length) {
    html = `<b>Seeing ${held.map(esc).join(', ')} but not announcing</b> — it is not moving, so it is treated as a fixed sign.`;
  }
  banner.className = `note banner ${cls}`;
  banner.innerHTML = html;
  banner.hidden = !html;
}

function renderEngineLine() {
  const e = ctx.engine;
  let t;
  if (e.state === 'ready') {
    t = `Engine ready · ${e.info.threads} thread${e.info.threads === 1 ? '' : 's'} · models loaded in ${(e.info.loadMs / 1000).toFixed(1)}s`;
    if (!e.info.isolated) t += ' · single-threaded (page not cross-origin isolated)';
  } else if (e.state === 'loading') t = `Engine: ${e.detail || 'loading'}…`;
  else if (e.state === 'error') t = `Engine error: ${e.error}`;
  else t = 'Engine: stopped';
  $('engineLine').textContent = t;
}

/* -------------------------------------------------------------- cameras
   One explicit state machine; every start and stop goes through apply(), one
   at a time. Before permission, browsers report placeholder cameras with no
   name or id, so none are listed until permission exists. */
const CHOICE_KEY = 'bibscan.camera';
const canUseCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
const NON_CAMERA = ['demo', 'video', 'off'];
let desired = store.get(CHOICE_KEY, canUseCamera() ? 'ask' : 'demo');
let source = 'off', running = false, busy = false, pendingApply = false;
let media = null, demo = null, videoUrl = null;
let sent = 0, lastResultAt = 0, loopToken = 0, fps = 0;

async function videoInputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
  } catch {
    return [];
  }
}
const named = (ds) => ds.filter((d) => d.label);

async function listCams() {
  const withLabels = named(await videoInputs());
  let html = '';
  if (withLabels.length) html += withLabels.map((d) => `<option value="${esc(d.deviceId)}">Camera: ${esc(d.label)}</option>`).join('');
  else if (canUseCamera()) html += '<option value="ask">This device’s camera — press Start to allow</option>';
  html += '<option value="demo">Demo runners (no camera needed)</option>';
  html += '<option value="video">A video file…</option>';
  html += '<option value="off">Off — nothing scanning</option>';
  camSel.innerHTML = html;

  const valid = (v) => [...camSel.options].some((o) => o.value === v);
  if (valid(desired)) camSel.value = desired;
  else if (!NON_CAMERA.includes(desired) && valid('ask')) camSel.value = 'ask';
  else if (desired === 'ask' && withLabels.length) camSel.value = withLabels[0].deviceId;
  else camSel.value = valid('ask') ? 'ask' : 'demo';
  desired = camSel.value;
  $('flipBtn').hidden = !(withLabels.length > 1 && !NON_CAMERA.includes(desired));
  $('videoRow').hidden = desired !== 'video';
  updateIdle();
}

function secureCheck() {
  const n = $('insecureNote');
  if (window.isSecureContext) { n.hidden = true; return true; }
  const links = ((ctx.info && ctx.info.https_urls) || []).map((u) => `<a href="${esc(u)}">${esc(u)}</a>`).join(' or ');
  n.innerHTML = '<b>This page is on plain http, so the browser will not share a camera.</b> ' +
    (links ? `Open ${links} and accept the certificate warning once.` : 'Open it as http://localhost on this computer, or start the server with <code>--lan</code> and use the https address it prints.') +
    ' Demo runners and video files work either way.';
  n.hidden = false;
  return false;
}

async function startLocal(deviceId) {
  if (!canUseCamera()) { secureCheck(); openDrawer(true); return false; }
  const size = { width: { ideal: ctx.cfg.capture.width }, height: { ideal: ctx.cfg.capture.height } };
  const generic = { facingMode: { ideal: 'environment' }, ...size };
  const specific = deviceId && deviceId !== 'ask' ? { deviceId: { exact: deviceId }, ...size } : null;
  let got = null;
  for (const want of [specific, generic]) {
    if (!want) continue;
    try {
      got = await navigator.mediaDevices.getUserMedia({ audio: false, video: want });
      break;
    } catch (e) {
      // A remembered camera can go stale (unplugged, browser restarted); fall
      // back to a generic request rather than refusing to start.
      if (want === generic) {
        showBannerText(e.name === 'NotAllowedError'
          ? '<b>Camera permission was denied.</b> Allow it in the browser settings, then press Start.'
          : `<b>Camera failed:</b> ${esc(e.message)}`, 'bad');
        return false;
      }
    }
  }
  if (!got) return false;
  media = got;
  video.srcObject = media;
  try { await video.play(); } catch { /* autoplay rules; frames still arrive */ }
  // Pin the selection to the camera we actually got. Not every browser reports
  // a deviceId for the stream, so fall back to the label, then the first camera.
  const track = media.getVideoTracks()[0];
  const settings = track && track.getSettings ? track.getSettings() : {};
  let pinned = settings.deviceId;
  if (!pinned) {
    const devs = named(await videoInputs());
    pinned = ((track && devs.find((d) => d.label === track.label)) || devs[0] || {}).deviceId;
  }
  if (pinned) { desired = pinned; store.set(CHOICE_KEY, pinned); }
  await listCams();
  if (pinned && [...camSel.options].some((o) => o.value === pinned)) camSel.value = pinned;
  return true;
}

function startDemo() {
  const bibs = [...ctx.bibs];
  demo = new DemoCamera(bibs.length ? bibs : ['1001', '1002', '1003'], { seed: Date.now() & 0xffff });
  try {
    video.srcObject = demo.start();
  } catch (e) {
    showBannerText(`<b>The demo camera is not available here:</b> ${esc(e.message)}`, 'bad');
    demo = null;
    return false;
  }
  video.play().catch(() => {});
  return true;
}

async function startVideo() {
  if (!videoUrl) {
    openDrawer(true);
    showBannerText('<b>Choose a video file</b> in the menu first.', 'bad');
    return false;
  }
  video.srcObject = null;
  video.src = videoUrl;
  video.loop = true;
  video.muted = true;
  try {
    await video.play();
  } catch (e) {
    showBannerText(`<b>Could not play that video:</b> ${esc(e.message)}`, 'bad');
    return false;
  }
  return true;
}

function stopSource() {
  if (media) { media.getTracks().forEach((t) => t.stop()); media = null; }
  if (demo) { demo.stop(); demo = null; }
  video.pause();
  video.srcObject = null;
  if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
  if (overlay.width) octx.clearRect(0, 0, overlay.width, overlay.height);
}

async function apply() {
  if (busy) { pendingApply = true; return; }
  busy = true;
  try {
    const want = desired;
    stopSource();
    source = 'off';
    if (!running || want === 'off') {
      running = false;
      setBtn();
      return;
    }
    let ok;
    if (want === 'demo') ok = startDemo();
    else if (want === 'video') ok = await startVideo();
    else ok = await startLocal(want);
    if (ok) {
      source = want === 'demo' ? 'demo' : want === 'video' ? 'video' : 'camera';
      ctx.engine.reset();
      held = [];
      loop();
    } else {
      running = false;
    }
    setBtn();
  } finally {
    busy = false;
    if (pendingApply) { pendingApply = false; apply(); }
  }
}

function setBtn() {
  goBtn.textContent = running ? 'Stop' : 'Start';
  goBtn.classList.toggle('stop', running);
  holdScreen(running);
  updateIdle();
  updateDot();
  renderBanner();
}

goBtn.onclick = () => { running = !running; apply(); };
camSel.onchange = () => {
  desired = camSel.value;
  store.set(CHOICE_KEY, desired);
  $('videoRow').hidden = desired !== 'video';
  if (desired === 'off') running = false;
  $('flipBtn').hidden = true;
  apply();
};
$('videoFile').onchange = () => {
  const file = $('videoFile').files[0];
  if (!file) return;
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  $('videoName').textContent = file.name;
  if (running && desired === 'video') apply();
};
$('flipBtn').onclick = async () => {
  const locals = named(await videoInputs());
  if (locals.length < 2) return;
  const i = locals.findIndex((d) => d.deviceId === desired);
  desired = locals[(i + 1) % locals.length].deviceId;
  store.set(CHOICE_KEY, desired);
  camSel.value = desired;
  if (running) apply();
};

function updateIdle() {
  const liveNow = running && source !== 'off';
  camInfo.hidden = !liveNow;
  $('fitBtn').hidden = !liveNow;
  if (liveNow) { camIdle.hidden = true; return; }
  camIdle.innerHTML = !window.isSecureContext && !NON_CAMERA.includes(desired)
    ? 'This page is on plain http, so the browser will not share a camera.<small>Demo runners and video files still work — pick one in the menu (☰).</small>'
    : 'Camera off — press Start';
  camIdle.hidden = false;
}

function updateDot() {
  const e = ctx.engine;
  if (e.state === 'error') return setConn('err', 'engine error');
  if (e.state === 'loading') return setConn('warn', 'loading models');
  if (running && Date.now() - lastResultAt < 3000) return setConn('ok', 'scanning');
  if (running) return setConn('warn', 'starting');
  return setConn('', e.state === 'ready' ? 'ready' : 'idle');
}
setInterval(updateDot, 500);

/* Frames go to the engine one at a time; the next is taken only when the last
   result is back, so the engine always works on the newest image. */
async function loop() {
  const mine = ++loopToken;
  while (running && mine === loopToken && source !== 'off') {
    // A backgrounded tab should not keep scanning frames nobody is looking at.
    if (document.hidden && source === 'camera') { await sleep(120); continue; }
    if (!ctx.engine.ready || !video.videoWidth || video.readyState < 2) { await sleep(80); continue; }
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(1, ctx.cfg.capture.long_side / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * s)), h = Math.max(1, Math.round(vh * s));
    if (cap.width !== w || cap.height !== h) { cap.width = w; cap.height = h; }
    cctx.drawImage(video, 0, 0, w, h);
    let pixels;
    try {
      pixels = cctx.getImageData(0, 0, w, h);
    } catch (e) {
      showBannerText(`<b>Cannot read frames from this source:</b> ${esc(e.message)}`, 'bad');
      running = false;
      apply();
      return;
    }
    const raceAt = ctx.race ? ctx.race.event_id : null;
    const kind = source;
    const capturedAt = Date.now();
    const t0 = performance.now();
    let res;
    try {
      res = await ctx.engine.process({ buffer: pixels.data.buffer, width: w, height: h, ts: performance.now() / 1000 });
    } catch (e) {
      if (ctx.engine.ready) showBannerText(`<b>Recognition failed:</b> ${esc(e.message)}`, 'bad');
      await sleep(300);
      continue;
    }
    if (mine !== loopToken || !running) break;
    lastResultAt = Date.now();
    sent++;
    const perFrame = 1000 / Math.max(1, performance.now() - t0);
    fps = fps ? fps * 0.8 + perFrame * 0.2 : perFrame;
    camInfo.textContent = `${sent} frames · ${fps.toFixed(1)} fps`;
    drawBoxes(res.readings || [], w, h);
    held = res.held || [];
    if ((ctx.race ? ctx.race.event_id : null) === raceAt) await announce(res, kind, raceAt, capturedAt);
    renderBanner();
  }
}

/* Green means "read in a frame captured in the last few seconds", so ages are
   measured from capture: recognition time does not stretch the highlight. */
async function announce(res, kind, eventId, capturedAt) {
  const sinceCapture = (Date.now() - capturedAt) / 1000;
  for (const c of res.confirmations) {
    const runners = eventId === null ? [] : await ctx.index.lookup(eventId, c.bib);
    const repeat = eventId === null ? 1 : await ctx.index.recordSighting(eventId, c.bib, c.meanConf, c.votes, runners.length > 0, kind);
    const isNew = !cards.has(c.bib);
    upsert({
      ts: Date.now() / 1000, bib: c.bib, confidence: c.meanConf, votes: c.votes, repeat, source: kind,
      seen_ago: c.seenAgo + sinceCapture, trusted: c.trusted, runners: runners.map(cardRunner),
    });
    if (isNew) speak(c.bib, runners[0]);
  }
  if (res.confirmations.length && eventId !== null) {
    ctx.emit('sightings');
    ctx.broadcast('sightings');
  }
  for (const bib of res.seen || []) markSeen(bib, capturedAt);
}

function speak(bib, runner) {
  if (!ctx.cfg.display.speak_names || typeof speechSynthesis === 'undefined') return;
  try {
    speechSynthesis.speak(new SpeechSynthesisUtterance(runner ? runner.display_name : `bib ${bib}, not in the roster`));
  } catch { /* no voices */ }
}

function drawBoxes(rs, w, h) {
  overlay.width = w;
  overlay.height = h;
  octx.clearRect(0, 0, w, h);
  octx.lineWidth = Math.max(2, w / 320);
  octx.font = `${(w / 26) | 0}px system-ui, sans-serif`;
  for (const r of rs) {
    const p = r.quad;
    if (!p) continue;
    octx.strokeStyle = r.bib ? '#4ade80' : '#60a5fa88';
    octx.beginPath();
    octx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < 4; i++) octx.lineTo(p[i][0], p[i][1]);
    octx.closePath();
    octx.stroke();
    if (r.bib) {
      const tw = octx.measureText(r.bib).width + 12, th = w / 22;
      octx.fillStyle = '#000b';
      octx.fillRect(p[0][0], p[0][1] - th, tw, th);
      octx.fillStyle = '#4ade80';
      octx.fillText(r.bib, p[0][0] + 6, p[0][1] - th / 4);
    }
  }
}

/* Keep the phone awake while scanning, and pick the camera back up after the
   phone was locked or the tab backgrounded - iOS stops the camera when that happens. */
let wake = null;
async function holdScreen(on) {
  try {
    if (on && 'wakeLock' in navigator && !wake && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) {
      await wake.release();
      wake = null;
    }
  } catch { /* not allowed here */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  holdScreen(true);
  if (source === 'camera') {
    const t = media && media.getVideoTracks()[0];
    if (!t || t.readyState === 'ended') apply();
  }
});

ctx.stopScanning = () => {
  if (running) { running = false; apply(); }
};
ctx.isScanning = () => running;
ctx.feed = { upsert, clear: clearFeed, cards };

function initLive() {
  setMode(mode);
  applyShare();
  setFill(store.get('bibscan.fill', '0') === '1');
  secureCheck();
  listCams();
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', listCams);
  renderHeader();
  loadRaces();
  renderEngineLine();
  setBtn();
  if (!ctx.race) clearFeed('No race yet. Add one in <a href="#/setup">Setup</a> — or add the demo race there and press <b>Start</b> with demo runners.');

  ctx.addEventListener('race', () => {
    ctx.engine.reset();
    held = [];
    clearFeed(ctx.race ? `Switched to <b>${esc(ctx.race.name)}</b>. Waiting for bibs.` : 'No race selected. Add one in <a href="#/setup">Setup</a>.');
    renderHeader();
    loadRaces();
    renderBanner();
  });
  ctx.addEventListener('roster', () => { renderHeader(); loadRaces(); refreshCards(); renderBanner(); });
  ctx.engine.addEventListener('change', () => { renderEngineLine(); renderBanner(); updateDot(); });
  ctx.syncer.addEventListener('change', renderBanner);
  setInterval(renderHeader, 30000); // race state moves with the clock
}

/* ================================================================ routing */

function route() {
  const h = location.hash;
  const view = h.startsWith('#/history') ? 'history' : h.startsWith('#/setup') ? 'setup' : 'live';
  for (const name of ['history', 'setup']) {
    const v = ctx.views[name];
    if (view === name && v.el.hidden) {
      v.el.hidden = false;
      v.el.scrollTop = 0;
      v.show();
    } else if (view !== name && !v.el.hidden) {
      v.el.hidden = true;
    }
  }
  if (view !== 'live') openDrawer(false);
  document.title = view === 'live' ? (ctx.race ? `${ctx.race.name} · bibscan` : 'bibscan') : `bibscan · ${view}`;
}

/* ================================================================== boot */

async function boot() {
  try {
    ctx.index = new RaceIndex(await IDBBackend.open());
  } catch (exc) {
    ctx.index = new RaceIndex(new MemoryBackend());
    ctx.persistent = false;
    ctx.storageError = exc.message || String(exc);
  }
  ctx.syncer.index = ctx.index;
  ctx.saved = await ctx.index.getSettings();
  ctx.cfg = build(ctx.saved);
  ctx.live.resultsEverySec = ctx.cfg.live.results_every_sec;
  ctx.live.entrantsEverySec = ctx.cfg.live.entrants_every_sec;
  await ctx.reloadRace();

  ctx.syncer.addEventListener('finished', async (e) => {
    if (ctx.race && e.detail.eventId === ctx.race.event_id) await ctx.reloadRace();
    ctx.broadcast('roster');
  });
  if (ctx.channel) {
    ctx.channel.onmessage = async (e) => {
      const type = e.data && e.data.type;
      if (type === 'race' || type === 'roster') {
        ctx.index.cache.clear();
        await ctx.reloadRace();
      } else if (type === 'sightings') ctx.emit('sightings');
      else if (type === 'settings') await ctx.reloadSettings();
    };
  }

  initLive();
  ctx.views = { history: mountHistory(ctx), setup: mountSetup(ctx) };
  window.addEventListener('hashchange', route);
  route();
  const engineSettled = ctx.startEngine();

  // Release the engine's worker threads as the page goes away, rather than
  // leaving them to teardown.
  window.addEventListener('pagehide', () => {
    ctx.stopScanning();
    ctx.engine.stop();
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) ctx.startEngine(); });

  fetch('/api/info', { cache: 'no-store' })
    .then((r) => (r.ok && (r.headers.get('content-type') || '').includes('json') ? r.json() : null))
    .catch(() => null)
    .then((info) => {
      ctx.info = info;
      secureCheck();
      ctx.emit('info');
    });

  // Registered once the engine has its models, so a first visit does not
  // download the same 26 MB twice at the same moment.
  if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
    engineSettled
      .then(() => navigator.serviceWorker.register('sw.js'))
      .catch(() => { /* e.g. an untrusted certificate */ });
  }
  ctx.booted = true;
  ctx.emit('booted');
}

boot().catch((exc) => {
  console.error(exc);
  banner.className = 'note banner bad';
  banner.innerHTML = `<b>bibscan could not start.</b> ${esc(exc.message || exc)}`;
  banner.hidden = false;
});
