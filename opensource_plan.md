# Portable, open-source release: lean plan and session handoff

Status: **agreed approach, nothing executed yet.** Written 2026-10-25. This replaces the earlier, heavier 7-phase draft (it estimated 12 to 17 days; this lean version is about 5 to 7). If you are a new chat session: read sections 1 to 4, then ask the owner the questions in section 3 (or use the defaults) and start with the spike in section 2.

## 1. The goal

Any teacher can deploy their **own copy** into **their own AWS account** with one command or a short guided process, so the project can be open source. The owner's own production later moves to a **separate, dedicated AWS account**, installed with the same process (Track B), which proves the process.

Track A (this plan): portable and open source. Track B (afterwards, using A): move production.

## 2. The lean plan: three moves

**Move 1: nothing personal in the code (about 1 to 1.5 days)**
- Measured: the maintainer's domain appears 115 times in 23 files (implement.md 44, END_TO_END.md 15, learning.md 8, API_REFERENCE.md 5, TECHNICAL_SPECIFICATION.md 5, tests/live_smoke.py 6, tests/run.mjs 8, ...). In the code students run it is only four constants: `student/portal-deploy.mjs` (`PORTAL_URL` default), `starter/template/platform.json` (`portal`), `starter/mcp/setup.mjs` and `starter/mcp/server.mjs` (`DEFAULT_PORTAL`), plus the sentence in `starter/rules/AGENTS.md` ("The site is `https://<name>.margdarshakss.com`").
- Source keeps a fake placeholder (for example `https://deploy.example.edu`). `node admin.mjs portal-publish` already knows the real portal address (stack output `PortalUrl`; `starter/publish-files.mjs` `buildPublishFiles(dir, portalUrl)` takes it), so substitute it at build time into the kit and the MCP package. Each teacher's published kit then points at their own portal.
- One-off scrub script for docs and tests (domain to `example.edu`, account ID to `<ACCOUNT_ID>`, certificate ARN and distribution IDs to placeholders), then a guard test (`tests/test_no_identifiers.py`) failing when a deny-listed value appears in any tracked file.
- No new config layer: the CloudFormation parameters are the configuration; the installer writes a git-ignored `samconfig.local.toml`. `tests/live_smoke.py` reads stack name and domain from the environment (today it assumes stack `student-hosting`).
- Remove from the public copy: `image.png`, `domainmyhand.md`, `sample-site.zip`, `.claude/`, `custom-domain/*.reference*`, `teacher-login.local` (already git-ignored; never read it).

**Move 2: one command, no SAM CLI, no domain needed (about 2 to 3 days)**
```bash
git clone <repo> && cd <repo> && node setup.mjs
```
Needs only Node, the AWS CLI (configured) and an AWS account.
- **Spike first (half a day):** confirm `aws cloudformation package` + `deploy --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND` deploys `template.yaml` without the SAM CLI (the Lambdas are plain Python, `CodeUri: lambda/`, no build step; the wizard creates the artifact bucket).
- **Try mode:** empty `RootDomain` (the template already supports it): portal and sites on `cloudfront.net` addresses, about 10 minutes.
- **Domain mode:** wildcard ACM certificate in us-east-1 (the wizard prints the one DNS validation record and waits), two-phase deploy (`PortalAlias=false`, then DNS, then `true`: CloudFront refuses the alias while DNS points elsewhere), prints the two DNS records.
- Optional modules (backend, AI, storage) are asked about, default off. Teacher login through the existing `admin.mjs teacher-setup` (stored hashed). Ends with a short smoke check, first steps, a cost note, and `node setup.mjs destroy`.
- Tests: `--dry-run` prints every command; snapshot-test that instead of building a fake AWS CLI.

**Move 3: publish (about 1 day)**
`LICENSE` (MIT default), README quickstart with cost table and architecture diagram, `SECURITY.md`, `CONTRIBUTING.md`, issue templates, CI gate (identifier test, gitleaks, existing cfn-lint and suite). **Publish from a fresh repository with one clean commit**: history has no credentials (checked) but contains the maintainer's domain and account ID.

**Cut from v1 (add back later):** custom student domains (they need hand-made CloudFront multi-tenant pieces, see `custom-domain/HANDOFF.md`; ship off and documented, or automate after a CloudFormation spike), an `npx create-...` package, a "Launch Stack" button, `upgrade`, multi-region (CloudFront certificates force us-east-1).

## 3. Decisions the owner must make (defaults in brackets)

1. Project name [neutral; drop "margdarshakss" from the product].
2. License [MIT].
3. Fresh single-commit public repo, current repo stays private [yes].
4. Custom domains out of v1 [yes].
5. New AWS account for production: created yet? Which domain will it use?

## 4. Track B (after A): move production to a dedicated account

- Reasons: the current account is shared with other live apps and has a Lambda concurrency limit of 10 (new accounts also start low and can need CloudFront verification: create the account early; the installer should read the quota and warn).
- Move: tokens table (hashes unchanged, so student tokens keep working), `sites/` and `archive/` in S3 (cross-account sync), teacher login (re-create), CLI key map, AI secret (re-enter), custom-domain tenants (re-created; students with custom domains must update one CNAME).
- Cutover: stage on a temporary domain, copy data, move the two DNS records and the aliases (a CloudFront alias lives on one distribution at a time; cross-account process to verify), minutes of downtime announced, keep the old stack a week as rollback.
- Student tools hold the old `execute-api` address in the legacy CLI only; the kit and MCP package use the portal address, which is why Move 1's build-time substitution matters.

## 5. Acceptance checklist

- [ ] `git grep` for the maintainer's account ID, domain and distribution IDs finds nothing, and the guard test enforces it.
- [ ] No personal or unreviewed files are tracked; secret scan clean.
- [ ] `node setup.mjs` from a clean account in try mode, no domain, about 10 minutes; with a domain it guides certificate and DNS and ends on `https://deploy.<domain>`.
- [ ] `destroy` leaves the account clean (apart from documented manual items such as DNS records).
- [ ] Backend, AI and storage each enable without manual AWS steps and are off by default.
- [ ] README quickstart, cost table, LICENSE, SECURITY, CONTRIBUTING and issue templates exist; CI runs suite, lint, identifier test and secret scan.
- [ ] (Track B) production runs in the new account from the same installer, tokens and sites migrated, old stack kept a week.

---

## 6. Handoff: the state of the project (for a new session)

**Repository:** `D:\Github_Codes\student-deploy`, branch `feature/custom-domains-and-portal-hosting` (pushed). Read first: `docs/TECHNICAL_SPECIFICATION.md` (source of truth; its section 14 facts are checked against the code by `tests/test_spec.py`), then `docs/AWS_LEARNINGS.md`.

**Production (AWS account `417780655868`, us-east-1, stack `student-hosting`, `UPDATE_COMPLETE`):** portal `https://deploy.margdarshakss.com`; features live: student sites, custom domains, backends, class AI, class storage (`StorageEnabled=true`, deployed 2026-10-24), the redesigned teacher dashboard, the MCP package. Published kit **1.6.0**, `class-platform-mcp` **1.0.0**.

**Tests:** `node tests/run.mjs` (35 steps, all green at the last run; takes several minutes); `python tests/live_smoke.py` against production (about 110 checks; two timing checks are known to flake: the in-flight limiter test and the OpenRouter usage lag). CI: `.github/workflows/ci.yml` (cfn-lint `python -m` does not work on this machine; use the `cfn-lint.exe` in the user Scripts folder).

**Deploy routine (what was used):** `sam build`; `sam deploy --no-execute-changeset --no-confirm-changeset`; read the change set; `aws cloudformation execute-change-set ...`; `node admin.mjs portal-publish` for pages, kit and MCP package. Never replace a stateful resource.

**Standing rules from the owner:** keep the alert email out of the repo; never read `teacher-login.local`; keep the `..._dist2` sibling project separate; confirm before outward-facing or hard-to-reverse actions (deploys and publishes were approved case by case); commits end with the co-author line.

**Open items:** the owner's real-editor check of the MCP package (VS Code, Antigravity), re-run the AI evaluation for kit 1.2 to 1.6 rules, point-in-time recovery for the student data table, pilot with real students, the public template repository, release tag.

**Machine gotchas (Windows, Git Bash):**
- Python or shell heredocs mangle backslashes and `\n` inside code written to files: write files with the Write tool, or fix them with the Edit tool.
- Stale test servers: a crashed test can leave a `python3.12` dev server listening on 8791 to 8798 and tests then fail with odd "token not accepted" errors; kill leftover `python3.12` processes first.
- `sam` is not on the Git Bash PATH: use PowerShell. Writing `samconfig.toml` with PowerShell `Set-Content -Encoding utf8` adds a BOM that breaks it; use `[System.IO.File]::WriteAllText` with a UTF-8 encoding without BOM.
- Calling `process.exit()` right after network use can print a libuv assertion on Node 25 / Windows: set `process.exitCode` instead.
