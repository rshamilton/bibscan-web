/* The page's handle on the recognition worker. */

export class EngineClient extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.state = 'idle'; // idle | loading | ready | error
    this.detail = '';
    this.error = null;
    this.info = {};
    this.lastFrameAt = 0;
    this.lastElapsed = 0;
    this.nextId = 1;
    this.waiting = new Map();
    this.generation = 0;
  }

  get ready() {
    return this.state === 'ready';
  }

  set(state, patch = {}) {
    Object.assign(this, { state, ...patch });
    this.dispatchEvent(new Event('change'));
  }

  /* Load the models. Resolves when the engine can take frames. */
  start(cfg, bibs) {
    this.stop();
    const generation = ++this.generation;
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
      this.set('error', { error: 'This browser has no Web Workers or WebAssembly, which the scanner needs.' });
      return Promise.reject(new Error(this.error));
    }
    this.set('loading', { detail: 'starting', error: null });
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
      } catch (exc) {
        this.set('error', { error: `could not start the engine: ${exc.message}` });
        reject(exc);
        return;
      }
      this.worker = worker;
      worker.onmessage = (e) => {
        if (generation !== this.generation) return;
        const m = e.data;
        if (m.type === 'progress') this.set('loading', { detail: m.stage });
        else if (m.type === 'ready') {
          this.set('ready', { detail: '', info: { loadMs: m.loadMs, threads: m.threads, isolated: m.isolated } });
          resolve();
        } else if (m.type === 'result') {
          this.lastFrameAt = Date.now();
          this.lastElapsed = m.elapsed;
          this.settle(m.id, null, m);
        } else if (m.type === 'error') {
          if (m.where === 'init') {
            this.set('error', { error: `could not load the models: ${m.message}` });
            reject(new Error(m.message));
          } else if (m.id !== null) this.settle(m.id, new Error(m.message));
          else this.dispatchEvent(new CustomEvent('warning', { detail: m.message }));
        }
      };
      worker.onerror = (e) => {
        if (generation !== this.generation) return;
        e.preventDefault?.();
        const message = e.message || 'the engine failed to load (module worker error)';
        this.set('error', { error: message });
        for (const id of [...this.waiting.keys()]) this.settle(id, new Error(message));
        reject(new Error(message));
      };
      worker.postMessage({ type: 'init', cfg, bibs: [...bibs] });
    });
  }

  stop() {
    this.generation++;
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const id of [...this.waiting.keys()]) this.settle(id, new Error('engine stopped'));
    if (this.state !== 'idle') this.set('idle', { detail: '' });
  }

  settle(id, err, value) {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    err ? w.reject(err) : w.resolve(value);
  }

  post(msg) {
    if (this.worker) this.worker.postMessage(msg);
  }

  setConfig(cfg) { this.post({ type: 'config', cfg }); }
  setBibs(bibs) { this.post({ type: 'bibs', bibs: [...bibs] }); }
  reset() { this.post({ type: 'reset' }); }

  /* One frame of RGBA pixels. The buffer is transferred, not copied. */
  process({ buffer, width, height, ts }) {
    if (!this.ready) return Promise.reject(new Error('engine not ready'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'frame', id, buffer, width, height, ts }, [buffer]);
    });
  }
}
