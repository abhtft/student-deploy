#!/usr/bin/env node
// MCP server for your AI editor (VS Code, Antigravity, Cursor, Claude Code...): lets the assistant check and deploy this project when you ask
// it to ("publish my site"), without you typing commands. It only runs this project's own tools, so nothing here is new behaviour:
//
//   check_project   the same as `npm run check`
//   deploy          check first, then the same as `npm run deploy` (it asks you for a yes before it publishes)
//   status          is your saved token valid, and for how many days; and whether a newer class kit is available
//   update_kit      bring the kit's own files up to date (it asks you for a yes first; same as `npm run platform -- update --apply`)
//
// The token is NOT in the editor's settings: run `npm run login` once in a terminal, the tools read it from .env.local like `npm run deploy` does.
//
//   node tools/mcp.mjs                  start the server (your editor does this; speaks MCP over stdin/stdout)
//   node tools/mcp.mjs --print-config   print the settings to paste into VS Code or Antigravity, with this folder's paths filled in
//   node tools/mcp.mjs --root <dir>     the project folder (default: the folder above tools/)
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitStatus, noticeText } from './update-notice.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const root = resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : join(here, '..'));
const kitVersion = (() => { try { return JSON.parse(readFileSync(join(root, 'platform.json'), 'utf8')).kitVersion || '0'; } catch { return '0'; } })();

if (args.includes('--print-config')) {
  const script = join(here, 'mcp.mjs');
  console.log(`VS Code: nothing to do. This folder already has .vscode/mcp.json; open the Chat view in Agent mode and start the "class-platform" server (VS Code offers a Start button above the file).

Antigravity: open the agent panel's "..." menu > MCP Servers > Manage MCP Servers > View raw config, and add this inside "mcpServers" (keep your other servers):

${JSON.stringify({ 'class-platform': { command: 'node', args: [script, '--root', root] } }, null, 2)}

Then refresh the MCP list. Run  npm run login  once in a terminal first (the server reads your token from .env.local).`);
} else {
  serve();
}

const MAX_OUTPUT = 8000;
const clean = (text) => {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '').replace(/mds_[A-Za-z0-9_-]{8,}/g, 'mds_***').trim();
  return plain.length > MAX_OUTPUT ? `...(earlier output cut)\n${plain.slice(-MAX_OUTPUT)}` : plain;
};

/** Run one of this project's own scripts and return its output. stdin is closed, so nothing can wait for typing. */
function run(script, scriptArgs, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(root, script), ...scriptArgs], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const timer = setTimeout(() => { output += `\nStopped: it took longer than ${Math.round(timeoutMs / 1000)} seconds.`; child.kill(); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolveRun({ ok: false, text: clean(`${output}\n${error.message}`) }); });
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ ok: code === 0, text: clean(output) }); });
  });
}

let deploying = false;
const TOOLS = [
  {
    name: 'check_project',
    description: 'Run the platform check on this project (layout, limits, imports, secrets). Run it before every deploy and fix every error it lists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => run('tools/check.mjs', [], 120000),
  },
  {
    name: 'deploy',
    description: 'Publish this project (backend first, then frontend) to the class platform and return the live address. It runs the check first and refuses to deploy if the check fails. IMPORTANT: ask the student whether to publish now, and call this with confirm=true only after they say yes.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'true only after the student agreed to publish now' },
        only: { type: 'string', enum: ['frontend', 'backend'], description: 'publish just one part (optional)' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    async run({ confirm, only }) {
      if (confirm !== true) return { ok: false, text: 'Not published. Ask the student whether to publish now; if they say yes, call deploy again with confirm=true.' };
      if (only !== undefined && only !== 'frontend' && only !== 'backend') return { ok: false, text: '"only" must be "frontend" or "backend".' };
      if (deploying) return { ok: false, text: 'A deploy is already running. Wait for it to finish.' };
      deploying = true;
      try {
        const checked = await run('tools/check.mjs', [], 120000);
        if (!checked.ok) return { ok: false, text: `Not published: the check found problems. Fix them first.\n\n${checked.text}` };
        return await run('portal-deploy.mjs', only ? ['--only', only] : [], 300000);
      } finally {
        deploying = false;
      }
    },
  },
  {
    name: 'status',
    description: 'Say whether the saved portal token is valid and for how many days. Deploys nothing. If it says no token is found, the student must run "npm run login" in their own terminal (never ask them to paste the token to you).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const token = await run('portal-deploy.mjs', ['status'], 60000);
      const kit = await kitStatus(root, { fresh: true });
      const kitLine = !kit ? 'Kit: could not reach the portal to compare versions.' : noticeText(kit) ? noticeText(kit).replace(/^[^A-Za-z]+/, 'Kit: ') + ' (ask the student, then use update_kit)' : `Kit ${kit.mine}: up to date.`;
      return { ok: token.ok, text: `${token.text}\n${kitLine}`.trim() };
    },
  },
  {
    name: 'update_kit',
    description: 'Bring the class kit\'s own files (the rules for AI editors, tools/, the deploy script, the helpers class_ai and class_storage, the check) up to date from the portal. It never touches the student\'s own code, .env files or files the student edited. IMPORTANT: ask the student first and call this with confirm=true only after they say yes. Afterwards tell them to restart this tool server (or reload the editor) so the new tools are used.',
    inputSchema: { type: 'object', properties: { confirm: { type: 'boolean', description: 'true only after the student agreed to update' } }, required: ['confirm'], additionalProperties: false },
    async run({ confirm }) {
      if (confirm !== true) return { ok: false, text: 'Not updated. Ask the student whether to update the kit now; if they say yes, call update_kit again with confirm=true.' };
      const done = await run('tools/platform.mjs', ['update', '--apply'], 120000);
      return { ok: done.ok, text: done.ok ? `${done.text}\n\nRestart this tool server (or reload the editor) so the updated tools are used.` : done.text };
    },
  },
];

function serve() {
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const fail = (id, code, message) => send({ id, error: { code, message } });

  async function handle(message) {
    const { id, method, params = {} } = message;
    if (id === undefined) return; // notifications (initialized, cancelled...) need no answer
    switch (method) {
      case 'initialize':
        return send({ id, result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'class-platform', version: kitVersion },
          instructions: 'Tools for this class project. When the student asks to publish: check_project, ask them to confirm, then deploy with confirm=true. If there is no token, the student runs "npm run login" themselves.',
        } });
      case 'ping':
        return send({ id, result: {} });
      case 'tools/list':
        return send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        const result = await tool.run(params.arguments ?? {});
        return send({ id, result: { content: [{ type: 'text', text: result.text || (result.ok ? 'Done.' : 'Failed.') }], isError: !result.ok } });
      }
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
      handle(message).catch((error) => fail(message.id ?? null, -32603, error.message));
    }
  });
}
