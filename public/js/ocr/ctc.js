/* CTC decoding for the PP-OCR recogniser, restricted to the characters a bib
   could contain.

   The bundled model has 6,625 output classes and only 95 are ASCII - the rest
   are CJK. Pointed at ordinary scenery it will decode texture as confident-
   looking foreign text. Excluding the disallowed classes from the argmax
   removes that whole category of noise. "ascii" rather than "digits" is the
   default on purpose: forcing digits would render the word WATER as some
   number and invent a bib that was never there. */

/* The model's class list: CTC blank, the embedded dictionary, then a space. */
export function buildCharset(keys) {
  return ['blank', ...keys, ' '];
}

const isAscii = (ch) => ch.charCodeAt(0) < 128;

/* Uint8Array of allowed classes, or null when everything is allowed. */
export function charsetMask(chars, mode) {
  if (mode !== 'ascii' && mode !== 'digits') return null;
  const mask = new Uint8Array(chars.length);
  chars.forEach((ch, i) => {
    if (i === 0 || [...ch].length !== 1) mask[i] = 1; // the CTC blank must stay enabled
    else if (mode === 'digits') mask[i] = ch >= '0' && ch <= '9' ? 1 : 0;
    else mask[i] = isAscii(ch) ? 1 : 0;
  });
  return mask;
}

/* data: Float32Array [batch, steps, classes] of probabilities. */
export function ctcDecode(data, batch, steps, classes, chars, mask = null) {
  const out = [];
  for (let b = 0; b < batch; b++) {
    let text = '';
    let confSum = 0, confN = 0;
    let prev = -1;
    for (let t = 0; t < steps; t++) {
      const base = (b * steps + t) * classes;
      let best = -1, bestP = -Infinity;
      for (let c = 0; c < classes; c++) {
        const p = mask && !mask[c] ? 0 : data[base + c];
        if (p > bestP) { bestP = p; best = c; }
      }
      if (best !== prev && best !== 0) {
        text += chars[best] ?? '';
        confSum += bestP;
        confN++;
      }
      prev = best;
    }
    out.push({ text, conf: confN ? confSum / confN : 0 });
  }
  return out;
}
