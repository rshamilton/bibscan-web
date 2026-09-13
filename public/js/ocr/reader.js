/* Bib text detection and recognition on PP-OCR models in onnxruntime-web.

   Detector, angle classifier and recogniser are driven separately rather than
   as one black box, for one important reason: detection cost scales with input
   area, but recognition quality depends on crop resolution. So we *detect* on
   a downscaled frame and *recognise* from full-resolution crops.

   Everything here is generic OCR. Bib-specific knowledge lives in matching.js,
   which decodes these raw strings against the real roster. */

import { roundHalfEven } from '../core/format.js';
import { dbPostprocess, filterDetections } from './dbpost.js';
import { buildCharset, charsetMask, ctcDecode } from './ctc.js';
import { angleDeg, looksNumeric, quadHeight, quadWidth } from './geometry.js';
import { cropImage, enhance, getPerspectiveTransform, resizeArea, resizeCubic, resizeLinear, rot90ccw, rotate180, warpPerspective } from './image.js';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const BATCH = 6;
const REC_H = 48, REC_W = 320, CLS_W = 192;

/* The detector wants sides that are multiples of 32. */
export function detInputSize(h, w) {
  const maxWh = Math.max(h, w);
  const limit = maxWh < 960 ? 960 : maxWh < 1500 ? 1500 : 2000;
  let ratio = 1;
  if (maxWh > limit) ratio = h > w ? limit / h : limit / w;
  const rh = Math.trunc(roundHalfEven(Math.trunc(h * ratio) / 32) * 32);
  const rw = Math.trunc(roundHalfEven(Math.trunc(w * ratio) / 32) * 32);
  return [rh, rw];
}

/* Write an image as normalised CHW floats, BGR order (the models were trained
   on OpenCV images), into `out` starting at `offset`, padding to `padW`. */
function writeTensor(img, out, offset, padW) {
  const { width: w, height: h, data } = img;
  const plane = h * padW;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const p = y * padW + x;
      out[offset + p] = data[s + 2] / 127.5 - 1;
      out[offset + plane + p] = data[s + 1] / 127.5 - 1;
      out[offset + 2 * plane + p] = data[s] / 127.5 - 1;
    }
  }
}

/* RapidOCR get_rotate_crop_image: warp the quad upright; stand tall crops on their side. */
export function rotateCrop(image, quad) {
  const cw = Math.trunc(Math.max(dist(quad[0], quad[1]), dist(quad[2], quad[3])));
  const ch = Math.trunc(Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2])));
  if (cw < 1 || ch < 1) return null;
  const M = getPerspectiveTransform(quad, [[0, 0], [cw, 0], [cw, ch], [0, ch]]);
  let crop = warpPerspective(image, M, cw, ch, { interp: 'cubic', border: 'replicate' });
  if (ch / cw >= 1.5) crop = rot90ccw(crop);
  return crop;
}

/* Perspective-correct a quad into an upright crop with a margin (bibscan warp_quad). */
export function warpQuad(image, quad, pad = 0.12) {
  const w = Math.max(dist(quad[1], quad[0]), dist(quad[2], quad[3]));
  const h = Math.max(dist(quad[3], quad[0]), dist(quad[2], quad[1]));
  const px = w * pad, py = h * pad;
  const ow = roundHalfEven(w + 2 * px), oh = roundHalfEven(h + 2 * py);
  if (ow < 8 || oh < 8) return null;
  const M = getPerspectiveTransform(quad, [[px, py], [px + w, py], [px + w, py + h], [px, py + h]]);
  return warpPerspective(image, M, ow, oh, { interp: 'linear', border: 'constant' });
}

const stableOrderByAspect = (crops) =>
  crops.map((c, i) => [c.width / c.height, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[1]);

export class BibReader {
  constructor(ort, sessions, keys, cfg) {
    this.ort = ort;
    this.det = sessions.det;
    this.cls = sessions.cls;
    this.rec = sessions.rec;
    this.chars = buildCharset(keys);
    this.setConfig(cfg);
  }

  /* load(name) resolves to the bytes of det.onnx / cls.onnx / rec.onnx, or the JSON text of rec_keys.json. */
  static async create(ort, load, cfg, sessionOptions = {}) {
    const opts = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      // Worker threads sleep between frames instead of busy-waiting: frames
      // arrive a fraction of a second apart, and spinning burns a phone's battery.
      extra: { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } },
      ...sessionOptions,
    };
    const det = await ort.InferenceSession.create(await load('det.onnx'), opts);
    const cls = await ort.InferenceSession.create(await load('cls.onnx'), opts);
    const rec = await ort.InferenceSession.create(await load('rec.onnx'), opts);
    const keys = JSON.parse(await load('rec_keys.json'));
    return new BibReader(ort, { det, cls, rec }, keys, cfg);
  }

  setConfig(cfg) {
    this.cfg = cfg;
    if (this.maskMode !== cfg.charset) {
      this.maskMode = cfg.charset;
      this.mask = charsetMask(this.chars, cfg.charset);
    }
  }

  async run(session, data, dims) {
    const feeds = { [session.inputNames[0]]: new this.ort.Tensor('float32', data, dims) };
    const out = await session.run(feeds);
    return out[session.outputNames[0]];
  }

  /* ------------------------------------------------------------- internals */

  /* Quads in `image` coordinates, detected on a downscaled copy. */
  async detect(image, longSide) {
    const longest = Math.max(image.width, image.height);
    const scale = longest ? Math.min(1, longSide / longest) : 1;
    const small = scale < 1
      ? resizeArea(image, roundHalfEven(image.width * scale), roundHalfEven(image.height * scale), 1 / scale, 1 / scale)
      : image;
    const [rh, rw] = detInputSize(small.height, small.width);
    if (rh <= 0 || rw <= 0) return [];
    const input = resizeLinear(small, rw, rh);
    const data = new Float32Array(3 * rh * rw);
    writeTensor(input, data, 0, rw);
    const pred = await this.run(this.det, data, [1, 3, rh, rw]);
    const [, , ph, pw] = pred.dims;
    const { boxes } = dbPostprocess(pred.data, pw, ph, small.width, small.height, {
      thresh: 0.3, boxThresh: this.cfg.box_thresh, maxCandidates: 1000, unclipRatio: this.cfg.unclip_ratio, useDilation: true,
    });
    return filterDetections(boxes, small.width, small.height).map((q) => q.map(([x, y]) => [x / scale, y / scale]));
  }

  /* Fix 180-degree flips. */
  async classify(crops) {
    crops = crops.slice();
    const order = stableOrderByAspect(crops);
    for (let start = 0; start < order.length; start += BATCH) {
      const idx = order.slice(start, start + BATCH);
      const data = new Float32Array(idx.length * 3 * REC_H * CLS_W);
      idx.forEach((i, k) => {
        const c = crops[i];
        const want = Math.ceil(REC_H * (c.width / c.height));
        const resized = resizeLinear(c, want > CLS_W ? CLS_W : want, REC_H);
        writeTensor(resized, data, k * 3 * REC_H * CLS_W, CLS_W);
      });
      const out = await this.run(this.cls, data, [idx.length, 3, REC_H, CLS_W]);
      const labels = out.dims[1];
      idx.forEach((i, k) => {
        let best = 0;
        for (let l = 1; l < labels; l++) if (out.data[k * labels + l] > out.data[k * labels + best]) best = l;
        if (best === 1 && out.data[k * labels + 1] > 0.9) crops[i] = rotate180(crops[i]);
      });
    }
    return crops;
  }

  async recognizeCrops(crops) {
    const results = new Array(crops.length);
    const order = stableOrderByAspect(crops);
    for (let start = 0; start < order.length; start += BATCH) {
      const idx = order.slice(start, start + BATCH);
      let maxRatio = REC_W / REC_H;
      for (const i of idx) maxRatio = Math.max(maxRatio, crops[i].width / crops[i].height);
      const imgW = Math.trunc(REC_H * maxRatio);
      const data = new Float32Array(idx.length * 3 * REC_H * imgW);
      idx.forEach((i, k) => {
        const c = crops[i];
        const want = Math.ceil(REC_H * (c.width / c.height));
        const resized = resizeLinear(c, want > imgW ? imgW : want, REC_H);
        writeTensor(resized, data, k * 3 * REC_H * imgW, imgW);
      });
      const out = await this.run(this.rec, data, [idx.length, 3, REC_H, imgW]);
      const [n, steps, classes] = out.dims;
      ctcDecode(out.data, n, steps, classes, this.chars, this.mask).forEach((r, k) => { results[idx[k]] = r; });
    }
    return results;
  }

  /* Recognise full-resolution crops for the given quads; null where a crop was empty. */
  async recognize(image, quads) {
    const crops = quads.map((q) => rotateCrop(image, q));
    const live = crops.map((c, i) => [c, i]).filter(([c]) => c && c.width && c.height);
    if (!live.length) return quads.map(() => null);
    const fixed = await this.classify(live.map(([c]) => c));
    const texts = await this.recognizeCrops(fixed);
    const out = quads.map(() => null);
    live.forEach(([, i], k) => { out[i] = texts[k]; });
    return out;
  }

  async recOne(crop) {
    if (!crop || Math.min(crop.width, crop.height) < 8) return null;
    const [fixed] = await this.classify([crop]);
    const [r] = await this.recognizeCrops([fixed]);
    return r || null;
  }

  usable(r) {
    return r.conf >= this.cfg.min_text_conf && quadHeight(r.quad) >= this.cfg.min_box_height_px && !!r.text.trim();
  }

  /* Second attempt at a box that read poorly - usually steep or blurred. Warps
     it upright, enlarges it and boosts local contrast; only replaces the
     original if it actually reads better. Skipped for text that could not be
     a number however it is squinted at. */
  async retryWeak(image, r) {
    if (r.conf >= 0.9 && Math.abs(angleDeg(r.quad)) < 4) return r;
    if (!looksNumeric(r.text)) return r;
    let crop = warpQuad(image, r.quad);
    if (!crop || Math.min(crop.width, crop.height) < 8) return r;
    if (crop.height < 64) {
      const f = 64 / crop.height;
      crop = resizeCubic(crop, roundHalfEven(crop.width * f), 64);
    }
    const got = await this.recOne(enhance(crop));
    if (got && got.conf > r.conf) return { ...r, text: got.text, conf: got.conf, pass: `${r.pass}+warp` };
    return r;
  }

  /* ------------------------------------------------------------------ api */

  /* Every usable text box in a frame, in full-frame coordinates. */
  async read(frame, roi = null) {
    let image = frame, ox = 0, oy = 0;
    if (roi) {
      const [x, y, w, h] = roi;
      image = cropImage(frame, x, y, w, h);
      ox = x; oy = y;
    }
    if (!image.width || !image.height) return [];

    let quads = await this.detect(image, this.cfg.det_long_side);
    let pass = 'base';
    // Nothing found: the runner is probably far away and the bib small.
    if (!quads.length && this.cfg.multiscale) {
      quads = await this.detect(image, this.cfg.det_long_side_fallback);
      pass = 'hi-res';
    }

    // Throw away boxes that cannot be a bib before paying for recognition: too
    // small to trust, or far wider than a few digits could be.
    quads = quads.filter((q) => {
      const h = quadHeight(q);
      return h >= this.cfg.min_box_height_px && h > 0 && quadWidth(q) / h <= this.cfg.max_aspect;
    });
    quads = quads.map((q, i) => [q, i]).sort((a, b) => quadHeight(b[0]) - quadHeight(a[0]) || a[1] - b[1]).map((x) => x[0]);
    if (this.cfg.max_boxes > 0) quads = quads.slice(0, this.cfg.max_boxes);
    if (!quads.length) return [];

    const texts = await this.recognize(image, quads);
    let readings = [];
    quads.forEach((q, i) => { if (texts[i]) readings.push({ text: texts[i].text, conf: texts[i].conf, quad: q, pass }); });

    if (this.cfg.angle_retry) {
      const improved = [];
      for (const r of readings) improved.push(await this.retryWeak(image, r));
      readings = improved;
    }
    return readings
      .filter((r) => this.usable(r))
      .map((r) => ({ ...r, quad: r.quad.map(([x, y]) => [x + ox, y + oy]) }));
  }
}
