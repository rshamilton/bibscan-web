/* Geometry and filtering helpers around the OCR models. Quads are four
   [x, y] points, clockwise from top-left. */

// Characters that could be part of a misread number. Used to decide whether a
// poor read is worth a second, more expensive attempt.
const NUMERIC_ISH = new Set('0123456789OoQDIilL|!ZzEASsGbTtBgq');

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const quadWidth = (q) => (dist(q[1], q[0]) + dist(q[2], q[3])) / 2;
export const quadHeight = (q) => (dist(q[3], q[0]) + dist(q[2], q[1])) / 2;
export const quadCenter = (q) => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];

/* Tilt of the text baseline in degrees. Negative is counter-clockwise. */
export const angleDeg = (q) => (Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI;

export function looksNumeric(text) {
  const chars = [...String(text)].filter((c) => !/\s/.test(c));
  if (!chars.length) return false;
  return chars.some((c) => c >= '0' && c <= '9') || chars.every((c) => NUMERIC_ISH.has(c));
}

/* 'x,y,w,h' in 0..1 fractions -> [x, y, w, h] pixels, or null when unset. */
export function parseRoi(spec, w, h) {
  spec = String(spec || '').trim();
  if (!spec) return null;
  const parts = spec.split(',');
  if (parts.length !== 4) throw new Error(`bad roi '${spec}', want 'x,y,w,h' as fractions of the frame`);
  const nums = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`bad roi '${spec}', want numbers`);
  const [fx, fy, fw, fh] = nums;
  const x = Math.max(0, Math.min(w - 1, Math.trunc(fx * w)));
  const y = Math.max(0, Math.min(h - 1, Math.trunc(fy * h)));
  return [x, y, Math.max(1, Math.min(w - x, Math.trunc(fw * w))), Math.max(1, Math.min(h - y, Math.trunc(fh * h)))];
}
