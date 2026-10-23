#!/usr/bin/env node
// Publishes your project to the class hosting with your portal token (the one you sign in with).
//
//   node portal-deploy.mjs                 backend/ first, then frontend/
//   node portal-deploy.mjs --only frontend  (or: --only backend)
//   node portal-deploy.mjs --skip-build    deploy the frontend's existing build folder
//   node portal-deploy.mjs --frontend web --backend api    use other folder names
//
// Expected layout:   frontend/  your app (built with `npm run build` into dist/, build/ or out/)
//                    backend/   index.mjs (Node) or app.py (Python) at its top level
// Either folder may be missing: only the one you have is published.
//
// Your token is read from PORTAL_TOKEN (environment, .env.local or .env). Never commit it.
// No npm install needed - only Node 20+. In GitHub Actions store the token as the secret PORTAL_TOKEN.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';

// Teacher: the portal address of your class (override with PORTAL_URL).
const PORTAL_URL = (process.env.PORTAL_URL || 'https://deploy.margdarshakss.com').replace(/\/$/, '');
const BACKEND_ENTRIES = ['index.mjs', 'index.js', 'app.py'];
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|__MACOSX|\.git|__pycache__)(\/|$)|\.py[co]$/;
const READY_TIMEOUT_MS = Number(process.env.PORTAL_READY_TIMEOUT_MS || 120000);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

/** fail() ends the run by throwing, so the process exits by itself (calling process.exit() while network connections are still closing
 *  can print a scary libuv assertion on Windows with newer Node versions). */
class Stop extends Error {}
function fail(message) {
  console.error(`
✖ ${message}`);
  throw new Stop(message);
}

function readToken() {
  if (process.env.PORTAL_TOKEN) return process.env.PORTAL_TOKEN.trim();
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, 'utf8').match(/^\s*PORTAL_TOKEN\s*=\s*["']?([^"'\s]+)/m);
    if (match) return match[1];
  }
  return fail('PORTAL_TOKEN not found. Add this line to .env.local (never commit it):\n  PORTAL_TOKEN=mds_xxxxxxxx\nIn GitHub Actions, add it as a repository secret named PORTAL_TOKEN.');
}

// ---------- API ----------
async function api(method, path, { session, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session) headers.authorization = `Bearer ${session}`;
  const res = await fetch(PORTAL_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).catch(
    (e) => fail(`Cannot reach the portal (${e.cause?.code || e.message}). Check your internet connection.`),
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${data.error || data.message || `${method} ${path} failed`} (HTTP ${res.status})`);
  return data;
}

async function putZip(uploadUrl, zip) {
  const put = await fetch(uploadUrl, { method: 'PUT', body: zip }).catch((e) => fail(`Upload failed (${e.cause?.code || e.message}).`));
  if (!put.ok) fail(`Upload failed (HTTP ${put.status}).`);
}

// ---------- ZIP (deflate, UTF-8 names) so students need no extra tools ----------
function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
  });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipFiles(root, files) {
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(relative(root, file).split(sep).join('/'));
    const data = readFileSync(file);
    const packed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// ---------- frontend ----------
function buildFrontend(project) {
  const pkgPath = join(project, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  if (!pkg.scripts?.build) return;
  console.log(`▶ npm run build (in ${project}/)`);
  const result = spawnSync('npm run build', { cwd: project, stdio: 'inherit', shell: true });
  if (result.status !== 0) fail('Build failed - fix the errors above and try again.');
}

async function deployFrontend(session, project) {
  if (!flag('--skip-build')) buildFrontend(project);
  // Which folder is published: the build output (dist/, build/ or out/ inside the frontend folder). A plain site with no build step
  // (index.html directly in a frontend/ folder) works too, but the repo root itself is never published as-is: it holds backend/, .git, .env ...
  const isRepoRoot = relative(process.cwd(), project) === '';
  const dir = ['dist', 'build', 'out'].map((d) => join(project, d)).find((d) => existsSync(join(d, 'index.html')))
    || (!isRepoRoot && existsSync(join(project, 'index.html')) ? project : null);
  if (!dir) fail(`No build folder with index.html found in ${project}/ (looked in dist/, build/, out/). Make sure "npm run build" creates one.`);
  const hidden = (f) => /(^|\/)(\.env(\..*)?|node_modules)(\/|$)/.test(relative(dir, f).split(sep).join('/'));
  const files = listFiles(dir).filter((f) => !JUNK.test(relative(dir, f).split(sep).join('/')) && !hidden(f));
  const zip = zipFiles(dir, files);
  console.log(`▶ Frontend: packed ${files.length} files from ${dir}/ (${(zip.length / 1024).toFixed(0)} KB)`);
  const { uploadUrl, maxBytes } = await api('POST', '/api/student/upload-url', { session });
  if (zip.length > maxBytes) fail(`The frontend is too large (${(zip.length / 1048576).toFixed(1)} MB, limit ${maxBytes / 1048576} MB).`);
  await putZip(uploadUrl, zip);
  console.log('▶ Frontend: publishing...');
  const result = await api('POST', '/api/student/publish', { session });
  if (result.warning) console.warn(`\n⚠ ${result.warning}`);
  console.log(`✔ Frontend live at ${result.url}  (${result.files} files, may take ~30s to refresh everywhere)`);
}

// ---------- backend ----------
async function deployBackend(session, dir) {
  const entry = BACKEND_ENTRIES.filter((e) => existsSync(join(dir, e)));
  if (entry.length === 0) fail(`No entry file in ${dir}/. Add index.mjs (Node 22) or app.py (Python 3.12) at its top level.`);
  if (entry.some((e) => e.endsWith('.py')) && entry.some((e) => !e.endsWith('.py'))) fail(`Include only one entry file in ${dir}/: index.mjs or app.py, not both.`);
  const files = listFiles(dir).filter((f) => !JUNK.test(relative(dir, f).split(sep).join('/')));
  const secrets = files.filter((f) => /(^|[\\/])\.env(\..*)?$/.test(f));
  if (secrets.length) fail(`Remove ${secrets.slice(0, 3).join(', ')} from ${dir}/. Secrets are set as environment variables on the portal (Backend card), not shipped in the code.`);
  const zip = zipFiles(dir, files);
  console.log(`▶ Backend: packed ${files.length} files from ${dir}/ (${(zip.length / 1024).toFixed(0)} KB)`);
  const { uploadUrl, maxBytes } = await api('POST', '/api/student/backend/upload-url', { session });
  if (zip.length > maxBytes) fail(`The backend is too large (${(zip.length / 1048576).toFixed(1)} MB, limit ${maxBytes / 1048576} MB). Bundle your dependencies (for example with esbuild).`);
  await putZip(uploadUrl, zip);
  console.log('▶ Backend: publishing...');
  let { token } = await api('POST', '/api/student/backend/publish', { session });
  const started = Date.now();
  while (token.backend.state === 'creating') {
    if (Date.now() - started > READY_TIMEOUT_MS) fail('The backend is still being created after waiting. Check the Backend card on the portal.');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    ({ token } = await api('GET', '/api/student/backend', { session }));
  }
  if (token.backend.state !== 'ready') fail(`The backend did not start: ${token.backend.error || token.backend.state}`);
  console.log(`✔ Backend ready (${token.backend.runtime}). Your site calls it at /api/<route>.`);
}

// ---------- main ----------
async function main() {
  const only = option('--only');
  if (only && !['frontend', 'backend'].includes(only)) fail('--only must be "frontend" or "backend".');
  const frontendDir = option('--frontend', 'frontend');
  const backendDir = option('--backend', 'backend');
  const doBackend = only !== 'frontend' && (existsSync(backendDir) || only === 'backend');
  const doFrontend = only !== 'backend' && (existsSync(frontendDir) || only === 'frontend');
  if (only === 'backend' && !existsSync(backendDir)) fail(`The folder ${backendDir}/ does not exist here.`);
  if (only === 'frontend' && !existsSync(frontendDir)) fail(`The folder ${frontendDir}/ does not exist here.`);
  if (!doBackend && !doFrontend) fail(`Nothing to deploy: no ${frontendDir}/ or ${backendDir}/ folder here. Run this from the root of your project.`);

  const { session, token } = await api('POST', '/api/student/login', { body: { token: readToken() } });
  if (!token.can_deploy) fail(`Your token cannot deploy right now (status: ${token.status}). Ask your teacher, or request regeneration on the portal.`);
  const daysLeft = Math.ceil((token.expires_at - Date.now() / 1000) / 86400);
  console.log(`▶ Signed in as ${token.student_name || token.slug} (${token.slug}). Token valid for ${daysLeft} more day${daysLeft === 1 ? '' : 's'}.`);
  if (daysLeft <= 3) console.warn('⚠ Your token expires soon. Request regeneration on the portal so deploys keep working.');

  if (doBackend) await deployBackend(session, backendDir);
  if (doFrontend) await deployFrontend(session, frontendDir);
}

main().catch((error) => {
  if (!(error instanceof Stop)) console.error(error);
  process.exitCode = 1;
});
