// Fixture access for the parity tests. See tools/make_fixtures.py.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIX = path.join(ROOT, 'tests', 'fixtures');

let cached = null;
export function reference() {
  cached ??= JSON.parse(fs.readFileSync(path.join(FIX, 'reference.json'), 'utf8'));
  return cached;
}

export function frame(name) {
  return { ...readPng(path.join(FIX, 'frames', `${name}.png`)), name };
}

/* [h][w][3] nested arrays (as the generator writes them) -> an image. */
export function toImage(rows) {
  const h = rows.length, w = rows[0].length;
  const data = new Uint8Array(w * h * 3);
  rows.forEach((row, y) => row.forEach((px, x) => data.set(px, (y * w + x) * 3)));
  return { width: w, height: h, data };
}

export function toGray(rows) {
  return { width: rows[0].length, height: rows.length, data: Uint8Array.from(rows.flat()) };
}

export function diffImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { max: Infinity, mean: Infinity, size: `${a.width}x${a.height} vs ${b.width}x${b.height}` };
  let max = 0, sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i] - b.data[i]);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: +(sum / a.data.length).toFixed(3) };
}

const center = (q) => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];

/* Pair each expected quad with the nearest unused actual quad by corner distance. */
export function matchQuads(expected, actual) {
  const used = new Set();
  return expected.map((e) => {
    let best = -1, bestD = Infinity;
    actual.forEach((a, i) => {
      if (used.has(i)) return;
      const d = Math.max(...e.map((p, k) => Math.hypot(p[0] - a[k][0], p[1] - a[k][1])));
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) used.add(best);
    return { index: best, distance: bestD, centerShift: best >= 0 ? Math.hypot(...center(e).map((v, k) => v - center(actual[best])[k])) : Infinity };
  });
}
