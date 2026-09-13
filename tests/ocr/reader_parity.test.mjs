// The full reader on real models, frame by frame, against what bibscan read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../../public/js/core/settings.js';
import { frame, matchQuads, reference } from '../helpers/fixtures.mjs';
import { getReader } from '../helpers/ocr.mjs';

const ref = reference();
const reader = await getReader();

test("defaults match bibscan's config.toml", () => {
  for (const [k, v] of Object.entries(ref.config.ocr)) {
    if (k === 'intra_op_num_threads') continue;
    assert.deepEqual(DEFAULTS.ocr[k], v, `ocr.${k}`);
  }
});

for (const [name, want] of Object.entries(ref.frames)) {
  test(`${name}: detector finds the same text boxes`, async () => {
    const quads = await reader.detect(frame(name), DEFAULTS.ocr.det_long_side);
    assert.equal(quads.length, want.det_quads.length, `js ${quads.length} boxes vs bibscan ${want.det_quads.length}`);
    // One pixel in the 448px detection map is ~3px in the 1280px frame.
    for (const m of matchQuads(want.det_quads, quads)) assert.ok(m.distance <= 9, `box corner off by ${m.distance.toFixed(1)}px`);
  });

  test(`${name}: reads the same text`, async () => {
    const got = await reader.read(frame(name));
    const pairs = matchQuads(want.readings.map((r) => r.quad), got.map((r) => r.quad));
    const table = want.readings.map((r, i) => `${JSON.stringify(r.text)}@${r.conf} -> ${pairs[i].index >= 0 ? `${JSON.stringify(got[pairs[i].index].text)}@${got[pairs[i].index].conf.toFixed(4)}` : 'nothing'}`);
    assert.equal(got.length, want.readings.length, `js read ${JSON.stringify(got.map((r) => r.text))}; bibscan ${JSON.stringify(want.readings.map((r) => r.text))}`);
    want.readings.forEach((r, i) => {
      const g = got[pairs[i].index];
      assert.ok(pairs[i].centerShift <= 9, `box moved ${pairs[i].centerShift}px: ${table[i]}`);
      assert.equal(g.text.trim(), r.text.trim(), table.join('; '));
      assert.ok(Math.abs(g.conf - r.conf) <= 0.03, `confidence: ${table[i]}`);
    });
    if (want.bib) assert.ok(got.some((r) => r.text.trim() === want.bib), `bib ${want.bib} not read`);
  });
}
