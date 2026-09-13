/* Synthetic race-bib imagery, drawn in the browser.

   Two uses: the demo camera (runners crossing a fixed scene, so everything can
   be tried with no camera and no race), and the self-test, which abuses bibs
   the way a finish line does - perspective from an off-axis camera, roll from a
   crooked pin, motion blur, noise, JPEG artefacts, uneven light - and measures
   what the scanner makes of them. A port of bibscan's synth.py. */

import { getPerspectiveTransform, invert3x3 } from './ocr/image.js';

export function mulberry32(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.uniform = (a, b) => a + (b - a) * next();
  next.int = (a, b) => a + Math.floor(next() * (b - a + 1));
  next.choice = (list) => list[Math.floor(next() * list.length)];
  return next;
}

const FONT = '"Liberation Sans", "Helvetica Neue", Arial, "DejaVu Sans", sans-serif';

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/* A flat, head-on race bib. */
export function renderBib(number, { width = 420, height = 300, event = 'BIBSCAN DEMO', footer = 'DEMO ROAD RACE' } = {}) {
  const c = canvas(width, height);
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(252,251,248)';
  g.fillRect(0, 0, width, height);
  g.fillStyle = 'rgb(79,49,44)';
  g.fillRect(0, 0, width, Math.round(height * 0.2));
  g.textBaseline = 'top';
  g.textAlign = 'center';
  g.fillStyle = '#fff';
  g.font = `bold ${Math.max(12, Math.round(height * 0.11))}px ${FONT}`;
  g.fillText(event, width / 2, Math.round(height * 0.045));
  // The number itself: as large as will fit, which is how real bibs are set.
  let size = Math.round(height * 0.6);
  for (; size > 10; size -= 4) {
    g.font = `bold ${size}px ${FONT}`;
    const m = g.measureText(number);
    if (m.width <= width * 0.86 && size * 0.74 <= height * 0.52) break;
  }
  g.fillStyle = 'rgb(17,17,17)';
  g.textBaseline = 'alphabetic';
  g.fillText(number, width / 2, Math.round(height * 0.26 + size * 0.74));
  g.textBaseline = 'top';
  g.fillStyle = 'rgb(96,90,90)';
  g.font = `bold ${Math.max(10, Math.round(height * 0.075))}px ${FONT}`;
  g.fillText(footer, width / 2, Math.round(height * 0.855));
  g.fillStyle = 'rgb(205,208,210)';
  for (const cx of [width * 0.09, width * 0.91]) {
    for (const cy of [height * 0.3, height * 0.8]) {
      g.beginPath();
      g.arc(cx, cy, 5, 0, Math.PI * 2);
      g.fill();
    }
  }
  return c;
}

function rotation(yaw, pitch, roll) {
  const [ry, rp, rr] = [yaw, pitch, roll].map((d) => (d * Math.PI) / 180);
  const Y = [[Math.cos(ry), 0, Math.sin(ry)], [0, 1, 0], [-Math.sin(ry), 0, Math.cos(ry)]];
  const P = [[1, 0, 0], [0, Math.cos(rp), -Math.sin(rp)], [0, Math.sin(rp), Math.cos(rp)]];
  const R = [[Math.cos(rr), -Math.sin(rr), 0], [Math.sin(rr), Math.cos(rr), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row) => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
  return mul(mul(Y, P), R);
}

/* Where the bib's corners land in the frame under a 3D rotation. */
export function projectCorners(bw, bh, p, ow, oh) {
  const R = rotation(p.yaw || 0, p.pitch || 0, p.roll || 0);
  const focal = Math.max(ow, oh) * 1.2;
  const depth = focal / Math.max(p.scale ?? 1, 0.05);
  return [[-bw / 2, -bh / 2], [bw / 2, -bh / 2], [bw / 2, bh / 2], [-bw / 2, bh / 2]].map(([x, y]) => {
    const X = R[0][0] * x + R[0][1] * y, Yv = R[1][0] * x + R[1][1] * y, Z = R[2][0] * x + R[2][1] * y + depth;
    return [(X * focal) / Z + ow / 2 + (p.offset_x || 0) * ow, (Yv * focal) / Z + oh / 2 + (p.offset_y || 0) * oh];
  });
}

/* Paint `src` (RGBA ImageData-like) into `dst` so its corners land on `quad`. */
export function warpInto(dst, src, quad) {
  const M = invert3x3(getPerspectiveTransform([[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]], quad));
  const xs = quad.map((q) => q[0]), ys = quad.map((q) => q[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(dst.width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(dst.height - 1, Math.ceil(Math.max(...ys)));
  const sw = src.width, sh = src.height, s = src.data, d = dst.data;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const w = M[6] * x + M[7] * y + M[8];
      const X = (M[0] * x + M[1] * y + M[2]) / w - 0.5;
      const Y = (M[3] * x + M[4] * y + M[5]) / w - 0.5;
      if (X < -0.5 || Y < -0.5 || X > sw - 0.5 || Y > sh - 0.5) continue;
      const ix = Math.max(0, Math.min(sw - 2, Math.floor(X))), iy = Math.max(0, Math.min(sh - 2, Math.floor(Y)));
      const fx = Math.min(1, Math.max(0, X - ix)), fy = Math.min(1, Math.max(0, Y - iy));
      const o = (y * dst.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = s[(iy * sw + ix) * 4 + c], p01 = s[(iy * sw + ix + 1) * 4 + c];
        const p10 = s[((iy + 1) * sw + ix) * 4 + c], p11 = s[((iy + 1) * sw + ix + 1) * 4 + c];
        d[o + c] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy;
      }
      d[o + 3] = 255;
    }
  }
}

/* Road, some shapes, and signage text the scanner must ignore. Fixed for a given seed. */
export function background(ow, oh, rng, clutter = true) {
  const c = canvas(ow, oh);
  const g = c.getContext('2d');
  const base = rng.int(70, 150);
  const grad = g.createLinearGradient(0, 0, 0, oh);
  grad.addColorStop(0, `rgb(${base - 30},${base - 30},${base - 30})`);
  grad.addColorStop(1, `rgb(${base + 30},${base + 30},${base + 30})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, ow, oh);
  if (clutter) {
    for (let i = rng.int(3, 9); i > 0; i--) {
      g.fillStyle = `rgb(${rng.int(40, 200)},${rng.int(40, 200)},${rng.int(40, 200)})`;
      g.fillRect(rng.int(0, ow - 1), rng.int(0, oh - 1), rng.int(30, 240), rng.int(20, 160));
    }
    const words = ['FINISH', '20K', 'MILE 3', 'WATER', 'GO', '2026'].sort(() => rng() - 0.5).slice(0, rng.int(1, 3));
    for (const word of words) {
      g.fillStyle = `rgb(${rng.int(150, 255)},${rng.int(150, 255)},${rng.int(150, 255)})`;
      g.font = `bold ${Math.round(rng.uniform(22, 48))}px ${FONT}`;
      g.fillText(word, rng.int(0, Math.max(1, ow - 200)), rng.int(40, oh - 20));
    }
  }
  return g.getImageData(0, 0, ow, oh);
}

/* Parameter sets that bracket what a finish-line camera actually sees. */
export function randomParams(rng, difficulty = 'mixed') {
  if (difficulty === 'easy') {
    return { yaw: rng.uniform(-12, 12), pitch: rng.uniform(-8, 8), roll: rng.uniform(-6, 6), scale: rng.uniform(0.75, 1.1),
      blur_len: 0, blur_angle: 0, noise: 0.004, brightness: rng.uniform(0.9, 1.1), jpeg_quality: 92,
      offset_x: rng.uniform(-0.12, 0.12), offset_y: rng.uniform(-0.08, 0.08) };
  }
  if (difficulty === 'hard') {
    return { yaw: rng.uniform(-45, 45), pitch: rng.uniform(-28, 28), roll: rng.uniform(-25, 25), scale: rng.uniform(0.28, 0.6),
      blur_len: rng.choice([0, 7, 11, 15]), blur_angle: rng.uniform(0, 180), noise: rng.uniform(0.004, 0.02),
      brightness: rng.uniform(0.55, 1.45), jpeg_quality: rng.choice([55, 70, 85]),
      offset_x: rng.uniform(-0.3, 0.3), offset_y: rng.uniform(-0.2, 0.2) };
  }
  return { yaw: rng.uniform(-30, 30), pitch: rng.uniform(-18, 18), roll: rng.uniform(-15, 15), scale: rng.uniform(0.45, 0.9),
    blur_len: rng.choice([0, 0, 5, 9]), blur_angle: rng.uniform(0, 180), noise: rng.uniform(0.002, 0.012),
    brightness: rng.uniform(0.7, 1.25), jpeg_quality: rng.choice([75, 88, 95]),
    offset_x: rng.uniform(-0.22, 0.22), offset_y: rng.uniform(-0.14, 0.14) };
}

function motionBlur(img, length, angleDeg) {
  if (length < 2) return;
  const { width: w, height: h, data } = img;
  const src = data.slice();
  const a = (angleDeg * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
  const taps = [];
  for (let k = 0; k < length; k++) {
    const t = k - (length - 1) / 2;
    taps.push([Math.round(t * dx), Math.round(t * dy)]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (const [ox, oy] of taps) {
        const sx = Math.min(w - 1, Math.max(0, x + ox)), sy = Math.min(h - 1, Math.max(0, y + oy));
        const p = (sy * w + sx) * 4;
        r += src[p]; g += src[p + 1]; b += src[p + 2];
      }
      const o = (y * w + x) * 4;
      data[o] = r / length; data[o + 1] = g / length; data[o + 2] = b / length;
    }
  }
}

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

async function jpeg(img, quality) {
  const c = canvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  const blob = c.convertToBlob
    ? await c.convertToBlob({ type: 'image/jpeg', quality: quality / 100 })
    : await new Promise((r) => c.toBlob(r, 'image/jpeg', quality / 100));
  const bmp = await createImageBitmap(blob);
  const out = canvas(img.width, img.height);
  const g = out.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  return g.getImageData(0, 0, img.width, img.height);
}

/* One synthetic frame: ImageData with the bib placed and the damage applied. */
export async function synthFrame(number, params, { bg, rng, bibCache = new Map() }) {
  if (!bibCache.has(number)) {
    const bib = renderBib(number);
    bibCache.set(number, bib.getContext('2d').getImageData(0, 0, bib.width, bib.height));
  }
  const bib = bibCache.get(number);
  let frame = new ImageData(new Uint8ClampedArray(bg.data), bg.width, bg.height);
  warpInto(frame, bib, projectCorners(bib.width, bib.height, params, bg.width, bg.height));
  const d = frame.data;
  if (params.brightness && params.brightness !== 1) for (let i = 0; i < d.length; i++) if (i % 4 !== 3) d[i] *= params.brightness;
  if (params.blur_len >= 2) motionBlur(frame, params.blur_len, params.blur_angle || 0);
  if (params.noise > 0) {
    const sd = params.noise * 255;
    for (let i = 0; i < d.length; i++) if (i % 4 !== 3) d[i] += gaussian(rng) * sd;
  }
  if (params.jpeg_quality) frame = await jpeg(frame, params.jpeg_quality);
  return frame;
}

/* The demo camera: runners from the roster cross a fixed scene, one or two at
   a time, as a MediaStream the page treats exactly like a real camera. */
export class DemoCamera {
  constructor(bibs, { width = 1280, height = 720, fps = 12, crossSec = 7, gapSec = 1.5, seed = 7 } = {}) {
    this.bibs = bibs.length ? bibs : ['1001'];
    this.rng = mulberry32(seed);
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.crossSec = crossSec;
    this.gapSec = gapSec;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.bg = background(width, height, mulberry32(4242));
    this.bibCache = new Map();
    this.timer = null;
    this.stream = null;
    this.runners = [];
    this.startedAt = 0;
    this.nextAt = 0;
    this.current = [];
  }

  bibImage(number) {
    if (!this.bibCache.has(number)) {
      const c = renderBib(number);
      this.bibCache.set(number, c.getContext('2d').getImageData(0, 0, c.width, c.height));
    }
    return this.bibCache.get(number);
  }

  spawn(now) {
    const n = this.rng() < 0.25 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.runners.push({
        bib: this.rng.choice(this.bibs),
        start: now + i * 900,
        lane: this.rng.uniform(-0.12, 0.14) + i * 0.08,
        size: this.rng.uniform(0.55, 0.8),
        yaw: this.rng.uniform(-18, 18),
        bob: this.rng.uniform(0, Math.PI * 2),
      });
    }
    this.nextAt = now + (this.crossSec + this.gapSec) * 1000 + (n - 1) * 900;
  }

  draw() {
    const now = performance.now();
    if (now >= this.nextAt) this.spawn(now);
    const frame = new ImageData(new Uint8ClampedArray(this.bg.data), this.width, this.height);
    this.runners = this.runners.filter((r) => now - r.start < this.crossSec * 1000);
    this.current = [];
    for (const r of this.runners) {
      const t = (now - r.start) / (this.crossSec * 1000);
      if (t < 0) continue;
      const p = {
        yaw: r.yaw - 10 + 20 * t, pitch: 4, roll: 6 * Math.sin(t * 9 + r.bob),
        scale: r.size + 0.12 * t, offset_x: -0.42 + 0.84 * t, offset_y: r.lane + 0.015 * Math.sin(t * 18 + r.bob),
      };
      const bib = this.bibImage(r.bib);
      warpInto(frame, bib, projectCorners(bib.width, bib.height, p, this.width, this.height));
      this.current.push(r.bib);
    }
    this.ctx.putImageData(frame, 0, 0);
  }

  start() {
    if (!this.canvas.captureStream) throw new Error('this browser cannot turn a canvas into a video stream');
    this.startedAt = performance.now();
    this.nextAt = this.startedAt + 600;
    this.draw();
    this.timer = setInterval(() => this.draw(), 1000 / this.fps);
    this.stream = this.canvas.captureStream(this.fps);
    return this.stream;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
