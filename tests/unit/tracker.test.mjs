// Temporal voting: what it takes before a bib is announced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BibTracker } from '../../public/js/core/tracker.js';

function make(kw = {}) {
  return new BibTracker({
    window_sec: 3.0, min_votes: 3, min_mean_conf: 0.65, cooldown_sec: 10.0,
    static_suppress_px: 8.0, static_grace_sec: 6.0,
    trust_window_sec: 20.0, trusted_min_votes: 1, trusted_cooldown_sec: 3.0,
    ...kw,
  });
}
const bibs = (out) => out.map((c) => c.bib);

test('needs enough votes', () => {
  const t = make();
  assert.deepEqual(t.poll(0.0), []);
  t.observe('3477', 0.9, 0.0, [10, 10], 40.0);
  assert.deepEqual(t.poll(0.0), []);
  t.observe('3477', 0.9, 0.3, [30, 12], 40.0);
  assert.deepEqual(t.poll(0.3), []);
  t.observe('3477', 0.9, 0.6, [55, 15], 40.0);
  assert.deepEqual(bibs(t.poll(0.6)), ['3477']);
});

test('low confidence never confirms', () => {
  const t = make();
  for (let i = 0; i < 6; i++) t.observe('9999', 0.4, i * 0.2, [i * 10, 5], 40.0);
  assert.deepEqual(t.poll(1.2), []);
});

test('votes outside the window expire', () => {
  const t = make();
  t.observe('123', 0.9, 0.0, [0, 0], 40.0);
  t.observe('123', 0.9, 0.5, [5, 0], 40.0);
  t.observe('123', 0.9, 9.0, [9, 0], 40.0);
  assert.deepEqual(t.poll(9.0), []);
});

test('cooldown blocks immediate repeat', () => {
  const t = make();
  for (let i = 0; i < 3; i++) t.observe('3477', 0.9, i * 0.2, [i * 40, 10], 40.0);
  assert.deepEqual(bibs(t.poll(0.4)), ['3477']);
  for (let i = 0; i < 3; i++) t.observe('3477', 0.9, 1.0 + i * 0.2, [i * 40, 10], 40.0);
  // Trusted re-announcement still respects the trusted cooldown (3s).
  assert.deepEqual(t.poll(1.4), []);
});

test('moving bib reannounces after cooldown', () => {
  const t = make();
  for (let i = 0; i < 3; i++) t.observe('3477', 0.95, i * 0.2, [i * 60, 10], 40.0);
  assert.deepEqual(bibs(t.poll(0.4)), ['3477']);
  for (let i = 0; i < 3; i++) t.observe('3477', 0.95, 20.0 + i * 0.2, [i * 60, 400], 40.0);
  assert.deepEqual(bibs(t.poll(20.4)), ['3477']);
});

test('static signage is never announced', () => {
  const t = make({ static_grace_sec: 6.0 });
  for (let ts = 0; ts < 12.0; ts += 0.25) {
    t.observe('20', 0.95, ts, [640.0, 100.0], 40.0);
    assert.deepEqual(t.poll(ts), []);
  }
  assert.ok(t.staticSuppressed.get('20') >= 1);
});

test('a bib that starts moving within the grace period is announced', () => {
  const t = make({ static_grace_sec: 6.0 });
  for (let i = 0; i < 4; i++) t.observe('3477', 0.95, i * 0.3, [640.0 + i * 25, 100.0], 40.0);
  assert.deepEqual(bibs(t.poll(0.9)), ['3477']);
});

test('a runner coming straight at the camera counts as moving', () => {
  const t = make({ static_grace_sec: 6.0 });
  for (let i = 0; i < 4; i++) t.observe('3477', 0.95, i * 0.3, [640.0 + i * 9, 360.0 + i * 12], 40.0 + i * 14);
  assert.deepEqual(bibs(t.poll(0.9)), ['3477']);
});

test('detector jitter on a sign is not mistaken for motion', () => {
  const t = make({ static_grace_sec: 6.0 });
  const wobble = [[0.0, 0.0, 22.0], [0.0, 0.0, 34.0], [3.0, 0.0, 36.0], [2.0, 1.0, 28.0]];
  for (let ts = 0; ts < 12.0; ts += 0.25) {
    const [dx, dy, h] = wobble[Math.floor(ts / 0.25) % wobble.length];
    t.observe('20', 0.95, ts, [640.0 + dx, 100.0 + dy], h);
    assert.deepEqual(t.poll(ts), [], `announced signage at t=${ts}`);
  }
  assert.ok(t.staticSuppressed.get('20') >= 1);
});

test('static filter can be disabled', () => {
  const t = make({ static_suppress_px: 0.0 });
  for (let i = 0; i < 3; i++) t.observe('20', 0.95, i * 0.2, [640.0, 100.0], 40.0);
  assert.deepEqual(bibs(t.poll(0.4)), ['20']);
});

test('pending reports progress', () => {
  const t = make();
  t.observe('777', 0.9, 0.0, [1, 1], 40.0);
  t.observe('777', 0.9, 0.2, [2, 1], 40.0);
  const [p] = t.pending(0.2);
  assert.deepEqual([p.bib, p.votes, p.needs], ['777', 2, 3]);
});

test('one vote per frame', () => {
  const t = make();
  for (let i = 0; i < 5; i++) t.observe('3477', 0.9, 0.0, [10, 10], 40.0);
  assert.deepEqual(t.poll(0.0), []);
});

test('held state clears when the bib leaves the frame', () => {
  const t = make({ static_grace_sec: 6.0, cooldown_sec: 30.0 });
  let ts = 0.0;
  while (ts < 12.0) { t.observe('20', 0.95, ts, [640.0, 100.0], 40.0); t.poll(ts); ts += 0.25; }
  assert.deepEqual(t.heldNow(ts), ['20']);
  for (let i = 0; i < 20; i++) { ts += 0.25; t.poll(ts); }
  assert.deepEqual(t.heldNow(ts), []);
});

test('held state clears once the bib moves', () => {
  const t = make({ static_grace_sec: 6.0, cooldown_sec: 30.0 });
  let ts = 0.0;
  while (ts < 9.0) { t.observe('30', 0.95, ts, [100.0, 100.0], 40.0); t.poll(ts); ts += 0.25; }
  assert.deepEqual(t.heldNow(ts), ['30']);
  const announced = [];
  for (let i = 0; i < 4; i++) {
    t.observe('30', 0.95, ts, [100.0 + i * 45, 100.0], 40.0);
    announced.push(...bibs(t.poll(ts)));
    ts += 0.3;
  }
  assert.deepEqual(announced, ['30']);
  assert.deepEqual(t.heldNow(ts), []);
});

test('static counter counts transitions, not polls', () => {
  const t = make({ static_grace_sec: 6.0 });
  for (let ts = 0; ts < 20.0; ts += 0.25) { t.observe('20', 0.95, ts, [640.0, 100.0], 40.0); t.poll(ts); }
  assert.equal(t.staticSuppressed.get('20'), 1);
});

function confirmThenLeave(t) {
  let ts = 0.0, out = [];
  for (let i = 0; i < 3; i++) { t.observe('1234', 0.95, ts, [100 + i * 40, 200], 40.0); out = t.poll(ts); ts += 0.3; }
  return { ts, out };
}

test('a recently confirmed bib comes straight back', () => {
  const t = make();
  let { ts, out } = confirmThenLeave(t);
  assert.deepEqual(bibs(out), ['1234']);
  ts += 5.0; // out of frame long enough to clear the track
  for (let i = 0; i < 3; i++) { t.poll(ts); ts += 0.3; }
  t.observe('1234', 0.95, ts, [400, 260], 46.0);
  out = t.poll(ts);
  assert.deepEqual(bibs(out), ['1234']);
  assert.equal(out[0].trusted, true);
});

test('trust expires', () => {
  const t = make({ trust_window_sec: 5.0 });
  let { ts } = confirmThenLeave(t);
  ts += 30.0;
  for (let i = 0; i < 3; i++) { t.poll(ts); ts += 0.3; }
  t.observe('1234', 0.95, ts, [500, 200], 40.0);
  assert.deepEqual(t.poll(ts), []);
});

test('trust can be disabled', () => {
  const t = make({ trust_window_sec: 0.0 });
  let { ts } = confirmThenLeave(t);
  ts += 5.0;
  for (let i = 0; i < 3; i++) { t.poll(ts); ts += 0.3; }
  t.observe('1234', 0.95, ts, [400, 260], 46.0);
  assert.deepEqual(t.poll(ts), []);
});

test('trust does not bypass the confidence bar', () => {
  const t = make();
  let { ts } = confirmThenLeave(t);
  ts += 5.0;
  for (let i = 0; i < 3; i++) { t.poll(ts); ts += 0.3; }
  t.observe('1234', 0.3, ts, [400, 260], 46.0);
  assert.deepEqual(t.poll(ts), []);
});

test('trust does not resurrect signage', () => {
  const t = make({ static_grace_sec: 2.0 });
  let ts = 0.0;
  for (let i = 0; i < 3; i++) { t.observe('20', 0.95, ts, [100 + i * 40, 200], 40.0); t.poll(ts); ts += 0.3; }
  while (ts < 20.0) {
    t.observe('20', 0.95, ts, [640.0, 100.0], 40.0);
    assert.deepEqual(t.poll(ts), []);
    ts += 0.25;
  }
});

test('reset forgets everything', () => {
  const t = make({ static_suppress_px: 0 });
  for (let i = 0; i < 3; i++) t.observe('55', 0.95, i * 0.2, [i, i], 40);
  assert.deepEqual(bibs(t.poll(0.4)), ['55']);
  t.reset();
  assert.equal(t.lastAnnounced('55'), null);
  assert.equal(t.staticSuppressedTotal(), 0);
});
