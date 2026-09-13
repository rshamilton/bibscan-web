/* Image operations the OCR pipeline needs, on plain byte arrays so the same
   code runs in a Web Worker and under Node tests.

   An image is {width, height, data: Uint8Array} with 3 channels, RGB order.
   The sampling rules follow OpenCV (pixel-centre alignment for resize, direct
   mapping for warps, cubic A = -0.75) because the models were tuned on crops
   produced that way. */

import { roundHalfEven } from '../core/format.js';

export function makeImage(width, height) {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

export function cloneImage(img) {
  return { width: img.width, height: img.height, data: img.data.slice() };
}

export function fromRGBA(rgba, width, height) {
  const out = makeImage(width, height);
  const d = out.data;
  for (let i = 0, j = 0, n = width * height; i < n; i++, j += 4) {
    d[i * 3] = rgba[j];
    d[i * 3 + 1] = rgba[j + 1];
    d[i * 3 + 2] = rgba[j + 2];
  }
  return out;
}

export function toRGBA(img) {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0, n = img.width * img.height; i < n; i++) {
    out[i * 4] = img.data[i * 3];
    out[i * 4 + 1] = img.data[i * 3 + 1];
    out[i * 4 + 2] = img.data[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function cropImage(img, x, y, w, h) {
  const out = makeImage(w, h);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.width + x) * 3;
    out.data.set(img.data.subarray(s, s + w * 3), r * w * 3);
  }
  return out;
}

const sat = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/* ------------------------------------------------------------------ resize */

/* cv2.INTER_LINEAR. */
export function resizeLinear(src, dw, dh) {
  const { width: sw, height: sh, data: s } = src;
  if (dw === sw && dh === sh) return cloneImage(src);
  const out = makeImage(dw, dh);
  const d = out.data;
  const tab = (dn, sn) => {
    const i0 = new Int32Array(dn), i1 = new Int32Array(dn), f = new Float32Array(dn);
    const scale = sn / dn;
    for (let k = 0; k < dn; k++) {
      const fx = (k + 0.5) * scale - 0.5;
      let ix = Math.floor(fx);
      let a = fx - ix;
      if (ix < 0) { ix = 0; a = 0; }
      if (ix >= sn - 1) { ix = sn - 1; a = 0; }
      i0[k] = ix;
      i1[k] = Math.min(ix + 1, sn - 1);
      f[k] = a;
    }
    return [i0, i1, f];
  };
  const [x0, x1, ax] = tab(dw, sw);
  const [y0, y1, ay] = tab(dh, sh);
  for (let y = 0; y < dh; y++) {
    const r0 = y0[y] * sw, r1 = y1[y] * sw, b = ay[y], b1 = 1 - b;
    for (let x = 0; x < dw; x++) {
      const a = ax[x], a1 = 1 - a;
      const p00 = (r0 + x0[x]) * 3, p01 = (r0 + x1[x]) * 3, p10 = (r1 + x0[x]) * 3, p11 = (r1 + x1[x]) * 3;
      const o = (y * dw + x) * 3;
      for (let c = 0; c < 3; c++) {
        d[o + c] = sat((s[p00 + c] * a1 + s[p01 + c] * a) * b1 + (s[p10 + c] * a1 + s[p11 + c] * a) * b);
      }
    }
  }
  return out;
}

/* cv2.INTER_AREA for downscaling: each output pixel is the coverage-weighted
   mean of the source pixels under it. `scale` is source pixels per output pixel. */
export function resizeArea(src, dw, dh, scaleX = src.width / dw, scaleY = src.height / dh) {
  const { width: sw, height: sh, data: s } = src;
  if (scaleX <= 1 && scaleY <= 1) return resizeLinear(src, dw, dh);
  const tab = (dn, sn, scale) => {
    const entries = [];
    for (let dx = 0; dx < dn; dx++) {
      const fsx1 = dx * scale;
      const fsx2 = fsx1 + scale;
      const cellWidth = Math.min(scale, sn - fsx1);
      let sx1 = Math.ceil(fsx1);
      let sx2 = Math.floor(fsx2);
      sx2 = Math.min(sx2, sn - 1);
      sx1 = Math.min(sx1, sx2);
      const list = [];
      if (sx1 - fsx1 > 1e-3) list.push([sx1 - 1, (sx1 - fsx1) / cellWidth]);
      for (let sx = sx1; sx < sx2; sx++) list.push([sx, 1 / cellWidth]);
      if (fsx2 - sx2 > 1e-3) list.push([sx2, Math.min(Math.min(fsx2 - sx2, 1), cellWidth) / cellWidth]);
      entries.push(list);
    }
    return entries;
  };
  const xt = tab(dw, sw, scaleX);
  const yt = tab(dh, sh, scaleY);
  // Horizontal pass into floats, then vertical.
  const tmp = new Float32Array(dw * sh * 3);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (const [sx, w] of xt[x]) {
        const p = (row + sx) * 3;
        r += s[p] * w; g += s[p + 1] * w; b += s[p + 2] * w;
      }
      const o = (y * dw + x) * 3;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
  }
  const out = makeImage(dw, dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (const [sy, w] of yt[y]) {
        const p = (sy * dw + x) * 3;
        r += tmp[p] * w; g += tmp[p + 1] * w; b += tmp[p + 2] * w;
      }
      const o = (y * dw + x) * 3;
      out.data[o] = sat(r); out.data[o + 1] = sat(g); out.data[o + 2] = sat(b);
    }
  }
  return out;
}

function cubicCoeffs(x, out) {
  const A = -0.75;
  out[0] = ((A * (x + 1) - 5 * A) * (x + 1) + 8 * A) * (x + 1) - 4 * A;
  out[1] = ((A + 2) * x - (A + 3)) * x * x + 1;
  out[2] = ((A + 2) * (1 - x) - (A + 3)) * (1 - x) * (1 - x) + 1;
  out[3] = 1 - out[0] - out[1] - out[2];
  return out;
}

/* cv2.INTER_CUBIC resize. */
export function resizeCubic(src, dw, dh) {
  const { width: sw, height: sh, data: s } = src;
  const out = makeImage(dw, dh);
  const tab = (dn, sn) => {
    const idx = new Int32Array(dn * 4), w = new Float32Array(dn * 4), c = new Float32Array(4);
    const scale = sn / dn;
    for (let k = 0; k < dn; k++) {
      const f = (k + 0.5) * scale - 0.5;
      const i = Math.floor(f);
      cubicCoeffs(f - i, c);
      for (let t = 0; t < 4; t++) {
        idx[k * 4 + t] = Math.min(sn - 1, Math.max(0, i - 1 + t));
        w[k * 4 + t] = c[t];
      }
    }
    return [idx, w];
  };
  const [xi, xw] = tab(dw, sw);
  const [yi, yw] = tab(dh, sh);
  const tmp = new Float32Array(dw * sh * 3);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 3;
      for (let t = 0; t < 4; t++) {
        const p = (y * sw + xi[x * 4 + t]) * 3, w = xw[x * 4 + t];
        tmp[o] += s[p] * w; tmp[o + 1] += s[p + 1] * w; tmp[o + 2] += s[p + 2] * w;
      }
    }
  }
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      for (let t = 0; t < 4; t++) {
        const p = (yi[y * 4 + t] * dw + x) * 3, w = yw[y * 4 + t];
        r += tmp[p] * w; g += tmp[p + 1] * w; b += tmp[p + 2] * w;
      }
      const o = (y * dw + x) * 3;
      out.data[o] = sat(r); out.data[o + 1] = sat(g); out.data[o + 2] = sat(b);
    }
  }
  return out;
}

/* ------------------------------------------------------------ perspective */

/* The 3x3 matrix mapping the four `src` points onto the four `dst` points. */
export function getPerspectiveTransform(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const p = A[col][col];
    if (Math.abs(p) < 1e-12) throw new Error('degenerate perspective transform');
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / p;
      if (f) for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('singular matrix');
  const inv = 1 / det;
  return [
    A * inv, -(b * i - c * h) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, -(a * f - c * d) * inv,
    C * inv, -(a * h - b * g) * inv, (a * e - b * d) * inv,
  ];
}

/* cv2.warpPerspective. `M` maps source to destination, as OpenCV takes it.
   interp: 'linear' | 'cubic'; border: 'constant' (black) | 'replicate'. */
export function warpPerspective(src, M, dw, dh, { interp = 'linear', border = 'constant' } = {}) {
  const { width: sw, height: sh, data: s } = src;
  const inv = invert3x3(M);
  const out = makeImage(dw, dh);
  const d = out.data;
  const replicate = border === 'replicate';
  const cx = new Float32Array(4), cy = new Float32Array(4);
  const px = (xx, yy, c) => {
    if (replicate) {
      xx = xx < 0 ? 0 : xx >= sw ? sw - 1 : xx;
      yy = yy < 0 ? 0 : yy >= sh ? sh - 1 : yy;
    } else if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) return 0;
    return s[(yy * sw + xx) * 3 + c];
  };
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const w = inv[6] * x + inv[7] * y + inv[8];
      const X = w ? (inv[0] * x + inv[1] * y + inv[2]) / w : 0;
      const Y = w ? (inv[3] * x + inv[4] * y + inv[5]) / w : 0;
      const ix = Math.floor(X), iy = Math.floor(Y);
      const fx = X - ix, fy = Y - iy;
      const o = (y * dw + x) * 3;
      if (!replicate && (ix < -2 || iy < -2 || ix > sw + 1 || iy > sh + 1)) continue;
      if (interp === 'cubic') {
        cubicCoeffs(fx, cx);
        cubicCoeffs(fy, cy);
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let j = 0; j < 4; j++) {
            let row = 0;
            for (let i = 0; i < 4; i++) row += px(ix - 1 + i, iy - 1 + j, c) * cx[i];
            v += row * cy[j];
          }
          d[o + c] = sat(v);
        }
      } else {
        for (let c = 0; c < 3; c++) {
          const v = (px(ix, iy, c) * (1 - fx) + px(ix + 1, iy, c) * fx) * (1 - fy)
            + (px(ix, iy + 1, c) * (1 - fx) + px(ix + 1, iy + 1, c) * fx) * fy;
          d[o + c] = sat(v);
        }
      }
    }
  }
  return out;
}

/* np.rot90: a quarter turn counter-clockwise. */
export function rot90ccw(img) {
  const { width: w, height: h, data: s } = img;
  const out = makeImage(h, w);
  for (let r = 0; r < w; r++) {
    for (let c = 0; c < h; c++) {
      const src = (c * w + (w - 1 - r)) * 3;
      const dst = (r * h + c) * 3;
      out.data[dst] = s[src]; out.data[dst + 1] = s[src + 1]; out.data[dst + 2] = s[src + 2];
    }
  }
  return out;
}

export function rotate180(img) {
  const n = img.width * img.height;
  const out = makeImage(img.width, img.height);
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = (n - 1 - i) * 3;
    out.data[a] = img.data[b]; out.data[a + 1] = img.data[b + 1]; out.data[a + 2] = img.data[b + 2];
  }
  return out;
}

/* ----------------------------------------------------------------- enhance */

const linearToSrgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const labFInv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);

/* OpenCV's 8-bit sRGB -> Lab is fixed-point, and it differs from the float
   formula by a level at places - paper white is L 252, not 251. That matters:
   CLAHE on a small crop has tiles of ~150 pixels and a clip limit of 1, so a
   one-level shift of the dominant white rewrites the tile's whole mapping. So
   this is OpenCV's integer path, table for table. */
const LAB_SHIFT = 12, GAMMA_SHIFT = 3, LAB_SHIFT2 = 15;
const descale = (x, n) => (x + (1 << (n - 1))) >> n;
const GAMMA_TAB = new Uint16Array(256).map((_, i) => {
  const x = i / 255;
  return roundHalfEven(255 * (1 << GAMMA_SHIFT) * (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
});
const CBRT_TAB = new Uint16Array(Math.trunc((255 * 3) / 2) * (1 << GAMMA_SHIFT)).map((_, i) => {
  const x = i / (255 * (1 << GAMMA_SHIFT));
  return roundHalfEven((1 << LAB_SHIFT2) * (x < 0.008856 ? x * 7.787 + 16 / 116 : Math.cbrt(x)));
});
const XYZ_COEFFS = [0.412453, 0.35758, 0.180423, 0.212671, 0.71516, 0.072169, 0.019334, 0.119193, 0.950227]
  .map((v, i) => roundHalfEven(((1 << LAB_SHIFT) * v) / [0.950456, 1, 1.088754][Math.floor(i / 3)]));
const L_SCALE = Math.trunc((116 * 255 + 50) / 100);
const L_SHIFT = -Math.trunc((16 * 255 * (1 << LAB_SHIFT2) + 50) / 100);

/* OpenCV-style CLAHE on one 8-bit channel. */
export function clahe(src, w, h, clipLimit = 2.0, tilesX = 8, tilesY = 8) {
  let ext = src, ew = w, eh = h;
  if (w % tilesX !== 0 || h % tilesY !== 0) {
    // OpenCV pads right and bottom with BORDER_REFLECT_101.
    ew = w + (tilesX - (w % tilesX));
    eh = h + (tilesY - (h % tilesY));
    const refl = (i, n) => {
      if (n === 1) return 0;
      while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
      return i;
    };
    ext = new Uint8Array(ew * eh);
    for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) ext[y * ew + x] = src[refl(y, h) * w + refl(x, w)];
  }
  const tw = ew / tilesX, th = eh / tilesY;
  const tileArea = tw * th;
  const clip = Math.max(Math.trunc((clipLimit * tileArea) / 256), 1);
  const lutScale = 255 / tileArea;
  const luts = new Uint8Array(tilesX * tilesY * 256);
  const hist = new Int32Array(256);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      hist.fill(0);
      for (let y = ty * th; y < (ty + 1) * th; y++) for (let x = tx * tw; x < (tx + 1) * tw; x++) hist[ext[y * ew + x]]++;
      let clipped = 0;
      for (let i = 0; i < 256; i++) if (hist[i] > clip) { clipped += hist[i] - clip; hist[i] = clip; }
      const batch = Math.trunc(clipped / 256);
      let residual = clipped - batch * 256;
      for (let i = 0; i < 256; i++) hist[i] += batch;
      if (residual) {
        const step = Math.max(Math.trunc(256 / residual), 1);
        for (let i = 0; i < 256 && residual > 0; i += step, residual--) hist[i]++;
      }
      const base = (ty * tilesX + tx) * 256;
      let sum = 0;
      for (let i = 0; i < 256; i++) { sum += hist[i]; luts[base + i] = sat(sum * lutScale); }
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const tyf = y / th - 0.5;
    let ty1 = Math.floor(tyf), ty2 = ty1 + 1;
    const ya = tyf - ty1, ya1 = 1 - ya;
    ty1 = Math.max(ty1, 0); ty2 = Math.min(ty2, tilesY - 1);
    for (let x = 0; x < w; x++) {
      const txf = x / tw - 0.5;
      let tx1 = Math.floor(txf), tx2 = tx1 + 1;
      const xa = txf - tx1, xa1 = 1 - xa;
      tx1 = Math.max(tx1, 0); tx2 = Math.min(tx2, tilesX - 1);
      const v = src[y * w + x];
      const l11 = luts[(ty1 * tilesX + tx1) * 256 + v], l12 = luts[(ty1 * tilesX + tx2) * 256 + v];
      const l21 = luts[(ty2 * tilesX + tx1) * 256 + v], l22 = luts[(ty2 * tilesX + tx2) * 256 + v];
      out[y * w + x] = sat((l11 * xa1 + l12 * xa) * ya1 + (l21 * xa1 + l22 * xa) * ya);
    }
  }
  return out;
}

/* 8-bit Lab exactly as cv2.cvtColor(COLOR_RGB2LAB) produces it. L is 0..255;
   a and b are returned centred on zero (the stored byte minus 128). */
export function rgbToLab(img) {
  const { width: w, height: h, data: s } = img;
  const n = w * h;
  const C = XYZ_COEFFS;
  const L = new Uint8Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const byte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0; i < n; i++) {
    const R = GAMMA_TAB[s[i * 3]], G = GAMMA_TAB[s[i * 3 + 1]], Bl = GAMMA_TAB[s[i * 3 + 2]];
    const fX = CBRT_TAB[descale(R * C[0] + G * C[1] + Bl * C[2], LAB_SHIFT)];
    const fY = CBRT_TAB[descale(R * C[3] + G * C[4] + Bl * C[5], LAB_SHIFT)];
    const fZ = CBRT_TAB[descale(R * C[6] + G * C[7] + Bl * C[8], LAB_SHIFT)];
    L[i] = byte(descale(L_SCALE * fY + L_SHIFT, LAB_SHIFT2));
    A[i] = byte(descale(500 * (fX - fY) + 128 * (1 << LAB_SHIFT2), LAB_SHIFT2)) - 128;
    B[i] = byte(descale(200 * (fY - fZ) + 128 * (1 << LAB_SHIFT2), LAB_SHIFT2)) - 128;
  }
  return { L, A, B };
}

export function labToRgb(L, A, B, w, h) {
  const n = w * h;
  const out = makeImage(w, h);
  for (let i = 0; i < n; i++) {
    const l = (L[i] * 100) / 255;
    const fy = (l + 16) / 116;
    const X = labFInv(fy + A[i] / 500) * 0.950456;
    const Y = l > 7.9996 ? fy * fy * fy : l / 903.3;
    const Z = labFInv(fy - B[i] / 200) * 1.088754;
    const r = 3.240479 * X - 1.53715 * Y - 0.498535 * Z;
    const g = -0.969256 * X + 1.875991 * Y + 0.041556 * Z;
    const b = 0.055648 * X - 0.204043 * Y + 1.057311 * Z;
    out.data[i * 3] = sat(linearToSrgb(Math.min(1, Math.max(0, r))) * 255);
    out.data[i * 3 + 1] = sat(linearToSrgb(Math.min(1, Math.max(0, g))) * 255);
    out.data[i * 3 + 2] = sat(linearToSrgb(Math.min(1, Math.max(0, b))) * 255);
  }
  return out;
}

/* CLAHE on luminance (Lab L). Helps bibs in harsh sun or deep shade. */
export function enhance(img) {
  const { width: w, height: h } = img;
  if (!w || !h) return img;
  const { L, A, B } = rgbToLab(img);
  return labToRgb(clahe(L, w, h), A, B, w, h);
}

export { roundHalfEven };
