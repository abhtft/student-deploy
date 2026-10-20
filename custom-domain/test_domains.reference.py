"""Tests for the custom-domain routes in lambda/app.py against in-memory DynamoDB/CloudFront fakes."""
import json
import os
import sys

from botocore.exceptions import ClientError

os.environ.update(AWS_REGION="us-east-1", AWS_ACCESS_KEY_ID="x", AWS_SECRET_ACCESS_KEY="x", BUCKET="b",
                  DISTRIBUTION_ID="E", DISTRIBUTION_DOMAIN="d", KEYS_PARAM="/k", SETTINGS_TABLE="t",
                  TENANT_DISTRIBUTION_ID="EMT", ROUTING_ENDPOINT="route.cloudfront.net", ROOT_DOMAIN="example.com")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda"))
import app  # noqa: E402


class FakeDynamo:
    def __init__(self):
        self.items = {}

    def get_item(self, TableName, Key, ConsistentRead):
        item = self.items.get(Key["name"]["S"])
        return {"Item": item} if item else {}

    def update_item(self, TableName, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues=None):
        item = self.items.setdefault(Key["name"]["S"], {"name": Key["name"]})
        sets, _, removes = UpdateExpression.partition(" REMOVE ") if UpdateExpression.startswith("SET") else ("", "", UpdateExpression[7:])
        if UpdateExpression.startswith("SET"):
            sets = sets[4:]
        for part in filter(None, [p.strip() for p in sets.split(",")]):
            ref, _, val = part.partition(" = ")
            item[ExpressionAttributeNames[ref]] = ExpressionAttributeValues[val]
        for ref in filter(None, [p.strip() for p in removes.split(",")]):
            item.pop(ExpressionAttributeNames[ref], None)


class FakeCloudFront:
    def __init__(self):
        self.dns_ok = False
        self.tenant = None
        self.cert_status = "pending-validation"
        self.deployed = True
        self.deleted = False

    def _view(self):
        return {"DistributionTenant": dict(self.tenant, Status="Deployed" if self.deployed else "InProgress"), "ETag": "e"}

    def create_distribution_tenant(self, **kw):
        if not self.dns_ok:
            raise ClientError({"Error": {"Code": "InvalidArgument", "Message": "Could not verify Domain Name ownership"}}, "Create")
        assert kw["Parameters"] == [{"Name": "student", "Value": "alice"}]
        domain = kw["Domains"][0]["Domain"]
        self.tenant = {"Id": "dt_1", "Enabled": True, "Domains": [{"Domain": domain, "Status": "inactive"}], "Customizations": {}}
        return {"DistributionTenant": self.tenant}

    def get_distribution_tenant(self, Identifier):
        if self.deleted:
            raise ClientError({"Error": {"Code": "NoSuchDistributionTenant"}}, "Get")
        return self._view()

    def get_managed_certificate_details(self, Identifier):
        return {"ManagedCertificateDetails": {"CertificateArn": "arn:cert", "CertificateStatus": self.cert_status}}

    def update_distribution_tenant(self, Id, IfMatch, Domains, **kw):
        if "Customizations" in kw:
            self.tenant["Customizations"] = kw["Customizations"]
            self.tenant["Domains"][0]["Status"] = "active"
        if "Enabled" in kw:
            self.tenant["Enabled"] = kw["Enabled"]

    def delete_distribution_tenant(self, Id, IfMatch):
        self.deleted = True


app.dynamodb = FakeDynamo()
app.cloudfront = FakeCloudFront()
fake_cf = app.cloudfront


def call(route, name="alice", body=None):
    event = {"routeKey": route, "headers": {}, "body": json.dumps(body) if body is not None else None}
    app.authenticate = lambda e: name
    response = app.handler(event, None)
    return response["statusCode"], json.loads(response["body"])


# --- validation ---
for bad in ["", "nodots", "alice.example.com", "x.example.com", "example.org", "a b.com", "d1.cloudfront.net", "-x.foo.com"]:
    try:
        app.validate_domain(bad)
    except app.DeployError:
        continue
    raise AssertionError(f"should reject {bad!r}")
assert app.validate_domain(" WWW.Alice.COM. ") == "www.alice.com"

# --- teacher switch off: server refuses, UI message comes from here ---
status, body = call("PUT /domain", body={"domain": "www.alice.com"})
assert status == 403 and body["error"] == app.NOT_ENABLED, (status, body)
status, body = call("GET /me")
assert status == 200 and body["customDomain"]["enabled"] is False and body["customDomain"]["state"] == "none"

# --- teacher switches on ---
app.save_settings("alice", enabled=True)
status, body = call("GET /me")
assert body["customDomain"]["enabled"] is True and body["siteUrl"] == "https://alice.example.com/"

status, body = call("PUT /domain", body={"domain": "bad"})
assert status == 400

# --- DNS not pointed yet -> waiting ---
status, body = call("PUT /domain", body={"domain": "www.alice.com"})
assert status == 200 and body["state"] == "waiting_dns" and body["cnameTarget"] == "route.cloudfront.net", body
status, body = call("PUT /domain", body={"domain": "www.other.com"})
assert status == 400 and "already have" in body["error"]
assert call("GET /domain/status")[1]["state"] == "waiting_dns"

# --- DNS pointed -> tenant created, cert pending -> issued -> applied -> live ---
fake_cf.dns_ok = True
assert call("GET /domain/status")[1]["state"] == "issuing_certificate"
assert call("GET /domain/status")[1]["state"] == "issuing_certificate", "cert still pending"
fake_cf.cert_status = "issued"
assert call("GET /domain/status")[1]["state"] == "finishing"
fake_cf.deployed = False
assert call("GET /domain/status")[1]["state"] == "finishing", "applied but still deploying"
fake_cf.deployed = True
status, body = call("GET /domain/status")
assert body["state"] == "live" and body["siteUrl"] == "https://www.alice.com/", body

# --- teacher switches off after setup: existing domain keeps working, no new one allowed ---
app.save_settings("alice", enabled=False)
assert call("GET /domain/status")[1]["state"] == "live"

# --- removal: disable first, delete once deployed ---
fake_cf.deployed = False
assert call("DELETE /domain")[1]["state"] == "removing"
assert fake_cf.tenant["Enabled"] is False
assert call("GET /domain/status")[1]["state"] == "removing"
fake_cf.deployed = True
assert call("GET /domain/status")[1]["state"] == "none" and fake_cf.deleted
assert call("GET /me")[1]["customDomain"]["domain"] == ""

# --- removing a domain that never got a tenant just clears it ---
app.save_settings("bob", enabled=True)
fake_cf.dns_ok = False
call("PUT /domain", name="bob", body={"domain": "www.bob.com"})
assert call("DELETE /domain", name="bob")[1]["state"] == "none"

print("test_domains.py: all passed")
