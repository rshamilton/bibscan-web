/* Post-processing for the DB (Differentiable Binarization) text detector:
   probability map in, text quadrilaterals out. A port of RapidOCR's
   DBPostProcess and TextDetector.filter_tag_det_res, without OpenCV.

   Contours are replaced by 8-connected components. Only a component's convex
   hull matters to minAreaRect, and the hull of a blob is set by its leftmost
   and rightmost pixel in each row, so that is all we keep. */

import { roundHalfEven } from '../core/format.js';

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/* Smallest-area enclosing rectangle: {corners, size: [w, h]}. */
export function minAreaRect(points) {
  const hull = convexHull(points);
  if (!hull.length) return { corners: [[0, 0], [0, 0], [0, 0], [0, 0]], size: [0, 0] };
  if (hull.length === 1) return { corners: [hull[0], hull[0], hull[0], hull[0]], size: [0, 0] };
  let best = null;
  const n = hull.length;
  for (let i = 0; i < (n === 2 ? 1 : n); i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const vx = -uy, vy = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = p[0] * ux + p[1] * uy, pv = p[0] * vx + p[1] * vy;
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-9) best = { area, ux, uy, vx, vy, minU, maxU, minV, maxV };
  }
  if (!best) return { corners: [hull[0], hull[0], hull[0], hull[0]], size: [0, 0] };
  const { ux, uy, vx, vy, minU, maxU, minV, maxV } = best;
  const at = (u, v) => [u * ux + v * vx, u * uy + v * vy];
  return {
    corners: [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)],
    size: [maxU - minU, maxV - minV],
  };
}

/* RapidOCR get_mini_boxes: the rectangle ordered top-left, top-right,
   bottom-right, bottom-left, plus its shorter side. */
export function getMiniBoxes(points) {
  const r = minAreaRect(points);
  const pts = r.corners.slice().sort((a, b) => a[0] - b[0]);
  let i1, i2, i3, i4;
  if (pts[1][1] > pts[0][1]) { i1 = 0; i4 = 1; } else { i1 = 1; i4 = 0; }
  if (pts[3][1] > pts[2][1]) { i2 = 2; i3 = 3; } else { i2 = 3; i3 = 2; }
  return { box: [pts[i1], pts[i2], pts[i3], pts[i4]], sside: Math.min(r.size[0], r.size[1]) };
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    // On an edge counts as inside, as cv2.fillPoly paints edge pixels.
    const minX = Math.min(xi, xj), maxX = Math.max(xi, xj), minY = Math.min(yi, yj), maxY = Math.max(yi, yj);
    if (x >= minX - 0.5 && x <= maxX + 0.5 && y >= minY - 0.5 && y <= maxY + 0.5) {
      const len = Math.hypot(xj - xi, yj - yi);
      if (len === 0 ? Math.hypot(x - xi, y - yi) <= 0.5 : Math.abs((xj - xi) * (yi - y) - (xi - x) * (yj - yi)) / len <= 0.5) return true;
    }
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* Mean probability inside the box - RapidOCR's box_score_fast. */
export function boxScoreFast(pred, w, h, box) {
  const clamp = (v, hi) => Math.min(Math.max(v, 0), hi);
  const xs = box.map((p) => p[0]), ys = box.map((p) => p[1]);
  const xmin = clamp(Math.floor(Math.min(...xs)), w - 1), xmax = clamp(Math.ceil(Math.max(...xs)), w - 1);
  const ymin = clamp(Math.floor(Math.min(...ys)), h - 1), ymax = clamp(Math.ceil(Math.max(...ys)), h - 1);
  const poly = box.map((p) => [Math.trunc(p[0] - xmin), Math.trunc(p[1] - ymin)]);
  let sum = 0, count = 0;
  for (let y = 0; y <= ymax - ymin; y++) {
    for (let x = 0; x <= xmax - xmin; x++) {
      if (pointInPolygon(x, y, poly)) {
        sum += pred[(ymin + y) * w + xmin + x];
        count++;
      }
    }
  }
  return count ? sum / count : 0;
}

/* Grow the box by area * ratio / perimeter on every side, as pyclipper's
   round-joined offset does. For a convex polygon that offset is the hull of
   circles around its vertices, which is what is built here. */
export function unclip(box, ratio) {
  let area = 0, length = 0;
  for (let i = 0; i < box.length; i++) {
    const a = box[i], b = box[(i + 1) % box.length];
    area += a[0] * b[1] - b[0] * a[1];
    length += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  area = Math.abs(area) / 2;
  const distance = length ? (area * ratio) / length : 0;
  const out = [];
  const steps = 32;
  for (const p of box) {
    // pyclipper works in integer coordinates.
    const px = Math.trunc(p[0]), py = Math.trunc(p[1]);
    for (let k = 0; k < steps; k++) {
      const t = (2 * Math.PI * k) / steps;
      out.push([Math.round(px + distance * Math.cos(t)), Math.round(py + distance * Math.sin(t))]);
    }
  }
  return out;
}

/* Connected components of the binary map: per component, the row extremes. */
export function componentExtremes(mask, w, h, maxComponents = 1000) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    if (comps.length >= maxComponents) break;
    const id = comps.length + 1;
    const rowMin = new Map(), rowMax = new Map();
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      const lo = rowMin.get(y);
      if (lo === undefined || x < lo) rowMin.set(y, x);
      const hi = rowMax.get(y);
      if (hi === undefined || x > hi) rowMax.set(y, x);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((!dx && !dy) || nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
        }
      }
    }
    const points = [];
    for (const [y, x] of rowMin) {
      points.push([x, y]);
      const x2 = rowMax.get(y);
      if (x2 !== x) points.push([x2, y]);
    }
    comps.push(points);
  }
  return comps;
}

/* pred: Float32Array probability map of size w x h. Boxes come back in the
   coordinates of the destW x destH image the map was computed from. */
export function dbPostprocess(pred, w, h, destW, destH, opts = {}) {
  const { thresh = 0.3, boxThresh = 0.5, maxCandidates = 1000, unclipRatio = 1.6, useDilation = true } = opts;
  const bitmap = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bitmap[i] = pred[i] > thresh ? 1 : 0;
  let mask = bitmap;
  if (useDilation) {
    // cv2.dilate with a 2x2 kernel: anchored at (1,1), so it reaches left and up.
    mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        mask[i] = bitmap[i] | (x > 0 ? bitmap[i - 1] : 0) | (y > 0 ? bitmap[i - w] : 0) | (x > 0 && y > 0 ? bitmap[i - w - 1] : 0);
      }
    }
  }
  const boxes = [], scores = [];
  for (const points of componentExtremes(mask, w, h, maxCandidates)) {
    const { box, sside } = getMiniBoxes(points);
    if (sside < 3) continue;
    const score = boxScoreFast(pred, w, h, box);
    if (boxThresh > score) continue;
    const grown = getMiniBoxes(unclip(box, unclipRatio));
    if (grown.sside < 5) continue;
    boxes.push(grown.box.map(([x, y]) => [
      Math.trunc(Math.min(Math.max(roundHalfEven((x / w) * destW), 0), destW)),
      Math.trunc(Math.min(Math.max(roundHalfEven((y / h) * destH), 0), destH)),
    ]));
    scores.push(score);
  }
  return { boxes, scores };
}

/* RapidOCR filter_tag_det_res: order corners clockwise, clip to the image,
   and drop boxes 3px or less across. */
export function filterDetections(boxes, imgW, imgH) {
  const out = [];
  for (const b of boxes) {
    const xSorted = b.slice().sort((p, q) => p[0] - q[0]);
    const left = xSorted.slice(0, 2).sort((p, q) => p[1] - q[1]);
    const right = xSorted.slice(2).sort((p, q) => p[1] - q[1]);
    const rect = [left[0], right[0], right[1], left[1]].map(([x, y]) => [
      Math.trunc(Math.min(Math.max(x, 0), imgW - 1)),
      Math.trunc(Math.min(Math.max(y, 0), imgH - 1)),
    ]);
    const rw = Math.trunc(Math.hypot(rect[0][0] - rect[1][0], rect[0][1] - rect[1][1]));
    const rh = Math.trunc(Math.hypot(rect[0][0] - rect[3][0], rect[0][1] - rect[3][1]));
    if (rw <= 3 || rh <= 3) continue;
    out.push(rect);
  }
  return out;
}
