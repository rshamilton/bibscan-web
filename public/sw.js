/* Offline support. After one visit the whole scanner - page, engine, models -
   works with no connection to anything, which is what a phone at a race needs.

   Models and the WebAssembly runtime are large and never change without a new
   file, so they are served from the cache first. Code is fetched fresh when the
   server is reachable and falls back to the cache when it is not. Race-data
   requests are never cached. */

const CACHE = 'bibscan-web-v1';

const FILES = [
  './',
  'index.html',
  'css/app.css',
  'icon.svg',
  'manifest.webmanifest',
  'js/app.js',
  'js/engine.js',
  'js/engine.worker.js',
  'js/store-idb.js',
  'js/synth.js',
  'js/ui.js',
  'js/views/history.js',
  'js/views/setup.js',
  'js/core/athlinks.js',
  'js/core/csv.js',
  'js/core/demo.js',
  'js/core/format.js',
  'js/core/index.js',
  'js/core/matching.js',
  'js/core/settings.js',
  'js/core/sync.js',
  'js/core/tracker.js',
  'js/ocr/ctc.js',
  'js/ocr/dbpost.js',
  'js/ocr/geometry.js',
  'js/ocr/image.js',
  'js/ocr/reader.js',
  'js/ocr/scanner.js',
  'models/det.onnx',
  'models/cls.onnx',
  'models/rec.onnx',
  'models/rec_keys.json',
  'vendor/ort/ort.wasm.min.mjs',
  'vendor/ort/ort-wasm-simd-threaded.mjs',
  'vendor/ort/ort-wasm-simd-threaded.wasm',
];

const HEAVY = /\/(models|vendor)\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    // 'no-cache' revalidates against the HTTP cache (a 304 from the server)
    // rather than downloading the models a second time.
    caches.open(CACHE).then((cache) => Promise.allSettled(FILES.map((f) => cache.add(new Request(f, { cache: 'no-cache' }))))),
  );
  self.skipWaiting();
});

/* No clients.claim(): a page starts using the worker on its next load. Claiming
   the open pages from inside activation left Firefox stuck in "activating", and
   every request from a claimed page - API calls included - waited on it forever. */
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});

function remember(request, response) {
  if (response.ok && response.type === 'basic') {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/proxy/') || url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  if (HEAVY.test(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => remember(request, res))));
    return;
  }
  event.respondWith(networkFirst(request));
});

/* The network if it answers, the cache if it fails - or if it has not answered
   after a few seconds. A server that has become unreachable (a phone walked out
   of Wi-Fi range) can leave a request hanging for a minute before it fails. */
function networkFirst(request) {
  const cached = () => caches.match(request, { ignoreSearch: true })
    .then((hit) => hit || (request.mode === 'navigate' ? caches.match('index.html') : undefined));
  return new Promise((resolve) => {
    let settled = false;
    const settle = (res) => {
      if (!settled && res) {
        settled = true;
        resolve(res);
      }
    };
    fetch(request)
      .then((res) => settle(remember(request, res)))
      .catch(() => cached().then((hit) => settle(hit || Response.error())));
    setTimeout(() => { if (!settled) cached().then(settle); }, 3000);
  });
}
