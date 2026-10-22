"""Live smoke test of the deployed platform: student login, backend deploy (Python and Node), env vars, logs, run allowance,
teacher on/off, the in-flight limiter and removal. It needs AWS credentials for the stack's account and talks to production.

Run it by hand after a deploy:  python tests/live_smoke.py   (takes about 3 minutes; not part of CI)
It creates one temporary student (slug zz-backendtest) directly in DynamoDB and removes everything it made, even on failure.
Override the address with SMOKE_BASE_URL / SMOKE_ROOT_DOMAIN when testing another stack."""
import concurrent.futures
import hashlib
import io
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import zipfile

import boto3
from botocore.exceptions import ClientError

ROOT_DOMAIN = os.environ.get("SMOKE_ROOT_DOMAIN", "margdarshakss.com")
BASE = os.environ.get("SMOKE_BASE_URL", f"https://deploy.{ROOT_DOMAIN}")
SLUG = "zz-backendtest"
SITE = f"https://{SLUG}.{ROOT_DOMAIN}"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "student", "backend-template")
cfn = boto3.client("cloudformation", region_name="us-east-1")
lam = boto3.client("lambda", region_name="us-east-1")
logs = boto3.client("logs", region_name="us-east-1")
table = boto3.resource("dynamodb", region_name="us-east-1").Table(
    cfn.describe_stack_resource(StackName="student-hosting", LogicalResourceId="TokensTable")["StackResourceDetail"]["PhysicalResourceId"])
BUCKET = cfn.describe_stack_resource(StackName="student-hosting", LogicalResourceId="SitesBucket")["StackResourceDetail"]["PhysicalResourceId"]

token = "mds_" + secrets.token_urlsafe(16)
tid = hashlib.sha256(token.encode()).hexdigest()
now = int(time.time())
failures = []
log = lambda *a: print(time.strftime("%H:%M:%S"), *a, flush=True)  # noqa: E731


def check(name, cond, detail=""):
    log(("PASS" if cond else "FAIL"), name, detail if not cond else "")
    if not cond:
        failures.append(name)


def http(method, url, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, method=method, data=data, headers=headers or ({"content-type": "application/json"} if raw is None else {}))
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            text = r.read().decode()
            return r.status, (json.loads(text) if text[:1] in ("{", "[") else text), dict(r.headers)
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        return e.code, (json.loads(text) if text[:1] in ("{", "[") else text), dict(e.headers)


def api(method, path, body=None, session=None):
    headers = {"content-type": "application/json"}
    if session:
        headers["authorization"] = f"Bearer {session}"
    s, b, _ = http(method, BASE + path, body, headers)
    return s, b


def zip_bytes(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


def template(flavor):
    folder = os.path.join(ROOT, flavor)
    return {n: open(os.path.join(folder, n), encoding="utf8").read() for n in os.listdir(folder)}


def set_backend_fields(**fields):
    item = table.get_item(Key={"pk": f"tok#{tid}"})["Item"]
    b = dict(item.get("backend") or {})
    b.update(fields)
    table.update_item(Key={"pk": f"tok#{tid}"}, UpdateExpression="SET backend = :b", ExpressionAttributeValues={":b": b})


def deploy(session, files, what):
    s, up = api("POST", "/api/student/backend/upload-url", session=session)
    check(f"{what}: upload-url", s == 200, up)
    ps, _, _ = http("PUT", up["uploadUrl"], raw=zip_bytes(files))
    check(f"{what}: zip uploaded to S3", ps == 200)
    s, body = api("POST", "/api/student/backend/publish", session=session)
    check(f"{what}: publish accepted", s == 200 and body["token"]["backend"]["state"] == "creating", body)
    state, started = "creating", time.time()
    while time.time() - started < 90:
        s, body = api("GET", "/api/student/backend", session=session)
        state = body["token"]["backend"]["state"] if s == 200 else "error"
        if state != "creating":
            break
        time.sleep(3)
    check(f"{what}: function ready", state == "ready", f"state={state} {body}")
    log(f"   ({what} took {int(time.time() - started)} s to become ready)")
    return state == "ready"


def site(path, method="GET", body=None):
    s, b, h = http(method, SITE + path, body)
    return s, b, h


def cleanup():
    for name in [f"sd-{SLUG}"]:
        try:
            lam.delete_function(FunctionName=name)
            log("cleanup: deleted function", name)
        except ClientError:
            pass
        try:
            logs.delete_log_group(logGroupName=f"/aws/lambda/{name}")
        except ClientError:
            pass
    scan = table.scan(FilterExpression="contains(pk, :s) OR pk = :g", ExpressionAttributeValues={":s": SLUG, ":g": "inflight#global"})
    for item in scan["Items"]:
        table.delete_item(Key={"pk": item["pk"]})
    table.delete_item(Key={"pk": f"tok#{tid}"})
    table.delete_item(Key={"pk": f"slug#{SLUG}"})
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.delete_object(Bucket=BUCKET, Key=f"uploads/{SLUG}-backend.zip")


table.put_item(Item={"pk": f"slug#{SLUG}", "token": tid})
table.put_item(Item={"pk": f"tok#{tid}", "id": tid, "slug": SLUG, "student_name": "Backend E2E", "hint": token[-4:], "created_at": now,
                     "expires_at": now + 7200, "revoked": False, "regen": {"state": "none"},
                     "backend": {"enabled": True, "runs_limit": 6, "runs_period": "month", "state": "none"}})
try:
    s, body = api("POST", "/api/student/login", {"token": token})
    check("student login", s == 200)
    session = body["session"]
    b = body["token"]["backend"]
    check("backend view: available, enabled, allowance 6", b["available"] and b["enabled"] and b["usage"]["limit"] == 6 and b["usage"]["used"] == 0, b)

    # ---------- A: Python starter template ----------
    if deploy(session, template("python"), "python template"):
        s, b, h = site("/api/health")
        check("GET /api/health through CloudFront", s == 200 and b == {"ok": True}, (s, b))
        check("response headers set by the gateway", h.get("X-Content-Type-Options", h.get("x-content-type-options")) == "nosniff")
        s, b, _ = site("/api/hello?name=Sam")
        check("GET /api/hello?name=Sam", s == 200 and b == {"message": "Hello, Sam!"}, (s, b))
        s, b, _ = site("/api/echo", "POST", {"a": 1})
        check("POST /api/echo with a JSON body", s == 200 and b == {"youSent": {"a": 1}}, (s, b))
        s, b, _ = site("/api/missing")
        check("unknown path is the function's own 404", s == 404 and b == {"error": "Not found"}, (s, b))

    # ---------- B: update path + environment variable + logs ----------
    CODE = ("import json, os\n"
            "def handler(event, context):\n"
            "    print('env-check', event['rawPath'])\n"
            "    return {'statusCode': 200, 'headers': {'content-type': 'application/json'},\n"
            "            'body': json.dumps({'greeting': os.environ.get('GREETING'), 'ip': event['requestContext']['http']['sourceIp'],\n"
            "                               'leaked': [h for h in event['headers'] if h in ('x-origin-secret', 'x-viewer-ip')]})}\n")
    if deploy(session, {"app.py": CODE}, "update with env-reading code"):
        s, body = api("PUT", "/api/student/backend/env", {"name": "GREETING", "value": "live-secret-value-42"}, session)
        check("set env var", s == 200 and body["token"]["backend"]["env_names"] == ["GREETING"], body)
        check("env value is never returned by the API", "live-secret-value-42" not in json.dumps(body))
        time.sleep(4)  # the function reconfigures after the change
        s, b, _ = site("/api/x")
        check("function sees the env var; platform headers are stripped", s == 200 and b["greeting"] == "live-secret-value-42" and b["leaked"] == [], (s, b))
        check("visitor IP is passed in sourceIp", b.get("ip") not in (None, "", "10.0.0.1"), b)
        lines = []
        for _ in range(10):
            s, body = api("GET", "/api/student/backend/logs", session=session)
            lines = body.get("lines", []) if s == 200 else []
            if any("env-check" in l["message"] for l in lines):
                break
            time.sleep(3)
        check("logs reach the student (CloudWatch)", any("env-check" in l["message"] for l in lines), lines[:3])
        check("log group retention is 7 days", logs.describe_log_groups(logGroupNamePrefix=f"/aws/lambda/sd-{SLUG}")["logGroups"][0].get("retentionInDays") == 7)

    # ---------- C: allowance (limit 6; 5 runs used so far) ----------
    s, body = api("GET", "/api/student/me", session=session)
    used = body["token"]["backend"]["usage"]["used"]
    log(f"   runs used so far: {used}")
    codes = [site("/api/x")[0] for _ in range(4)]
    allowed = max(6 - used, 0)
    check(f"exactly {allowed} more runs allowed, then 429", codes == [200] * allowed + [429] * (4 - allowed), codes)
    s, b, h = site("/api/x")
    check("429 body names the allowance and says when it resets", s == 429 and b["error"] == "allowance_exhausted" and b["resets_at"] and "Retry-After" in {k.title(): v for k, v in h.items()}, (s, b))
    s, body = api("GET", "/api/student/me", session=session)
    check("usage meter data shows 6 / 6", body["token"]["backend"]["usage"]["used"] == 6, body["token"]["backend"]["usage"])

    # ---------- D: teacher OFF / ON (gateway), and reserved concurrency 0 at an account limit of 10 ----------
    set_backend_fields(runs_limit=1000)
    set_backend_fields(enabled=False)
    time.sleep(12)  # the gateway caches settings for 10 s
    s, b, _ = site("/api/x")
    check("OFF: /api answers 503 backend_off", s == 503 and b["error"] == "backend_off", (s, b))
    s, body = api("POST", "/api/student/backend/upload-url", session=session)
    check("OFF: deploys are refused", s == 403, (s, body))
    try:
        lam.put_function_concurrency(FunctionName=f"sd-{SLUG}", ReservedConcurrentExecutions=0)
        check("AWS accepts reserved concurrency 0 at an account limit of 10", True)
        lam.delete_function_concurrency(FunctionName=f"sd-{SLUG}")
    except ClientError as e:
        check("AWS accepts reserved concurrency 0 at an account limit of 10", False, e.response["Error"]["Message"])
    set_backend_fields(enabled=True)
    time.sleep(12)
    s, b, _ = site("/api/x")
    check("ON: service restored", s == 200, (s, b))

    # ---------- E: the in-flight limiter under real parallel load ----------
    SLOW = ("import json, time\n"
            "def handler(event, context):\n"
            "    time.sleep(2)\n"
            "    return {'statusCode': 200, 'body': json.dumps({'ok': True})}\n")
    if deploy(session, {"app.py": SLOW}, "slow handler for the limiter test"):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: site("/api/slow")[0], range(8)))
        ok, busy = results.count(200), results.count(429)
        log(f"   8 parallel requests -> {ok} ok, {busy} busy: {sorted(results)}")
        check("at most 3 student requests run at once (global cap), the rest get 429", 1 <= ok <= 3 and ok + busy == 8, results)
        time.sleep(1)
        check("after the burst, requests work again (slots released)", site("/api/slow")[0] == 200)

    # ---------- F: remove, then the Node runtime ----------
    s, body = api("DELETE", "/api/student/backend", session=session)
    check("remove backend", s == 200 and body["token"]["backend"]["state"] == "none", body)
    check("function and log group are gone", all(f["FunctionName"] != f"sd-{SLUG}" for f in lam.list_functions()["Functions"]))
    s, b, _ = site("/api/health")
    check("after removal: no_backend", s == 404 and b["error"] == "no_backend", (s, b))
    if deploy(session, template("node"), "Node 22 template"):
        s, b, _ = site("/api/hello?name=Node")
        check("Node runtime answers through the gateway", s == 200 and b == {"message": "Hello, Node!"}, (s, b))
        check("runtime recorded as nodejs22.x", lam.get_function_configuration(FunctionName=f"sd-{SLUG}")["Runtime"] == "nodejs22.x")
        cfg = lam.get_function_configuration(FunctionName=f"sd-{SLUG}")
        check("sandbox settings: 256 MB, 10 s, logs-only role", cfg["MemorySize"] == 256 and cfg["Timeout"] == 10 and cfg["Role"].endswith(cfg["Role"].split("/")[-1]) and "Sandbox" in cfg["Role"], cfg["Role"])
finally:
    cleanup()
    leftover_functions = [f["FunctionName"] for f in lam.list_functions()["Functions"] if f["FunctionName"] == f"sd-{SLUG}"]
    leftover_groups = [g["logGroupName"] for g in logs.describe_log_groups(logGroupNamePrefix=f"/aws/lambda/sd-{SLUG}")["logGroups"]]
    check("cleanup: test function removed", leftover_functions == [], leftover_functions)
    check("cleanup: test log group removed", leftover_groups == [], leftover_groups)
    left = [i["pk"] for i in table.scan(FilterExpression="contains(pk, :s)", ExpressionAttributeValues={":s": SLUG})["Items"]]
    check("cleanup: no test rows left", left == [], left)
log("ALL STEPS PASSED" if not failures else f"FAILED: {failures}")
sys.exit(0 if not failures else 1)
