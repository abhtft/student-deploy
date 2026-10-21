# Student Deploy Portal: the complete workflow

This is the single reference for how the whole system works from end to end: what it is, how a request travels, what each role does day to day, how to set it up and operate it, how it was verified, and where it is limited. It describes the system **as deployed on 2026-10-21** (stack `student-hosting`, region `us-east-1`).

Other documents, each with a narrower job:

| Document | Use it for |
|---|---|
| **This file** | The whole picture and the day-to-day workflows |
| [API_REFERENCE.md](API_REFERENCE.md) | Every HTTP route, request, response and error code |
| [../README.md](../README.md) | Short intro and the original CLI setup |
| [../implement.md](../implement.md) | Step-by-step setup and verification, Parts 1 to 4 |
| [../backend_wire.md](../backend_wire.md) | Design reasoning and decisions for student backends |
| [../student/BACKEND.md](../student/BACKEND.md) | Student guide to writing a backend |
| [../learning.md](../learning.md) | Lessons learned, mistakes and how they were fixed |
| [../custom-domain/HANDOFF.md](../custom-domain/HANDOFF.md) | Background on the custom-domain spike |

---

## 1. What the system does

A teacher gives each student a **token**. With it a student publishes their **frontend** (a built folder or zip) to their own address, optionally attaches a **backend** (a small Node or Python function reached at `/api/...`), and optionally serves the site on their **own domain**. Everything runs in the teacher's AWS account; students get no AWS access.

```
                 TEACHER                                           STUDENT
   ┌──────────────────────────────┐                 ┌──────────────────────────────────────────┐
   │ create token (duration, name) │                 │ sign in with the token                    │
   │ extend / revoke / take offline│                 │ upload frontend  (dist folder or .zip)    │
   │ approve or deny regeneration  │                 │ upload backend   (optional, if allowed)   │
   │ Domain on/off   Backend on/off│                 │ set env variables, read logs              │
   │ run allowance (Runs…, +1,000) │                 │ add own domain   (optional, if allowed)   │
   └──────────────┬───────────────┘                 │ watch expiry bar, request regeneration     │
                  │                                  └─────────────────────┬────────────────────┘
                  └───────────── https://deploy.margdarshakss.com ─────────┘
                                         (the portal: /teacher and /student)

   Result for the student:
     https://<slug>.margdarshakss.com            the site            (always, while the token lives)
     https://<slug>.margdarshakss.com/api/...    the backend         (if the teacher turned Backend on)
     https://www.theirdomain.com[/api/...]       the same, on their own domain (if the teacher turned Domain on)
```

### The four layers (each added on top of the last)

1. **Static hosting** per student: files in a private S3 bucket, served by CloudFront at `<slug>.margdarshakss.com`.
2. **Tokens and the portal:** expiring tokens, teacher and student pages, regeneration requests, a daily sweeper.
3. **Custom domains:** a student's own subdomain with automatic HTTPS (CloudFront multi-tenant).
4. **Student backends:** one function per student behind a gateway, with a teacher-set on/off switch and run allowance.

The original command-line flow (a permanent key and `node deploy.mjs`) still works in parallel.

---

## 2. Architecture

### 2.1 Components and where each lives

| Layer | Component | Defined in | Purpose |
|---|---|---|---|
| Storage | S3 bucket (private) | `template.yaml` | `sites/<slug>/` published sites, `uploads/` temporary zips (deleted after 1 day), `archive/<slug>/` sites taken offline, `portal/` the portal pages |
| Data | DynamoDB `TokensTable` | `template.yaml` | token records plus locks and counters (see 2.3) |
| Secrets | SSM parameters `/student-deploy/teacher`, `/student-deploy/keys` | `template.yaml` (initial `{}`) | teacher login (salted hash) and legacy CLI keys |
| CDN | `Distribution` | `template.yaml` | `*.margdarshakss.com`: serves `sites/<slug>/` and routes `/api/*` to the backend |
| CDN | `PortalDistribution` | `template.yaml` | `deploy.margdarshakss.com`: portal pages from `portal/`, `/api/*` to the portal API |
| CDN | multi-tenant distribution `E1NTIC3LHBW49Q` | **created by hand** (outside the template) | serves students' custom domains, one tenant per domain |
| API | `DeployApi` (HTTP API) | `template.yaml` | portal API and the legacy CLI routes |
| API | `BackendApi` (HTTP API) | `template.yaml`, only if `BackendEnabled=true` | student backend traffic, with its own throttle |
| Compute | `DeployFunction` (`lambda/app.py` + `portal.py`, `domains.py`, `backends.py`) | `template.yaml` | the portal API, publishing, domain and backend management |
| Compute | `SweeperFunction` (daily 03:00 UTC) | `template.yaml` | archives sites past expiry + grace, finishes stuck domain removals |
| Compute | `GatewayFunction` (`lambda/gateway.py`) | `template.yaml`, only if `BackendEnabled=true` | the single entry to every student backend: checks, limits, counting |
| Compute | `sd-<slug>` | created at runtime by the portal | one function per student backend |
| Security | `StudentSandboxRole` + permission boundary | `template.yaml` | the role every student function runs as: it can only write its own logs |

### 2.2 How requests travel

**A. Someone opens a student's site** (`https://alice.margdarshakss.com/cart`)
```
Browser -> CloudFront (Distribution) -> router function: host "alice" -> /sites/alice/...,
           a path with no file extension becomes /index.html (single-page-app fallback)
        -> S3 sites/alice/index.html   (private bucket, read through an origin access control)
```

**B. The student's page calls its backend** (`fetch('/api/analyse')` on `alice.margdarshakss.com`)
```
Browser -> CloudFront /api/* behavior -> BackendRouteFunction: host -> slug, /api/analyse -> /b/alice/analyse, add x-viewer-ip
        -> BackendApi (one catch-all route /b/{slug}/{proxy+}) -> GatewayFunction
              1 origin secret correct?   2 path and slug valid?   3 body <= 1 MB?
              4 backend deployed?        5 token active (not revoked/expired/offline)?
              6 teacher toggle ON?       7 per-visitor limit?      8 in-flight slot free (max 3 total, 2 per student)?
              9 run allowance left? (atomic count)                 -> invoke
        -> sd-alice  handler(event, context)  -> response validated and shaped -> back to the browser
```

**C. The same on a custom domain** (`https://test.votebecho.com/api/analyse`): the multi-tenant distribution has its own `/api/*` route to the same API, with origin path `/b/{{student}}` (the tenant parameter picks the student) and the function `student-hosting-tenant-api` stripping `/api`.

**D. A student publishes** (portal): the browser zips the folder, asks `POST /api/student/upload-url` for a presigned S3 URL, `PUT`s the zip straight to S3, then calls `POST /api/student/publish`. The function validates and unzips into `sites/<slug>/`, removes files that disappeared, and clears the CDN caches (the normal distribution and the student's custom-domain tenant).

### 2.3 What is stored in DynamoDB (`pk` is the only key)

| `pk` prefix | Item | Notes |
|---|---|---|
| `tok#<sha256>` | the token record | holds slug, name, expiry, flags, `regen`, `domain*`, `backend`. Only the **hash** of a token is stored |
| `slug#<slug>` | a lock | keeps site names unique |
| `domain#<domain>` | a lock | keeps custom domains unique |
| `fail#<ip>` | login failures | teacher login lockout (expires by TTL) |
| `runs#<slug>#<period>` | run counter | exact allowance counting (expires by TTL) |
| `inflight#global`, `inflight#<slug>` | in-flight counters | the concurrency limiter, with leak recovery |
| `ip#<slug>#<hash>#<minute>` | per-visitor counter | rate limit (expires by TTL) |

### 2.4 Token life

```
 created ──► ACTIVE ───────────────► EXPIRED (3 days, read-only) ───────► OFFLINE
              │  warning bar in the last 3 days   │ site still online; student can sign in and      files moved to archive/<slug>/
              │  student may request regeneration │ request regeneration; uploads and backend       (never deleted)
              │                                   │ deploys are blocked
              └── revoke (teacher): token stops working; the live site is not changed
 approve a request or extend (teacher) ──► ACTIVE again, and an archived site is restored.
```
Status is **derived from time** (`expires_at`, the grace period, an `archived` flag, a `revoked` flag), not stored, so nothing can get out of sync. The daily sweeper only moves *files*.

---

## 3. Roles and workflows

### 3.1 Teacher: daily use (`https://deploy.margdarshakss.com/teacher`)

| Task | How |
|---|---|
| Sign in | username and password (5 wrong attempts from one address lock it for 15 minutes) |
| Create a token | **New token**: valid for 7 to 180 days or custom (1 to 365), optional student name, optional site name. The token is shown **once**: copy it, or use **Copy message for the student** |
| Site name rules | teacher-set name, else made from the student name, else random (`s-xxxxxx`). 1 to 30 lowercase letters, digits and `-`. Reserved: `sites uploads archive deploy www api admin mail ftp app apps static assets bs lenden` |
| See state | each row: status pill, expiry bar, last deploy, custom-domain state, backend usage |
| Extend | adds days to the current expiry (counted from today if already expired); restores an archived site |
| Take offline | stops serving the site now (files archived, not deleted) |
| Revoke | the student can no longer sign in or deploy; the live site is not changed |
| Requests tab | pending regeneration requests with the student's note: **Approve** (choose the new duration, counted from today) or **Deny** (optional reason) |
| **Domain: on / off** | lets this student add a custom domain. Turning it off later does **not** remove a live domain |
| **Backend: on / off** | ON serves requests and allows deploys. OFF answers `503 backend_off` within about 10 seconds and pauses deploys; code is kept. This is the kill switch |
| **Runs…** / **+1,000** | the run allowance: a number and a period (`day`, `month`, `total`). Default 5,000 per month, maximum 1,000,000, 0 means none. A *run* is one call that reached the student's function (failures count, blocked requests do not) |

Nothing is deleted automatically: archives, functions and code stay until a human removes them.

### 3.2 Student: publishing the frontend (`/student`)

1. Sign in by pasting the token. The card shows the site address, the status and the expiry bar.
2. Build the project (`npm run build`), then in **Upload your site** drag in the build folder (or choose a `.zip`).
3. A checklist runs in the browser before anything is sent:
   - `index.html` is found (a `dist/`, `build/` or `out/` inside a dropped project is detected; a source folder whose `index.html` loads `/src/...` is rejected);
   - at most 2,000 files and 200 MB, with `node_modules` and `.git` never read;
   - no `node_modules`, `.git` or `.env*` in the upload;
   - file names use letters, digits, `. _ - @ + ~` only (spaces and special characters are blocked; capital letters only warn).
4. **Upload and publish**. The site is live at `https://<slug>.margdarshakss.com/` within seconds.
5. **Expiry:** an amber banner appears in the last 3 days with **Request regeneration**; the teacher answers in the inbox. After expiry the student can still sign in (read-only) for 3 days.

The older command-line route is unchanged: the teacher runs `node admin.mjs add <name>`, and the student runs `node deploy.mjs` with `DEPLOY_KEY` (see `student/README.md`).

### 3.3 Student: adding a backend (`/student`, **Backend** card)

Requires **Backend: on** from the teacher. Full guide: [../student/BACKEND.md](../student/BACKEND.md).

1. Write one function: `index.mjs` (Node 22) or `app.py` (Python 3.12) exporting `handler`. Start from `student/backend-template/` and test locally with `node student/backend-test.mjs <folder> GET /hello`.
2. In the Backend card choose the backend folder (or a zip). The checker looks for the entry file, refuses `.env` files, and ignores `__pycache__`. Limits: 5 MB zip, 50 MB unzipped, 500 files.
3. **Upload and deploy**: the card shows *Deploying…* for a few seconds, then **Ready**.
4. Secrets: **Environment variables** (write-only; the portal can never show a value again; at most 20 variables and 4 KB).
5. Call it from the site at `/api/...`. **Try it** opens `/api/health`. **Show recent logs** lists the function's output for the last hour (kept 7 days).
6. The **usage meter** shows runs used against the allowance (amber at 80%, red at 100%).
7. **Remove backend** deletes the function and its log group; the teacher's on/off and allowance stay.

What visitors see when something is off: see the error table in [API_REFERENCE.md](API_REFERENCE.md#student-backend-gateway). A complete worked example (a React app plus a Python backend) lives in `D:\Github_Codes\Shopping_List_Prepare_by_voice_command_dist2`.

### 3.4 Student: adding a custom domain (**Custom domain** card)

Requires **Domain: on** from the teacher.

1. Enter a **subdomain** such as `www.theirname.com` (a bare domain cannot hold a CNAME at most providers). `margdarshakss.com` names and AWS addresses are refused. One domain per student, and the token must be active.
2. At their DNS provider add one `CNAME` for that name pointing to the **routing endpoint** shown in the card (`d4cls3ve04vi3.cloudfront.net`). On Cloudflare the record must be **DNS only** (grey cloud).
3. The card advances by itself: **DNS record, HTTPS certificate, Finishing setup, Live**, usually 1 to 3 minutes after the record is visible.
4. **Remove domain** disables the tenant, waits until it is deployed, then deletes it (the daily sweeper finishes it if the student leaves).

A domain keeps working if the teacher later turns the switch off; the switch only controls whether a student can *add* one.

### 3.5 What happens automatically

| When | What |
|---|---|
| Every publish | validate, unzip into `sites/<slug>/`, delete files no longer present, clear the CDN cache for the site and for its custom-domain tenant |
| Daily 03:00 UTC (sweeper) | tokens past expiry + 3 days: site moved to `archive/<slug>/`, flagged `archived`; also finishes domain removals the student never completed |
| Approve / extend | an archived site is moved back and caches are cleared |
| Every request to `/api` | the gateway checks, counts one run, invokes, and releases its slot |

---

## 4. Setting it up and operating it

### 4.1 First-time setup, in order (details: `implement.md`)

1. **Prerequisites:** AWS CLI logged in, SAM CLI, Node 20+, Python 3.12, an ACM certificate for `*.margdarshakss.com` in us-east-1.
2. **Deploy the stack** (`sam deploy`, parameters in `samconfig.toml`). Two-phase for the portal address: deploy with `PortalAlias=false`, create the DNS record `deploy -> <PortalDistributionDomain>`, redeploy with `PortalAlias=true` (CloudFront refuses an alias whose DNS still points at another distribution, e.g. through the `*` wildcard).
3. **DNS records** (at the DNS host): `*  CNAME -> <DistributionDomain>`; `deploy  CNAME -> <PortalDistributionDomain>`. Existing explicit records (such as `bs`) keep winning over `*`.
4. **Teacher login:** `node admin.mjs teacher-setup <username>` (hidden password prompt; stores a salted scrypt hash in SSM). Never edit the `TeacherAccount` resource in the template: an update resets it.
5. **Publish the portal pages:** `node admin.mjs portal-publish`.
6. **Custom domains (hand-made pieces):** the multi-tenant distribution, the function `student-hosting-spa-fallback`, the connection group (routing endpoint) and the origin access control. Their IDs go into `samconfig.toml` as `TenantDistributionId` and `RoutingEndpoint`. Configuration files: `custom-domain/`. Then give that distribution its `/api` route: `python custom-domain/apply-tenant-api-route.py --apply` (see 4.4).
7. **Backends:** set `BackendEnabled="true"` in `samconfig.toml` and deploy (staged: see `implement.md` Part 4). Recommended first: a budget alert, and request the Lambda concurrency quota increase.

### 4.2 The safe deploy routine (every time)

```
node tests/run.mjs                                            # all checks green
sam deploy --no-execute-changeset --no-confirm-changeset      # creates a changeset, changes nothing
aws cloudformation describe-change-set ...                    # read EVERY row: no unexpected Remove or Replace
aws cloudformation execute-change-set ...
# verify: portal 200, API 401 without a session, existing sites and bs unaffected
```
**Deploy only from this folder.** A template from another copy once deleted the portal, the table and the sweeper. Creating a changeset also catches problems that lint cannot (for example a circular dependency between resources).

### 4.3 Everyday commands

| Task | Command |
|---|---|
| Change the portal pages | edit `web/`, then `node admin.mjs portal-publish` |
| Reset the teacher password | `node admin.mjs teacher-setup <username>` |
| Legacy CLI students | `node admin.mjs add|remove|list` |
| Watch the sweeper | `sam logs --stack-name student-hosting --name SweeperFunction` |
| List student functions | `aws lambda list-functions --query "Functions[?starts_with(FunctionName,'sd-')].FunctionName"` |
| See a student's backend logs | CloudWatch group `/aws/lambda/sd-<slug>` |
| Archived sites | `aws s3 ls s3://<bucket>/archive/` (removed only by hand: `aws s3 rm .../archive/<slug> --recursive`) |
| Emergency stop for one student | the **Backend: off** button, or `aws lambda put-function-concurrency --function-name sd-<slug> --reserved-concurrent-executions 0` |
| Stop all backends | deploy with `BackendEnabled="false"` (functions stay, nothing is deleted) |
| Local click-through, no AWS | `python tests/dev_server.py` then `http://localhost:8777/` (demo teacher login and tokens are printed) |

### 4.4 Resources outside CloudFormation

These were created with the CLI and are **not** recreated by `sam deploy` or removed by `sam delete`:

| Thing | Value |
|---|---|
| Multi-tenant distribution (template for tenants) | `E1NTIC3LHBW49Q` (`custom-domain/tenant-distribution.json`) |
| Function: SPA fallback | `student-hosting-spa-fallback` (`custom-domain/spa-fallback.js`) |
| Function: tenant `/api` route | `student-hosting-tenant-api` (`custom-domain/tenant-api-route.js`) |
| Connection group routing endpoint | `d4cls3ve04vi3.cloudfront.net` |
| Origin access control for the tenants | `E35NKLYVBXWXX4` |
| Tenants | one per custom domain, created and deleted by the portal at runtime |

If the tenant distribution is ever recreated, redo its `/api` route with `custom-domain/apply-tenant-api-route.py` (dry run by default; saves the current config first; never prints the shared secret).

### 4.5 Configuration reference

Template parameters (`samconfig.toml`): `RootDomain`, `CertificateArn`, `PortalAlias`, `TenantDistributionId`, `RoutingEndpoint`, `BackendEnabled`, `OfflineGraceDays`, `KeysParameterName`, `TeacherParameterName`.
Lambda environment (set for every function through `Globals`): `BUCKET`, `DISTRIBUTION_ID`, `DISTRIBUTION_DOMAIN`, `ROOT_DOMAIN`, `KEYS_PARAM`, `TOKENS_TABLE`, `TEACHER_PARAM`, `OFFLINE_GRACE_DAYS`, `TENANT_DISTRIBUTION_ID`, `ROUTING_ENDPOINT`, `BACKEND_ENABLED`, `SANDBOX_ROLE_ARN`, `BACKEND_RESERVED_CONCURRENCY` (0: not usable at an account limit of 10), `INFLIGHT_GLOBAL` (3), `INFLIGHT_STUDENT` (2), `PER_IP_PER_MINUTE` (120), `ORIGIN_SECRET` (derived from the stack ID).

### 4.6 Limits at a glance

| Area | Limit |
|---|---|
| Frontend upload | 50 MB zip, 200 MB unzipped, 2,000 files; about 25 s to publish |
| Token duration | 1 to 365 days; grace 3 days; warning window 3 days |
| Sessions | teacher 8 hours, student 12 hours |
| Backend upload | 5 MB zip, 50 MB unzipped, 500 files; one entry file (`index.mjs`/`index.js` or `app.py`) |
| Backend runtime | 256 MB, 10 seconds, request and response 1 MB each; 20 env variables, 4 KB |
| Backend concurrency | 3 student requests in flight in total, 2 per student; 120 requests per minute per visitor; Backend API throttle 10 per second (burst 20) |
| Run allowance | default 5,000 per month, up to 1,000,000; the teacher edits it any time |
| Account Lambda limit | **10 concurrent executions** (shared with other apps): enable backends for a few students only until the quota is raised |
| Custom domains | one per student, subdomains only |

---

## 5. Security model (what protects what)

- **No AWS access for students.** Their key or token only reaches their own folder and function.
- **Private bucket.** Only CloudFront can read, only `sites/*` (and `portal/*` for the portal distribution), through origin access control.
- **Tokens:** 128-bit random, only the SHA-256 is stored, shown once. Two session types are signed with different keys, so a student session can never pass a teacher check. Revoking a token ends its sessions at once.
- **Teacher login:** salted scrypt hash; the hash is computed even for a wrong username (no timing leak); five failures lock an address for 15 minutes. Behind CloudFront the real address comes from `x-viewer-ip`, trusted **only** together with the secret origin header (direct calls cannot forge it).
- **Student functions run in a sandbox:** a role that can only write its own logs (bounded by a permission boundary), 256 MB, 10 s, no AWS credentials worth having. They can use the public internet (a residual risk, accepted for a class setting).
- **The control plane is narrow.** The Deploy Lambda may manage only functions named `sd-*`, may pass only the sandbox role and only to Lambda, and may never create roles; `tests/test_template_backend.py` guards this against accidental widening.
- **The gateway protects the account.** Direct calls to the Backend API are refused; slots are capped so student traffic cannot take more than about 6 of the account's 10 Lambda slots; every limit is enforced on the server.
- **Secrets:** environment variables are write-only and never stored in DynamoDB or returned by any API; failure details never reach visitors or platform logs; `.env` files in uploads are refused.
- **Text is never HTML** in the portal pages (a small DOM helper builds every element).

Known residual risks: a student's public `/api` can be called by anyone, so strangers can use up a student's run allowance (limits and teacher top-ups mitigate it); function egress to the internet is unrestricted.

---

## 6. How it was verified

**Automated (17 checks, `node tests/run.mjs`, no AWS needed):** portal logic, publishing, regeneration, sweeper, custom-domain state machine, backend allowance (exact under 60 parallel callers), in-flight limiter and leak recovery, gateway lifecycle and header hygiene, response shaping, real Python and Node handlers executed from uploaded zips, starter templates, SigV4 presigned-URL configuration, template IAM scoping (mutation-tested), the CloudFront functions, the tenant distribution config, the folder checkers and the in-browser zip builder (validated by the Lambda's own validator).

**In the browser (local dev server):** teacher and student flows, expiry bars and banners, uploads with failing and passing checklists, the custom-domain stepper, the backend card (deploy, env, logs, allowance, off/on), light and dark themes, phone width.

**Live, with temporary students (removed afterwards, leftovers scanned):**
- custom domain: certificate, HTTPS, redeploy reaching the domain within seconds, removal;
- backends: 48 checks (Python and Node 22 deploy, calls through CloudFront, env var used but never returned, logs with 7-day retention, exact allowance then 429, off/on, reserved concurrency 0 accepted at a limit of 10, 8 parallel requests giving exactly 3 runs and 5 `busy`, removal, cleanup);
- custom domain plus backend with a real student's site (`test.votebecho.com`): analyse, submit, health, SPA fallback, direct-API and forged-header checks.

**Manual acceptance checklist** (after any significant change):
1. Teacher: sign in, create a token, copy the message.
2. Student (private window): sign in, upload a build folder: checklist green, site opens at `<slug>.margdarshakss.com`.
3. A folder with `my photo.png` or a source `index.html`: the button stays disabled and names the problem.
4. Token with 2 days left: amber banner, **Request regeneration**, teacher approves with a new duration.
5. **Take offline**: the site stops (about a minute), files appear in `archive/<slug>/`; **Extend** brings it back.
6. **Backend: on**, deploy the Python and Node starter templates, `/api/hello` answers, an env variable is visible to the function, logs show output.
7. **Runs…** to 3: the 4th call returns `429 allowance_exhausted`; **+1,000** restores service; **Backend: off** returns `503 backend_off` within about 10 seconds.
8. **Domain: on**, add a custom domain, wait for **Live**, open it over HTTPS, redeploy and see the change, call `/api/...` on it, **Remove domain**.

---

## 7. Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| "Teacher account is not set up yet" | the SSM entry is still `{}` | `node admin.mjs teacher-setup <name>` |
| "Too many failed attempts" | 5 wrong passwords from one address | wait 15 minutes, or delete the `fail#<ip>` item |
| Upload fails with a network error and a CORS note in the console | page opened on an address other than `https://deploy.margdarshakss.com` | use the real portal address |
| Pages show old content after a change | cache | `node admin.mjs portal-publish` (it clears the cache), then hard-refresh |
| `sam deploy` fails with `CNAMEAlreadyExists` / "DNS record points to another distribution" | wildcard DNS still points the name at another distribution | two-phase alias (4.1 step 2) |
| Changeset fails with "Circular dependency" | a function's shared environment references a resource that depends on it | override those variables for that function (see the gateway in `template.yaml`) |
| `/api/...` shows the site's own page | backend feature not deployed, CloudFront still updating, or a custom-domain tenant without its `/api` route | check `BackendEnabled`; apply `custom-domain/apply-tenant-api-route.py` |
| **HTML** 403 on `POST /api/...` on a custom domain | CloudFront rejected the method: the tenant distribution has no `/api/*` behavior | `python custom-domain/apply-tenant-api-route.py --apply` |
| `404 no_backend` | no backend deployed yet, or still creating | wait for **Ready**; a freshly deployed backend is served within about 2 seconds |
| `403 forbidden` from the gateway | request did not come through CloudFront (no origin secret) | call the site address, not the API URL |
| `429 busy` | in-flight limiter working | the starter frontend retries; raise caps only after the quota increase |
| `429 allowance_exhausted` | the student's runs are used up | **+1,000** or **Runs…** |
| `503 backend_off` | the teacher turned it off | **Backend: on** |
| Backend upload "SignatureDoesNotMatch" | presigned URL signed with the old scheme | the backend S3 client must use SigV4 (fixed and tested) |
| Custom domain stuck on "Add the DNS record" | the CNAME is not visible, or the record is proxied | `nslookup -type=CNAME <domain>` must show the routing endpoint; Cloudflare **DNS only** |
| Custom domain "CloudFront refused this domain" | the name is attached to another distribution | remove it there first |
| Domain stuck on "Removing" | the tenant is still deploying | it finishes on the next poll or the daily sweep |
| Site name "already taken" | names are unique across portal tokens, CLI students and reserved names | choose another |

A response from the platform's gateway is always JSON `{"error": "<code>"}`. An **HTML** error page from `X-Cache: Error from cloudfront` means CloudFront itself refused the request and the backend was never reached.

---

## 8. Costs

Pay-per-use services (CloudFront, Lambda, API Gateway, DynamoDB on demand, S3): a class costs a few cents to a few dollars a month. The run allowance bounds backend compute per student (the default 5,000 runs of at most 10 s at 256 MB is roughly $0.17 per student per month at the very worst, approximate). Custom-domain tenant pricing is **not verified**: a community report says the first 10 tenants are free; check the billing console. Recommended: an AWS Budget with email alerts before widening access.

---

## 9. Known limitations and next steps

| Limitation | Notes |
|---|---|
| One teacher account | several accounts need a list in the SSM entry plus add/remove commands (designed, not built) |
| Backend deploy only through the portal | the CLI keys have no token record to hold the toggle and allowance; needs a design decision |
| Lambda quota is 10 | request an increase to 1000 before enabling more than a few backends, then switch to reserved concurrency per student |
| Function internet egress is unrestricted | accepted for a class setting; blocking it needs a VPC with filtering |
| No Content-Security-Policy on the portal | add once it can be tested against real S3 uploads |
| No teacher button to remove a student's custom domain | switch the permission off, take the site offline, or revoke |
| Custom-domain pieces are outside CloudFormation | documented and guarded by a test; bring them into the template later |
| `/api` exactly (no trailing slash) | the `/api/*` route does not match it, so the visitor gets the site's own page. `/api/` and everything below it reach the student's function (path `/` for `/api/`). Frontends should always call `/api/<route>` (checked live on both the normal address and a custom domain) |
| Not yet: CORS allow-list for cross-origin use, "Request more runs" from the student, custom-domain support for the portal address itself | listed in `backend_wire.md` |

---

## 10. Repository map

| Path | Purpose |
|---|---|
| `template.yaml`, `samconfig.toml` | all AWS resources managed by CloudFormation, and the parameters used for this stack |
| `lambda/app.py` | entry point: legacy CLI routes, portal publish, cache invalidation, restore/archive, sweeper |
| `lambda/portal.py` | tokens, logins, sessions, regeneration, store abstraction, routing for `/api/...` |
| `lambda/domains.py` | custom-domain state machine, removal, teacher switch |
| `lambda/backends.py` | backend control plane: validate, create/update, env, logs, remove, toggle, allowance |
| `lambda/gateway.py` | the gateway for every student backend call |
| `web/` | the portal pages and modules (`teacher`, `student`, `common`, `check`, `backend`, `backend-check`, `zip`, `shared.css`) |
| `admin.mjs` | `add`, `remove`, `list`, `teacher-setup`, `portal-publish` |
| `student/` | CLI uploader, guides, starter backend templates, local backend runner |
| `custom-domain/` | the tenant distribution config, functions, and the reviewed apply script |
| `tests/` | the test suite, in-memory fakes of AWS, and the local dev server |
| `docs/` | this guide and the API reference |
| `implement.md`, `backend_wire.md`, `learning.md`, `README.md` | setup steps, design, lessons, intro |
