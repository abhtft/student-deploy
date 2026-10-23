# Class platform project: rules for AI assistants

You are helping a student build a small web app that is hosted on their teacher's **class platform**. The platform has strict, simple
rules. Follow them exactly: the app is checked by `npm run check` before every deploy and anything that breaks a rule is rejected.
**Never invent platform features.** If something is not described here, say so and ask the student or their teacher.

## What the platform is (read this first)

| Part | What it is |
|---|---|
| Frontend | A **static website** built from `frontend/` (React + Vite + TypeScript by default). The platform publishes the build output (`dist/`). |
| Backend | **One function** in `backend/`: Python 3.12 (`app.py`) **or** Node 22 (`index.mjs`). No server process, no framework that listens on a port. |
| Address | The site is `https://<name>.margdarshakss.com`. The backend is reached at **`/api/...` on the same address** (the `/api` prefix is removed before your function sees the path). No CORS needed. |
| Class AI | The teacher can switch on an AI key for the student's backend. The helper `class_ai` makes the call in one line. |
| Deploy | Push to GitHub `main`: a GitHub Action runs `npm run check`, then deploys backend and frontend. |

**Does not work here** (tutorials often assume these, so say so plainly if the student asks): Express, Flask, Django, FastAPI or any server
that listens on a port; MongoDB, MySQL, PostgreSQL or any database server; Firebase Admin; Next.js server apps and server-side rendering;
websockets; cron jobs; background workers; installing packages on the platform. Offer the closest thing that does work (a function
route, `localStorage`, or an external HTTP service called from the backend: see "Where data lives").

## Golden rules

1. **Layout is fixed:** `frontend/` (the site) and `backend/` (the function) at the top of the project. Do not rename or nest them.
2. **Frontend calls the backend with a relative address only:** `fetch('/api/...')` (use `frontend/src/api.ts`). Never `http://localhost...`, never a full URL of the platform.
3. **No secrets in the browser.** Anything in `frontend/` is public. Never put an API key or token there, and never use a `VITE_` variable for a secret. Never call an AI service (OpenAI, OpenRouter, Anthropic, Google...) from the frontend.
4. **AI goes through the backend, with `class_ai`:**
   Python: `from class_ai import ask` then `answer = ask("your prompt")`.
   Node: `import { ask } from './class_ai.mjs'` then `const answer = await ask('your prompt')`.
   - `ask` returns the answer text or raises/throws `AiError` (it has `.kind` and a friendly `.message`: return that to the frontend, e.g. HTTP 503 `{"error": kind, "message": message}`). Pass `default="..."` / `{ default: '...' }` to get a fallback text instead.
   - For a **conversation** use `chat(messages)` (a list of `{"role": "user"|"assistant", "content": "..."}`; put one `{"role": "system", "content": "..."}` first for instructions). The AI remembers nothing between calls: the frontend keeps the history (in `localStorage`, so say it is per browser) and sends it each time. Validate its size and send only the latest messages (for example the last 20, each at most 1000 characters).
   - For **structured answers (JSON)** see "Structured AI answers" below.
   - **Do not edit `class_ai.py` / `class_ai.mjs`** (they are refreshed with the kit), do not write your own AI client, do not read the AI key yourself.
5. **Backend uses only the standard library** (Python) or Node 22 built-ins (Node). The platform installs nothing. If a package is truly needed, bundle it into the backend folder. Use `urllib.request` / `fetch` for HTTP.
6. **Backend limits:** 10 seconds per request (25 s while the class AI is on), 256 MB, request and response at most 1 MB, the backend folder at most 500 files and 5 MB zipped. Keep text answers short (`max_tokens` 200-400); lists or JSON may need up to 800.
7. **Secrets:** a backend secret (a database URL, another service's key) is set by the student in the portal (Backend card > Environment variables) and read with `os.environ["NAME"]` / `process.env.NAME`. Never write a secret into any file, never create `.env` inside `backend/`. For local runs only, `.env.local` at the project root is allowed (it is git-ignored).
8. **The portal token is never written to any file.** It lives only in the GitHub repository secret `PORTAL_TOKEN`. **If the student pastes a real key or token into the chat, do not use it and do not store it anywhere**; tell them to revoke or regenerate it (an AI key at its provider, the portal token via the teacher) and explain where such a value belongs.
9. **One backend language.** `app.py` **or** `index.mjs`, not both. To switch to Node: delete `backend/app.py` and `backend/class_ai.py`, then move the files from `variants/node-backend/` into `backend/` (and delete the `variants/` folder).
10. **Do not edit** `.github/workflows/deploy.yml`, `portal-deploy.mjs`, `tools/` or `platform.json` unless the student's teacher asked for it.

## Backend pattern (Python)

```python
def handler(event, context):
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]            # "/items" for the call /api/items
    ...
    return {"statusCode": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(data)}
```
Add new routes **inside `handler`, next to the examples** (one `if method == ... and path == ...` per route). Return JSON with a string `body`.
Validate input (types and lengths) and answer `400` with `{"error": "...", "message": "..."}` when it is wrong. Keep `/health`; you may delete
the other starter routes (`/hello`, `/echo`, `/ask`) when the app does not use them. `backend/app.py` and `variants/node-backend/index.mjs`
are working examples.

## Backend pattern (Node, `backend/index.mjs`)

```js
export const handler = async (event) => {
  const { method } = event.requestContext.http;
  const path = event.rawPath;                       // "/items" for the call /api/items
  if (method === 'POST' && path === '/items') {
    const body = JSON.parse(event.body || '{}');    // validate it before use
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  }
  return { statusCode: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not_found' }) };
};
```
When you switch the backend to Node, also update the text in the frontend and README that names `backend/app.py`.

## Structured AI answers (JSON)

Models wrap JSON in words or code fences and sometimes get it wrong, and the offline mock returns plain text. So:
1. Ask for JSON only and describe the exact shape in the prompt.
2. Parse defensively: cut the text from the first `[`/`{` to the last `]`/`}`, `json.loads` it in a try/except, check every field's type, drop bad items.
3. If nothing valid remains, return a friendly error (for example HTTP 502 `{"error": "bad_answer", "message": "Please try again."}`): never crash.
4. Give the offline mock a sample reply of the right shape so the whole flow can be tried locally: Python `ask(prompt, mock='[{"question": "...", ...}]')`, Node `await ask(prompt, { mock: '[{"question": "..."}]' })`. The real AI ignores `mock`. The mock returns the **same** reply for every input, so locally the content looks repetitive; tell the student that the real AI will differ.
5. Allow enough `max_tokens` (up to 800) so the JSON is not cut off.

## Frontend pattern

Put every backend call in `frontend/src/api.ts` (`api('/ask', { method: 'POST', body: JSON.stringify({ prompt }) })`). Show `error.message` to the user: it is already friendly. Keep the app static: client-side routing is fine, server rendering is not.

## Calling other services

- The **backend** may call public HTTPS APIs (`urllib.request` / `fetch`). Use a timeout of 8 seconds or less per call: the total request limit is 10 s (25 s with the class AI). Never send private data.
- The **browser** may call a keyless public API directly only if that API allows browser calls (CORS) and needs no key. Otherwise route it through the backend.
- Anything that needs a key goes through the backend with the key in a portal environment variable, never in the code.

## Where data lives

There is **no database**. Choose the simplest option and **tell the student its limits**:
- `localStorage` in the browser: free and simple, but the data stays in that browser on that device (clearing site data deletes it). Say this in plain words, and in the app where it matters.
- **Data shared between visitors** (a leaderboard, a guestbook, shared notes) needs an external service with an HTTP interface, called from the backend with `urllib.request` / `fetch`. The **student** must create that account and set its URL and key as portal environment variables; you must not create accounts, invent credentials or write them into code. Use these names so every project looks the same: `STORE_URL` and `STORE_KEY`, and add them as commented lines to `.env.example`. Unless the teacher names another service, use a free **Supabase** project's REST interface (PostgREST): create a table in its dashboard, then
  `GET  {STORE_URL}/rest/v1/<table>?select=*&order=created_at.desc&limit=10` and `POST {STORE_URL}/rest/v1/<table>` with a JSON body, sending the headers `apikey: <STORE_KEY>` and `Authorization: Bearer <STORE_KEY>` (use the "anon" key with row-level security enabled so visitors cannot read or change anything you did not allow).
  Make the app still work, in a clearly labelled "practice mode" (data kept in memory, say that it is lost and not shared), when the variables are missing. Keep every storage call to 8 seconds or less and answer `502 storage_error` when it fails. Explain the limits honestly: free tiers have quotas, anyone can post fake data unless you validate it, two writers at the same moment can overwrite each other, and the data is not live (refresh to see new entries).
- If this is not enough, tell the student to ask their teacher; do not pretend the platform has storage it does not have.

## Commands the student (or you) can run

| Command | What it does |
|---|---|
| `npm run dev` | Starts the site (http://localhost:3000) and the backend (http://127.0.0.1:8788). The AI is an **offline mock** locally, so nothing is spent. |
| `npm run dev -- --backend-only` | Just the backend. Test it with curl **including the `/api` prefix**: `curl http://127.0.0.1:8788/api/health`. To use another port run `python tools/dev_server.py <port>` (or `node tools/dev_server.mjs <port>`). |
| `npm run check` | The platform check: layout, limits, imports, secrets. **Run it before every commit.** |
| `npm run build` | Builds the site into `frontend/dist`. |
| `npm run doctor` | Checks Node, Python and git on the computer. |

## How to work

- Change one thing at a time, then run `npm run check` and, for UI work, `npm run dev`.
- Read the check output: every `✖` has a `fix:` line. Do not silence the check, edit it, or work around it.
- Prefer small, readable code with short comments. This is a learning project: explain choices in plain words.
- Send the AI only what it needs (a topic, task names), not private data.
- Before finishing a task, tell the student: what changed, how to try it locally, any limits (for example "saved in this browser only"), and "commit and push to `main` to deploy".

## First-time setup for the student (once)

1. Create a GitHub repository for this folder and push it.
2. GitHub > the repository > Settings > Secrets and variables > Actions > **New repository secret**: name `PORTAL_TOKEN`, value = the token from the teacher.
3. Push to `main`. Open the **Actions** tab: green means the site is live at the student's address.

## When something fails

| Symptom | Likely cause and fix |
|---|---|
| Action fails at "Platform check" | Run `npm run check` locally and fix each `✖`. |
| Action fails at "Deploy" with 401 | The `PORTAL_TOKEN` secret is wrong or the token was revoked: set it again or ask the teacher. |
| Deploy says the token cannot deploy (expired) | Ask the teacher for an extension, then run the workflow again. |
| "Owner not enabled for you" | The teacher has not switched on the Backend (or AI) for this student. |
| `/api/...` returns 404 `no_backend` | The backend has not been deployed yet: push, then check the Actions tab. |
| `AiError not_enabled` | The class AI is not switched on for the student: ask the teacher. |
| `AiError cap_reached` | The AI allowance is used up: ask the teacher. |
| Backend answers 502 `function_error` | The function crashed: read the logs in the portal (Backend card > Show recent logs). |
| Works locally, not deployed | A non-standard-library import, a file outside `backend/`, or a hard-coded localhost address: `npm run check` finds these. |
