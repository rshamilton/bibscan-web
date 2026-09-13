// A BibReader running the real models in Node, on the same onnxruntime-web
// release that is vendored into public/vendor/ort.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { BibReader } from '../../public/js/ocr/reader.js';
import { build } from '../../public/js/core/settings.js';
import { ROOT } from './fixtures.mjs';

ort.env.wasm.numThreads = Math.max(1, Math.min(4, os.cpus().length));

export function loadModelFile(name) {
  const p = path.join(ROOT, 'public', 'models', name);
  return name.endsWith('.json') ? fs.readFileSync(p, 'utf8') : fs.readFileSync(p);
}

let pending = null;
export function getReader(cfg = build().ocr) {
  pending ??= BibReader.create(ort, async (name) => loadModelFile(name), cfg);
  return pending;
}
