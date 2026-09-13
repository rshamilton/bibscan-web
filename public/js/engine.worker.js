/* The recognition engine, off the main thread.

   Loads the three PP-OCR models into onnxruntime-web and runs frames through
   the scanner one at a time. Messages are handled strictly in order: a frame
   that arrives while another is being read waits its turn, but the page only
   ever sends the next frame after the last result came back, so nothing piles
   up - the same "always work on the newest image" rule as the camera path. */

import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { BibReader } from './ocr/reader.js';
import { Scanner } from './ocr/scanner.js';
import { fromRGBA } from './ocr/image.js';

const BASE = new URL('../', import.meta.url);
let scanner = null;
let queue = Promise.resolve();

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

/* Transient failures are retried: on a first visit the service worker is
   installing and fetching the same files at the same moment. */
async function load(name) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(new URL(`models/${name}`, BASE));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return name.endsWith('.json') ? await r.text() : new Uint8Array(await r.arrayBuffer());
    } catch (exc) {
      last = exc;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw new Error(`could not load ${name} (${last && last.message})`);
}

function threadsFor(cfg) {
  if (!self.crossOriginIsolated) return 1;
  if (cfg.ocr.threads > 0) return cfg.ocr.threads;
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
}

async function init({ cfg, bibs }) {
  const started = performance.now();
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', BASE).href;
  ort.env.wasm.numThreads = threadsFor(cfg);
  ort.env.wasm.proxy = false;
  post({ type: 'progress', stage: 'loading models' });
  const reader = await BibReader.create(ort, load, cfg.ocr);
  scanner = new Scanner(reader, cfg, bibs || []);
  post({ type: 'progress', stage: 'warming up' });
  // One small frame compiles the kernels, so the first real frame is not slow.
  await scanner.reader.read({ width: 64, height: 32, data: new Uint8Array(64 * 32 * 3).fill(255) });
  post({
    type: 'ready',
    loadMs: Math.round(performance.now() - started),
    threads: ort.env.wasm.numThreads,
    isolated: !!self.crossOriginIsolated,
  });
}

async function handle(m) {
  switch (m.type) {
    case 'init':
      return init(m);
    case 'config':
      if (scanner) scanner.setConfig(m.cfg);
      return;
    case 'bibs':
      if (scanner) scanner.setBibs(m.bibs || []);
      return;
    case 'reset':
      if (scanner) scanner.tracker.reset();
      return;
    case 'frame': {
      if (!scanner) throw new Error('engine not ready');
      const img = fromRGBA(new Uint8Array(m.buffer), m.width, m.height);
      const out = await scanner.process(img, m.ts);
      post({ type: 'result', id: m.id, width: m.width, height: m.height, fps: scanner.fps, ...out });
      return;
    }
    default:
      throw new Error(`unknown message ${m.type}`);
  }
}

self.onmessage = (e) => {
  const m = e.data;
  queue = queue.then(() => handle(m)).catch((err) => {
    post({ type: 'error', id: m.id ?? null, where: m.type, message: String((err && err.message) || err) });
  });
};
