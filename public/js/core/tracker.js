/* Temporal voting.

   A single frame is never enough. Runners are moving, bibs flap, and OCR will
   occasionally read 3477 as 8477. So we never announce on one read: a bib has
   to turn up in several distinct frames inside a short window, with decent
   average confidence, before we commit to it.

   All times are in seconds. */

class Track {
  constructor(bib, firstEver) {
    this.bib = bib;
    this.firstEver = firstEver; // survives pruning, unlike `seen`
    this.seen = [];             // [ts, conf, x, y, height]
  }

  prune(cutoff) {
    let n = 0;
    while (n < this.seen.length && this.seen[n][0] < cutoff) n++;
    if (n) this.seen.splice(0, n);
  }

  /* How far the box wandered from its own average position, in pixels. */
  driftPx() {
    const points = this.seen.filter((s) => s[2] !== null).map((s) => [s[2], s[3]]);
    if (points.length < 2) return Infinity; // unknown, so never call it static
    const cx = points.reduce((a, p) => a + p[0], 0) / points.length;
    const cy = points.reduce((a, p) => a + p[1], 0) / points.length;
    return Math.max(...points.map(([px, py]) => Math.hypot(px - cx, py - cy)));
  }

  /* Position only: a sign holds within ~2px while a runner's bib travels 100px+
     over the same window. Box size swings ~25% frame to frame on a fixed sign,
     so it is deliberately not part of this test. */
  isStatic(maxDriftPx) {
    return this.driftPx() < maxDriftPx;
  }
}

export class BibTracker {
  constructor(cfg) {
    this.cfg = cfg;
    this.tracks = new Map();
    this.announced = new Map();
    // Cumulative, for benchmarks. Not what a UI should show.
    this.staticSuppressed = new Map();
    // What is being held back *right now*, bib -> when it was last held.
    this.held = new Map();
  }

  /* Record one frame's reading of a bib: when, how sure, where, how big. */
  observe(bib, conf, ts, pos = null, height = null) {
    const [x, y] = pos || [null, null];
    let track = this.tracks.get(bib);
    if (!track) {
      track = new Track(bib, ts);
      this.tracks.set(bib, track);
    }
    // One vote per frame: a bib read twice in the same instant is one look.
    const last = track.seen[track.seen.length - 1];
    if (last && last[0] === ts) {
      if (conf > last[1]) track.seen[track.seen.length - 1] = [ts, conf, x, y, height];
      return;
    }
    track.seen.push([ts, conf, x, y, height]);
  }

  /* Bibs that just crossed the evidence bar. Call once per frame. */
  poll(now) {
    const cfg = this.cfg;
    const cutoff = now - cfg.window_sec;
    const out = [];

    for (const [bib, track] of [...this.tracks]) {
      track.prune(cutoff);
      if (!track.seen.length) {
        this.tracks.delete(bib);
        this.held.delete(bib); // left the frame: stop warning about it
        continue;
      }
      // A bib confirmed moments ago does not have to earn every vote again.
      const last = this.announced.get(bib);
      const trusted = last !== undefined && cfg.trust_window_sec > 0 && now - last <= cfg.trust_window_sec;
      const needVotes = trusted ? cfg.trusted_min_votes : cfg.min_votes;
      const cooldown = trusted ? cfg.trusted_cooldown_sec : cfg.cooldown_sec;

      const votes = track.seen.length;
      if (votes < needVotes) continue;
      const confs = track.seen.map((s) => s[1]);
      const meanConf = confs.reduce((a, c) => a + c, 0) / votes;
      if (meanConf < cfg.min_mean_conf) continue;

      // Anything that hasn't moved is fixed signage, not a runner ("20K" is
      // bib 20). Withhold judgement until the grace period is up; checked
      // before the cooldown so the held state stays accurate for the UI.
      if (cfg.static_suppress_px > 0 && track.isStatic(cfg.static_suppress_px)) {
        if (now - track.firstEver > cfg.static_grace_sec) {
          if (!this.held.has(bib)) this.staticSuppressed.set(bib, (this.staticSuppressed.get(bib) || 0) + 1);
          this.held.set(bib, now);
        }
        continue;
      }

      if (last !== undefined && now - last < cooldown) continue;

      this.announced.set(bib, now);
      this.held.delete(bib); // it moved, so it is a runner after all
      const drift = track.driftPx();
      out.push({
        bib,
        votes,
        meanConf,
        bestConf: Math.max(...confs),
        firstSeen: track.seen[0][0],
        lastSeen: track.seen[votes - 1][0],
        movementPx: drift === Infinity ? 0 : drift,
        trusted,
      });
      track.seen = []; // require fresh evidence next time
    }

    // Highest confidence first, so the clearest read lands on top.
    out.sort((a, b) => b.meanConf - a.meanConf);
    return out;
  }

  /* Bibs with some evidence but not yet enough. */
  pending(now) {
    const cutoff = now - this.cfg.window_sec;
    const out = [];
    for (const track of this.tracks.values()) {
      track.prune(cutoff);
      if (!track.seen.length) continue;
      const confs = track.seen.map((s) => s[1]);
      out.push({ bib: track.bib, votes: confs.length, meanConf: confs.reduce((a, c) => a + c, 0) / confs.length, needs: this.cfg.min_votes });
    }
    return out.sort((a, b) => b.votes - a.votes || (a.bib < b.bib ? -1 : a.bib > b.bib ? 1 : 0));
  }

  lastAnnounced(bib) {
    return this.announced.get(bib) ?? null;
  }

  /* Bibs currently being seen but withheld as fixed signage - only ones still
     in frame, so the UI never nags about a bib you have taken away. */
  heldNow(now) {
    const stale = now - Math.max(this.cfg.window_sec * 2, this.cfg.static_grace_sec);
    return [...this.held].filter(([bib, at]) => at >= stale && this.tracks.has(bib)).map(([bib]) => bib).sort();
  }

  staticSuppressedTotal() {
    let n = 0;
    for (const v of this.staticSuppressed.values()) n += v;
    return n;
  }

  forget(bib) {
    this.tracks.delete(bib);
    this.announced.delete(bib);
    this.held.delete(bib);
  }

  reset() {
    this.tracks.clear();
    this.announced.clear();
    this.held.clear();
    this.staticSuppressed.clear();
  }
}
