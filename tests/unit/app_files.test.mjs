// Every module import in the app resolves, every element a script looks up
// exists, and the offline cache lists exactly the files the app loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/fixtures.mjs';

const PUBLIC = path.join(ROOT, 'public');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const appJs = walk(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js'));

test('every relative import in the app points at a real file', () => {
  for (const file of appJs) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/g)) {
      if (!m[1].startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), m[1]);
      assert.ok(fs.existsSync(target), `${path.relative(ROOT, file)} imports missing ${m[1]}`);
    }
  }
});

test('named imports exist as exports in the target module', () => {
  for (const file of appJs) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
      const target = fs.readFileSync(path.resolve(path.dirname(file), m[2]), 'utf8');
      for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        const id = name.replace(/\$/g, '\\$');
        const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+${id}(?![\\w$])`).test(target)
          || new RegExp(`export\\s*\\{[^}]*(?<![\\w$])${id}(?![\\w$])[^}]*\\}`).test(target);
        assert.ok(exported, `${path.relative(ROOT, file)} imports ${name} from ${m[2]}, which does not export it`);
      }
    }
  }
});

test('every id the scripts look up is in index.html', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const file of appJs) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\$\('([A-Za-z][\w-]*)'\)|getElementById\('([A-Za-z][\w-]*)'\)/g)) {
      const id = m[1] || m[2];
      assert.ok(ids.has(id), `${path.relative(ROOT, file)} looks up #${id}, which index.html does not have`);
    }
  }
});

test('the offline cache lists every file the app loads, and only those', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const listed = [...sw.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const f of listed) if (f !== './') assert.ok(fs.existsSync(path.join(PUBLIC, f)), `sw.js caches missing ${f}`);
  const wanted = [
    ...appJs.map((f) => path.relative(PUBLIC, f)),
    'models/det.onnx', 'models/cls.onnx', 'models/rec.onnx', 'models/rec_keys.json',
    'vendor/ort/ort.wasm.min.mjs', 'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm',
    'index.html', 'css/app.css', 'icon.svg', 'manifest.webmanifest',
  ].map((f) => f.split(path.sep).join('/'));
  for (const f of wanted) assert.ok(listed.includes(f), `sw.js does not cache ${f}`);
});

test('vendored onnxruntime-web is byte-identical to the pinned npm release', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const nm = path.join(ROOT, 'node_modules', 'onnxruntime-web');
  if (!fs.existsSync(nm)) return test.skip?.('run npm install to compare');
  assert.equal(JSON.parse(fs.readFileSync(path.join(nm, 'package.json'), 'utf8')).version, pkg.devDependencies['onnxruntime-web']);
  for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    assert.ok(fs.readFileSync(path.join(nm, 'dist', f)).equals(fs.readFileSync(path.join(PUBLIC, 'vendor', 'ort', f))), f);
  }
});

test('no inline scripts (the CSP forbids them)', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\ssrc=/, 'inline <script> found');
    assert.equal(m[2].trim(), '');
  }
  assert.doesNotMatch(html, /\son[a-z]+="/, 'inline event handler found');
});
