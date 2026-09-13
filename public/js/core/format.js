/* Small formatting helpers shared by the app, the worker and the tests. */

/* Python's round(): ties go to the even neighbour. The OCR geometry mirrors
   numpy/OpenCV behaviour, and the finish-time formatting mirrors bibscan. */
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function formatMillis(ms) {
  if (!ms || ms <= 0) return '--:--';
  const total = roundHalfEven(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* Best-effort first/last split. The roster only gives a display name. */
export function splitName(display) {
  const parts = String(display || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return ['', ''];
  if (parts.length === 1) return [parts[0], ''];
  return [parts[0], parts.slice(1).join(' ')];
}

export function hometown(r) {
  return [r && r.city, r && r.region].filter(Boolean).join(', ');
}

export function raceState(race, nowSec = Date.now() / 1000) {
  if (!race) return 'unknown';
  const started = !!race.start_epoch && nowSec >= race.start_epoch;
  const finished = !!race.end_epoch && nowSec >= race.end_epoch;
  if (started && !finished) return 'live';
  if (finished) return 'finished';
  if (race.start_epoch) return 'upcoming';
  return 'unknown';
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const pad2 = (n) => String(n).padStart(2, '0');

/* Local "YYYY-MM-DD HH:MM:SS" for an epoch in seconds. */
export function localStamp(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function localDate(sec) {
  return sec ? localStamp(sec).slice(0, 10) : '';
}
