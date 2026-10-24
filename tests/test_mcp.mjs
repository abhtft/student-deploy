// The MCP server in the kit (tools/mcp.mjs), driven the way an AI editor drives it: JSON-RPC lines on stdin/stdout. It runs against the
// whole dev portal (real portal, gateway and Lambda code on in-memory AWS). Only the backend is deployed here, so no npm install is needed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const { buildKit } = await import(pathToFileURL(join(repo, 'starter', 'build-kit.mjs')).href);
const python = spawnSync('python', ['--version']).status === 0 ? 'python' : 'python3';
const say = (m) => console.log(`  ok  ${m}`);

const PORT = 8797;
const URL = `http://127.0.0.1:${PORT}`;
const portal = spawn(python, [join(here, 'dev_server.py'), String(PORT)], { env: { ...process.env, AWS_DEFAULT_REGION: 'us-east-1' } });
let out = '';
portal.stdout.on('data', (d) => (out += d));
portal.stderr.on('data', (d) => (out += d));
const work = mkdtempSync(join(tmpdir(), 'kit-mcp-'));

/** A minimal MCP client: starts the server, sends requests, waits for the answer with the same id. */
function client(root, env = {}) {
  const child = spawn(process.execPath, [join(root, 'tools', 'mcp.mjs'), '--root', root], {
    cwd: tmpdir(), // like an editor: the working directory is NOT the project, --root says where it is
    env: { ...process.env, PORTAL_URL: URL, PORTAL_TOKEN: '', PORTAL_READY_TIMEOUT_MS: '60000', ...env },
  });
  const lines = [];
  const waiting = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      lines.push(line);
      const message = JSON.parse(line); // every stdout line must be a JSON-RPC message, or the editor would reject the server
      waiting.get(message.id)?.(message);
    }
  });
  let next = 0;
  const call = (method, params) => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    call,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    tool: async (name, args = {}) => (await call('tools/call', { name, arguments: args })).result,
    lines,
    close: () => child.kill(),
  };
}

try {
  for (let i = 0; i < 300 && !out.includes('Backend demo:'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('Backend demo:'), `the dev portal did not start within 30 s:\n${out}`);
  const token = out.match(/Alice\s+(mds_\S+)/)[1];

  const kit = join(work, 'kit');
  buildKit(kit);
  const vscode = JSON.parse(readFileSync(join(kit, '.vscode', 'mcp.json'), 'utf8'));
  assert.equal(vscode.servers['class-platform'].type, 'stdio');
  assert.ok(vscode.servers['class-platform'].args.some((a) => a.endsWith('tools/mcp.mjs')));
  assert.doesNotMatch(JSON.stringify(vscode), /mds_|PORTAL_TOKEN/, 'the editor settings must not carry the token');
  say('the kit ships a VS Code .vscode/mcp.json that starts tools/mcp.mjs and holds no token');

  const printed = spawnSync(process.execPath, [join(kit, 'tools', 'mcp.mjs'), '--root', kit, '--print-config'], { encoding: 'utf8' });
  assert.equal(printed.status, 0);
  const snippet = JSON.parse(printed.stdout.slice(printed.stdout.indexOf('{\n  "class-platform"'), printed.stdout.indexOf('\n}\n') + 2));
  assert.equal(snippet['class-platform'].command, 'node');
  assert.equal(snippet['class-platform'].args[0], join(kit, 'tools', 'mcp.mjs'));
  say('--print-config gives the Antigravity entry with this folder\'s absolute paths');

  const mcp = client(kit);
  const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal(init.result.serverInfo.name, 'class-platform');
  mcp.notify('notifications/initialized');
  const tools = (await mcp.call('tools/list')).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['check_project', 'deploy', 'status']);
  assert.deepEqual(tools.find((t) => t.name === 'deploy').inputSchema.required, ['confirm']);
  assert.equal((await mcp.call('nope')).error.code, -32601);
  assert.equal((await mcp.call('tools/call', { name: 'nope' })).error.code, -32602);
  assert.deepEqual((await mcp.call('ping')).result, {});
  say('handshake, tool list (check_project, deploy, status), unknown method and tool answered with JSON-RPC errors');

  const checked = await mcp.tool('check_project');
  assert.equal(checked.isError, false, checked.content[0].text);
  say('check_project passes on a fresh kit');

  // no token yet: a clear instruction, never a hang waiting for typing
  const noToken = await mcp.tool('status');
  assert.equal(noToken.isError, true);
  assert.match(noToken.content[0].text, /npm run login/);
  say('status without a token tells the student to run npm run login');

  // the student runs `npm run login` (here: the same file it would write)
  writeFileSync(join(kit, '.env.local'), `PORTAL_TOKEN=${token}\n`);
  const status = await mcp.tool('status');
  assert.equal(status.isError, false, status.content[0].text);
  assert.match(status.content[0].text, /Signed in as .*alice/i);
  say('status reads the saved token and reports who is signed in and for how long');

  // deploy needs a yes from the student
  const unconfirmed = await mcp.tool('deploy', { only: 'backend' });
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.content[0].text, /Not published.*confirm=true/s);
  assert.equal((await fetch(`${URL}/b/alice/health`)).status === 200, false, 'nothing was deployed without confirmation');
  const wrongOnly = await mcp.tool('deploy', { confirm: true, only: 'everything' });
  assert.equal(wrongOnly.isError, true);
  say('deploy without confirm=true publishes nothing');

  // a project that fails the check is not deployed
  appendFileSync(join(kit, 'backend', 'app.py'), '\nimport requests\n');
  const refused = await mcp.tool('deploy', { confirm: true, only: 'backend' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /check found problems.*backend-python-import/s);
  assert.equal((await fetch(`${URL}/b/alice/health`)).status === 200, false, 'a failing check stops the deploy before anything is uploaded');
  const fixed = readFileSync(join(kit, 'backend', 'app.py'), 'utf8').replace('\nimport requests\n', '');
  writeFileSync(join(kit, 'backend', 'app.py'), fixed);
  say('a project that fails the check is refused with the check\'s own explanation');

  const deployed = await mcp.tool('deploy', { confirm: true, only: 'backend' });
  assert.equal(deployed.isError, false, deployed.content[0].text);
  assert.match(deployed.content[0].text, /Backend ready \(python3\.12\)/);
  assert.equal((await fetch(`${URL}/b/alice/health`)).status, 200);
  say('deploy with confirm=true checks, then publishes the backend through the same portal-deploy.mjs');

  const everything = JSON.stringify(mcp.lines);
  assert.ok(!everything.includes(token), 'the token must never appear in anything the server says');
  mcp.close();
  say('the token appears nowhere in the server\'s output');

  // a rejected token is explained, not dumped
  const stale = client(kit, { PORTAL_TOKEN: 'mds_thisTokenWasReplaced12345' });
  await stale.call('initialize', { protocolVersion: '2025-06-18' });
  const rejected = await stale.tool('status');
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /does not accept this token.*npm run login/s);
  assert.ok(!stale.lines.join('').includes('mds_thisTokenWasReplaced12345'));
  stale.close();
  say('a replaced or expired token gets the npm run login instruction, and is not echoed');

  console.log('mcp: all passed');
} finally {
  portal.kill();
  rmSync(work, { recursive: true, force: true });
}
