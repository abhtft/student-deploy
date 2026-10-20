"""Local preview of the whole portal: static files from web/ + the REAL Lambda code on /api/* with in-memory AWS.

    python tests/dev_server.py [port]        then open http://127.0.0.1:8777/

Teacher login: teacher / teacher-pass-123.  Student tokens for the demo data are printed at startup.
State lives in memory only; restart to reset.
"""
import json
import mimetypes
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

here = os.path.dirname(os.path.abspath(__file__))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
os.environ.update(AWS_REGION="us-east-1", AWS_DEFAULT_REGION="us-east-1", AWS_ACCESS_KEY_ID="x", AWS_SECRET_ACCESS_KEY="x",
                  BUCKET="b", DISTRIBUTION_ID="E1", DISTRIBUTION_DOMAIN="d123.cloudfront.net", ROOT_DOMAIN="margdarshakss.com",
                  KEYS_PARAM="/k")
sys.path[:0] = [os.path.join(here, "..", "lambda"), here]
import app  # noqa: E402
import portal  # noqa: E402
from fakes import FakeCloudFront, FakeS3, FakeSSM, store  # noqa: E402

WEB = os.path.join(here, "..", "web")
app.s3, app.ssm, app.cloudfront = FakeS3(port), FakeSSM(), FakeCloudFront()
salt = b"dev-salt-dev-sal"
portal._store = portal.MemoryStore()
portal._teacher.update(loaded_at=10**12, value={
    "username": "teacher", "salt": portal.b64(salt), "hash": portal.b64(portal.scrypt_hash("teacher-pass-123", salt)), "secret": portal.b64(b"d" * 32)})

DAY = portal.DAY
t0 = int(time.time())


def seed(name, expires_in_days, created_days_ago=30, **fields):
    made = portal.create_token({"days": 30, "student_name": name}, t0 - created_days_ago * DAY, app.site_url)
    tid = made["item"]["id"]
    portal.db().update(f"tok#{tid}", {"expires_at": t0 + int(expires_in_days * DAY), **fields})
    store[f"sites/{made['item']['slug']}/index.html"] = {"Body": f"<h1>{name}</h1>".encode()}
    print(f"  {name:<8} {made['token']}   (expires in {expires_in_days} days)")
    return tid


print("Demo students (paste a token at /student.html):")
seed("Alice", 20, last_deploy_at=t0 - 3600)
seed("Bob", 2, regen={"state": "pending", "requested_at": t0 - 7200, "note": "Need more time for my final project"})
seed("Carol", -1)
dave = seed("Dave", -5, archived=True, archived_at=t0 - 2 * DAY)
seed("Erin", 10, revoked=True)
print("Teacher: teacher / teacher-pass-123\n", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.send_header("access-control-allow-origin", "*")  # like the bucket's CORS rule: the browser PUTs straight to "S3"
        self.end_headers()
        self.wfile.write(body)

    def api(self, method):
        length = int(self.headers.get("content-length") or 0)
        event = {"rawPath": self.path.split("?")[0], "routeKey": "ANY /api/{proxy+}", "body": self.rfile.read(length).decode() if length else "",
                 "requestContext": {"http": {"method": method, "sourceIp": self.client_address[0]}},
                 "headers": {k.lower(): v for k, v in self.headers.items()}}
        result = app.handler(event, None)
        self.send(result["statusCode"], result["body"].encode())

    def do_POST(self):
        self.api("POST")

    def do_OPTIONS(self):
        self.send_response(204)
        for name, value in (("access-control-allow-origin", "*"), ("access-control-allow-methods", "PUT"), ("access-control-allow-headers", "*")):
            self.send_header(name, value)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_PUT(self):  # fake presigned S3 upload
        length = int(self.headers["content-length"])
        store[self.path[len("/s3/"):]] = {"Body": self.rfile.read(length)}
        self.send(200, b"", "text/plain")

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.api("GET")
        name = self.path.split("?")[0].lstrip("/") or "index.html"
        path = os.path.normpath(os.path.join(WEB, name))
        if not path.startswith(os.path.normpath(WEB)) or not os.path.isfile(path):
            return self.send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send(200, open(path, "rb").read(), ctype + ("; charset=utf-8" if ctype.startswith("text/") or "javascript" in ctype else ""))


ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
