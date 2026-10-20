// Tests for web/check.js (folder checks) and web/zip.js (zip builder). The zip is verified by the real Lambda validation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../web/check.js';
import { buildZip } from '../web/zip.js';

const here = dirname(fileURLToPath(import.meta.url));
const python = spawnSync('python', ['--version']).status === 0 ? 'python' : 'python3';
const item = (path, text = 'x') => ({ path, file: new Blob([text]) });
const items = (spec) => Object.entries(spec).map(([p, t]) => item(p, t));
const levels = (r) => r.checks.map((c) => c.level);
const errors = (r) => r.checks.filter((c) => c.level === 'error').map((c) => c.text).join(' | ');
const SOURCE = '<script type="module" src="/src/main.jsx"></script>';
const BUILT = '<script type="module" src="/assets/index-a1b2.js"></script>';

// ---- analyze ----
let r = await analyze(items({ 'site/index.html': BUILT, 'site/assets/app.js': '1', 'site/.DS_Store': '' }));
assert.ok(r.ok, errors(r));
assert.equal(r.root, 'site/');
assert.deepEqual(r.files.map((f) => f.path).sort(), ['assets/app.js', 'index.html'], 'top folder stripped, junk ignored');

r = await analyze(items({ 'index.html': BUILT, 'a.js': '1' }));
assert.ok(r.ok && r.root === '', 'loose files at the root');

r = await analyze(items({ 'proj/package.json': '{}', 'proj/index.html': SOURCE, 'proj/src/main.jsx': 'x', 'proj/dist/index.html': BUILT, 'proj/dist/assets/a.js': '1' }));
assert.ok(r.ok, errors(r));
assert.equal(r.root, 'proj/dist/', 'whole project dropped: dist/ is auto-detected');

r = await analyze(items({ 'proj/index.html': SOURCE, 'proj/src/main.jsx': 'x' }));
assert.ok(!r.ok && /source code/.test(errors(r)), 'source folder without a build is rejected');

r = await analyze(items({ 'proj/package.json': '{}', 'proj/src/a.js': 'x' }));
assert.ok(!r.ok && /No index\.html/.test(errors(r)));
assert.ok(!(await analyze([])).ok);

r = await analyze([...items({ 'site/index.html': BUILT }), { path: 'site/node_modules/', skipped: true }]);
assert.ok(!r.ok && /node_modules/.test(errors(r)), 'node_modules inside the upload is rejected');
r = await analyze([...items({ 'proj/dist/index.html': BUILT, 'proj/package.json': '{}' }), { path: 'proj/node_modules/', skipped: true }]);
assert.ok(r.ok, 'node_modules outside dist/ is fine');

r = await analyze(items({ 'index.html': BUILT, '.env.local': 'SECRET=1' }));
assert.ok(!r.ok && /\.env/.test(errors(r)));

r = await analyze(items({ 'index.html': BUILT, 'my photo.png': 'x', 'ok.png': 'x' }));
assert.ok(!r.ok && /my photo\.png/.test(errors(r)), 'spaces in names are blocked');
r = await analyze(items({ 'index.html': BUILT, 'Logo.png': 'x' }));
assert.ok(r.ok && levels(r).includes('warn'), 'capital letters only warn');
r = await analyze(items({ 'index.html': '<img src="http://localhost:5173/a.png">' }));
assert.ok(r.ok && levels(r).includes('warn'), 'localhost reference warns');

const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`f${i}.txt`, 'x']));
r = await analyze(items({ 'index.html': BUILT, ...many }));
assert.ok(!r.ok && /Too many files/.test(errors(r)));
r = await analyze([item('index.html', BUILT), { path: 'big.bin', file: { size: 201 * 1024 * 1024, text: async () => '' } }]);
assert.ok(!r.ok && /too large/.test(errors(r)));

r = await analyze([item('index.html', BUILT), { path: 'photos.bin', file: { size: 60 * 1024 * 1024, text: async () => '' } }]);
assert.ok(r.ok && r.checks.some((c) => c.level === 'warn' && /60 MB/.test(c.text)), 'big sites get an early warning, not a block');

// ---- zip: build in Node, then let the real Lambda code validate and read it ----
const files = [
  { path: 'index.html', file: new Blob([BUILT.repeat(50)]) },
  { path: 'assets/app.js', file: new Blob(['console.log("héllo");'.repeat(100)]) },
  { path: 'assets/empty.txt', file: new Blob([]) },
  { path: 'assets/ünï.svg', file: new Blob(['<svg/>']) },
  { path: 'img/photo.bin', file: new Blob([crypto.getRandomValues(new Uint8Array(5000))]) }, // incompressible -> stored
];
const progress = [];
const zip = await buildZip(files, (done, total) => progress.push([done, total]));
assert.deepEqual(progress.at(-1), [5, 5]);
const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
try {
  writeFileSync(join(dir, 'site.zip'), Buffer.from(await zip.arrayBuffer()));
  const script = `
import os, sys, zipfile
os.environ.update(AWS_REGION="us-east-1", AWS_ACCESS_KEY_ID="x", AWS_SECRET_ACCESS_KEY="x", BUCKET="b", DISTRIBUTION_ID="E", DISTRIBUTION_DOMAIN="d", KEYS_PARAM="/k")
sys.path.insert(0, sys.argv[1])
import app
z = zipfile.ZipFile(sys.argv[2])
assert z.testzip() is None, "CRC check failed"
entries = app.site_entries(z)
assert sorted(entries) == ["assets/app.js", "assets/empty.txt", "assets/ünï.svg", "img/photo.bin", "index.html"], sorted(entries)
assert z.read("assets/app.js").decode() == 'console.log("héllo");' * 100
assert z.getinfo("index.html").compress_type == 8 and z.getinfo("img/photo.bin").compress_type == 0
print("ok")`;
  const py = spawnSync(python, ['-c', script, join(here, '..', 'lambda'), join(dir, 'site.zip')], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr || py.stdout);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('test_web.mjs: all passed');
