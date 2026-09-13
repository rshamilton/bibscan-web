// Headless Firefox driven over WebDriver BiDi. No npm dependencies.
//
// Chromium on this Pi silently never completes requests to localhost, so the UI
// checks run in Firefox instead - a different engine from Chromium, which is if
// anything closer to what the iPhone's Safari does.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBUG = !!process.env.DEBUG;
const t0 = Date.now();
export const log = (...a) => { if (DEBUG) console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a); };

const live = new Set();
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const p of live) { try { p.kill('SIGKILL'); } catch {} }
    if (sig !== 'exit') process.exit(1);
  });
}

export const IPHONE = { width: 390, height: 844, dpr: 2 };
export const DESKTOP = { width: 1366, height: 860, dpr: 1 };

export class Firefox {
  static async launch({ port = 9444, downloadDir = null } = {}) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ffbidi-'));
    // A fake camera and no permission prompt, so getUserMedia can be exercised.
    const prefs = [
      'user_pref("media.navigator.streams.fake", true);',
      'user_pref("media.navigator.permission.disabled", true);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
      'user_pref("remote.prefs.recommended", true);',
    ];
    // Downloads saved straight into a known folder, so a test can open the file.
    if (downloadDir) {
      prefs.push(
        'user_pref("browser.download.folderList", 2);',
        `user_pref("browser.download.dir", ${JSON.stringify(downloadDir)});`,
        'user_pref("browser.download.useDownloadDir", true);',
        'user_pref("browser.download.always_ask_before_handling_new_types", false);',
        'user_pref("browser.download.manager.showWhenStarting", false);',
        'user_pref("browser.download.alwaysOpenPanel", false);',
        'user_pref("browser.helperApps.neverAsk.saveToDisk", "text/csv,application/json");',
      );
    }
    fs.writeFileSync(path.join(profile, 'user.js'), prefs.join('\n'));
    const args = ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${port}`];
    log('launching firefox');
    const proc = spawn('firefox', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    live.add(proc);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    for (let i = 0; i < 120; i++) {
      if (/WebDriver BiDi listening on (ws:\/\/\S+)/.test(stderr)) break;
      await sleep(250);
    }
    const m = stderr.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
    if (!m) { proc.kill('SIGKILL'); throw new Error('firefox BiDi did not start:\n' + stderr.slice(-800)); }
    const ff = new Firefox(proc, profile, m[1].replace(/\/$/, '') + '/session');
    ff.stderrText = () => stderr;
    await ff.connect();
    return ff;
  }

  constructor(proc, profile, url) {
    Object.assign(this, { proc, profile, url, id: 0, pending: new Map(), listeners: [] });
  }

  connect() {
    return new Promise((resolve, reject) => {
      log('ws connect', this.url);
      this.ws = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error('BiDi websocket open timed out')), 15000);
      this.ws.onerror = (e) => { clearTimeout(timer); reject(new Error('BiDi websocket error ' + (e.message || e.type))); };
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.type === 'error' ? p.reject(new Error(`${msg.error}: ${msg.message}`)) : p.resolve(msg.result);
          return;
        }
        for (const l of this.listeners) l(msg);
      };
      this.ws.onopen = async () => {
        clearTimeout(timer);
        try {
          await this.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
          resolve();
        } catch (e) { reject(e); }
      };
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    log('->', method);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`BiDi ${method} no reply in ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); log('<-', method); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  async newPage(device = IPHONE, { preload = null } = {}) {
    const { context } = await this.send('browsingContext.create', { type: 'tab' });
    const page = new Page(this, context);
    await this.send('session.subscribe', { events: ['log.entryAdded'], contexts: [context] });
    this.listeners.push((msg) => {
      if (msg.method !== 'log.entryAdded' || msg.params?.source?.context !== context) return;
      const e = msg.params;
      const line = `[${e.level}] ${e.text}${e.stackTrace?.callFrames?.[0] ? ` @${e.stackTrace.callFrames[0].lineNumber}` : ''}`;
      (e.level === 'error' ? page.errors : page.console).push(line);
    });
    await page.setDevice(device);
    if (preload) {
      await this.send('script.addPreloadScript', { functionDeclaration: preload, contexts: [context] });
    }
    return page;
  }

  async close() {
    try { await this.send('session.end', {}, 3000); } catch {}
    try { this.ws.close(); } catch {}
    live.delete(this.proc);
    this.proc.kill('SIGTERM');
    await sleep(500);
    try { this.proc.kill('SIGKILL'); } catch {}
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch {}
  }
}

export class Page {
  constructor(ff, context) { Object.assign(this, { ff, context, console: [], errors: [] }); }

  setDevice(d) {
    return this.ff.send('browsingContext.setViewport', {
      context: this.context, viewport: { width: d.width, height: d.height }, devicePixelRatio: d.dpr,
    });
  }

  // wait: 'complete' | 'interactive' | 'none'. A reload served by a service
  // worker with the server down never reports 'complete' to BiDi, so offline
  // checks navigate with 'none' and poll the page instead.
  async goto(url, settleMs = 1500, wait = 'complete') {
    await this.ff.send('browsingContext.navigate', { context: this.context, url, wait }, 30000);
    await sleep(settleMs);
  }

  async eval(expression) {
    const r = await this.ff.send('script.evaluate', {
      expression, target: { context: this.context }, awaitPromise: true, resultOwnership: 'none',
      serializationOptions: { maxObjectDepth: 6 },
    });
    if (r.type === 'exception') throw new Error(r.exceptionDetails?.text || 'evaluate threw');
    return deserialize(r.result);
  }

  async waitFor(expression, timeoutMs = 15000, stepMs = 200) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try { if (await this.eval(expression)) return true; } catch {}
      await sleep(stepMs);
    }
    return false;
  }

  async screenshot(file) {
    const r = await this.ff.send('browsingContext.captureScreenshot', { context: this.context, origin: 'viewport' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

// BiDi returns typed remote values; turn them back into plain JS.
function deserialize(v) {
  if (!v) return v;
  switch (v.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return v.value;
    case 'number': return typeof v.value === 'string' ? Number(v.value) : v.value;
    case 'array': return (v.value || []).map(deserialize);
    case 'object': return Object.fromEntries((v.value || []).map(([k, x]) => [typeof k === 'string' ? k : deserialize(k), deserialize(x)]));
    default: return v.value !== undefined ? v.value : `<${v.type}>`;
  }
}
