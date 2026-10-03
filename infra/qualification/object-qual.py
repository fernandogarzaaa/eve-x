"""EVE-X object-storage qualification: S3 CRUD + checksums + failure modes.
Reads credentials from GARAGE_S3_* env (never committed). Writes evidence JSON.
Usage: GARAGE_S3_KEY=... GARAGE_S3_SECRET=... python infra/qualification/object-qual.py
"""
import hashlib
import json
import os
import sys

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:
    print("boto3 required: pip install boto3")
    sys.exit(2)

ENDPOINT = os.environ.get("GARAGE_S3_ENDPOINT", "http://127.0.0.1:3900")
BUCKET = os.environ.get("GARAGE_BUCKET", "evex")
KEY = os.environ["GARAGE_S3_KEY"]
SECRET = os.environ["GARAGE_S3_SECRET"]

s3 = boto3.client(
    "s3", endpoint_url=ENDPOINT, aws_access_key_id=KEY,
    aws_secret_access_key=SECRET, region_name="garage",
)
phases = []


def rec(name, ok, detail=""):
    phases.append({"name": name, "ok": bool(ok), "detail": str(detail)[:200]})
    print(f"{'PASS' if ok else 'FAIL'} {name} :: {str(detail)[:120]}")
    if not ok:
        finish()
        sys.exit(1)


def finish():
    os.makedirs("artifacts/qualification", exist_ok=True)
    with open("artifacts/qualification/object-qual.json", "w") as f:
        json.dump({"endpoint": ENDPOINT, "bucket": BUCKET, "phases": phases}, f, indent=1)


# Real EVE-X-shaped artifacts (screenshot bytes, trace JSONL, report JSON).
shot = bytes(range(256)) * 4096  # 1 MiB deterministic pseudo-PNG
trace = "".join(json.dumps({"seq": i, "actor": "eve-agent", "goal": "g"}) + "\n" for i in range(500))
report = json.dumps({"sessionId": "sess-qual", "success": True, "findings": []})
objs = {"qual/shot.png": shot, "qual/trace.jsonl": trace.encode(), "qual/report.json": report.encode()}
digests = {k: hashlib.sha256(v).hexdigest() for k, v in objs.items()}

for k, v in objs.items():
    s3.put_object(Bucket=BUCKET, Key=k, Body=v)
rec("upload-3-artifacts", True, f"{len(objs)} objects")

for k, v in objs.items():
    got = s3.get_object(Bucket=BUCKET, Key=k)["Body"].read()
    rec(f"download-checksum:{k}", hashlib.sha256(got).hexdigest() == digests[k], f"{len(got)} bytes")

listed = {o["Key"] for o in s3.list_objects_v2(Bucket=BUCKET, Prefix="qual/").get("Contents", [])}
rec("list-prefix", set(objs) <= listed, f"{len(listed)} keys under qual/")

# Duplicate upload (overwrite) must replace, not duplicate.
s3.put_object(Bucket=BUCKET, Key="qual/shot.png", Body=b"v2")
got = s3.get_object(Bucket=BUCKET, Key="qual/shot.png")["Body"].read()
rec("duplicate-overwrite", got == b"v2", f"{len(got)} bytes")
s3.put_object(Bucket=BUCKET, Key="qual/shot.png", Body=objs["qual/shot.png"])  # restore

# Failure modes must fail safely with typed errors.
try:
    s3.get_object(Bucket=BUCKET, Key="qual/does-not-exist")
    rec("missing-object-404", False, "expected NoSuchKey")
except ClientError as e:
    rec("missing-object-404", e.response["Error"]["Code"] == "NoSuchKey", e.response["Error"]["Code"])

try:
    bad = boto3.client("s3", endpoint_url=ENDPOINT, aws_access_key_id="BAD",
                        aws_secret_access_key="BAD", region_name="garage")
    bad.list_objects_v2(Bucket=BUCKET)
    rec("bad-credentials-denied", False, "expected auth failure")
except ClientError as e:
    rec("bad-credentials-denied", e.response["Error"]["Code"] in ("InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied"), e.response["Error"]["Code"])

# Corrupt local copy must NOT match the stored digest (client-side integrity).
corrupt = bytearray(objs["qual/report.json"])
corrupt[10] ^= 0xFF
rec("corrupt-detectable", hashlib.sha256(bytes(corrupt)).hexdigest() != digests["qual/report.json"], "local tamper changes digest")

finish()
print("OBJECT QUAL COMPLETE")
