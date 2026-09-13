// The whole pipeline on synthetic runners: OCR, roster decoding, voting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Scanner } from '../../public/js/ocr/scanner.js';
import { build } from '../../public/js/core/settings.js';
import { demoRunners } from '../../public/js/core/demo.js';
import { frame } from '../helpers/fixtures.mjs';
import { getReader } from '../helpers/ocr.mjs';

const reader = await getReader();
const DEMO_BIBS = demoRunners().map((r) => r.bib);

// Reading a frame is deterministic, so identical frames are read once. `shift`
// moves the boxes, standing in for a runner moving between frames.
const cache = new Map();
const cachedReader = (shift = () => [0, 0]) => {
  let n = 0;
  return {
    setConfig() {},
    async read(img, roi) {
      if (!cache.has(img.name)) cache.set(img.name, await reader.read(img, roi));
      const [dx, dy] = shift(n++);
      return cache.get(img.name).map((r) => ({ ...r, quad: r.quad.map(([x, y]) => [x + dx, y + dy]) }));
    },
  };
};

async function run(scanner, names) {
  const announced = [], observed = [];
  for (let i = 0; i < names.length; i++) {
    const out = await scanner.process(frame(names[i]), i * 0.25);
    announced.push(...out.confirmations.map((c) => c.bib));
    observed.push(out.observations.map((o) => o.bib));
  }
  return { announced, observed };
}

test('a runner crossing the frame is announced, by the right bib', async () => {
  const s = new Scanner(cachedReader(), build(), DEMO_BIBS);
  const { announced } = await run(s, [0, 1, 2, 3].map((i) => `cross_1147_${i}`));
  assert.deepEqual(announced, ['1147']);
});

test('an angled, motion-blurred bib is announced', async () => {
  const s = new Scanner(cachedReader(), build(), DEMO_BIBS);
  const { announced } = await run(s, [0, 1, 2, 3, 4].map((i) => `angled_1203_${i}`));
  assert.deepEqual(announced, ['1203']);
});

test('one good frame is not enough', async () => {
  const s = new Scanner(cachedReader(), build(), DEMO_BIBS);
  const out = await s.process(frame('mixed_1300'), 0);
  assert.deepEqual(out.observations.map((o) => o.bib), ['1300']);
  assert.deepEqual(out.confirmations, []);
});

test('a bib that never moves is treated as signage', async () => {
  const s = new Scanner(cachedReader(), build(), DEMO_BIBS);
  const { announced } = await run(s, Array(40).fill('static_1188')); // past the 6s grace period
  assert.deepEqual(announced, []);
  assert.ok(s.tracker.staticSuppressed.get('1188') >= 1);
});

test('fixed signage that is a valid bib ("20K" -> 20) is never announced', async () => {
  const s = new Scanner(cachedReader(), build(), [...DEMO_BIBS, '20']);
  const { announced, observed } = await run(s, Array(40).fill('signage'));
  assert.ok(observed.flat().includes('20'), 'expected the sign to be read as bib 20');
  assert.deepEqual(announced, []);
  assert.ok(s.tracker.staticSuppressedTotal() >= 1);
});

test('with four-digit bibs, "20K" is not even a candidate', async () => {
  const s = new Scanner(cachedReader(), build(), DEMO_BIBS);
  const { observed } = await run(s, ['signage']);
  assert.deepEqual(observed.flat(), []);
});

test('mixed difficulty: every runner announced correctly, nobody wrong', async () => {
  for (const bib of ['1004', '1099', '1256', '1512', '1618', '1300']) {
    const s = new Scanner(cachedReader((n) => [n * 30, n * 6]), build(), DEMO_BIBS);
    const { announced } = await run(s, Array(3).fill(`mixed_${bib}`));
    assert.deepEqual(announced, [bib], `runner ${bib}`);
  }
});

test('the read boxes of announced bibs are labelled for the overlay', async () => {
  const s = new Scanner(cachedReader(), build(), DEMO_BIBS);
  const out = await s.process(frame('cross_1147_2'), 0);
  const labelled = out.readings.filter((r) => r.bib);
  assert.deepEqual(labelled.map((r) => r.bib), ['1147']);
  assert.equal(labelled[0].quad.length, 4);
});
