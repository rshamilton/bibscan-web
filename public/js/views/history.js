/* History: everyone seen in the active race, a CSV of it, and one-off bib lookups. */

import { historyCsv } from '../core/csv.js';
import { esc } from '../core/format.js';
import { refreshBib } from '../core/sync.js';
import { $, download, slug, when } from '../ui.js';

export function mountHistory(ctx) {
  const el = $('historyView');
  const find = $('histFind');
  let rows = [];

  async function load() {
    const race = ctx.race;
    $('askTimerRow').hidden = !(race && race.kind === 'athlinks');
    if (!race) {
      rows = [];
      $('histSub').textContent = 'No race selected';
      render();
      return;
    }
    const sightings = await ctx.index.sightings(race.event_id, 0);
    const { byBib } = await ctx.index.load(race.event_id);
    rows = sightings.map((s) => {
      const r = (byBib.get(s.bib) || [])[0];
      return {
        ...s,
        name: r ? r.display_name : null,
        course: r ? r.course : '',
        finished: r ? r.finished : false,
        time: r && r.finished ? r.finish_time : null,
        hometown: r ? r.hometown : '',
      };
    });
    $('histSub').textContent = `${race.name} · ${rows.length} runner${rows.length === 1 ? '' : 's'} seen`;
    render();
  }

  function render() {
    const f = find.value.trim().toLowerCase();
    const shown = rows.filter((r) => !f || String(r.bib).includes(f) || (r.name || '').toLowerCase().includes(f));
    const box = $('histRows');
    if (!shown.length) {
      box.innerHTML = `<div class="muted">${rows.length ? 'No match.' : 'Nobody seen yet.'}</div>`;
      return;
    }
    box.innerHTML =
      '<table><thead><tr><th>Bib</th><th>Name</th><th>Race</th><th>Result</th><th>Seen</th><th>Times</th></tr></thead><tbody>' +
      shown.map((r) =>
        `<tr class="${r.name ? '' : 'miss'}"><td class="bib">${esc(r.bib)}</td>` +
        `<td>${esc(r.name || 'not in roster')}${r.hometown ? `<div class="muted">${esc(r.hometown)}</div>` : ''}</td>` +
        `<td>${esc(r.course || '')}</td>` +
        `<td>${r.finished ? esc(r.time || '') : r.name ? '<span class="muted">out on course</span>' : ''}</td>` +
        `<td>${when(r.last_seen)}</td><td>${r.hits}</td></tr>`,
      ).join('') +
      '</tbody></table>';
  }

  find.oninput = render;

  $('histCsv').onclick = async () => {
    if (!ctx.race) return;
    const sightings = await ctx.index.sightings(ctx.race.event_id, 0);
    const { byBib } = await ctx.index.load(ctx.race.event_id);
    download(`bibscan-${slug(ctx.race.name)}-seen.csv`, new Blob([historyCsv(sightings, byBib)], { type: 'text/csv' }));
  };

  $('histClear').onclick = async () => {
    if (!ctx.race || !confirm('Clear the list of runners seen? Roster data is not affected.')) return;
    await ctx.index.clearSightings(ctx.race.event_id);
    ctx.broadcast('sightings');
    ctx.emit('sightings');
  };

  $('lookupForm').onsubmit = async (e) => {
    e.preventDefault();
    const bib = $('lookupBib').value.trim();
    const out = $('lookupOut');
    const race = ctx.race;
    if (!bib) return;
    if (!race) {
      out.innerHTML = '<div class="note bad">Add a race in Setup first.</div>';
      return;
    }
    out.innerHTML = '<div class="muted gap">Looking…</div>';
    let runners = await ctx.index.lookup(race.event_id, bib);
    let source = 'lookup', warning = '';
    if (race.kind === 'athlinks' && ($('askTimer').checked || !runners.length)) {
      try {
        const fresh = await refreshBib(ctx.index, ctx.client, race.event_id, bib);
        if (fresh.length) runners = fresh;
        source = 'lookup (live)';
        await ctx.reloadRace();
        ctx.broadcast('roster');
      } catch (exc) {
        warning = `Could not ask the timer: ${exc.message}`;
      }
    }
    await ctx.index.recordSighting(race.event_id, bib, 1.0, 0, runners.length > 0, source);
    ctx.emit('sightings');
    ctx.broadcast('sightings');
    out.innerHTML = (warning ? `<div class="note">${esc(warning)}</div>` : '') + (runners.length
      ? runners.map((r) =>
        `<div class="card lookup open" data-bib="${esc(bib)}"><div class="row1"><span class="bibtag">${esc(bib)}</span><span class="nm">${esc(r.display_name)}</span>` +
        `<span class="rt">${r.finished ? esc(r.finish_time) : '<span class="out">on course</span>'}</span></div>` +
        `<div class="row2">${[r.course, r.finished && r.overall_rank ? `#${r.overall_rank} overall` : '', r.gender && r.age ? `${r.gender}${r.age}` : '', r.hometown].filter(Boolean).map(esc).join(' · ')}</div></div>`,
      ).join('')
      : `<div class="note bad">No runner with bib ${esc(bib)} in ${esc(race.name)}.</div>`);
  };

  ctx.addEventListener('sightings', () => { if (!el.hidden) load(); });
  ctx.addEventListener('roster', () => { if (!el.hidden) load(); });
  ctx.addEventListener('race', () => {
    $('lookupOut').innerHTML = '';
    if (!el.hidden) load();
  });

  return { el, show: load };
}
