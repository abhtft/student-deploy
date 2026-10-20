"""In-memory stand-ins for S3 and CloudFront shared by the local tests."""
import json

from botocore.exceptions import ClientError

store, invalidations = {}, []


class Body:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data


class FakeS3:
    def __init__(self, port=0):
        self.port = port

    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f"http://127.0.0.1:{self.port}/s3/{Params['Key']}"

    def head_object(self, Bucket, Key):
        if Key not in store:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": len(store[Key]["Body"])}

    def get_object(self, Bucket, Key):
        return {"Body": Body(store[Key]["Body"])}

    def put_object(self, Bucket, Key, Body, **kw):
        store[Key] = {"Body": Body, **kw}

    def copy_object(self, Bucket, Key, CopySource):
        store[Key] = dict(store[CopySource["Key"]])

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
