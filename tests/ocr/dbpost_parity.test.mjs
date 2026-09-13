// Detector post-processing on bibscan's own probability map gives bibscan's boxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dbPostprocess, filterDetections } from '../../public/js/ocr/dbpost.js';
import { detInputSize } from '../../public/js/ocr/reader.js';
import { FIX, matchQuads, reference } from '../helpers/fixtures.mjs';

const d = reference().dbpost;
const bytes = fs.readFileSync(path.join(FIX, 'det_map.f32'));
const pred = new Float32Array(new Uint8Array(bytes).buffer);

test('detector input size follows RapidOCR', () => {
  assert.equal(pred.length, d.map_w * d.map_h);
  assert.deepEqual(detInputSize(d.dest_h, d.dest_w), d.input);
});

test('same boxes as RapidOCR from the same probability map', () => {
  const { boxes } = dbPostprocess(pred, d.map_w, d.map_h, d.dest_w, d.dest_h, { boxThresh: d.box_thresh, unclipRatio: d.unclip_ratio });
  const js = filterDetections(boxes, d.dest_w, d.dest_h);
  assert.equal(js.length, d.boxes.length, `boxes: js ${JSON.stringify(js)} vs py ${JSON.stringify(d.boxes)}`);
  for (const m of matchQuads(d.boxes, js)) assert.ok(m.distance <= 2, `corner off by ${m.distance}px`);
});
