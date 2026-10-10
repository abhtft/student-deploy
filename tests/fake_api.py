"""Local stand-in for API Gateway + S3 + SSM + CloudFront that runs the REAL Lambda handler.

    python fake_api.py <lambda_dir> <port> [root_domain]

POST /upload-url, /publish  -> handled by lambda/app.py (key for student "alice" is "s3cret")
PUT  /s3/<key>              -> fake presigned upload
GET  /                      -> dump of stored objects + CloudFront invalidations (for assertions)
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

lambda_dir, port = sys.argv[1], int(sys.argv[2])
os.environ.update(
    AWS_REGION="us-east-1", AWS_DEFAULT_REGION="us-east-1", AWS_ACCESS_KEY_ID="x", AWS_SECRET_ACCESS_KEY="x",
    BUCKET="b", DISTRIBUTION_ID="E1", DISTRIBUTION_DOMAIN="d123.cloudfront.net",
    ROOT_DOMAIN=sys.argv[3] if len(sys.argv) > 3 else "", KEYS_PARAM="/student-deploy/keys",
)
sys.path.insert(0, lambda_dir)
import app  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

store, invalidations = {}, []


class Body:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data


class FakeS3:
    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f"http://127.0.0.1:{port}/s3/{Params['Key']}"

    def head_object(self, Bucket, Key):
        if Key not in store:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": len(store[Key]["Body"])}

    def get_object(self, Bucket, Key):
        return {"Body": Body(store[Key]["Body"])}

    def put_object(self, Bucket, Key, Body, **kw):
        store[Key] = {"Body": Body, **kw}

    def delete_object(self, Bucket, Key):
        store.pop(Key, None)

    def delete_objects(self, Bucket, Delete):
        for o in Delete["Objects"]:
            store.pop(o["Key"], None)

    def get_paginator(self, name):
        class Paginator:
            def paginate(self, Bucket, Prefix):
                yield {"Contents": [{"Key": k} for k in sorted(store) if k.startswith(Prefix)]}

        return Paginator()


class FakeSSM:
    def get_parameter(self, Name):
        return {"Parameter": {"Value": json.dumps({"alice": "s3cret"})}}


class FakeCloudFront:
    def create_invalidation(self, DistributionId, InvalidationBatch):
        invalidations.append(InvalidationBatch["Paths"]["Items"])


app.s3, app.ssm, app.cloudfront = FakeS3(), FakeSSM(), FakeCloudFront()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        store[self.path[len("/s3/"):]] = {"Body": self.rfile.read(int(self.headers["Content-Length"]))}
        self._send(200, b"")

    def do_POST(self):
        event = {"routeKey": f"POST {self.path}", "headers": {k.lower(): v for k, v in self.headers.items()}}
        result = app.handler(event, None)
        self._send(result["statusCode"], result["body"].encode())

    def do_GET(self):
        objects = {k: {**{kk: vv for kk, vv in v.items() if kk != "Body"}, "size": len(v["Body"])} for k, v in store.items()}
        self._send(200, json.dumps({"objects": objects, "invalidations": invalidations}).encode())


HTTPServer(("127.0.0.1", port), Handler).serve_forever()
