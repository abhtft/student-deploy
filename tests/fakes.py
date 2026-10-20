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


class FakeTenantCloudFront:
    """In-memory CloudFront multi-tenant API (distribution tenants) for the custom-domain tests and the dev server.

    Tests drive each step with the flags below; dev_server.py subclasses it to advance them with timers.
    """

    def __init__(self):
        self.dns_ok = False  # True, or a callable(domain) -> bool: the CNAME is visible to CloudFront
        self.cert_status = "pending-validation"
        self.deployed = True
        self.tenants = {}
        self.invalidations = []
        self.main_invalidations = []
        self.refuse_with = None  # (code, message): make create_distribution_tenant fail
        self._n = 0

    @staticmethod
    def _error(code, message="", op="Call"):
        return ClientError({"Error": {"Code": code, "Message": message}}, op)

    def _dns_ok(self, domain):
        return self.dns_ok(domain) if callable(self.dns_ok) else self.dns_ok

    def create_distribution_tenant(self, **kw):
        if self.refuse_with:
            raise self._error(*self.refuse_with)
        domain = kw["Domains"][0]["Domain"]
        if not self._dns_ok(domain):
            raise self._error("InvalidArgument", "Could not verify Domain Name ownership", "CreateDistributionTenant")
        assert kw["ManagedCertificateRequest"]["PrimaryDomainName"] == domain
        self._n += 1
        tenant = {"Id": f"dt_{self._n}", "Name": kw["Name"], "Enabled": True, "Parameters": kw["Parameters"],
                  "Domains": [{"Domain": domain, "Status": "inactive"}], "Customizations": {}}
        self.tenants[tenant["Id"]] = tenant
        return {"DistributionTenant": tenant}

    def _tenant(self, tenant_id):
        if tenant_id not in self.tenants:
            raise self._error("EntityNotFound", "", "GetDistributionTenant")
        return self.tenants[tenant_id]

    def get_distribution_tenant(self, Identifier):
        tenant = self._tenant(Identifier)
        return {"DistributionTenant": dict(tenant, Status="Deployed" if self.deployed else "InProgress"), "ETag": "e"}

    def get_managed_certificate_details(self, Identifier):
        self._tenant(Identifier)
        return {"ManagedCertificateDetails": {"CertificateArn": "arn:aws:acm:us-east-1:1:certificate/x", "CertificateStatus": self.cert_status}}

    def update_distribution_tenant(self, Id, IfMatch, Domains, **kw):
        tenant = self._tenant(Id)
        if "Customizations" in kw:
            tenant["Customizations"] = kw["Customizations"]
            tenant["Domains"][0]["Status"] = "active"
        if "Enabled" in kw:
            tenant["Enabled"] = kw["Enabled"]

    def delete_distribution_tenant(self, Id, IfMatch):
        tenant = self._tenant(Id)
        assert not tenant["Enabled"], "a tenant must be disabled before it is deleted"
        del self.tenants[Id]

    def create_invalidation(self, DistributionId, InvalidationBatch):
        self.main_invalidations.append(InvalidationBatch["Paths"]["Items"])

    def create_invalidation_for_distribution_tenant(self, Id, InvalidationBatch):
        self._tenant(Id)
        self.invalidations.append((Id, InvalidationBatch["Paths"]["Items"]))
