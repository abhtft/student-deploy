// The student's "Deploy from GitHub" card: the two files to download and the steps. Nothing here touches the API, and no token is ever
// put in a downloaded file. The files are published next to the pages (see portal-downloads.json).
import { fill, h } from './common.js';

export const DOWNLOAD_FILES = {
  cli: 'portal-deploy.mjs',
  guide: 'github-deploy-guide.md',
  workflow: { frontend: 'deploy-frontend-folder.yml', root: 'deploy-root-app.yml' },
};

let built = false;

export function stopGithub() {
  built = false;
}

export function renderGithub(box, token) {
  if (!token.can_deploy && token.status === 'revoked') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (built) return; // built once per sign-in, so the chosen layout is never reset by a refresh
  built = true;

  const workflow = h('a', { class: 'btn', href: DOWNLOAD_FILES.workflow.frontend, download: 'deploy.yml' }, 'Download deploy.yml');
  const choose = (layout) => workflow.setAttribute('href', DOWNLOAD_FILES.workflow[layout]);
  const option = (value, text, checked) => h('label', { style: 'display:flex;gap:8px;align-items:center;color:var(--text)' },
    h('input', { type: 'radio', name: 'gh-layout', value, checked, style: 'width:auto', onchange: () => choose(value) }), text);

  fill(box,
    h('h2', {}, 'Deploy from GitHub'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Optional. Push your code to GitHub and your site and backend publish themselves. Setup takes about 10 minutes, once.'),
    h('div', { class: 'stack', style: 'gap:6px' },
      h('strong', {}, 'Where is your app in the repo?'),
      option('frontend', h('span', {}, 'In a ', h('code', {}, 'frontend/'), ' folder (with ', h('code', {}, 'backend/'), ' beside it)'), true),
      option('root', h('span', {}, 'At the top of the repo (a normal Vite or React project, with ', h('code', {}, 'backend/'), ' beside ', h('code', {}, 'src/'), ')'), false)),
    h('div', { class: 'actions', style: 'display:flex;gap:8px;flex-wrap:wrap' },
      h('a', { class: 'btn', href: DOWNLOAD_FILES.cli, download: DOWNLOAD_FILES.cli }, 'Download portal-deploy.mjs'),
      workflow,
      h('a', { class: 'btn', href: DOWNLOAD_FILES.guide, download: 'GITHUB-DEPLOY-GUIDE.md' }, 'Full guide')),
    h('ol', { class: 'small', style: 'margin:0;padding-left:20px;display:grid;gap:4px' },
      h('li', {}, 'Put ', h('code', {}, 'portal-deploy.mjs'), ' in the root of your repo (next to ', h('code', {}, 'package.json'), ').'),
      h('li', {}, 'Save the workflow as ', h('code', {}, '.github/workflows/deploy.yml'), ' in your repo (create the folders if needed).'),
      h('li', {}, 'On GitHub open ', h('strong', {}, 'Settings, Secrets and variables, Actions, New repository secret'), '. Name it ', h('code', {}, 'PORTAL_TOKEN'),
        ' and paste the token you signed in with. Never put the token in a file you commit.'),
      h('li', {}, 'Push to ', h('code', {}, 'main'), ' and watch the ', h('strong', {}, 'Actions'), ' tab. Your site updates when it turns green.')),
    h('p', { class: 'small muted', style: 'margin:0' },
      'A ', h('code', {}, 'backend/'), ' folder (',
      h('code', {}, 'index.mjs'), ' or ', h('code', {}, 'app.py'), ') is deployed too, once your teacher has turned the backend on. The pipeline stops working when your token expires: request regeneration here, then update the secret.'));
}
