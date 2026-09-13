/* Small DOM helpers shared by the views. */

export const $ = (id) => document.getElementById(id);

export function note(el, html, cls = '') {
  if (typeof el === 'string') el = $(el);
  el.className = `note ${cls}`;
  el.innerHTML = html;
  el.hidden = !html;
}

/* Save a Blob as a file. */
export function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const slug = (s) => String(s || 'race').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'race';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function when(sec) {
  return sec ? new Date(sec * 1000).toLocaleTimeString() : '';
}

export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, String(v));
    } catch {
      /* private mode */
    }
  },
};
