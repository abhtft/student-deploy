"""Student frontend deploy API.

POST /upload-url    -> presigned S3 PUT URL for uploads/<student>.zip
POST /publish       -> unzip into sites/<student>/, remove stale files, invalidate CloudFront
GET /me             -> student's site URL and custom-domain state
PUT /domain         -> request a custom domain (only if the teacher enabled it for this student)
GET /domain/status  -> advance and report the custom-domain setup (poll this)
DELETE /domain      -> remove the custom domain

Auth: header `x-deploy-key: <student>.<secret>`, checked against the
{"student": "secret"} JSON map stored in SSM Parameter Store.

Custom domains are CloudFront multi-tenant "distribution tenants". Per-student settings
(teacher's on/off switch, domain, tenant id) live in DynamoDB.
"""
import hmac
import io
import json
import mimetypes
import os
import posixpath
import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

BUCKET = os.environ["BUCKET"]
DISTRIBUTION_ID = os.environ["DISTRIBUTION_ID"]
DISTRIBUTION_DOMAIN = os.environ["DISTRIBUTION_DOMAIN"]
ROOT_DOMAIN = os.environ.get("ROOT_DOMAIN", "")
KEYS_PARAM = os.environ["KEYS_PARAM"]
SETTINGS_TABLE = os.environ.get("SETTINGS_TABLE", "")
TENANT_DISTRIBUTION_ID = os.environ.get("TENANT_DISTRIBUTION_ID", "")
ROUTING_ENDPOINT = os.environ.get("ROUTING_ENDPOINT", "")

NOT_ENABLED = "Owner not enabled for you. Please contact site owner."
DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")

MAX_ZIP_BYTES = 50 * 1024 * 1024
MAX_UNZIPPED_BYTES = 200 * 1024 * 1024
MAX_FILES = 2000
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,29}$")
JUNK = ("__MACOSX/", ".DS_Store", "Thumbs.db")

EXTRA_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".txt": "text/plain",
}

s3 = boto3.client(
    "s3",
    region_name=os.environ.get("AWS_REGION"),
    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}, max_pool_connections=32),
)
ssm = boto3.client("ssm")
cloudfront = boto3.client("cloudfront")
dynamodb = boto3.client("dynamodb")

_keys = {"loaded_at": 0.0, "value": {}}


class DeployError(Exception):
    pass


class ForbiddenError(DeployError):
    pass


def handler(event, context):
    name = authenticate(event)
    if not name:
        return reply(401, error="Invalid or missing x-deploy-key. Ask your teacher for your deploy key.")

    route = event.get("routeKey", "")
    try:
        if route == "POST /upload-url":
            return upload_url(name)
        if route == "POST /publish":
            return publish(name)
        if route == "GET /me":
            return me(name)
        if route == "PUT /domain":
            return set_domain(name, event)
        if route == "GET /domain/status":
            return domain_status(name)
        if route == "DELETE /domain":
            return delete_domain(name)
    except ForbiddenError as e:
        return reply(403, error=str(e))
    except DeployError as e:
        return reply(400, error=str(e))
    return reply(404, error=f"Unknown route {route}")


def authenticate(event):
    key = (event.get("headers") or {}).get("x-deploy-key", "")
    name, _, _ = key.partition(".")
    if not NAME_RE.match(name) or name in ("sites", "uploads"):
        return None
    secret = load_keys().get(name)
    if not secret or not hmac.compare_digest(key.encode(), f"{name}.{secret}".encode()):
        return None
    return name


def load_keys():
    # Cache briefly so adding/removing a student takes effect within a minute.
    if time.time() - _keys["loaded_at"] > 60:
        value = ssm.get_parameter(Name=KEYS_PARAM)["Parameter"]["Value"]
        _keys["value"] = json.loads(value or "{}")
        _keys["loaded_at"] = time.time()
    return _keys["value"]


def upload_url(name):
    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": f"uploads/{name}.zip"},
        ExpiresIn=600,
    )
    return reply(200, uploadUrl=url, maxBytes=MAX_ZIP_BYTES)


def publish(name):
    zip_key = f"uploads/{name}.zip"
    try:
        size = s3.head_object(Bucket=BUCKET, Key=zip_key)["ContentLength"]
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            raise DeployError("No upload found. Call /upload-url and PUT your zip first.")
        raise
    if size > MAX_ZIP_BYTES:
        s3.delete_object(Bucket=BUCKET, Key=zip_key)
        raise DeployError(f"Zip is {size // 1024 // 1024} MB; the limit is {MAX_ZIP_BYTES // 1024 // 1024} MB.")

    body = s3.get_object(Bucket=BUCKET, Key=zip_key)["Body"].read()
    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile:
        raise DeployError("Upload is not a valid zip file.")

    entries = site_entries(archive)
    prefix = f"sites/{name}/"

    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [pool.submit(put_file, prefix + path, archive.read(info), path) for path, info in entries.items()]
        for future in futures:
            future.result()

    stale = [key for key in list_keys(prefix) if key[len(prefix):] not in entries]
    for i in range(0, len(stale), 1000):
        s3.delete_objects(Bucket=BUCKET, Delete={"Objects": [{"Key": k} for k in stale[i:i + 1000]], "Quiet": True})

    # Cache entries are keyed by the rewritten URI (/sites/<name>/...); /<name>/* covers the viewer path in path mode.
    paths = [f"/sites/{name}/*", f"/{name}/*"]
    cloudfront.create_invalidation(
        DistributionId=DISTRIBUTION_ID,
        InvalidationBatch={"Paths": {"Quantity": len(paths), "Items": paths}, "CallerReference": f"{name}-{time.time_ns()}"},
    )
    s3.delete_object(Bucket=BUCKET, Key=zip_key)

    result = {"url": site_url(name), "files": len(entries), "removed": len(stale)}
    warning = base_path_warning(name, archive.read(entries["index.html"]))
    if warning:
        result["warning"] = warning
    return reply(200, **result)


def site_entries(archive):
    """Return {relative/path: ZipInfo} for the site, validated and rooted at index.html."""
    entries = {}
    total = 0
    for info in archive.infolist():
        if info.is_dir() or any(j in info.filename for j in JUNK):
            continue
        raw = info.filename.replace("\\", "/")
        path = posixpath.normpath(raw)
        if raw.startswith("/") or path == "." or path.startswith("../") or path == "..":
            raise DeployError(f"Unsafe path in zip: {info.filename}")
        entries[path] = info
        total += info.file_size

    if len(entries) > MAX_FILES:
        raise DeployError(f"Too many files ({len(entries)}); the limit is {MAX_FILES}.")
    if total > MAX_UNZIPPED_BYTES:
        raise DeployError(f"Site is {total // 1024 // 1024} MB unzipped; the limit is {MAX_UNZIPPED_BYTES // 1024 // 1024} MB.")

    # Accept a zip of the build folder itself (dist/index.html) as well as of its contents.
    if "index.html" not in entries and entries and all("/" in p for p in entries):
        tops = {p.split("/", 1)[0] for p in entries}
        if len(tops) == 1:
            cut = len(tops.pop()) + 1
            entries = {p[cut:]: info for p, info in entries.items()}

    if "index.html" not in entries:
        raise DeployError("index.html not found at the top of the zip. Zip the contents of your build folder (e.g. dist/).")
    return entries


def put_file(key, data, path):
    s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=content_type(path), CacheControl=cache_control(path))


def content_type(path):
    ext = posixpath.splitext(path)[1].lower()
    guessed = EXTRA_TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
    if guessed.startswith("text/") or guessed in ("application/json", "application/manifest+json"):
        guessed += "; charset=utf-8"
    return guessed


def cache_control(path):
    # CloudFront keeps everything until the next publish invalidates it (s-maxage);
    # browsers always revalidate HTML and keep other files for 5 minutes.
    if path.endswith(".html"):
        return "public, max-age=0, must-revalidate, s-maxage=31536000"
    return "public, max-age=300, s-maxage=31536000"


def list_keys(prefix):
    keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        keys.extend(obj["Key"] for obj in page.get("Contents", []))
    return keys


def site_url(name):
    if ROOT_DOMAIN:
        return f"https://{name}.{ROOT_DOMAIN}/"
    return f"https://{DISTRIBUTION_DOMAIN}/{name}/"


def base_path_warning(name, index_html):
    """In path mode, root-absolute asset URLs (/assets/x.js) miss the /<name>/ prefix and 404."""
    if ROOT_DOMAIN:
        return None
    if re.search(rb'(?:src|href)="/(?!/)', index_html) and f'"/{name}/'.encode() not in index_html:
        return f"Your index.html loads files from '/...'. Set base: '/{name}/' in vite.config to make them load from your folder."
    return None


# ---------- custom domains ----------

STATUS_MESSAGES = {
    "none": "",
    "waiting_dns": "Waiting for your DNS record. Add the CNAME shown below, then this page continues on its own.",
    "issuing_certificate": "DNS found. Issuing your HTTPS certificate (usually 1-5 minutes).",
    "finishing": "Certificate ready. Finishing setup (usually 1-5 minutes).",
    "live": "Your custom domain is live.",
    "removing": "Removing your custom domain...",
}


def get_settings(name):
    item = dynamodb.get_item(TableName=SETTINGS_TABLE, Key={"name": {"S": name}}, ConsistentRead=True).get("Item", {})
    return {
        "enabled": item.get("enabled", {}).get("BOOL", False),
        "domain": item.get("domain", {}).get("S", ""),
        "tenantId": item.get("tenantId", {}).get("S", ""),
        "removing": item.get("removing", {}).get("BOOL", False),
    }


def save_settings(name, **fields):
    """Set the given fields; a value of None removes the attribute."""
    names, values, sets, removes = {}, {}, [], []
    for i, (field, value) in enumerate(fields.items()):
        names[f"#f{i}"] = field
        if value is None:
            removes.append(f"#f{i}")
        else:
            values[f":v{i}"] = {"BOOL": value} if isinstance(value, bool) else {"S": value}
            sets.append(f"#f{i} = :v{i}")
    expression = ("SET " + ", ".join(sets) if sets else "") + (" REMOVE " + ", ".join(removes) if removes else "")
    args = {"TableName": SETTINGS_TABLE, "Key": {"name": {"S": name}}, "UpdateExpression": expression.strip(), "ExpressionAttributeNames": names}
    if values:
        args["ExpressionAttributeValues"] = values
    dynamodb.update_item(**args)


def domain_summary(settings, status):
    return {
        "enabled": settings["enabled"],
        "domain": settings["domain"],
        "state": status,
        "message": STATUS_MESSAGES.get(status, ""),
        "cnameTarget": ROUTING_ENDPOINT,
        "siteUrl": f"https://{settings['domain']}/" if settings["domain"] else "",
    }


def validate_domain(raw):
    domain = raw.strip().lower().rstrip(".")
    if not DOMAIN_RE.match(domain):
        raise DeployError("That is not a valid domain name. Example: www.example.com")
    if ROOT_DOMAIN and (domain == ROOT_DOMAIN or domain.endswith("." + ROOT_DOMAIN)):
        raise DeployError(f"Use your own domain. {ROOT_DOMAIN} names are already served for you.")
    if domain.endswith((".cloudfront.net", ".amazonaws.com")):
        raise DeployError("Use your own domain, not an AWS address.")
    if domain.count(".") < 2:
        raise DeployError("Use a subdomain such as www.example.com. A CNAME cannot be set on the bare domain.")
    return domain


def me(name):
    settings = get_settings(name)
    status = "none"
    if settings["domain"]:
        status = "removing" if settings["removing"] else ("live" if settings["tenantId"] else "waiting_dns")
    return reply(200, name=name, siteUrl=site_url(name), customDomain=domain_summary(settings, status))


def set_domain(name, event):
    settings = get_settings(name)
    if not settings["enabled"]:
        raise ForbiddenError(NOT_ENABLED)
    if settings["domain"]:
        raise DeployError("You already have a custom domain. Remove it first.")
    try:
        body = json.loads(event.get("body") or "{}")
    except ValueError:
        raise DeployError('Send JSON like {"domain": "www.example.com"}.')
    domain = validate_domain(str(body.get("domain", "")))
    save_settings(name, domain=domain, tenantId=None, removing=None)
    return domain_status(name)


def domain_status(name):
    """Advance the setup by one step and report where it is. Safe to call repeatedly."""
    settings = get_settings(name)
    domain = settings["domain"]
    if not domain:
        return reply(200, **domain_summary(settings, "none"))
    if settings["removing"]:
        return finish_removal(name, settings)

    tenant_id = settings["tenantId"]
    if not tenant_id:
        try:
            tenant = cloudfront.create_distribution_tenant(
                DistributionId=TENANT_DISTRIBUTION_ID,
                Name=f"student-{name}",
                Domains=[{"Domain": domain}],
                Parameters=[{"Name": "student", "Value": name}],
                ManagedCertificateRequest={"ValidationTokenHost": "cloudfront", "PrimaryDomainName": domain},
                Enabled=True,
            )["DistributionTenant"]
        except ClientError as e:
            error = e.response["Error"]
            if error.get("Code") == "InvalidArgument":
                # CloudFront could not verify the domain points at it yet.
                return reply(200, **domain_summary(settings, "waiting_dns"))
            raise DeployError(f"CloudFront refused this domain: {error.get('Message', error.get('Code'))}")
        save_settings(name, tenantId=tenant["Id"])
        return reply(200, **domain_summary(settings, "issuing_certificate"))

    found = cloudfront.get_distribution_tenant(Identifier=tenant_id)
    tenant = found["DistributionTenant"]
    cert_arn = ((tenant.get("Customizations") or {}).get("Certificate") or {}).get("Arn")
    active = any(d.get("Domain") == domain and d.get("Status") == "active" for d in tenant.get("Domains", []))
    if cert_arn and active and tenant.get("Status") == "Deployed":
        return reply(200, **domain_summary(settings, "live"))
    if cert_arn:
        return reply(200, **domain_summary(settings, "finishing"))

    details = cloudfront.get_managed_certificate_details(Identifier=tenant_id)["ManagedCertificateDetails"]
    if str(details.get("CertificateStatus", "")).lower() == "issued":
        cloudfront.update_distribution_tenant(
            Id=tenant_id,
            IfMatch=found["ETag"],
            Domains=[{"Domain": domain}],
            Customizations={"Certificate": {"Arn": details["CertificateArn"]}},
        )
        return reply(200, **domain_summary(settings, "finishing"))
    return reply(200, **domain_summary(settings, "issuing_certificate"))


def delete_domain(name):
    settings = get_settings(name)
    if not settings["domain"]:
        return reply(200, **domain_summary(settings, "none"))
    if not settings["tenantId"]:
        save_settings(name, domain=None)
        return reply(200, **domain_summary(get_settings(name), "none"))
    found = cloudfront.get_distribution_tenant(Identifier=settings["tenantId"])
    if found["DistributionTenant"].get("Enabled"):
        cloudfront.update_distribution_tenant(
            Id=settings["tenantId"], IfMatch=found["ETag"], Domains=[{"Domain": settings["domain"]}], Enabled=False
        )
    save_settings(name, removing=True)
    return finish_removal(name, get_settings(name))


def finish_removal(name, settings):
    try:
        found = cloudfront.get_distribution_tenant(Identifier=settings["tenantId"])
    except ClientError as e:
        if "NoSuch" not in e.response["Error"].get("Code", ""):
            raise
        found = None
    if found:
        tenant = found["DistributionTenant"]
        if tenant.get("Enabled") or tenant.get("Status") != "Deployed":
            return reply(200, **domain_summary(settings, "removing"))
        cloudfront.delete_distribution_tenant(Id=settings["tenantId"], IfMatch=found["ETag"])
    save_settings(name, domain=None, tenantId=None, removing=None)
    return reply(200, **domain_summary(get_settings(name), "none"))


def reply(status, **body):
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(body)}
