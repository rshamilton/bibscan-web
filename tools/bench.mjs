// Accuracy benchmark: runs the app's own self-test (Setup page) in headless
// Firefox, on this machine's CPU, and prints the result.
//
//   node tools/bench.mjs                                  30 runners x 5 frames, hard
//   node tools/bench.mjs --count 50 --frames 5 --difficulty mixed
//
// Uses the active race's bibs if the benchmark browser has one, otherwise the
// demo race. Needs Firefox; starts its own server on a spare port.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP, Firefox, sleep } from '../tests/ui/bidi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = { count: 30, frames: 5, difficulty: 'hard', port: 8796 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!(key in args)) {
    console.error(`unknown option ${process.argv[i]}`);
    process.exit(2);
  }
  args[key] = key === 'difficulty' ? process.argv[i + 1] : Number(process.argv[i + 1]);
}

const BASE = `http://127.0.0.1:${args.port}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(args.port)], { stdio: 'ignore' });
let ff;
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
    await sleep(150);
  }
  ff = await Firefox.launch({ port: 9480 });
  const page = await ff.newPage(DESKTOP);
  await page.goto(`${BASE}/?nosw#/setup`, 1500);
  if (!(await page.waitFor(`window.bibscan && bibscan.engine.state === 'ready'`, 180000, 500))) throw new Error('the engine did not load');
  if (!(await page.eval(`bibscan.bibs.size`))) {
    await page.eval(`document.getElementById('demoBtn').click()`);
    await page.waitFor(`bibscan.bibs.size > 0`, 30000);
  }
  const info = await page.eval(`({ race: bibscan.race.name, bibs: bibscan.bibs.size, threads: bibscan.engine.info.threads, ua: navigator.userAgent })`);
  console.log(`race: ${info.race} (${info.bibs} bibs) · ${info.threads} engine threads · ${info.ua}`);
  console.log(`self-test: ${args.count} runners x ${args.frames} frames, ${args.difficulty}\n`);
  await page.eval(`(() => {
    const set = (id, v) => { const s = document.getElementById(id); if (![...s.options].some((o) => o.value === v)) s.add(new Option(v)); s.value = v; };
    set('stCount', '${args.count}'); set('stFrames', '${args.frames}'); set('stDifficulty', '${args.difficulty}');
    document.getElementById('stRun').click();
  })()`);
  const started = Date.now();
  let last = '';
  while (!(await page.eval(`!!document.getElementById('stSummary')`))) {
    const progress = await page.eval(`document.getElementById('stOut').textContent`);
    if (progress !== last) { process.stdout.write(`\r${progress}   `); last = progress; }
    await sleep(2000);
  }
  const text = await page.eval(`(() => {
    const out = [document.getElementById('stSummary').innerText];
    let row = [];
    for (const el of document.querySelector('#stOut .result').children) {
      if (el.classList.contains('h')) { out.push('', el.textContent); continue; }
      row.push(el.textContent);
      if (row.length === 3) { out.push('  ' + row[0].padEnd(18) + row[1].padEnd(12) + row[2]); row = []; }
    }
    return out.join('\\n');
  })()`);
  console.log(`\r${' '.repeat(60)}\r${text}\n\n(${((Date.now() - started) / 60000).toFixed(1)} min)`);
  const wrong = await page.eval(`+document.getElementById('stSummary').dataset.wrong`);
  process.exitCode = wrong ? 1 : 0;
} finally {
  if (ff) await ff.close();
  server.kill();
}
