/* Setup: races, rosters without the internet, settings, the engine and its
   self-test, the phone link, and your data. */

import { AmbiguousRace, resolveRace } from '../core/athlinks.js';
import { rosterFromCsv } from '../core/csv.js';
import { DEMO_EVENT_ID, demoRace, demoRunners } from '../core/demo.js';
import { esc, localDate } from '../core/format.js';
import { describe } from '../core/settings.js';
import { background, mulberry32, randomParams, synthFrame } from '../synth.js';
import { $, download, note } from '../ui.js';

const SECTIONS = {
  tracker: 'Confirming a runner',
  ocr: 'Reading the image',
  capture: 'Camera',
  display: 'Display',
  live: 'Live results',
};

const inputId = (key) => `s_${key.replace('.', '_')}`;
const keepData = () => { try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* optional */ } };

export function mountSetup(ctx) {
  const el = $('setupView');

  /* ------------------------------------------------------------ add a race */

  async function addRace(spec) {
    const btn = $('addBtn');
    btn.disabled = true;
    btn.textContent = 'Adding…';
    note('addMsg', 'Looking up the race…');
    try {
      const { info, sourceUrl } = await resolveRace(spec, ctx.client);
      await ctx.index.addRace(info, { sourceUrl, activate: true, kind: 'athlinks' });
      await ctx.setActiveRace(info.event_id);
      keepData();
      const syncing = ctx.syncer.start({ eventId: info.event_id });
      const courses = info.courses.map((c) => c.name).join(', ') || 'no courses listed yet';
      note('addMsg', `Added <b>${esc(info.name)}</b> (${esc(courses)}). ${syncing ? 'Pulling its roster now.' : 'Another sync is running; press <b>Sync roster now</b> when it finishes.'}`, 'ok');
      $('spec').value = '';
      await renderRaces();
    } catch (exc) {
      if (exc instanceof AmbiguousRace) {
        note('addMsg', `<b>${esc(exc.masterName)}</b> is a recurring race. Pick an edition:<ul class="editions">` +
          exc.editions.slice(0, 12).map((e) => `<li><span>${esc(e.date)} · ${esc(e.name)} <span class="muted">id ${e.event_id}</span></span><button type="button" data-edition="${e.event_id}">Add</button></li>`).join('') +
          '</ul>');
        $('addMsg').querySelectorAll('[data-edition]').forEach((b) => { b.onclick = () => addRace(`event:${b.dataset.edition}`); });
      } else {
        note('addMsg', esc(exc.message).replace(/\n/g, '<br>'), 'bad');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add';
    }
  }
  $('addForm').onsubmit = (e) => {
    e.preventDefault();
    const spec = $('spec').value.trim();
    if (spec) addRace(spec);
  };

  /* ----------------------------------------------- rosters without internet */

  async function setTotals(eventId, rows) {
    for (const c of await ctx.index.courses(eventId)) {
      const mine = rows.filter((r) => r.course_id === c.course_id);
      await ctx.index.updateCourse(eventId, c.course_id, { entrant_total: mine.length, result_total: mine.filter((r) => r.finished).length });
    }
    const now = Date.now() / 1000;
    await ctx.index.updateRace(eventId, { entrants_synced_at: now, results_synced_at: rows.some((r) => r.finished) ? now : null });
  }

  $('csvFile').onchange = async () => {
    const file = $('csvFile').files[0];
    $('csvFile').value = '';
    if (!file) return;
    try {
      const eventId = -Date.now(); // local races get negative ids, clear of Athlinks'
      const { courses, rows, columns, skipped } = rosterFromCsv(await file.text(), { eventId });
      const name = $('csvName').value.trim() || file.name.replace(/\.[^.]+$/, '') || 'Imported race';
      await ctx.index.addRace({ event_id: eventId, name, start_epoch: null, end_epoch: null, timezone: 'UTC', courses }, { activate: true, kind: 'csv' });
      await ctx.index.upsertResults(eventId, rows);
      await setTotals(eventId, rows);
      await ctx.setActiveRace(eventId);
      keepData();
      $('csvName').value = '';
      note('csvMsg',
        `Imported <b>${rows.length}</b> runners into <b>${esc(name)}</b> (${esc(courses.map((c) => c.name).join(', '))}).` +
        (skipped ? ` Skipped ${skipped} row${skipped === 1 ? '' : 's'} without a bib or a name.` : '') +
        `<br><span class="muted">Columns used: ${Object.entries(columns).map(([f, h]) => `${esc(f.replace(/_/g, ' '))} ← “${esc(h)}”`).join(', ')}</span>`, 'ok');
      await renderRaces();
    } catch (exc) {
      note('csvMsg', `<b>Could not import that file.</b> ${esc(exc.message)}`, 'bad');
    }
  };

  $('demoBtn').onclick = async () => {
    const rows = demoRunners();
    await ctx.index.addRace(demoRace(), { activate: true, kind: 'demo' });
    await ctx.index.upsertResults(DEMO_EVENT_ID, rows);
    await setTotals(DEMO_EVENT_ID, rows);
    await ctx.setActiveRace(DEMO_EVENT_ID);
    note('csvMsg', `Added the demo race with ${rows.length} made-up runners. On the Live page, pick <b>Demo runners</b> as the camera and press <b>Start</b>.`, 'ok');
    await renderRaces();
  };

  /* ----------------------------------------------------------------- races */

  async function renderRaces() {
    const races = await ctx.index.races();
    const box = $('races');
    box.classList.remove('muted');
    if (!races.length) {
      box.innerHTML = '<div class="muted">No races yet. Add one above, import a CSV, or add the demo race.</div>';
    } else {
      const counts = await Promise.all(races.map((r) => ctx.index.counts(r.event_id)));
      box.innerHTML = races.map((r, i) => {
        const kind = r.kind === 'csv' ? 'imported from CSV' : r.kind === 'demo' ? 'demo race' : `Athlinks id ${r.event_id}`;
        return `<div class="race" data-race="${r.event_id}"><div class="race-top"><b>${esc(r.name)}</b>${r.active ? '<span class="pill live">active</span>' : ''}</div>` +
          `<div class="muted">${esc(r.start_epoch ? localDate(r.start_epoch) : 'no date')} · ${esc(r.state)} · ${counts[i].total} runners, ${counts[i].finished} finished</div>` +
          `<div class="muted">${(r.courses || []).map((c) => esc(c.name)).join(', ') || 'no courses'} · ${esc(kind)}</div>` +
          (r.active ? '' : `<div class="row race-actions"><button type="button" data-use="${r.event_id}">Use this race</button><button type="button" class="danger" data-rm="${r.event_id}">Remove</button></div>`) +
          '</div>';
      }).join('');
      box.querySelectorAll('[data-use]').forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try { await ctx.setActiveRace(Number(b.dataset.use)); } catch (e) { note('addMsg', esc(e.message), 'bad'); }
          await renderRaces();
        };
      });
      box.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('Remove this race, its runners and its history?')) return;
          b.disabled = true;
          await ctx.index.removeRace(Number(b.dataset.rm));
          await ctx.reloadRace();
          ctx.broadcast('roster');
          await renderRaces();
        };
      });
    }
    $('setupSub').textContent = ctx.race ? `${ctx.race.name} · ${ctx.counts.total} runners` : 'races, settings and data';
    updateSyncButtons();
  }

  function updateSyncButtons() {
    const athlinks = !!(ctx.race && ctx.race.kind === 'athlinks');
    $('syncBtn').disabled = $('syncEntBtn').disabled = !athlinks || ctx.syncer.state.running;
    $('liveToggle').disabled = !athlinks;
    if (ctx.live.running && (!athlinks || ctx.live.eventId !== ctx.race.event_id)) ctx.live.stop();
    $('liveToggle').checked = ctx.live.running;
  }

  const doSync = (entrants, results) => {
    if (!ctx.race) return;
    if (!ctx.syncer.start({ eventId: ctx.race.event_id, entrants, results })) $('syncMsg').textContent = 'a sync is already running';
  };
  $('syncBtn').onclick = () => doSync(true, true);
  $('syncEntBtn').onclick = () => doSync(true, false);

  function renderSync() {
    const s = ctx.syncer.state;
    const who = s.race_name ? `${s.race_name}: ` : '';
    let t = '';
    if (s.running) t = `${who}${s.stage} ${s.detail}`;
    else if (s.error) t = `${who}failed: ${s.error}`;
    else if (s.finished_at) t = `${who}done`;
    $('syncMsg').textContent = t;
    updateSyncButtons();
  }
  ctx.syncer.addEventListener('change', renderSync);
  ctx.syncer.addEventListener('finished', () => { if (!el.hidden) renderRaces(); });

  function renderLive() {
    $('liveMsg').textContent = ctx.live.running
      ? `Pulling new results every ${ctx.cfg.live.results_every_sec}s${ctx.live.lastRun ? ` · last pull ${new Date(ctx.live.lastRun * 1000).toLocaleTimeString()}` : ''}.`
      : '';
  }
  $('liveToggle').onchange = () => {
    if ($('liveToggle').checked && ctx.race) ctx.live.start(ctx.race.event_id);
    else ctx.live.stop();
    renderLive();
  };
  ctx.live.addEventListener('change', renderLive);

  /* -------------------------------------------------------------- settings */

  function renderSettings() {
    const items = describe(ctx.cfg);
    let html = '';
    for (const [section, title] of Object.entries(SECTIONS)) {
      html += `<h2 class="gap2">${title}</h2>`;
      for (const s of items.filter((x) => x.section === section)) {
        const id = inputId(s.key);
        let input;
        if (s.type === 'bool') input = `<input type="checkbox" id="${id}"${s.value ? ' checked' : ''}>`;
        else if (s.key === 'ocr.charset') input = `<select id="${id}">${['ascii', 'digits', 'all'].map((v) => `<option${v === s.value ? ' selected' : ''}>${v}</option>`).join('')}</select>`;
        else if (s.type === 'str') input = `<input type="text" id="${id}" class="wide" value="${esc(s.value)}" placeholder="whole frame">`;
        else input = `<input type="number" id="${id}" value="${s.value}"${s.min !== null ? ` min="${s.min}"` : ''}${s.max !== null ? ` max="${s.max}"` : ''} step="${s.type === 'float' ? 'any' : '1'}">`;
        const tag = s.applies === 'engine' ? '<span class="tag">restarts engine</span>' : s.applies === 'camera' ? '<span class="tag">next camera start</span>' : '';
        html += `<div class="set" data-key="${s.key}"><div><label class="lab" for="${id}">${esc(s.label)}</label>${tag}<div class="hlp">${esc(s.help)}</div></div><div>${input}</div></div>`;
      }
    }
    const box = $('settings');
    box.innerHTML = html;
    box.classList.remove('muted');
  }

  $('saveBtn').onclick = async () => {
    const changed = {};
    for (const s of describe(ctx.cfg)) {
      const input = $(inputId(s.key));
      if (!input) continue;
      const value = s.type === 'bool' ? input.checked : input.value;
      if (String(value) !== String(s.value)) changed[s.key] = value;
    }
    $('settings').querySelectorAll('.set.bad').forEach((x) => x.classList.remove('bad'));
    if (!Object.keys(changed).length) {
      $('setMsg').textContent = 'Nothing changed.';
      return;
    }
    try {
      const { applies, restarted } = await ctx.saveSettings(changed);
      $('setMsg').textContent = `Saved ${Object.keys(changed).length} setting${Object.keys(changed).length === 1 ? '' : 's'}.` +
        (restarted ? ' The engine is restarting.' : '') +
        (applies.includes('camera') ? ' Camera resolution applies the next time the camera starts.' : '') +
        (applies.includes('now') ? ' Applied immediately.' : '');
      renderSettings();
    } catch (exc) {
      $('setMsg').textContent = exc.message;
      for (const s of describe(ctx.cfg)) {
        if (exc.message.startsWith(s.label)) document.querySelector(`.set[data-key="${s.key}"]`)?.classList.add('bad');
      }
    }
  };

  $('resetBtn').onclick = async () => {
    if (!confirm('Reset all scanner settings to their defaults?')) return;
    await ctx.resetSettings();
    renderSettings();
    $('setMsg').textContent = 'Reset to defaults.';
  };
  ctx.addEventListener('settings', () => { if (!el.hidden) renderSettings(); });

  /* ------------------------------------------------------ engine + self-test */

  function renderEngine() {
    const e = ctx.engine;
    const status = e.state === 'ready' ? 'ready' : e.state === 'loading' ? `loading (${e.detail || '…'})` : e.state === 'error' ? `error: ${e.error}` : e.state;
    const rows = [
      ['Status', status],
      ['Runs on', 'this device: WebAssembly on the CPU. Frames never leave the browser.'],
      ['Threads', e.info.threads ? `${e.info.threads}${e.info.isolated ? '' : ' (cross-origin isolation is off, so one thread)'}` : '–'],
      ['Models loaded in', e.info.loadMs ? `${(e.info.loadMs / 1000).toFixed(1)} s` : '–'],
      ['Last frame', e.lastElapsed ? `${Math.round(e.lastElapsed)} ms` : '–'],
    ];
    $('engineStatus').innerHTML = rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div>${esc(v)}</div>`).join('');
    $('engineStatus').dataset.state = e.state;
  }
  ctx.engine.addEventListener('change', () => { if (!el.hidden) renderEngine(); });
  setInterval(() => { if (!el.hidden) renderEngine(); }, 1000);
  $('engineRestart').onclick = () => ctx.startEngine();

  let selftestRunning = false;

  async function selftest(bibs, count, frames, difficulty) {
    const rng = mulberry32(20260913);
    const pool = bibs.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    pool.length = Math.min(count, pool.length);
    const bg = background(1280, 720, mulberry32(rng.int(1, 1e9)));
    const bibCache = new Map();
    const r = { frameOk: 0, frameWrong: 0, frameNone: 0, right: 0, wrong: 0, missed: 0, falseAlarms: [], times: [], runners: 0, planned: pool.length, stopped: false };
    for (const [n, bib] of pool.entries()) {
      if (!selftestRunning) { r.stopped = true; break; }
      ctx.engine.reset();
      const announced = [];
      for (let f = 0; f < frames; f++) {
        const img = await synthFrame(bib, randomParams(rng, difficulty), { bg, rng, bibCache });
        const res = await ctx.engine.process({ buffer: img.data.buffer, width: img.width, height: img.height, ts: f * 0.25 });
        r.times.push(res.elapsed);
        const got = new Set(res.observations.map((o) => o.bib));
        if (!got.size) r.frameNone++;
        else if (got.has(bib)) r.frameOk++;
        else r.frameWrong++;
        announced.push(...res.confirmations.map((c) => c.bib));
      }
      r.runners++;
      if (announced.includes(bib)) r.right++;
      else if (announced.length) r.wrong++;
      else r.missed++;
      r.falseAlarms.push(...announced.filter((b) => b !== bib));
      note('stOut', `Running… ${n + 1}/${pool.length} runners · ${r.right} announced correctly`);
    }
    return r;
  }

  function renderSelftest(r, frames, difficulty) {
    const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
    const framesTotal = r.frameOk + r.frameWrong + r.frameNone;
    const sorted = r.times.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const line = (label, n, of, cls = '') => `<span>${label}</span><span class="${cls}">${n} / ${of}</span><span class="${cls}">${pct(n, of)}</span>`;
    const html =
      `<div id="stSummary" data-runners="${r.runners}" data-right="${r.right}" data-wrong="${r.wrong}" data-missed="${r.missed}" data-false-alarms="${r.falseAlarms.length}">` +
      `<b>${r.runners} runners × ${frames} frames, ${esc(difficulty)}</b>${r.stopped ? ' (stopped early)' : ''}</div>` +
      '<div class="result">' +
      '<div class="h">Per frame (a single look)</div>' +
      line('read correctly', r.frameOk, framesTotal) + line('read wrong', r.frameWrong, framesTotal) + line('no read', r.frameNone, framesTotal) +
      '<div class="h">Per runner (after voting)</div>' +
      line('announced right', r.right, r.runners, 'good') + line('announced WRONG', r.wrong, r.runners, r.wrong ? 'bad' : '') + line('never announced', r.missed, r.runners) +
      '<div class="h">Other</div>' +
      `<span>false alarms</span><span class="${r.falseAlarms.length ? 'bad' : ''}">${r.falseAlarms.length}</span><span>${esc([...new Set(r.falseAlarms)].slice(0, 8).join(', '))}</span>` +
      `<span>median frame</span><span>${Math.round(median)} ms</span><span>${median ? (1000 / median).toFixed(1) : '–'} fps</span>` +
      '</div>';
    note('stOut', html, r.wrong || r.falseAlarms.length ? 'bad' : 'ok');
  }

  $('stRun').onclick = async () => {
    if (selftestRunning) { selftestRunning = false; return; }
    const bibs = [...ctx.bibs];
    if (!bibs.length) {
      note('stOut', "The self-test uses the active race's bib numbers. Add a race, import a roster, or add the demo race first.", 'bad');
      return;
    }
    if (!ctx.engine.ready) {
      note('stOut', 'The engine is not ready yet.', 'bad');
      return;
    }
    ctx.stopScanning();
    selftestRunning = true;
    $('stRun').textContent = 'Stop self-test';
    const frames = Number($('stFrames').value), difficulty = $('stDifficulty').value;
    try {
      renderSelftest(await selftest(bibs, Number($('stCount').value), frames, difficulty), frames, difficulty);
    } catch (exc) {
      note('stOut', `<b>Self-test failed:</b> ${esc(exc.message)}`, 'bad');
    } finally {
      selftestRunning = false;
      $('stRun').textContent = 'Run self-test';
      ctx.engine.reset();
    }
  };

  /* -------------------------------------------------------------- phone link */

  function renderNet() {
    const box = $('netInfo');
    const info = ctx.info;
    if (!info) {
      box.innerHTML = 'This page is not being served by the bibscan-web server, so adding Athlinks races is unavailable. Demo runners and CSV rosters still work.';
      return;
    }
    const copyNote = ' A phone keeps its own races and history, so add the race there too — or export a backup here and import it on the phone.';
    if (info.https_urls && info.https_urls.length) {
      box.innerHTML = `On a phone on the same network, open ${info.https_urls.map((u) => `<code>${esc(u)}</code>`).join(' or ')} and accept the certificate warning once. The phone then runs the whole scanner itself.${copyNote}`;
    } else {
      box.innerHTML = `Phones only share their camera with a secure (https) page. Restart the server with <code>node server.mjs --lan</code> and open the https address it prints on the phone.${copyNote}`;
    }
  }
  ctx.addEventListener('info', () => { if (!el.hidden) renderNet(); });

  /* ---------------------------------------------------------------- data */

  async function renderStorage() {
    let text = ctx.persistent
      ? 'Everything — races, runners, history, settings — is stored in this browser on this device.'
      : `This browser is not letting the page store data (${ctx.storageError}), so nothing is kept after the page closes.`;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        text += ` Using ${((est.usage || 0) / 1e6).toFixed(1)} MB.`;
      }
      if (navigator.storage && navigator.storage.persisted && (await navigator.storage.persisted())) text += ' Protected from automatic clean-up.';
    } catch { /* estimates are optional */ }
    $('storageInfo').textContent = text;
  }

  async function afterDataChange() {
    ctx.index.cache.clear();
    await ctx.reloadSettings();
    await ctx.reloadRace();
    ctx.broadcast('race');
    ctx.broadcast('settings');
    await show();
  }

  $('exportBtn').onclick = async () => {
    const data = await ctx.index.exportAll();
    download(`bibscan-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
    note('dataMsg', 'Backup downloaded.', 'ok');
  };

  $('importFile').onchange = async () => {
    const file = $('importFile').files[0];
    $('importFile').value = '';
    if (!file || !confirm('Replace everything stored in this browser with this backup?')) return;
    try {
      const data = JSON.parse(await file.text());
      ctx.stopScanning();
      ctx.live.stop();
      await ctx.index.importAll(data);
      await afterDataChange();
      note('dataMsg', 'Backup restored.', 'ok');
    } catch (exc) {
      note('dataMsg', `<b>Could not restore that file.</b> ${esc(exc.message)}`, 'bad');
    }
  };

  $('wipeBtn').onclick = async () => {
    if (!confirm('Delete every race, runner, sighting and setting stored in this browser?')) return;
    ctx.stopScanning();
    ctx.live.stop();
    await ctx.index.clearAll();
    await afterDataChange();
    note('dataMsg', 'Everything was deleted.', 'ok');
  };

  /* ----------------------------------------------------------------- show */

  async function show() {
    renderSettings();
    renderEngine();
    renderSync();
    renderLive();
    renderNet();
    await renderRaces();
    await renderStorage();
  }

  ctx.addEventListener('race', () => { if (!el.hidden) renderRaces(); else updateSyncButtons(); });
  ctx.addEventListener('roster', () => { if (!el.hidden) renderRaces(); });

  return { el, show };
}
