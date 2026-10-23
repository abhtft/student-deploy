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

Not available: databases, file storage, cron jobs, websockets, server-side rendering (Next.js server apps do **not** work), long-running
processes, installing packages on the platform.

## Golden rules

1. **Layout is fixed:** `frontend/` (the site) and `backend/` (the function) at the top of the project. Do not rename or nest them.
2. **Frontend calls the backend with a relative address only:** `fetch('/api/...')` (use `frontend/src/api.ts`). Never `http://localhost...`, never a full URL of the platform.
3. **No secrets in the browser.** Anything in `frontend/` is public. Never put an API key or token there, and never use a `VITE_` variable for a secret. Never call an AI service (OpenAI, OpenRouter, Anthropic, Google...) from the frontend.
4. **AI goes through the backend, with `class_ai`:**
   Python: `from class_ai import ask` then `answer = ask("your prompt")`.
   Node: `import { ask } from './class_ai.mjs'` then `const answer = await ask('your prompt')`.
   `ask` returns the answer text or raises/throws `AiError` (it has `.kind` and a friendly `.message`; pass `default="..."` / `{ default: '...' }` to get a fallback text instead). **Do not edit `class_ai.py` / `class_ai.mjs`** (they are refreshed with the kit) and do not write your own AI client or read the AI key yourself.
5. **Backend uses only the standard library** (Python) or Node 22 built-ins (Node). The platform installs nothing. If a package is truly needed, bundle it into the backend folder. Use `urllib.request` / `fetch` for HTTP.
6. **Backend limits:** 10 seconds per request (25 s while the class AI is on), 256 MB, request and response at most 1 MB, the backend folder at most 500 files and 5 MB zipped. Keep AI answers short (`max_tokens` 200-400).
7. **Secrets:** a backend secret (a database URL, another service's key) is set by the student in the portal (Backend card > Environment variables) and read with `os.environ["NAME"]` / `process.env.NAME`. Never write a secret into any file, never create `.env` inside `backend/`. For local runs only, `.env.local` at the project root is allowed (it is git-ignored).
8. **The portal token is never written to any file.** It lives only in the GitHub repository secret `PORTAL_TOKEN` (and in the student's head). If a token or key appears in a file, remove it and tell the student to regenerate it.
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
Return JSON with a string `body`. Validate input (check types and lengths) and answer `400` with `{"error": "...", "message": "..."}` when it is wrong.
`backend/app.py` and `variants/node-backend/index.mjs` are working examples: `/health`, `/hello`, `/echo`, `/ask` (the AI).

## Frontend pattern

Put every backend call in `frontend/src/api.ts` (`api('/ask', { method: 'POST', body: JSON.stringify({ prompt }) })`). Show `error.message` to the user: it is already friendly. Keep the app static: client-side routing is fine, server rendering is not.

## Where data lives

There is **no database**. For a student project use `localStorage` in the browser for things only that browser needs. If data must be shared between users, use an external free service from the **backend** (keys in portal environment variables) and tell the student about the limits of that choice.

## Commands the student (or you) can run

| Command | What it does |
|---|---|
| `npm run dev` | Starts the site (http://localhost:3000) and the backend (http://127.0.0.1:8788). The AI is an **offline mock** locally, so nothing is spent. |
| `npm run check` | The platform check: layout, limits, imports, secrets. **Run it before every commit.** |
| `npm run build` | Builds the site into `frontend/dist`. |
| `npm run doctor` | Checks Node, Python and git on the computer. |

## How to work

- Change one thing at a time, then run `npm run check` and, for UI work, `npm run dev`.
- Read the check output: every `✖` has a `fix:` line. Do not silence the check, edit it, or work around it.
- Prefer small, readable code with short comments. This is a learning project: explain choices in plain words.
- Before finishing a task, tell the student: what changed, how to try it locally, and "commit and push to `main` to deploy".

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
