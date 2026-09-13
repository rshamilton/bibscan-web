/* The pipeline: frame in, confirmed runners out.

     frame -> detect + recognise text      (reader.js)
           -> decode against the roster    (matching.js)
           -> vote across frames           (tracker.js)
           -> confirmations for the page to name and announce

   A bib is never announced on the strength of one frame. */

import { resolve } from '../core/matching.js';
import { BibTracker } from '../core/tracker.js';
import { parseRoi, quadCenter, quadHeight } from './geometry.js';

// How much a decode that needed repairing is discounted before voting: still
// useful evidence, but it needs more frames of agreement to clear the bar.
export const PENALTY_DISCOUNT = new Map([[0, 1.0], [1, 0.85], [1.5, 0.78]]);

export class Scanner {
  constructor(reader, cfg, bibs = []) {
    this.reader = reader;
    this.cfg = cfg;
    this.tracker = new BibTracker(cfg.tracker);
    this.frames = 0;
    this.totalMs = 0;
    this.setBibs(bibs);
  }

  /* Bound the digit search by what this event actually issued. If every bib is
     four digits, a five-digit read is noise by definition. */
  setBibs(bibs) {
    this.bibs = new Set([...bibs].map(String));
    const lengths = this.bibs.size ? [...this.bibs].map((b) => b.length) : [this.cfg.ocr.min_digits, this.cfg.ocr.max_digits];
    this.minDigits = Math.max(this.cfg.ocr.min_digits, Math.min(...lengths));
    this.maxDigits = Math.min(this.cfg.ocr.max_digits, Math.max(...lengths));
  }

  setConfig(cfg) {
    this.cfg = cfg;
    this.tracker.cfg = cfg.tracker;
    if (this.reader.setConfig) this.reader.setConfig(cfg.ocr);
    this.setBibs(this.bibs);
  }

  decode(text) {
    return resolve(text, this.bibs, {
      minDigits: this.minDigits,
      maxDigits: this.maxDigits,
      fuzzy: this.cfg.tracker.fuzzy_match,
      maxEditDistance: this.cfg.tracker.max_edit_distance,
    });
  }

  /* One frame all the way through. `ts` is in seconds on a monotonic clock. */
  async process(frame, ts) {
    const started = performance.now();
    let roi = null;
    try {
      roi = parseRoi(this.cfg.capture.roi, frame.width, frame.height);
    } catch {
      roi = null; // validated on save; never let a bad value stop scanning
    }
    const readings = await this.reader.read(frame, roi);
    this.frames++;

    // Per frame, keep the best-scoring observation of each distinct bib, so one
    // bib visible twice in a frame is still one vote.
    const best = new Map();
    readings.forEach((reading, i) => {
      const match = this.decode(reading.text);
      if (!match) return;
      const conf = reading.conf * (PENALTY_DISCOUNT.get(match.penalty) ?? 0.7);
      const prev = best.get(match.bib);
      if (!prev || conf > prev.conf) best.set(match.bib, { bib: match.bib, conf, raw: reading.text, how: match.how, reading: i });
    });

    const observations = [...best.values()];
    for (const o of observations) {
      const q = readings[o.reading].quad;
      this.tracker.observe(o.bib, o.conf, ts, quadCenter(q), quadHeight(q));
    }
    const confirmations = this.tracker.poll(ts).map((c) => ({ ...c, seenAgo: Math.max(0, ts - c.lastSeen) }));
    const announced = new Set(confirmations.map((c) => c.bib));
    // Runners already on the board read again: lets the page keep them green.
    const seen = observations.filter((o) => !announced.has(o.bib) && this.tracker.lastAnnounced(o.bib) !== null).map((o) => o.bib);

    const elapsed = performance.now() - started;
    this.totalMs += elapsed;
    return {
      readings: readings.map((r, i) => ({
        text: r.text,
        conf: Math.round(r.conf * 1000) / 1000,
        quad: r.quad.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
        bib: (observations.find((o) => o.reading === i) || {}).bib || null,
      })),
      observations: observations.map(({ bib, conf, raw, how }) => ({ bib, conf, raw, how })),
      confirmations,
      seen,
      pending: this.tracker.pending(ts).map(({ bib, votes, needs }) => ({ bib, votes, needs })),
      held: this.tracker.heldNow(ts),
      elapsed,
    };
  }

  get fps() {
    return this.totalMs ? (this.frames * 1000) / this.totalMs : 0;
  }
}
