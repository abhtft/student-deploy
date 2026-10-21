// The student's "Backend" card: upload, state, usage meter, environment variables, logs, removal.
import { analyzeBackend, BACKEND_LIMITS } from './backend-check.js';
import { ask, date, fill, h, toast } from './common.js';
import { buildZip } from './zip.js';

let sig = null; // structural state; the card is rebuilt only when it changes, so typing is never wiped
let timer = null;
let meterBox = null;
let picked = null; // {mode: 'zip', file} | {mode: 'folder', result}

export function stopBackend() {
  clearTimeout(timer);
  sig = meterBox = picked = null;
}

export function renderBackend(box, token, { call, setToken }) {
  const b = token.backend;
  if (!b || !b.available) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const state = JSON.stringify([b.enabled, b.state, b.error, b.env_names, token.can_deploy]);
  if (state !== sig) {
    sig = state;
    clearTimeout(timer);
    build(box, token, { call, setToken });
  }
  if (meterBox) fill(meterBox, meter(b));
}

// ---------- usage meter ----------
function meter(b) {
  const u = b.usage;
  if (!u) return null;
  const percent = u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : 100;
  const cls = percent >= 100 ? 'bad' : percent >= 80 ? 'warn' : '';
  const period = { day: 'today', month: 'this month', total: 'in total' }[u.period];
  const reset = u.resets_at ? ` · resets ${date(u.resets_at)}` : '';
  return h('div', {},
    h('div', { class: `bar ${cls}`, role: 'progressbar', 'aria-label': 'Runs used', 'aria-valuenow': Math.round(percent), 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { style: `width:${Math.max(percent, u.used ? 2 : 0)}%` })),
    h('div', { class: 'small muted', style: 'margin-top:4px' }, `${u.used.toLocaleString()} / ${u.limit.toLocaleString()} runs ${period}${reset}`),
    percent >= 100 ? h('div', { class: 'notice bad', style: 'margin-top:8px' }, 'The allowance is used up, so visitors get a “used its allowed runs” message. Ask your teacher for more.')
      : percent >= 80 ? h('div', { class: 'notice warn', style: 'margin-top:8px' }, 'You have used most of your run allowance. Ask your teacher if you need more.') : null);
}

// ---------- the card ----------
function build(box, token, ctx) {
  const b = token.backend;
  meterBox = h('div', {});
  const site = token.url.replace(/\/$/, '');

  if (!b.enabled && b.state === 'none') {
    fill(box, h('h2', {}, 'Backend'),
      h('label', {}, 'Backend', h('input', { disabled: true, placeholder: 'index.mjs or app.py' })),
      h('div', { class: 'notice warn', role: 'status' }, 'Owner not enabled for you. Please contact site owner.'));
    meterBox = null;
    return;
  }
  const off = !b.enabled
    ? h('div', { class: 'notice bad', role: 'status' }, 'Your teacher turned your backend off, so it is not answering requests. Deploys are paused until it is turned on again.') : null;
  const error = h('div', { class: 'error', role: 'alert' });
  const body = [h('h2', {}, 'Backend'), off, meterBox];

  if (b.enabled) {
    body.push(h('p', { class: 'muted small', style: 'margin:0' },
      `Add a function that visitors reach at ${site}/api/… Upload a folder or zip with index.mjs (Node 22) or app.py (Python 3.12) exporting a handler. Limits: ${b.limits.timeout_seconds} s per request, ${b.limits.memory_mb} MB, ${b.limits.zip_mb} MB zip.`));
    if (b.state === 'creating') body.push(h('div', { class: 'notice', role: 'status' }, 'Deploying your function… this usually takes a few seconds.'));
    if (b.state === 'failed') body.push(h('div', { class: 'notice bad', role: 'alert' }, `Deployment failed: ${b.error}`));
    if (b.state === 'ready') {
      body.push(h('div', {}, h('span', { class: 'pill active' }, 'Ready'), ' ',
        h('span', { class: 'small muted' }, `${b.runtime === 'nodejs22.x' ? 'Node 22' : 'Python 3.12'}${b.deployed_at ? ` · deployed ${date(b.deployed_at)}` : ''}`)),
      h('div', { class: 'small' }, 'Try it: ', h('a', { href: `${site}/api/health`, target: '_blank', rel: 'noopener' }, `${site}/api/health`), ' (counts as one run)'));
    }
    if (b.state !== 'creating') body.push(uploader(b, ctx, error));
    if (b.state === 'ready') body.push(envSection(b, ctx, error), logsSection(ctx));
  }
  if (b.state !== 'none') body.push(removeButton(ctx, error));
  body.push(error);
  fill(box, ...body);
  if (b.state === 'creating') timer = setTimeout(() => poll(ctx), 3000);
}

/** The server advances one step per call, so poll until the function is ready or failed. */
async function poll(ctx) {
  try {
    const before = sig;
    const { token } = await ctx.call('/api/student/backend');
    ctx.setToken(token); // a changed state rebuilds the card, which schedules its own next poll
    if (sig === before && token.backend.state === 'creating') timer = setTimeout(() => poll(ctx), 3000);
  } catch {
    timer = setTimeout(() => poll(ctx), 8000);
  }
}

// ---------- upload ----------
function uploader(b, ctx, errorBox) {
  const checks = h('div', {});
  const status = h('div', { class: 'small muted', role: 'status' });
  const upload = h('button', { class: 'primary', disabled: true }, b.state === 'ready' ? 'Upload new version' : 'Upload and deploy');

  const refresh = () => {
    if (!picked) { fill(checks); upload.disabled = true; return; }
    const list = picked.mode === 'zip'
      ? [{ level: picked.file.size > BACKEND_LIMITS.zipBytes ? 'error' : 'ok', text: `${picked.file.name} (${(picked.file.size / 1048576).toFixed(1)} MB). The server checks the contents when you deploy.` }]
      : picked.result.checks;
    const icon = { ok: '✔', warn: '⚠', error: '✖' };
    fill(checks, h('ul', { class: 'checklist' }, list.map((c) => h('li', { class: c.level }, h('span', { class: 'icon' }, icon[c.level]), h('span', {}, c.text)))));
    upload.disabled = !(picked.mode === 'zip' ? picked.file.size <= BACKEND_LIMITS.zipBytes : picked.result.ok);
  };
  refresh();

  const folder = h('input', { type: 'file', webkitdirectory: true, multiple: true, class: 'hidden', onchange: (e) => pick(e.target, refresh) });
  const zip = h('input', { type: 'file', accept: '.zip,application/zip', class: 'hidden', onchange: (e) => pick(e.target, refresh) });
  upload.addEventListener('click', async () => {
    upload.disabled = true;
    errorBox.textContent = '';
    try {
      status.textContent = 'Preparing…';
      const blob = picked.mode === 'zip' ? picked.file : await buildZip(picked.result.files);
      if (blob.size > BACKEND_LIMITS.zipBytes) throw new Error(`The zipped backend is ${(blob.size / 1048576).toFixed(1)} MB; the limit is ${BACKEND_LIMITS.zipBytes / 1048576} MB. Bundle your dependencies or remove unused files.`);
      const { uploadUrl } = await ctx.call('/api/student/backend/upload-url', { method: 'POST' });
      status.textContent = 'Uploading…';
      const put = await fetch(uploadUrl, { method: 'PUT', body: blob });
      if (!put.ok) throw new Error(`The upload was rejected (${put.status}).`);
      status.textContent = 'Deploying…';
      const { token } = await ctx.call('/api/student/backend/publish', { method: 'POST' });
      picked = null;
      ctx.setToken(token);
    } catch (e) {
      errorBox.textContent = e.message;
      status.textContent = '';
      refresh();
    }
  });
  return h('div', { class: 'stack' },
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
      h('button', { onclick: () => folder.click() }, 'Choose backend folder'), h('button', { onclick: () => zip.click() }, 'Choose .zip'), folder, zip),
    checks, h('div', {}, upload), status);
}

async function pick(input, refresh) {
  const files = [...input.files];
  input.value = '';
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) picked = { mode: 'zip', file: files[0] };
  else {
    const items = files.map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    picked = { mode: 'folder', result: analyzeBackend(items) };
  }
  refresh();
}

// ---------- environment variables (write-only) ----------
function envSection(b, ctx, errorBox) {
  const name = h('input', { placeholder: 'NAME', 'aria-label': 'Variable name', autocomplete: 'off', spellcheck: 'false' });
  const value = h('input', { type: 'password', placeholder: 'value (hidden, never shown again)', 'aria-label': 'Variable value', autocomplete: 'off' });
  const save = h('button', { class: 'small primary', onclick: async () => {
    errorBox.textContent = '';
    try {
      const { token } = await ctx.call('/api/student/backend/env', { method: 'PUT', body: { name: name.value, value: value.value } });
      toast('Saved');
      ctx.setToken(token);
    } catch (e) {
      errorBox.textContent = e.message;
    }
  } }, 'Save variable');
  const rows = b.env_names.map((n) => h('div', { style: 'display:flex;gap:8px;align-items:center' }, h('code', {}, n), h('span', { class: 'small muted' }, '••••••'),
    h('button', { class: 'small danger', onclick: async () => {
      try { ctx.setToken((await ctx.call(`/api/student/backend/env/${n}`, { method: 'DELETE' })).token); } catch (e) { errorBox.textContent = e.message; }
    } }, 'Delete')));
  return h('div', { class: 'stack' }, h('h2', { style: 'margin:8px 0 0' }, 'Environment variables'),
    h('p', { class: 'muted small', style: 'margin:0' }, 'Use these for secrets such as database URLs or API keys. Values are write-only: the portal can never show them again.'),
    rows.length ? rows : h('div', { class: 'small muted' }, 'None yet.'),
    h('div', { class: 'form-grid' }, name, value), h('div', {}, save));
}

// ---------- logs ----------
function logsSection(ctx) {
  const output = h('pre', { class: 'logs hidden' });
  const button = h('button', { class: 'small', onclick: async () => {
    try {
      const { lines } = await ctx.call('/api/student/backend/logs');
      output.textContent = lines.length ? lines.map((l) => `${new Date(l.t * 1000).toLocaleTimeString()}  ${l.message}`).join('\n') : 'No log lines in the last hour.';
      output.classList.remove('hidden');
    } catch (e) {
      output.textContent = e.message;
      output.classList.remove('hidden');
    }
  } }, 'Show recent logs');
  return h('div', { class: 'stack' }, h('div', {}, button), output);
}

function removeButton(ctx, errorBox) {
  return h('div', {}, h('button', { class: 'small danger', onclick: async () => {
    const r = await ask({ title: 'Remove your backend?', text: 'Your function and its logs are deleted. The run allowance and your teacher’s settings stay.', confirm: 'Remove', danger: true });
    if (!r) return;
    try { ctx.setToken((await ctx.call('/api/student/backend', { method: 'DELETE' })).token); } catch (e) { errorBox.textContent = e.message; }
  } }, 'Remove backend'));
}
