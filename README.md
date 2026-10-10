# Student frontend hosting (teacher setup)

Every student publishes their built frontend (`dist/`) to **your** AWS account with one command:

```bash
node deploy.mjs
```

Students get no AWS access. They only get a personal deploy key.

```
deploy.mjs ──POST /upload-url──▶ API Gateway ─▶ Lambda ──(checks key in SSM)
           ──PUT dist.zip──────▶ S3 uploads/<student>.zip
           ──POST /publish─────▶ Lambda: unzip → S3 sites/<student>/ , clear CloudFront cache
Browser ──▶ CloudFront ──(router function)──▶ S3 sites/<student>/   (private bucket, OAC)
```

| File | What it is |
|---|---|
| `template.yaml` | Everything in AWS: bucket, CloudFront, router function, API, Lambda, key store |
| `lambda/app.py` | The upload/publish API (stdlib + boto3, nothing to install) |
| `admin.mjs` | Add, remove and list students |
| `student/deploy.mjs` | The file you hand to students |
| `student/deploy.yml` | Optional GitHub Action for students (auto-deploy on push) |
| `student/README.md` | Student instructions |

## One-time setup (about 20 min)

Prerequisites: AWS CLI (logged in), [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), Node 18+.

### 1. Pick the URL style

| | Subdomain (recommended) | Path |
|---|---|---|
| Student URL | `https://alice.apps.example.com` | `https://dxxxx.cloudfront.net/alice/` |
| Student code changes | **none** | must set `base: '/alice/'` in `vite.config` |
| You need | a domain you control + free ACM certificate | nothing |

For subdomains, request an ACM certificate for `*.apps.example.com` **in us-east-1** (CloudFront requires that region) and validate it via DNS.

### 2. Deploy the stack

```bash
cd infra/student-deploy
sam deploy --guided --stack-name student-hosting --capabilities CAPABILITY_IAM
```

When prompted, set `RootDomain=apps.example.com` and `CertificateArn=arn:aws:acm:us-east-1:...`, or leave both empty for path mode. Choose any region close to your students (e.g. `ap-south-1`). The first deploy takes about 5 minutes (CloudFront). Later `sam deploy` runs reuse the saved answers.

### 3. Point DNS (subdomain mode only)

Create one record at your DNS provider: `*.apps.example.com  CNAME  <DistributionDomain output>`.
With Route 53 you can use an A/ALIAS record to the distribution instead.

### 4. Bake the API URL into the student script

Copy the `DeployApiUrl` output into `API_URL` at the top of `student/deploy.mjs`. You hand out this exact file.

### 5. Add students

```bash
node admin.mjs add alice bob carol     # prints DEPLOY_KEY + site URL for each
node admin.mjs list
node admin.mjs remove bob              # revokes the key within a minute; the site stays up
```

Send each student their `DEPLOY_KEY` line, plus `student/deploy.mjs` and `student/README.md`.

## Day-to-day

- **Take a site down:** `aws s3 rm s3://<BucketName>/sites/alice --recursive`
- **See what's deployed:** `aws s3 ls s3://<BucketName>/sites/`
- **Lambda logs:** `sam logs --stack-name student-hosting --tail`
- **Tear everything down:** empty the bucket, then run `sam delete --stack-name student-hosting`

## Limits and costs

- 50 MB zip, 200 MB unzipped, 2,000 files, about 25 s publish time per deploy. A typical Vite app is 1–5 MB and publishes in 2–3 s.
- The key map is one standard SSM parameter (4 KB), which holds about 100 students. `admin.mjs list` shows how much is used. For more students, switch the parameter to the Advanced tier in the console.
- The API is throttled to 5 requests/s (burst 20) to protect against loops or abuse.
- Each publish clears 2 cache paths, and the first 1,000 paths a month are free (about 500 deploys). A class typically costs **$0–1/month**.

## Security model (kept simple on purpose)

- Students never get AWS credentials. Their key only lets them overwrite **their own** `sites/<name>/` folder.
- The bucket is private. Only this CloudFront distribution can read it, and only `sites/*`.
- The Lambda role can touch only this bucket, create cache invalidations on this distribution, and read the key parameter.
- Keys are stored in plain text in SSM, which is fine for a class. Rotate a key with `remove` and then `add`.
- **Do not change the `StudentKeys` resource in `template.yaml`.** If CloudFormation ever updates it, the key map resets to `{}`.

## Backends

Student frontends are static, so CloudFront does **not** proxy `/api`. Each app must call its backend through `import.meta.env.VITE_API_URL`, and that backend must:
- be served over **HTTPS** (browsers block HTTP calls from HTTPS pages), and
- allow the student's site origin in CORS (`https://alice.apps.example.com`, or `*` for simplicity).
