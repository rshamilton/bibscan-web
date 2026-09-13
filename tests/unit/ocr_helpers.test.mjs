// Geometry, decoding and post-processing helpers around the OCR models (no model load).
import test from 'node:test';
import assert from 'node:assert/strict';
import { angleDeg, looksNumeric, parseRoi, quadCenter, quadHeight, quadWidth } from '../../public/js/ocr/geometry.js';
import { buildCharset, charsetMask, ctcDecode } from '../../public/js/ocr/ctc.js';
import { convexHull, dbPostprocess, filterDetections, getMiniBoxes, minAreaRect } from '../../public/js/ocr/dbpost.js';
import { detInputSize, warpQuad } from '../../public/js/ocr/reader.js';
import { cropImage, fromRGBA, makeImage, resizeArea, rot90ccw, rotate180, toRGBA } from '../../public/js/ocr/image.js';
import { formatMillis, roundHalfEven, splitName } from '../../public/js/core/format.js';

const quad = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('quad geometry', () => {
  const q = quad(100, 50, 200, 60);
  near(quadHeight(q), 60);
  near(quadWidth(q), 200);
  near(angleDeg(q), 0);
  assert.deepEqual(quadCenter(q), [200, 80]);
});

test('reading angle is signed', () => {
  assert.ok(angleDeg([[0, 10], [100, 0], [100, 40], [0, 50]]) < 0);
});

for (const [spec, expected] of [['', null], ['0,0,1,1', [0, 0, 1280, 720]], ['0.25,0.5,0.5,0.5', [320, 360, 640, 360]]]) {
  test(`parseRoi ${JSON.stringify(spec)}`, () => assert.deepEqual(parseRoi(spec, 1280, 720), expected));
}

test('parseRoi rejects nonsense', () => {
  assert.throws(() => parseRoi('1,2,3', 1280, 720));
  assert.throws(() => parseRoi('a,b,c,d', 1280, 720));
  assert.throws(() => parseRoi('0.1,,0.5,0.5', 1280, 720));
});

test('parseRoi clamps to the frame', () => {
  const [x, y, w, h] = parseRoi('0.9,0.9,0.5,0.5', 1000, 1000);
  assert.ok(x + w <= 1000 && y + h <= 1000);
});

for (const [text, expected] of [['3477', true], ['34T7', true], ['OII', true], ['WATER', false], ['FINISH', false], ['', false], ['MILE 3', true]]) {
  test(`looksNumeric ${JSON.stringify(text)}`, () => assert.equal(looksNumeric(text), expected));
}

test('warpQuad straightens a box', () => {
  const img = makeImage(200, 200);
  for (let y = 50; y < 150; y++) for (let x = 50; x < 150; x++) img.data.fill(255, (y * 200 + x) * 3, (y * 200 + x) * 3 + 3);
  const out = warpQuad(img, quad(50, 50, 100, 100));
  assert.ok(out.width > 0 && out.height > 0);
  const c = (Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2)) * 3;
  assert.deepEqual([...out.data.subarray(c, c + 3)], [255, 255, 255]);
});

test('warpQuad handles a degenerate box', () => {
  assert.equal(warpQuad(makeImage(50, 50), quad(0, 0, 2, 2)), null);
});

test('charset: blank and the space class are always the ends', () => {
  const chars = buildCharset(['1', '2']);
  assert.deepEqual(chars, ['blank', '1', '2', ' ']);
});

test('restricted decode blocks non-ASCII classes', () => {
  const chars = ['blank', '1', '2', 'A', '中', '文', ' '];
  assert.deepEqual([...charsetMask(chars, 'ascii')], [1, 1, 1, 1, 0, 0, 1]);
  assert.deepEqual([...charsetMask(chars, 'digits')], [1, 1, 1, 0, 0, 0, 0]);
  assert.equal(charsetMask(chars, 'all'), null);
});

test('CTC decode collapses repeats, drops blanks, honours the mask', () => {
  const chars = ['blank', '1', '2', 'A', '中', '文', ' '];
  const C = chars.length;
  const steps = [
    { 0: 0.9 }, { 1: 0.8 }, { 1: 0.7 }, { 0: 0.9 }, { 1: 0.6 }, { 4: 0.85, 3: 0.1 },
  ];
  const data = new Float32Array(steps.length * C);
  steps.forEach((s, t) => Object.entries(s).forEach(([c, p]) => { data[t * C + Number(c)] = p; }));
  const [masked] = ctcDecode(data, 1, steps.length, C, chars, charsetMask(chars, 'ascii'));
  assert.equal(masked.text, '11A');
  near(masked.conf, (0.8 + 0.6 + 0.1) / 3, 1e-6);
  const [open] = ctcDecode(data, 1, steps.length, C, chars, null);
  assert.equal(open.text, '11中');
});

test('CTC decode of nothing is empty with zero confidence', () => {
  const data = new Float32Array(3 * 4);
  for (let t = 0; t < 3; t++) data[t * 4] = 1;
  assert.deepEqual(ctcDecode(data, 1, 3, 4, ['blank', 'a', 'b', ' ']), [{ text: '', conf: 0 }]);
});

test('convex hull and min-area rectangle', () => {
  const pts = [[0, 0], [10, 0], [10, 4], [0, 4], [5, 2], [3, 1]];
  assert.equal(convexHull(pts).length, 4);
  const r = minAreaRect(pts);
  near(r.size[0] * r.size[1], 40, 1e-6);
  // A diamond: the tight rectangle is rotated 45 degrees, not axis-aligned.
  const d = minAreaRect([[5, 0], [10, 5], [5, 10], [0, 5]]);
  near(d.size[0] * d.size[1], 50, 1e-6);
});

test('mini boxes come back clockwise from the top-left', () => {
  const { box, sside } = getMiniBoxes([[20, 30], [60, 30], [60, 45], [20, 45]]);
  assert.deepEqual(box, [[20, 30], [60, 30], [60, 45], [20, 45]]);
  near(sside, 15);
});

test('DB post-processing turns a confident blob into one grown box', () => {
  const w = 64, h = 32;
  const pred = new Float32Array(w * h);
  for (let y = 10; y <= 20; y++) for (let x = 10; x <= 40; x++) pred[y * w + x] = 0.9;
  // A faint blob: above the pixel threshold, below the box threshold.
  for (let y = 24; y <= 29; y++) for (let x = 50; x <= 60; x++) pred[y * w + x] = 0.35;
  const { boxes, scores } = dbPostprocess(pred, w, h, w * 2, h * 2, { boxThresh: 0.6, unclipRatio: 1.6 });
  assert.equal(boxes.length, 1);
  // The 2x2 dilation grows the mask a pixel right and down, which dilutes the
  // score: 0.9 * (31 * 11) / (32 * 12).
  assert.ok(Math.abs(scores[0] - (0.9 * 341) / 384) < 1e-6, String(scores[0]));
  const [b] = filterDetections(boxes, w * 2, h * 2);
  // Grown past the blob on every side, in the 2x destination coordinates.
  assert.ok(b[0][0] < 20 && b[0][1] < 20 && b[2][0] > 80 && b[2][1] > 40, JSON.stringify(b));
});

test('detections of 3px or less are dropped', () => {
  assert.deepEqual(filterDetections([[[0, 0], [3, 0], [3, 10], [0, 10]]], 100, 100), []);
  assert.equal(filterDetections([[[0, 0], [30, 0], [30, 10], [0, 10]]], 100, 100).length, 1);
});

test('detector input is a multiple of 32, rounded like Python', () => {
  assert.deepEqual(detInputSize(256, 448), [256, 448]);
  assert.deepEqual(detInputSize(720, 1280), [704, 1280]); // 22.5 rounds to 22, as in bibscan
  assert.deepEqual(detInputSize(1080, 1920), [1088, 1920]);
  assert.deepEqual(detInputSize(2000, 3000), [1344, 1984]); // 62.5 rounds to 62
});

test('image helpers', () => {
  const img = fromRGBA(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18, 255]), 3, 2);
  assert.deepEqual([...img.data], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.equal(toRGBA(img)[7], 255);
  assert.deepEqual([...cropImage(img, 1, 1, 2, 1).data], [13, 14, 15, 16, 17, 18]);
  const r = rot90ccw(img); // np.rot90: the right column becomes the top row
  assert.deepEqual([r.width, r.height], [2, 3]);
  assert.deepEqual([...r.data.subarray(0, 6)], [7, 8, 9, 16, 17, 18]);
  assert.deepEqual([...rotate180(img).data.subarray(0, 3)], [16, 17, 18]);
  const flat = makeImage(40, 40);
  flat.data.fill(77);
  assert.ok(resizeArea(flat, 13, 13).data.every((v) => v === 77));
});

test('Python-style rounding and time formatting', () => {
  assert.deepEqual([0.5, 1.5, 2.5, -2.5, -3.5, 2.4].map(roundHalfEven), [0, 2, 2, -2, -4, 2]);
  assert.equal(formatMillis(1469600), '24:30');
  assert.equal(formatMillis(3723000), '1:02:03');
  assert.equal(formatMillis(null), '--:--');
  assert.equal(formatMillis(2500), '0:02');
  assert.deepEqual(splitName('  Ryan  van Hamilton '), ['Ryan', 'van Hamilton']);
  assert.deepEqual(splitName(''), ['', '']);
});
