# Implementation guide: test, deploy and onboard (margdarshakss.com)

This guide has two parts: Part 1 (below) sets up the hosting and the CLI flow; [Part 2](#part-2-web-portal-at-deploymargdarshakss-com) adds the web portal. Follow the phases in order. Each phase ends with a **✅ Pass check**; don't continue until it passes.
Total time: about 45 minutes, most of it waiting for CloudFront and DNS.

Commands use `curl.exe` (not `curl`) so they work in both PowerShell and Git Bash. Run everything from this folder unless told otherwise:

```
cd infra/student-deploy
```

---

## 0. What I checked in your AWS account (read-only, nothing was changed)

| Check | Result | Consequence |
|---|---|---|
| AWS account | `417780655868`, IAM user with `AdministratorAccess` | You can create every resource in this stack |
| Default region | `us-east-1` | Stack deploys here; the CloudFront certificate must also be here, and it is |
| ACM certificate `*.margdarshakss.com` | **ISSUED**, us-east-1, expires 2027-02-09 | Used as-is. It is already attached to another distribution, which is fine (certificates can be shared) |
| Existing CloudFront distribution | `E2TDU2YC4RBM49` serving `bs.margdarshakss.com` | Left untouched. A specific name (`bs`) beats the wildcard (`*`), so `bs.margdarshakss.com` keeps working |
| Route 53 hosted zones | **none** | Your DNS is at your registrar or another DNS host, so the wildcard record in Phase 6 is added **by hand there** |
| Existing stacks | two ECS stacks, unrelated | No name clashes (`student-hosting`, `/student-deploy/keys`) |
| SAM CLI | **not installed** | Phase 2 installs it |

> **Wildcard certificate rule:** `*.margdarshakss.com` covers exactly one level, so student sites are `alice.margdarshakss.com`.
> `alice.apps.margdarshakss.com` would **not** be covered. That's why `samconfig.toml` uses `RootDomain=margdarshakss.com`.

`samconfig.toml` in this folder already holds your stack name, region, domain and certificate ARN, so deploy needs no prompts.

---

## Phase 1: Local tests (no AWS, 1 minute)

These run the **real** `deploy.mjs` and the **real** Lambda code against an in-memory fake of S3/SSM/CloudFront, plus the real CloudFront routing function from `template.yaml`.

Needs Node 18+ and Python 3 with boto3:

```
pip install boto3
node tests/run.mjs
```

Expected:

```
✔ lambda: zip validation, content types, warnings
✔ router: subdomain mode (RootDomain set)
✔ router: path mode (RootDomain empty)
✔ e2e: first deploy publishes all files with correct headers
✔ e2e: redeploy removes files that disappeared from the build
✔ e2e: wrong key is rejected and changes nothing
✔ e2e: key of an unknown student is rejected

All local tests passed
```

✅ **Pass check:** `All local tests passed`. If a step fails, fix it before touching AWS.

Optional: lint the template (`uvx cfn-lint template.yaml`). One warning about `CertificateArn` is expected and harmless.

---

## Phase 2: Install the SAM CLI (once)

```
winget install Amazon.SAM-CLI
```

Close and reopen your terminal, then:

```
sam --version
aws sts get-caller-identity
```

✅ **Pass check:** `sam --version` prints a version, and `get-caller-identity` shows account `417780655868`.

(If `winget` can't install it, use the MSI from the [AWS SAM CLI install page](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html).)

---

## Phase 3: Pre-flight (2 minutes)

Record the DNS baseline for your existing site so you can prove later that it was not affected:

```
nslookup bs.margdarshakss.com
```

Note the answer. It should point at `d15a5zralmyfzf.cloudfront.net`. Then confirm the certificate is still valid and covers the wildcard:

```
aws acm describe-certificate --region us-east-1 --certificate-arn arn:aws:acm:us-east-1:417780655868:certificate/6a5e2ee0-71cd-4d9b-9b5c-7d43b675d9bb --query "Certificate.[Status,SubjectAlternativeNames]" --output text
```

✅ **Pass check:** prints `ISSUED` and `*.margdarshakss.com`.

---

## Phase 4: Deploy the stack (about 5–10 minutes)

```
sam deploy
```

SAM prints a **changeset**: the list of resources it will create. Review it. You should see only *Add* rows: an S3 bucket and policy, a CloudFront distribution, function and access control, an HTTP API, a Lambda function with its IAM role, and one SSM parameter. Nothing should say *Modify* or *Remove*. Answer `y` to deploy.

CloudFront is the slow part (usually 3–8 minutes). When finished you'll see `Successfully created/updated stack - student-hosting`. Show the outputs:

```
aws cloudformation describe-stacks --stack-name student-hosting --query "Stacks[0].Outputs" --output table
```

Write down these four values:

| Output | Used for |
|---|---|
| `DeployApiUrl` | Phase 5 (goes into the student script) |
| `DistributionDomain` | Phase 6 (the DNS record) and the pre-DNS smoke test |
| `BucketName` | Cleanup and debugging |
| `SiteUrlPattern` | Should read `https://<student>.margdarshakss.com/` |

✅ **Pass check:** stack status is `CREATE_COMPLETE`:

```
aws cloudformation describe-stacks --stack-name student-hosting --query "Stacks[0].StackStatus" --output text
```

> **If the deploy fails**, CloudFormation rolls everything back automatically (nothing is left running or billed). Read the cause with
> `aws cloudformation describe-stack-events --stack-name student-hosting --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" --output text`
> then see [Troubleshooting](#troubleshooting). The stack will be stuck in `ROLLBACK_COMPLETE`; delete it before retrying:
> `aws cloudformation delete-stack --stack-name student-hosting`, wait a minute, then run `sam deploy` again.

---

## Phase 5: Give the student script its API URL

Replace the placeholder in `student/deploy.mjs` with your `DeployApiUrl`. This one-liner avoids the PowerShell encoding trap (the file contains ✔/✖ characters):

```
node -e "const f='student/deploy.mjs',u=process.argv[1],fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('https://REPLACE_ME.execute-api.REGION.amazonaws.com',u))" https://YOUR-API-ID.execute-api.us-east-1.amazonaws.com
```

(Or just open the file and edit the `API_URL` line near the top.)

✅ **Pass check:** `node --check student/deploy.mjs` prints nothing, and the line `const API_URL = ...` shows your real URL.

---

## Phase 6: Smoke test BEFORE touching DNS (about 5 minutes)

This proves the whole pipeline (key check, upload, unzip, S3, CloudFront) using the plain `cloudfront.net` address, with zero DNS changes.

### 6a. Create a test student

```
node admin.mjs add smoketest
```

It prints a `DEPLOY_KEY=smoketest.xxxx` line. Copy it. Because `admin.mjs` creates the key store entry, this also verifies your AWS CLI access works end to end.

### 6b. Deploy the sample site

PowerShell:

```powershell
cd sample-site
$env:DEPLOY_KEY = "smoketest.PASTE_SECRET_HERE"
node ../student/deploy.mjs --skip-build --dir .
```

Git Bash:

```bash
cd sample-site
DEPLOY_KEY=smoketest.PASTE_SECRET_HERE node ../student/deploy.mjs --skip-build --dir .
```

Expected:

```
▶ Packed 3 files from ./ (1 KB)
▶ Publishing...
✔ Live at https://smoketest.margdarshakss.com/  (3 files, ...)
```

(The `margdarshakss.com` address won't resolve yet; that's Phase 7.)

### 6c. Check it through CloudFront's own address

Replace `DIST` with your `DistributionDomain` (looks like `d1234abcd.cloudfront.net`):

```
curl.exe -s -o NUL -w "%{http_code} %{content_type}\n" https://DIST/smoketest/
curl.exe -s -o NUL -w "%{http_code} %{content_type}\n" https://DIST/smoketest/assets/app.js
curl.exe -s -o NUL -w "%{http_code} %{content_type}\n" https://DIST/smoketest/assets/style.css
```

(Git Bash: use `/dev/null` instead of `NUL`.)

Expected:

```
200 text/html; charset=utf-8
200 text/javascript; charset=utf-8
200 text/css; charset=utf-8
```

Then open `https://DIST/smoketest/` in a browser. You should see **"It works 🎉"** and the line **"JavaScript loaded from d1234abcd.cloudfront.net"** (this proves JS loaded and executed).

### 6d. Check the security properties

```
curl.exe -s -o NUL -w "%{http_code}\n" https://DIST/doesnotexist/
curl.exe -s -o NUL -w "%{http_code}\n" https://BUCKET.s3.amazonaws.com/sites/smoketest/index.html
curl.exe -s -o NUL -w "%{http_code}\n" -X POST YOUR_DEPLOY_API_URL/publish
```

(`YOUR_DEPLOY_API_URL` is the full `DeployApiUrl` output, including `https://`. `BUCKET` is the `BucketName` output.)

Expected: the first prints `403` or `404` (an unknown student has nothing), the second prints `403` (**the bucket is private; only CloudFront can read it**), the third prints `401` (no key means no access).

### 6e. Check re-deploys clean up and refresh

Edit `sample-site/index.html` (change the `<h1>` text), delete `sample-site/assets/style.css`, and run the Phase 6b deploy again. Wait about 30 seconds, then hard-refresh (Ctrl+Shift+R) the browser. You should see the new heading, unstyled, and:

```
curl.exe -s -o NUL -w "%{http_code}\n" https://DIST/smoketest/assets/style.css
```

prints `403` or `404` (the old file was removed). Restore the sample with `git checkout sample-site` afterwards.

✅ **Pass check:** 6c all `200`, 6d returns `403/404`, `403` and `401`, 6e shows the update and the removal.

---

## Phase 7: Point your wildcard DNS at CloudFront

Because you have no Route 53 zone, do this at wherever `margdarshakss.com` DNS is managed (registrar or DNS host).

Add **one** record:

| Type | Name / Host | Value / Target | TTL |
|---|---|---|---|
| `CNAME` | `*` | your `DistributionDomain` (e.g. `d1234abcd.cloudfront.net`) | 300 |

Notes:
- **Do not delete or change existing records**, especially the one for `bs`. Explicit records always win over `*`, so `bs.margdarshakss.com` keeps going to its own distribution.
- Some hosts want the full name (`*.margdarshakss.com`) and some just `*`. Use whichever the form expects.
- **Cloudflare:** set the record to **DNS only** (grey cloud). A proxied record sends traffic through Cloudflare instead of straight to CloudFront and breaks the setup.
- A wildcard also catches names you haven't defined (e.g. `foo.margdarshakss.com`); they'll show an error page instead of "not found". That's harmless.

Wait 1–5 minutes, then verify:

```
nslookup smoketest.margdarshakss.com
nslookup bs.margdarshakss.com
curl.exe -sI https://smoketest.margdarshakss.com/
```

Expected:
- `smoketest...` resolves to CloudFront addresses (a CNAME to `d1234abcd.cloudfront.net`).
- `bs...` still gives **exactly the baseline you recorded in Phase 3**.
- `curl` shows `HTTP/2 200` and `content-type: text/html; charset=utf-8`.

Open `https://smoketest.margdarshakss.com/` in a browser: "It works 🎉", padlock valid, and "JavaScript loaded from smoketest.margdarshakss.com". Then click the **/some/deep/route** link. It must show the **same page** (single-page-app fallback works).

✅ **Pass check:** all of the above, and `https://bs.margdarshakss.com` still loads as before.

---

## Phase 8: Clean up the smoke test

```
node admin.mjs remove smoketest
aws s3 rm s3://BUCKET/sites/smoketest --recursive
```

✅ **Pass check:** `node admin.mjs list` no longer shows `smoketest`.

---

## Phase 9: Onboard students

### 9a. Create their keys

```
node admin.mjs add alice bob carol
```

Each student gets a block like this, so send it to them privately:

```
DEPLOY_KEY=alice.xxxxxxxxxxxxxxxx
Site: https://alice.margdarshakss.com/
```

Names must be lowercase letters, digits or `-` (max 30), and can't be reserved (`www`, `api`, `admin`, `mail`, `bs`, ...). Add any other subdomain you already use to the `RESERVED` list at the top of `admin.mjs`.

### 9b. What to send each student

A folder with just these three files from `student/`:
- `deploy.mjs` (already contains your API URL)
- `README.md` (their instructions)
- `deploy.yml` (optional GitHub auto-deploy)

They put `deploy.mjs` in their project root, put `DEPLOY_KEY=...` in `.env.local`, and run `node deploy.mjs`.

### 9c. Their backend requirements (tell students)

- The frontend must read its backend URL from `import.meta.env.VITE_API_URL` (Vite) or the framework's equivalent. CloudFront serves static files only and has no `/api` proxy.
- The backend must be **HTTPS** and allow the student's origin in CORS (`https://alice.margdarshakss.com`). A dev backend with `origins: "*"` works.

### 9d. Deploy this repo as the first real site (dress rehearsal)

This repo is already adapted: [App.tsx](../../src/App.tsx) reads `VITE_API_URL`, and `npm run deploy` is wired up. From the repo root:

```
node infra/student-deploy/admin.mjs add shoplist
```

Create `.env.local` in the repo root (it's git-ignored by `*.local`; confirm with `git check-ignore .env.local`):

```
DEPLOY_KEY=shoplist.PASTE_SECRET_HERE
```

and `.env.production` with your live backend (HTTPS):

```
VITE_API_URL=https://YOUR-BACKEND-URL
```

then:

```
npm run deploy
```

✅ **Pass check:** `https://shoplist.margdarshakss.com` loads the app, and creating a list / voice input (voice needs HTTPS, which you now have) reaches the backend. If the browser console shows a CORS error, add the site's origin to the backend's `CORS(...)` config in `app.py`.

> To place `deploy.mjs` at the repo root for the GitHub Action (`student/deploy.yml` runs `node deploy.mjs`), copy `student/deploy.mjs` there, or change the workflow to `npm run deploy`.

---

## Day-2 operations

| Task | Command |
|---|---|
| List students and URLs | `node admin.mjs list` |
| Add students | `node admin.mjs add name1 name2` |
| Revoke a student's access (site stays up) | `node admin.mjs remove name` |
| Rotate a key | `node admin.mjs remove name` then `node admin.mjs add name` |
| Take a site offline | `aws s3 rm s3://BUCKET/sites/name --recursive`, **then** `aws cloudfront create-invalidation --distribution-id DIST_ID --paths "/sites/name/*"` (CloudFront keeps cached copies until invalidated, so the site stays visible without this step) |
| See what's hosted | `aws s3 ls s3://BUCKET/sites/` |
| Watch deploy errors | `sam logs --stack-name student-hosting --tail` |
| Change limits, name, or code | Edit the files here and run `sam deploy` (**don't** change the `StudentKeys` resource: updating it resets all keys) |

**Cost:** about $0–1/month for a class (free-tier CloudFront and Lambda, storage in MB). Set a budget alarm if you'd like a safety net: AWS Console → Billing → Budgets.

## Full teardown

```
aws s3 rm s3://BUCKET --recursive
sam delete --stack-name student-hosting
```

Then delete the `*` CNAME at your DNS host. Your certificate and the `bs` distribution are not touched.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `sam deploy` fails with `CNAMEAlreadyExists` for `*.margdarshakss.com` | Another distribution (possibly in another account) already claims that wildcard. Find it: `aws cloudfront list-distributions --query "DistributionList.Items[].[Id,Aliases.Items]"`. Remove the alias there, or switch to a subdomain root like `apps.margdarshakss.com` with a matching `*.apps.margdarshakss.com` certificate |
| Stack stuck in `ROLLBACK_COMPLETE` | `aws cloudformation delete-stack --stack-name student-hosting`, wait, rerun `sam deploy` |
| `deploy.mjs`: `Invalid or missing x-deploy-key` | Key typed wrong, student not added, or removed. Keys are cached up to 60 seconds after a change |
| `deploy.mjs`: `API_URL ... is not set` | Phase 5 not done in the file you handed out |
| `deploy.mjs`: `index.html not found at the top of the zip` | Their build failed or output went somewhere unusual. Use `--dir <folder>` (Angular: `--dir dist/<app>/browser`) |
| Site shows XML `AccessDenied` | Nothing published for that name yet (or the path is a typo). Publish, or check `aws s3 ls s3://BUCKET/sites/` |
| Old version still showing | Wait ~30 s, then Ctrl+Shift+R. If it persists: `aws cloudfront list-invalidations --distribution-id DIST_ID` and check status is `Completed` |
| Page loads, CSS/JS missing (404) | Only in path mode: the app needs `base: '/name/'`. In your subdomain mode this should not happen. Check the browser Network tab for the failing URL |
| Certificate warning in the browser | Name is two levels deep (`a.b.margdarshakss.com`), which the wildcard doesn't cover, or DNS points at the wrong host |
| `This site can't be reached` on `name.margdarshakss.com` | DNS record not added or not propagated. `nslookup name.margdarshakss.com` |
| Blank page + CORS error in console | Backend doesn't allow the origin. Fix backend CORS (see 9c) |
| Page works but API calls fail | `VITE_API_URL` missing at **build** time (it's baked in during `npm run build`), or the backend is `http://` (mixed content blocked) |
| Voice input says it requires HTTPS | Student opened the site over `http://`. CloudFront redirects automatically, so use the `https://` link |
| `curl` of the API shows `{"message":"Too Many Requests"}` | Throttle (20 req/s, burst 50). Raise `ThrottlingRateLimit` in `template.yaml` and redeploy |

## Final acceptance checklist

- [ ] `node tests/run.mjs` passes
- [ ] Stack is `CREATE_COMPLETE`
- [ ] Smoke test passed on `cloudfront.net` (Phase 6)
- [ ] `https://smoketest.margdarshakss.com/` worked, including the deep-route fallback (Phase 7)
- [ ] `bs.margdarshakss.com` still behaves exactly as before
- [ ] Bucket returns `403` when accessed directly
- [ ] Wrong or missing key returns `401`
- [ ] `smoketest` removed (Phase 8)
- [ ] First real site (`shoplist`) deployed and talking to its backend
- [ ] Students have their `deploy.mjs`, `README.md` and personal `DEPLOY_KEY`

---

# Part 2: Web portal at deploy.margdarshakss.com

Teachers create expiring tokens in a web page; students sign in with a token and upload their build folder. The CLI flow above keeps working in parallel. The same `sam deploy` creates everything, so if you have not deployed yet, Phase 4 already includes the portal and you can skip step P2.

How it fits together:

```
deploy.margdarshakss.com ─ CloudFront (PortalDistribution)
   ├─ /*      → s3://BUCKET/portal/   (the pages in web/)
   └─ /api/*  → API Gateway → Lambda → DynamoDB (tokens)
Daily 03:00 UTC: SweeperFunction moves expired sites to s3://BUCKET/archive/<name>/
```

Token life: **active** until its expiry, then **expired** (read-only, site still online) for 3 days, then **offline** (site moved to `archive/`, restored if the teacher approves a regeneration or extends the token). Nothing is ever deleted automatically.

## P1. Try it locally first (no AWS, 1 minute)

```
python tests/dev_server.py
```

Open `http://localhost:8777/`. Teacher login is `teacher` / `teacher-pass-123`; the student tokens for the five demo students are printed in the terminal. Everything is in memory and resets when you stop it.

✅ **Pass check:** you can sign in as teacher, create a token, sign in as a student with it, and upload a folder.

## P2. Update the stack

```
node tests/run.mjs
sam deploy
```

The changeset should show **Add** rows for a DynamoDB table, a second CloudFront distribution and function, an SSM parameter (`TeacherAccount`), a sweeper Lambda with its schedule, and **Modify** rows for the bucket (CORS rule), the bucket policy, the API (new `/api/{proxy+}` route) and the existing Lambda (environment and permissions). Nothing should say *Remove* or *Replace*. CloudFront takes 3–8 minutes.

Write down the new outputs:

| Output | Used for |
|---|---|
| `PortalUrl` | The address you give people (`https://deploy.margdarshakss.com/`) |
| `PortalDistributionDomain` | The DNS target in P5 and the smoke test in P4 |
| `PortalDistributionId`, `TokensTableName` | Used by `admin.mjs` automatically |

✅ **Pass check:** stack status is `UPDATE_COMPLETE`.

## P3. Create the teacher login

```
node admin.mjs teacher-setup yourname
```

It asks for a password (at least 10 characters, typed hidden) and stores a salted hash in SSM. Run it again any time to change the password. Takes effect within a minute.

> **Never edit the `TeacherAccount` resource in `template.yaml`.** A CloudFormation update to it would reset the login to empty (same rule as `StudentKeys`).

## P4. Publish the pages and smoke-test the API

```
node admin.mjs portal-publish
```

Re-run this whenever you change anything in `web/`. Then check, using `PortalDistributionDomain` as `PDIST`:

```
curl.exe -s -o NUL -w "%{http_code} %{content_type}\n" https://PDIST/
curl.exe -s -o NUL -w "%{http_code} %{content_type}\n" https://PDIST/teacher
curl.exe -s -o NUL -w "%{http_code} %{content_type}\n" https://PDIST/common.js
curl.exe -s -w "  %{http_code}\n" https://PDIST/api/admin/tokens
curl.exe -s -o NUL -w "%{http_code}\n" https://BUCKET.s3.amazonaws.com/portal/index.html
```

(Git Bash: `/dev/null` instead of `NUL`.) Expected: `200 text/html`, `200 text/html`, `200 text/javascript`, `{"error":"Please sign in again."}  401`, and `403` (the bucket stays private).

Open `https://PDIST/teacher` in a browser, sign in, and create a token. Teacher features work on this address. **Student uploads from the `cloudfront.net` address are blocked by the bucket's CORS rule on purpose**, so test uploads after P5.

✅ **Pass check:** all of the above, and you can create a token.

## P5. Point DNS at the portal

At your DNS host add **one** record:

| Type | Name / Host | Value / Target | TTL |
|---|---|---|---|
| `CNAME` | `deploy` | your `PortalDistributionDomain` | 300 |

An explicit `deploy` record beats the `*` wildcard, so student sites and `bs` are unaffected. On Cloudflare use **DNS only** (grey cloud). If `sam deploy` failed with `CNAMEAlreadyExists` for `deploy.margdarshakss.com`, another distribution already claims that name; remove it there first.

```
nslookup deploy.margdarshakss.com
curl.exe -sI https://deploy.margdarshakss.com/
```

✅ **Pass check:** `HTTP/2 200`, valid padlock, and `https://bs.margdarshakss.com` and a student site still load.

## P6. Full walk-through (acceptance test)

1. **Teacher:** open `https://deploy.margdarshakss.com/teacher`, sign in, click **New token**, valid 7 days, student name `Test One`. Copy the token.
2. **Student:** open `/student` in a private window, paste the token. You should see `test-one.margdarshakss.com`, a green bar and "Nothing uploaded yet".
3. **Upload:** drag in the `sample-site` folder. The checklist should be all green; click **Upload and publish**. Open the link: "It works 🎉".
4. **Bad upload:** drag in a folder with a file called `my photo.png`. The button must stay disabled and name the file.
5. **Warning and regeneration:** create a second token valid for **2 days** (inside the 3-day warning window). The student page shows the amber banner and a **Request regeneration** button. Send a request.
6. **Approve:** the teacher page shows a badge on **Requests**. Approve with 30 days. The student page shows the new expiry.
7. **Expiry:** click **Take offline** on the first token. `test-one.margdarshakss.com` stops loading (after about a minute), the files are in `archive/test-one/`, and **Extend** brings the site back.
8. **Clean up:** **Revoke** the test tokens. Optionally `aws s3 rm s3://BUCKET/archive/test-one --recursive`.

✅ **Pass check:** all eight steps behave as described.

## Portal day-2 operations

| Task | How |
|---|---|
| Create, extend, revoke, take offline, approve | The teacher page |
| Update the pages | Edit `web/`, then `node admin.mjs portal-publish` |
| Change the teacher password | `node admin.mjs teacher-setup yourname` |
| See archived (offline) sites | `aws s3 ls s3://BUCKET/archive/`. They are never deleted automatically; remove one with `aws s3 rm s3://BUCKET/archive/NAME --recursive` |
| Watch the daily sweep | `sam logs --stack-name student-hosting --name SweeperFunction` |
| Change the 3-day grace period | `OfflineGraceDays` parameter, then `sam deploy` |
| Look at the data | DynamoDB table `TokensTableName`. Only a hash of each token is stored, so lost tokens can't be recovered: create a new one |

Portal troubleshooting:

| Symptom | Likely cause and fix |
|---|---|
| Teacher page says "Teacher account is not set up yet" | Run P3 |
| "Too many failed attempts" | Five wrong passwords from one address lock it for 15 minutes. Wait, or delete the `fail#<ip>` item in the DynamoDB table |
| Student upload fails with a network error and a CORS message in the console | The page was opened on an address other than `https://deploy.margdarshakss.com`. Use the real address |
| Pages show old content after `portal-publish` | Hard-refresh. `portal-publish` already invalidates the cache |
| `/teacher` gives an XML error | Pages not published yet (P4), or the CloudFront function did not deploy. Open `/teacher.html` to tell them apart |
| Site name "already taken" | Names are unique across portal tokens and CLI students. Pick another |

---

# Part 3: Custom domains for students

A student can serve their site on their own domain (for example `www.theirname.com`) in addition to `name.margdarshakss.com`. The teacher decides who may use it.

**Teacher:** on the Tokens page each student has a **Domain: off / on** button. Off (the default) shows the student a disabled field with "Owner not enabled for you. Please contact site owner." Switching it off later does not remove a domain that is already live.

**Student:** on their page, **Custom domain** card:
1. Type a subdomain such as `www.theirname.com` and click **Save**. (A bare domain like `theirname.com` is refused: it cannot hold a CNAME at most DNS providers.)
2. At their DNS provider, add one `CNAME` record for that name pointing to `d4cls3ve04vi3.cloudfront.net` (on Cloudflare: **DNS only**, grey cloud).
3. The page moves through *DNS record*, *HTTPS certificate*, *Finishing setup*, *Live* by itself (usually 1 to 3 minutes after the record is visible). HTTPS is automatic.
4. **Remove domain** undoes it at any time.

Rules: one domain per student; a domain can belong to only one student; the token must be active to start; `margdarshakss.com` names and AWS addresses are refused.

## How it is built

Each custom domain is a CloudFront **distribution tenant** of one shared multi-tenant distribution. The tenant's origin path is `/sites/<student>` (a parameter), so it serves the same files as the student's normal address. Code: `lambda/domains.py` (state machine, advanced by polling `GET /api/student/domain/status`), routes in `lambda/portal.py`, UI in `web/student.js` and `web/teacher.js`.

Things that matter when you operate it:
- **A redeploy clears the custom domain's cache too** (`create_invalidation_for_distribution_tenant`). Without that, objects would be cached for up to a year.
- **Sites that go offline** (expired + grace, or "Take offline") stop being served on the custom domain as well; restoring brings them back.
- **Removal** disables the tenant, waits until it is deployed, then deletes it. If a student leaves the page mid-removal, the daily sweeper finishes it.
- **Pricing is unverified.** A community report says the first 10 tenants are free. Check the AWS billing console before enabling many students.

## AWS pieces that are NOT in `template.yaml`

These were created by hand with the CLI and are referenced by the `TenantDistributionId` and `RoutingEndpoint` parameters in `samconfig.toml`. `sam delete` will not remove them, and they are not recreated by `sam deploy`:

| Thing | Value |
|---|---|
| Multi-tenant distribution (template) | `E1NTIC3LHBW49Q`, config in `custom-domain/tenant-distribution.json` |
| CloudFront function (SPA fallback) | `student-hosting-spa-fallback`, source `custom-domain/spa-fallback.js` |
| Connection group routing endpoint | `d4cls3ve04vi3.cloudfront.net` (what students point their CNAME at) |
| Origin access control used by the template | `E35NKLYVBXWXX4` |

To switch the feature off, deploy with `TenantDistributionId=""`: students then see no domain card.

The bucket policy lets that distribution and its tenants read `sites/*` (statement `CustomDomainTenantsReadPublishedSitesOnly`).

## Custom-domain troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Stuck on "Add the DNS record" | The CNAME is not visible yet or points elsewhere. `nslookup -type=CNAME www.theirname.com` must show `d4cls3ve04vi3.cloudfront.net`. On Cloudflare the record must be DNS only |
| "CloudFront refused this domain: ..." | The name is already attached to another CloudFront distribution or tenant. Remove it there first |
| Live but shows an old version | Normally cleared on publish. If it persists, create an invalidation for the tenant: `aws cloudfront create-invalidation-for-distribution-tenant --id dt_xxx --invalidation-batch ...` |
| Student cannot start (403) | The Domain switch is off for them, or the token is not active |
| Domain stuck on "Removing" | The tenant is still deploying. It finishes by itself on the next poll or daily sweep |

Always deploy from **this** folder with the safe routine: `sam deploy --no-execute-changeset --no-confirm-changeset`, read every changeset row, then `aws cloudformation execute-change-set`. A template from another copy would delete the portal, the tokens table and the sweeper.
