import { api, ApiError, ask, copyText, date, duration, expiryBar, h, now, session, statusPill, toast } from './common.js';

const $ = (id) => document.getElementById(id);
const DURATIONS = [[7, '7 days'], [14, '14 days'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '180 days']];
let tokens = [];
let requests = [];
let tab = 'tokens';

function show(signedIn) {
  $('login').classList.toggle('hidden', signedIn);
  $('app').classList.toggle('hidden', !signedIn);
}

/** Run an API call for the teacher; a 401 means the session ended, so go back to the sign-in form. */
async function call(path, options) {
  try {
    return await api(path, { role: 'teacher', ...options });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && session('teacher')) {
      session('teacher', null);
      show(false);
    }
    throw e;
  }
}

async function load() {
  $('error').textContent = '';
  try {
    [{ tokens }, { requests }] = await Promise.all([call('/api/admin/tokens'), call('/api/admin/requests')]);
  } catch (e) {
    $('error').textContent = e.message;
    return;
  }
  render();
}

function render() {
  $('badge').textContent = requests.length;
  $('badge').classList.toggle('hidden', requests.length === 0);
  $('tab-tokens').setAttribute('aria-selected', tab === 'tokens');
  $('tab-requests').setAttribute('aria-selected', tab === 'requests');
  const rows = tab === 'tokens' ? tokens.map(tokenRow) : requests.map(requestRow);
  const empty = tab === 'tokens' ? 'No tokens yet. Click “New token” to create one.' : 'No pending requests.';
  $('panel').replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty' }, empty)]));
}

function who(t) {
  return h('div', {},
    h('div', { class: 'title' }, t.student_name || t.slug),
    h('div', { class: 'small muted' }, t.student_name ? `${t.slug} · ` : '', h('a', { href: t.url, target: '_blank', rel: 'noopener' }, t.url.replace('https://', ''))));
}

function tokenRow(t) {
  const btn = (label, fn, cls = '') => h('button', { class: `small ${cls}`, onclick: fn }, label);
  const live = t.status !== 'revoked';
  return h('div', { class: 'row' },
    h('div', {}, who(t), h('div', { style: 'margin-top:6px' }, statusPill(t), ' ',
      t.regen.state === 'pending' ? h('span', { class: 'pill warn' }, 'Regeneration requested') : null),
      h('div', { class: 'small muted', style: 'margin-top:4px' }, `Token …${t.hint} · ${t.last_deploy_at ? `last deploy ${date(t.last_deploy_at)}` : 'never deployed'}`),
      t.custom_domain.domain ? h('div', { class: 'small muted', style: 'margin-top:2px' }, `Custom domain: ${t.custom_domain.domain} (${t.custom_domain.state.replace('_', ' ')})`) : null),
    expiryBar(t),
    h('div', { class: 'btns' },
      live && t.custom_domain.available ? btn(t.custom_domain.enabled ? 'Domain: on' : 'Domain: off', () => toggleDomain(t)) : null,
      live ? btn('Extend', () => extend(t)) : null,
      live && !t.archived ? btn('Take offline', () => offline(t)) : null,
      live ? btn('Revoke', () => revoke(t), 'danger') : null));
}

function requestRow(t) {
  const original = Math.max(Math.round((t.expires_at - t.created_at) / 86400), 1);
  return h('div', { class: 'row' },
    h('div', {}, who(t), h('div', { class: 'small muted', style: 'margin-top:6px' }, `Requested ${date(t.regen.requested_at)}`),
      t.regen.note ? h('div', { style: 'margin-top:4px' }, `“${t.regen.note}”`) : null),
    h('div', {}, statusPill(t), h('div', { class: 'small muted', style: 'margin-top:4px' }, t.archived ? 'Site is offline; approving brings it back' : expiryText(t))),
    h('div', { class: 'btns' },
      h('button', { class: 'small primary', onclick: () => approve(t, original) }, 'Approve'),
      h('button', { class: 'small danger', onclick: () => deny(t) }, 'Deny')));
}

const expiryText = (t) => (t.status === 'active' ? `Expires in ${duration(t.expires_at - now())}` : `Expired ${duration(now() - t.expires_at)} ago`);

async function act(path, body, message) {
  try {
    await call(path, { method: 'POST', body });
    toast(message);
    await load();
  } catch (e) {
    $('error').textContent = e.message;
  }
}

async function extend(t) {
  const r = await ask({ title: `Extend ${t.slug}`, text: 'Days are added to the current expiry (or counted from today if it has already expired).',
    fields: [{ name: 'days', label: 'Days to add', type: 'number', value: 7, min: 1, max: 365, required: true }], confirm: 'Extend' });
  if (r) act(`/api/admin/tokens/${t.id}/extend`, { days: Number(r.days) }, 'Extended');
}

async function toggleDomain(t) {
  const enabled = !t.custom_domain.enabled;
  act(`/api/admin/tokens/${t.id}/domain-access`, { enabled }, enabled ? `Custom domain allowed for ${t.slug}` : `Custom domain switched off for ${t.slug}`);
}

async function offline(t) {
  const r = await ask({ title: `Take ${t.slug} offline?`, text: 'The site stops being served now. Files are archived, not deleted, and come back if you extend the token or approve a request.', confirm: 'Take offline', danger: true });
  if (r) act(`/api/admin/tokens/${t.id}/offline`, {}, 'Site taken offline');
}

async function revoke(t) {
  const r = await ask({ title: `Revoke ${t.slug}?`, text: 'The student can no longer sign in or deploy. The live site is not changed.', confirm: 'Revoke', danger: true });
  if (r) act(`/api/admin/tokens/${t.id}/revoke`, {}, 'Revoked');
}

async function approve(t, original) {
  const options = [...DURATIONS];
  if (!options.some(([d]) => d === original)) options.unshift([original, `${original} days (original)`]);
  const r = await ask({ title: `Approve ${t.slug}`, text: 'New duration, counted from today.', fields: [{ name: 'days', label: 'New duration', options, value: original }], confirm: 'Approve' });
  if (r) act(`/api/admin/tokens/${t.id}/approve`, { days: Number(r.days) }, 'Approved');
}

async function deny(t) {
  const r = await ask({ title: `Deny ${t.slug}`, fields: [{ name: 'reason', label: 'Reason (shown to the student, optional)', maxlength: 300 }], confirm: 'Deny', danger: true });
  if (r) act(`/api/admin/tokens/${t.id}/deny`, { reason: r.reason }, 'Denied');
}

async function newToken() {
  const options = [...DURATIONS, ['custom', 'Custom…']];
  const r = await ask({ title: 'New token', fields: [
    { name: 'days', label: 'Valid for', options, value: 30 },
    { name: 'student_name', label: 'Student name (optional)', maxlength: 60 },
    { name: 'slug', label: 'Site name (optional)', placeholder: 'defaults to the student name', maxlength: 30 },
  ], confirm: 'Create' });
  if (!r) return;
  let days = r.days;
  if (days === 'custom') {
    const c = await ask({ title: 'Custom duration', fields: [{ name: 'days', label: 'Days (1–365)', type: 'number', value: 45, min: 1, max: 365, required: true }], confirm: 'Create' });
    if (!c) return;
    days = c.days;
  }
  try {
    const body = { days: Number(days), student_name: r.student_name, slug: r.slug || undefined };
    const { token, item } = await call('/api/admin/tokens', { method: 'POST', body });
    showCreated(token, item);
    await load();
  } catch (e) {
    $('error').textContent = e.message;
  }
}

function showCreated(token, item) {
  const portal = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}student.html`;
  const message = `Your deploy token: ${token}\nSign in at ${portal}\nYour site will be ${item.url}\nValid until ${date(item.expires_at)}.`;
  $('created').classList.remove('hidden');
  $('created').replaceChildren(
    h('h2', {}, `Token for ${item.student_name || item.slug}`),
    h('p', { class: 'notice warn', style: 'margin-top:0' }, 'Copy it now. For security it is shown only once.'),
    h('div', { class: 'secret' }, token),
    h('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' },
      h('button', { class: 'primary small', onclick: () => copyText(token) }, 'Copy token'),
      h('button', { class: 'small', onclick: () => copyText(message) }, 'Copy message for the student'),
      h('button', { class: 'small', onclick: () => $('created').classList.add('hidden') }, 'Done')));
  $('created').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const form = new FormData(e.target);
  try {
    const { session: s } = await api('/api/teacher/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } });
    session('teacher', s);
    e.target.reset();
    show(true);
    load();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});
$('logout').onclick = () => { session('teacher', null); tokens = requests = []; $('created').classList.add('hidden'); show(false); };
$('refresh').onclick = load;
$('new-token').onclick = newToken;
$('tab-tokens').onclick = () => { tab = 'tokens'; render(); };
$('tab-requests').onclick = () => { tab = 'requests'; render(); };

setInterval(() => { if (session('teacher') && !document.hidden) load(); }, 60000);
if (session('teacher')) { show(true); load(); } else show(false);
