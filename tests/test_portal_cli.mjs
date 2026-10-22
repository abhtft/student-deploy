// End to end for student/portal-deploy.mjs: the real CLI -> the whole dev server (real portal, gateway and Lambda code on in-memory AWS).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const python = spawnSync('python', ['--version']).status === 0 ? 'python' : 'python3';
const PORT = 8781;
const URL = `http://127.0.0.1:${PORT}`;

const server = spawn(python, [join(here, 'dev_server.py'), String(PORT)], { env: { ...process.env, AWS_DEFAULT_REGION: 'us-east-1' } });
let out = '';
server.stdout.on('data', (d) => (out += d));
server.stderr.on('data', (d) => (out += d));
const work = mkdtempSync(join(tmpdir(), 'portal-cli-'));

try {
  for (let i = 0; i < 100 && !out.includes('Backend demo:'); i++) await new Promise((r) => setTimeout(r, 100));
  const tokens = Object.fromEntries([...out.matchAll(/^\s+(\w+)\s+(mds_\S+)\s+\(expires/gm)].map((m) => [m[1], m[2]]));
  assert.ok(tokens.Alice && tokens.Bob && tokens.Carol && tokens.Erin, `demo tokens not found in:\n${out}`);

  const project = (name, { frontend = true, backend = true } = {}) => {
    const dir = join(work, name);
    if (frontend) {
      mkdirSync(join(dir, 'frontend', 'dist', 'assets'), { recursive: true });
      writeFileSync(join(dir, 'frontend', 'dist', 'index.html'), '<script src="/assets/app.js"></script>');
      writeFileSync(join(dir, 'frontend', 'dist', 'assets', 'app.js'), 'console.log(1)');
    }
    if (backend) {
      mkdirSync(join(dir, 'backend'), { recursive: true });
      copyFileSync(join(root, 'student', 'backend-template', 'python', 'app.py'), join(dir, 'backend', 'app.py'));
    }
    return dir;
  };
  const run = (cwd, token, ...args) =>
    spawnSync('node', [join(root, 'student', 'portal-deploy.mjs'), '--skip-build', ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, PORTAL_URL: URL, PORTAL_TOKEN: token ?? '', PORTAL_READY_TIMEOUT_MS: '30000' },
    });
  const check = (name, fn) => { try { fn(); console.log(`  ok  ${name}`); } catch (e) { console.log(`  FAIL ${name}`); throw e; } };

  // 1. a student with the backend switched on deploys both parts
  const full = project('alice');
  const first = run(full, tokens.Alice);
  check('Alice: backend and frontend both published', () => {
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /Backend ready \(python3\.12\)/);
    assert.match(first.stdout, /Frontend live at https:\/\/alice\.margdarshakss\.com\/ {2}\(2 files/);
    assert.ok(first.stdout.indexOf('Backend ready') < first.stdout.indexOf('Frontend live'), 'backend goes first');
  });
  const hello = await (await fetch(`${URL}/b/alice/hello?name=CLI`)).json();
  check('the deployed backend answers through the gateway', () => assert.deepEqual(hello, { message: 'Hello, CLI!' }));

  // 2. redeploy is fine; a token can be read from .env.local instead of the environment
  writeFileSync(join(full, '.env.local'), `PORTAL_TOKEN="${tokens.Alice}"\n`);
  const again = run(full, undefined, '--only', 'frontend');
  check('redeploy with the token from .env.local, frontend only', () => {
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.doesNotMatch(again.stdout, /Backend/);
  });

  // an app at the repo root (a normal Vite project) next to backend/ is a supported layout: only its build output is published
  const rootLayout = project('rootapp', { frontend: false });
  mkdirSync(join(rootLayout, 'dist'), { recursive: true });
  writeFileSync(join(rootLayout, 'dist', 'index.html'), '<h1>root app</h1>');
  writeFileSync(join(rootLayout, 'dist', '.env'), 'SECRET=1');
  const rootRun = run(rootLayout, tokens.Alice, '--frontend', '.');
  check('app at the repo root: --frontend . publishes dist/ (and backend/ too), never a .env', () => {
    assert.equal(rootRun.status, 0, rootRun.stdout + rootRun.stderr);
    assert.match(rootRun.stdout, /Frontend: packed 1 files from dist\//);
    assert.match(rootRun.stdout, /Backend ready/);
  });
  const noBuild = join(work, 'nobuild');
  mkdirSync(noBuild, { recursive: true });
  writeFileSync(join(noBuild, 'index.html'), '<h1>source</h1>');
  writeFileSync(join(noBuild, '.env'), 'SECRET=1');
  const noBuildRun = run(noBuild, tokens.Alice, '--frontend', '.');
  check('repo root without a build folder is refused, not published as-is', () => {
    assert.notEqual(noBuildRun.status, 0);
    assert.match(noBuildRun.stderr, /No build folder/);
    assert.doesNotMatch(noBuildRun.stdout, /publishing/);
  });

  // 3. refusals each give a clear message and a failing exit code
  const frontOnly = project('bob', { backend: false });
  const bob = run(frontOnly, tokens.Bob);
  check('Bob (expires in 2 days): frontend deploys and a warning is shown', () => {
    assert.equal(bob.status, 0, bob.stdout + bob.stderr);
    assert.match(bob.stderr, /expires soon/);
  });
  check('a folder that is missing is simply skipped', () => assert.doesNotMatch(bob.stdout, /Backend/));
  const bobBackend = run(project('bob2'), tokens.Bob);
  check('backend not enabled by the teacher: clear refusal, exit 1', () => {
    assert.notEqual(bobBackend.status, 0);
    assert.match(bobBackend.stderr, /not enabled|contact site owner/i);
  });
  const carol = run(project('carol'), tokens.Carol);
  check('expired token cannot deploy', () => {
    assert.notEqual(carol.status, 0);
    assert.match(carol.stderr, /cannot deploy right now \(status: expired\)/);
  });
  const erin = run(project('erin'), tokens.Erin);
  check('revoked token is refused at sign-in', () => {
    assert.notEqual(erin.status, 0);
    assert.match(erin.stderr, /401/);
  });
  const none = run(project('nobody'), 'mds_notarealtoken');
  check('unknown token is refused', () => assert.notEqual(none.status, 0));
  const missing = run(project('notoken'), '');
  check('no token: explains how to set PORTAL_TOKEN', () => {
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /PORTAL_TOKEN not found/);
  });

  // 4. local mistakes are caught before anything is uploaded
  const withEnv = project('envfile');
  writeFileSync(join(withEnv, 'backend', '.env'), 'SECRET=1');
  const envRun = run(withEnv, tokens.Alice, '--only', 'backend');
  check('a .env file in backend/ is refused', () => {
    assert.notEqual(envRun.status, 0);
    assert.match(envRun.stderr, /Remove .*\.env/);
    assert.doesNotMatch(envRun.stdout, /packed|publishing/, 'refused locally, before anything is uploaded');
  });
  const both = project('both');
  writeFileSync(join(both, 'backend', 'index.mjs'), 'export const handler = async () => ({});');
  const bothRun = run(both, tokens.Alice, '--only', 'backend');
  check('two entry files are refused', () => {
    assert.notEqual(bothRun.status, 0);
    assert.match(bothRun.stderr, /only one entry file/);
  });
  const empty = run(mkdtempSync(join(work, 'empty-')), tokens.Alice);
  check('an empty folder explains the expected layout', () => {
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /Nothing to deploy/);
  });
  console.log('portal-deploy CLI: all passed');
} finally {
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
