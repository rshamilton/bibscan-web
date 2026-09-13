// The image operations reimplemented from OpenCV, checked against OpenCV itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clahe, enhance, getPerspectiveTransform, labToRgb, resizeArea, resizeCubic, resizeLinear, rgbToLab, warpPerspective } from '../../public/js/ocr/image.js';
import { diffImages, reference, toGray, toImage } from '../helpers/fixtures.mjs';

const cv = reference().cv;
const src = toImage(cv.src);

function close(actual, key, { max, mean }) {
  const want = toImage(cv[key]);
  const d = diffImages(actual, want);
  assert.ok(d.max <= max && d.mean <= mean, `${key}: ${JSON.stringify(d)} (allowed max ${max}, mean ${mean})`);
}

// OpenCV does 8-bit resampling in fixed point, so a level of rounding either way is expected.
test('resize linear (downscale) matches OpenCV', () => close(resizeLinear(src, 61, 17), 'resize_linear_61x17', { max: 1, mean: 0.5 }));
test('resize linear (upscale) matches OpenCV', () => close(resizeLinear(src, 90, 70), 'resize_linear_90x70', { max: 1, mean: 0.5 }));

test('resize area matches OpenCV', () => {
  const want = toImage(cv['resize_area_fx0.37']);
  close(resizeArea(src, want.width, want.height, 1 / 0.37, 1 / 0.37), 'resize_area_fx0.37', { max: 1, mean: 0.5 });
});

test('resize cubic matches OpenCV', () => close(resizeCubic(src, 80, 64), 'resize_cubic_80x64', { max: 2, mean: 0.5 }));

// Warps quantise source coordinates to 1/1024 px in OpenCV; allow for that.
test('warp perspective, linear + constant border, matches OpenCV', () =>
  close(warpPerspective(src, cv.matrix.flat(), 50, 40, { interp: 'linear', border: 'constant' }), 'warp_linear_constant_50x40', { max: 3, mean: 0.6 }));

test('warp perspective, cubic + replicate border, matches OpenCV', () =>
  close(warpPerspective(src, cv.matrix.flat(), 50, 40, { interp: 'cubic', border: 'replicate' }), 'warp_cubic_replicate_50x40', { max: 3, mean: 0.6 }));

test('getPerspectiveTransform matches OpenCV', () => {
  const M = getPerspectiveTransform(cv.quad, [[0, 0], [40, 0], [40, 28], [0, 28]]);
  cv.perspective_to_40x28.flat().forEach((v, i) => assert.ok(Math.abs(v - M[i]) <= 1e-6 * Math.max(1, Math.abs(v)), `M[${i}] ${M[i]} vs ${v}`));
});

test('CLAHE matches OpenCV', () => {
  const g = toGray(cv.gray);
  const out = clahe(g.data, g.width, g.height);
  const want = Uint8Array.from(cv.clahe_gray.flat());
  let max = 0;
  out.forEach((v, i) => { max = Math.max(max, Math.abs(v - want[i])); });
  assert.ok(max <= 1, `max diff ${max}`);
});

test('RGB to 8-bit Lab is exactly OpenCV', () => {
  const { L, A, B } = rgbToLab(src);
  cv.lab.flat().forEach(([l, a, b], i) => {
    assert.deepEqual([L[i], A[i] + 128, B[i] + 128], [l, a, b], `pixel ${i}`);
  });
});

test("Lab back to RGB (after CLAHE) matches OpenCV, given OpenCV's Lab", () => {
  const lab = cv.lab.flat();
  const L = Uint8Array.from(lab.map((p) => p[0]));
  const A = Float32Array.from(lab.map((p) => p[1] - 128));
  const B = Float32Array.from(lab.map((p) => p[2] - 128));
  close(labToRgb(clahe(L, src.width, src.height), A, B, src.width, src.height), 'enhance', { max: 3, mean: 0.3 });
});

test('enhance (CLAHE on Lab luminance) matches OpenCV', () => close(enhance(src), 'enhance', { max: 3, mean: 0.3 }));

// The size bibscan actually enhances: a bib crop enlarged to 64px high. Paper
// white dominates each tile here, which is what exposed a one-level Lab difference.
test('enhance on a real bib crop matches OpenCV', () => close(enhance(toImage(cv.crop)), 'enhance_crop', { max: 3, mean: 0.3 }));
