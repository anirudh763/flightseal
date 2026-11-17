#!/usr/bin/env python3
"""Run the receipt registry end to end in LocalStack 4.12.0 (community) and record what really happened.

  uv run --no-project --with boto3==1.43.123 python registry/localstack/e2e.py

Default mode starts the pinned image on 127.0.0.1:4599 (named volume `hashwing-localstack`, PERSISTENCE=1), deploys
the table, the Lambda and a REST API v1 `{proxy+}` stand-in (the HTTP API and Cognito are not in the community
image), runs every scenario through the API URL, checks persistence across `docker restart` and container
re-creation, writes docs/aws/evidence/localstack-4.12.0.json and removes the container and volume.

`--api-url` mode (used by deploy_cdklocal.sh; needs LocalStack Pro) runs the same scenarios against an already
deployed HTTP API with Cognito tokens and skips the container lifecycle and persistence steps.

Never touches real AWS: fixed test credentials, no config files, explicit endpoint.
"""
import os

os.environ.update(AWS_ACCESS_KEY_ID="test", AWS_SECRET_ACCESS_KEY="test", AWS_CONFIG_FILE="/dev/null",
                  AWS_SHARED_CREDENTIALS_FILE="/dev/null", AWS_DEFAULT_REGION="us-east-1")
for _v in ("AWS_PROFILE", "AWS_SESSION_TOKEN", "AWS_ENDPOINT_URL"):
    os.environ.pop(_v, None)

import argparse  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import platform  # noqa: E402
import secrets  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402
import zipfile  # noqa: E402
from pathlib import Path  # noqa: E402

import boto3  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "registry"))
from registry import ed25519, receipt  # noqa: E402
from registry.identity import make_dev_token  # noqa: E402

IMAGE = "localstack/localstack:4.12.0"
DIGEST = "sha256:0df3a97da57de03a588c05d9b8f390f15c7033fc7c4512f94619d344bc3cd317"
NAME, VOLUME, PORT = "hashwing-localstack", "hashwing-localstack", 4599
ENDPOINT = f"http://127.0.0.1:{PORT}"
TABLE, FUNCTION, STAGE = "hashwing-registry-e2e", "hashwing-registry-e2e", "e2e"
DEDUPE_SECONDS = 8
EVIDENCE = ROOT / "docs" / "aws" / "evidence" / "localstack-4.12.0.json"

steps = []


def record(name, result, detail=""):
    steps.append({"step": name, "result": result, "detail": detail})
    print(f"[{result:7}] {name}{': ' + detail if detail else ''}", flush=True)


def check(name, ok, detail=""):
    record(name, "pass" if ok else "fail", detail)
    return ok


def sh(*args, check_rc=True):
    r = subprocess.run(args, capture_output=True, text=True)
    if check_rc and r.returncode:
        raise RuntimeError(f"{' '.join(args[:3])}...: {r.stderr.strip()[-400:]}")
    return r.stdout.strip()


def client(service):
    return boto3.client(service, endpoint_url=ENDPOINT, region_name="us-east-1")


def http(method, url, token=None, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, {"_raw": raw[:300].decode(errors="replace")}


# ------------------------------------------------------------------ container lifecycle

def start_container():
    sh("docker", "run", "-d", "--name", NAME, "-p", f"127.0.0.1:{PORT}:4566",
       "-v", f"{VOLUME}:/var/lib/localstack", "-v", "/var/run/docker.sock:/var/run/docker.sock",
       "-e", "PERSISTENCE=1", "-e", f"MAIN_CONTAINER_NAME={NAME}", f"{IMAGE}@{DIGEST}")


def wait_healthy(timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{ENDPOINT}/_localstack/health", timeout=5) as r:
                health = json.loads(r.read())
            if health.get("services", {}).get("dynamodb") in ("available", "running"):
                return health
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError("LocalStack did not become healthy")


def remove_everything():
    sh("docker", "stop", "-t", "20", NAME, check_rc=False)
    sh("docker", "rm", "-f", NAME, check_rc=False)
    for cid in sh("docker", "ps", "-aq", "--filter", f"name={NAME}-lambda", check_rc=False).split():
        sh("docker", "rm", "-f", cid, check_rc=False)
    sh("docker", "volume", "rm", "-f", VOLUME, check_rc=False)


# ------------------------------------------------------------------ deployment (REST v1 stand-in)

def lambda_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(ROOT / "registry" / "handler.py", "handler.py")
        for f in sorted((ROOT / "registry" / "registry").glob("*.py")):
            z.write(f, f"registry/{f.name}")
    return buf.getvalue()


def lambda_env(dev_secret):
    return {"TABLE_NAME": TABLE, "IDENTITY_ADAPTER": "dev-hs256", "DEV_TOKEN_SECRET": dev_secret,
            "DEDUPE_SECONDS": str(DEDUPE_SECONDS)}


def deploy(dev_secret):
    ddb = client("dynamodb")
    ddb.create_table(TableName=TABLE, BillingMode="PAY_PER_REQUEST",
                     AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"},
                                           {"AttributeName": "SK", "AttributeType": "S"}],
                     KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}])
    ddb.get_waiter("table_exists").wait(TableName=TABLE)
    ddb.update_time_to_live(TableName=TABLE, TimeToLiveSpecification={"Enabled": True, "AttributeName": "ttl"})
    role = client("iam").create_role(RoleName="hashwing-registry-e2e", AssumeRolePolicyDocument=json.dumps({
        "Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"},
                                                "Action": "sts:AssumeRole"}]}))["Role"]["Arn"]
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
    lam = client("lambda")
    fn = lam.create_function(
        FunctionName=FUNCTION, Runtime="python3.12", Role=role, Handler="handler.handler", Architectures=[arch],
        Code={"ZipFile": lambda_zip()}, MemorySize=128, Timeout=30,
        Environment={"Variables": lambda_env(dev_secret)})
    lam.get_waiter("function_active_v2").wait(FunctionName=FUNCTION)
    apigw = client("apigateway")
    api_id = apigw.create_rest_api(name="hashwing-registry-e2e")["id"]
    root_id = [r for r in apigw.get_resources(restApiId=api_id)["items"] if r["path"] == "/"][0]["id"]
    proxy = apigw.create_resource(restApiId=api_id, parentId=root_id, pathPart="{proxy+}")["id"]
    apigw.put_method(restApiId=api_id, resourceId=proxy, httpMethod="ANY", authorizationType="NONE")
    apigw.put_integration(restApiId=api_id, resourceId=proxy, httpMethod="ANY", type="AWS_PROXY",
                          integrationHttpMethod="POST",
                          uri=f"arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/{fn['FunctionArn']}/invocations")
    apigw.create_deployment(restApiId=api_id, stageName=STAGE)
    return api_id, arch


def find_api_url(api_id):
    """LocalStack serves REST APIs under more than one URL shape; use the first that reaches our Lambda."""
    errors = []
    for base in (f"{ENDPOINT}/_aws/execute-api/{api_id}/{STAGE}", f"{ENDPOINT}/restapis/{api_id}/{STAGE}/_user_request_"):
        status, body = http("GET", base + "/v1/keys")
        if status == 401 and body == {"error": "unauthorized"}:
            return base
        errors.append(f"{base}: {status} {body}")
    raise RuntimeError("API not reachable: " + " | ".join(errors))


# ------------------------------------------------------------------ scenarios

class Dev:
    def __init__(self, secret):
        self.secret = secret

    def __call__(self, org, role, sub):
        return make_dev_token(self.secret, sub, org, role, int(time.time()) + 3600)


class CognitoTokens:
    """--api-url mode: users created in the LocalStack Cognito pool; the client sends the ID token."""

    def __init__(self, pool, client_id):
        self.idp, self.pool, self.client_id, self.cache = client("cognito-idp"), pool, client_id, {}

    def __call__(self, org, role, sub):
        if (org, role, sub) not in self.cache:
            user, pw = f"{sub}@{org}.example.invalid", "Aa1!" + secrets.token_urlsafe(16)
            self.idp.admin_create_user(UserPoolId=self.pool, Username=user, MessageAction="SUPPRESS",
                                       UserAttributes=[{"Name": "email", "Value": user},
                                                       {"Name": "custom:org_id", "Value": org},
                                                       {"Name": "custom:role", "Value": role}])
            self.idp.admin_set_user_password(UserPoolId=self.pool, Username=user, Password=pw, Permanent=True)
            auth = self.idp.admin_initiate_auth(UserPoolId=self.pool, ClientId=self.client_id,
                                                AuthFlow="ADMIN_USER_PASSWORD_AUTH",
                                                AuthParameters={"USERNAME": user, "PASSWORD": pw})
            self.cache[(org, role, sub)] = auth["AuthenticationResult"]["IdToken"]
        return self.cache[(org, role, sub)]


def receipt_line(seed, count):
    head = secrets.token_bytes(32)
    sig = ed25519.sign(seed, receipt.signed_message(count, head))
    return receipt.to_line(receipt.Receipt(count, head, ed25519.public_key(seed), sig))


def scenarios(url, tok, table, dedupe):
    """Every check goes through the API URL; the DynamoDB reads only confirm what was (not) written."""
    ddb = client("dynamodb")
    seed = secrets.token_bytes(32)
    admin, pilot, other = tok("orgA", "admin", "admin-1"), tok("orgA", "pilot", "pilot-1"), tok("orgB", "pilot", "pilot-9")

    def envelope(t):
        return http("POST", url + "/v1/envelopes", t, {})[1]["envelope_id"]

    def register(t, text, idem, env_id):
        return http("POST", url + "/v1/registrations", t, {"receipt": text, "idempotency_key": idem, "envelope_id": env_id})

    def reg_items(rid):
        return ddb.query(TableName=table, ConsistentRead=True, KeyConditionExpression="PK = :p AND SK = :s",
                         ExpressionAttributeValues={":p": {"S": "ORG#orgA"}, ":s": {"S": "REG#" + rid}})["Items"]

    _, ch = http("GET", url + "/v1/keys/challenge", admin)
    status, out = http("POST", url + "/v1/keys", admin, {
        "public_key": ed25519.public_key(seed).hex(), "nonce": ch["nonce"],
        "signature": ed25519.sign(seed, ch["message"].encode()).hex()})
    check("enroll company key (admin, signed challenge)", status == 201, f"{status} {out.get('state', out)}")

    env_a = envelope(pilot)
    r1 = receipt_line(seed, 100)
    status, ack1 = register(pilot, r1, "e2e-idem-0000000001", env_a)
    check("authorized register", status == 201 and ack1.get("disposition") == "active", f"{status}")

    status, out = http("POST", url + "/v1/registrations", None, {"receipt": r1})
    check("denied: no token", status == 401, f"{status} {out}")
    status, out = register(other, receipt_line(seed, 101), "e2e-idem-0000000002", envelope(other))
    check("denied: wrong org (key enrolled in orgA, token orgB)", (status, out.get("error")) == (403, "key_not_enrolled"),
          f"{status} {out}")

    status, again = register(pilot, r1, "e2e-idem-0000000001", env_a)
    check("duplicate retry returns the original ack", status == 200 and again == ack1, f"{status}")

    r2 = receipt_line(seed, 200)
    register(pilot, r2, "e2e-idem-0000000003", env_a)  # committed; the response is deliberately discarded
    status, ack2 = register(pilot, r2, "e2e-idem-0000000003", env_a)
    one = len(reg_items(ack2.get("registration_id", "x"))) == 1
    check("lost ack: retry after a discarded response", status == 200 and one,
          f"{status}; registration items in DynamoDB: {'1' if one else 'not 1'}")

    _, share1 = http("POST", url + "/v1/shares", pilot, {"registration_id": ack1["registration_id"]})
    before = http("GET", url + share1["path"])[0]
    withdraw = http("DELETE", url + share1["path"], pilot)[0]
    after = http("GET", url + share1["path"])
    replay = register(pilot, r1, "e2e-idem-0000000001", env_a)[0]
    after_replay = http("GET", url + share1["path"])
    check("withdrawal: share 200, withdrawn, then 404 (also after an identical register retry)",
          (before, withdraw, after[0], replay, after_replay[0]) == (200, 200, 404, 200, 404) and after == after_replay,
          f"GET {before}, DELETE {withdraw}, GET {after[0]}, retry {replay}, GET {after_replay[0]}")

    _, share2 = http("POST", url + "/v1/shares", pilot, {"registration_id": ack2["registration_id"]})
    deleted = http("DELETE", url + f"/v1/registrations/{ack2['registration_id']}", admin)[0]
    share_after = http("GET", url + share2["path"])[0]
    item = (reg_items(ack2["registration_id"]) or [{}])[0]
    check("deletion: registration tombstoned, its share 404",
          deleted == 200 and share_after == 404 and item.get("state", {}).get("S") == "deleted" and "received_at" not in item,
          f"DELETE {deleted}, GET share {share_after}, stored state {item.get('state', {}).get('S')}")

    status, out = register(pilot, r2, "e2e-idem-0000000004", envelope(pilot))
    check("replay after deletion (new idempotency key)", (status, out.get("error")) == (410, "registration_deleted"),
          f"{status} {out}")

    if dedupe is None:
        record("replay after dedupe expiry", "skipped", "DEDUPE_SECONDS is not shortened on this deployment")
    else:
        r3 = receipt_line(seed, 300)
        env3 = envelope(pilot)
        _, ack3 = register(pilot, r3, "e2e-idem-0000000005", env3)
        time.sleep(dedupe + 2)
        status, again3 = register(pilot, r3, "e2e-idem-0000000005", env3)
        check(f"replay after dedupe expiry ({dedupe}s)", status == 200 and again3 == ack3 and len(reg_items(ack3["registration_id"])) == 1,
              f"{status}")

    status, page = http("GET", url + "/v1/registrations?limit=1", pilot)
    status2, rest = http("GET", url + f"/v1/registrations?limit=1&cursor={page.get('next_cursor')}", pilot)
    check("list registrations, one per page with a cursor (DynamoDB Query)",
          status == status2 == 200 and len(page.get("registrations", [])) == 1 and bool(page.get("next_cursor"))
          and len(rest.get("registrations", [])) == 1
          and rest["registrations"][0]["registration_id"] != page["registrations"][0]["registration_id"],
          f"{status} {status2}")
    status, keys = http("GET", url + "/v1/keys", pilot)
    check("list keys", status == 200 and [k["state"] for k in keys.get("keys", [])] == ["active"], f"{status}")
    env_old = envelope(pilot)
    status, ep = http("POST", url + "/v1/epoch", admin, {})
    status2, out = register(pilot, receipt_line(seed, 400), "e2e-idem-0000000006", env_old)
    check("epoch bump (transaction with its tombstone) invalidates an outstanding envelope",
          status == 200 and ep.get("epoch") == 1 and (status2, out.get("error")) == (422, "envelope_expired"),
          f"epoch {status} {ep}, register {status2} {out}")
    return {"share_path": share2["path"], "rid": ack1["registration_id"], "pilot": pilot, "ack1": ack1,
            "withdrawn_paths": [share1["path"], share2["path"]], "rid2": ack2["registration_id"]}


def restore_drill(url, state, base_env):
    """Restore a pre-withdrawal copy into a second table, serve it gated, apply tombstones, check through the API.

    LocalStack community has no PITR restore, so the "backup" is emulated: every item is copied and the withdrawal
    and deletion done above are undone in the copy (and its tombstones dropped). That emulation is stated in the
    evidence; the gate, apply_tombstones and the API checks are real.
    """
    import hashlib

    from registry.restore import apply_tombstones
    from registry.store import DynamoTable

    ddb, lam, target = client("dynamodb"), client("lambda"), TABLE + "-restored"
    _, live_share = http("POST", url + "/v1/shares", state["pilot"], {"registration_id": state["rid"]})
    ddb.create_table(TableName=target, BillingMode="PAY_PER_REQUEST",
                     AttributeDefinitions=[{"AttributeName": "PK", "AttributeType": "S"},
                                           {"AttributeName": "SK", "AttributeType": "S"}],
                     KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}])
    ddb.get_waiter("table_exists").wait(TableName=target)
    for page in ddb.get_paginator("scan").paginate(TableName=TABLE, ConsistentRead=True):
        for item in page["Items"]:
            if not item["PK"]["S"].startswith("TOMB#"):
                ddb.put_item(TableName=target, Item=item)
    restored = DynamoTable(target, client=ddb)
    for path in state["withdrawn_paths"]:
        restored.update("SHARE#" + hashlib.sha256(path.rsplit("/", 1)[1].encode()).hexdigest(), "SHARE",
                        set={"state": "active"})
    restored.update("ORG#orgA", "REG#" + state["rid2"], set={"state": "active", "received_at": int(time.time())})

    def serve(env):
        lam.update_function_configuration(FunctionName=FUNCTION, Environment={"Variables": env})
        lam.get_waiter("function_updated_v2").wait(FunctionName=FUNCTION)

    restore_id = secrets.token_hex(8)
    serve({**base_env, "TABLE_NAME": target, "RESTORED_FROM": TABLE, "RESTORE_ID": restore_id})
    gated = [http("GET", url + p)[1].get("error") for p in [live_share["path"], *state["withdrawn_paths"]]]
    gated.append(http("POST", url + "/v1/envelopes", state["pilot"], {})[1].get("error"))  # an authenticated route
    gated.append(http("GET", url + "/v1/registrations", state["pilot"])[1].get("error"))
    check("restore gate: public and authenticated routes 503 restore_pending before tombstones are applied",
          gated == ["restore_pending"] * 5, "GET share x3, POST /v1/envelopes, GET /v1/registrations: " + str(gated))
    n = apply_tombstones(DynamoTable(TABLE, client=ddb), restored, source_name=TABLE, target_name=target,
                         restore_id=restore_id, served=TABLE)
    views = [http("GET", url + p)[0] for p in [live_share["path"], *state["withdrawn_paths"]]]
    marker = restored.get("SYSTEM", "RESTORE") or {}
    check("restore apply (Scan, Put, Update in DynamoDB): withdrawn and deleted views 404, active one 200",
          views == [200, 404, 404] and marker.get("source") == TABLE,
          f"{n} tombstones applied; live/withdrawn/deleted share GET: {views}; backup emulated by copying items and "
          "undoing the withdrawal and deletion (no PITR in LocalStack community)")
    serve(base_env)


def persistence(url_for, state):
    """Write, restart, read back through the API and directly from DynamoDB. Never reseed."""
    pilot = state["pilot"]
    url = url_for()
    _, live = http("POST", url + "/v1/shares", pilot, {"registration_id": state["rid"]})
    check("persistence: share served before restart", http("GET", url + live["path"])[0] == 200)

    def probe(label):
        out = {}
        try:
            names = client("dynamodb").list_tables()["TableNames"]
            out["table_exists"] = TABLE in names
            if out["table_exists"]:
                got = client("dynamodb").get_item(TableName=TABLE, ConsistentRead=True,
                                                  Key={"PK": {"S": "ORG#orgA"}, "SK": {"S": "REG#" + state["rid"]}})
                out["registration_item_readable"] = "Item" in got
        except Exception as err:  # noqa: BLE001 - recorded verbatim
            out["dynamodb_error"] = f"{type(err).__name__}: {err}"[:300]
        try:
            out["lambda_exists"] = FUNCTION in [f["FunctionName"] for f in client("lambda").list_functions()["Functions"]]
            out["rest_api_exists"] = bool(client("apigateway").get_rest_apis()["items"])
        except Exception as err:  # noqa: BLE001
            out["control_plane_error"] = f"{type(err).__name__}: {err}"[:300]
        try:
            u = url_for()
            status, body = http("GET", u + live["path"], timeout=60)
            out["api_share_status"] = status
            out["api_share_matches"] = status == 200 and body.get("head") == state["ack1"]["head"]
        except Exception as err:  # noqa: BLE001
            out["api_error"] = f"{type(err).__name__}: {err}"[:300]
        survived = out.get("registration_item_readable") and out.get("api_share_matches")
        record(f"persistence after {label}", "pass" if survived else "fail", json.dumps(out, sort_keys=True))

    sh("docker", "restart", NAME)
    wait_healthy()
    probe("docker restart (same container, volume, PERSISTENCE=1)")
    sh("docker", "rm", "-f", NAME)
    start_container()
    wait_healthy()
    probe("docker rm and re-create on the same volume")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--api-url", help="run against an already deployed HTTP API (LocalStack Pro + cdklocal)")
    p.add_argument("--user-pool-id")
    p.add_argument("--client-id")
    p.add_argument("--table-name")
    a = p.parse_args()
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    meta = {"image": IMAGE, "digest": DIGEST, "boto3": boto3.__version__, "host_machine": platform.machine(),
            "started_at": started, "mode": "rest-v1-stand-in",
            "note": "REST API v1 {proxy+} stand-in, not the HTTP API; dev-hs256 identity adapter; LocalStack community"}
    if a.api_url:
        meta.update(mode="cdklocal-http-api", image="localstack/localstack-pro:4.12.0", digest="not pinned",
                    note="HTTP API with the Cognito JWT authorizer deployed by cdklocal; cognito identity adapter "
                         "(ID tokens from the LocalStack user pool); LocalStack Pro; no persistence or restore steps")
        try:
            scenarios(a.api_url.rstrip("/"), CognitoTokens(a.user_pool_id, a.client_id), a.table_name, None)
        except Exception as err:  # noqa: BLE001
            record("scenarios", "blocked", f"{type(err).__name__}: {err}"[:500])
        meta["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        meta["summary"] = {r: sum(s["result"] == r for s in steps) for r in ("pass", "fail", "blocked", "skipped")}
        out = EVIDENCE.with_name("localstack-4.12.0-cdklocal-http-api.json")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({**meta, "steps": steps}, indent=2) + "\n")
        print(f"evidence: {out.relative_to(ROOT)}")
        return 0 if all(s["result"] in ("pass", "skipped") for s in steps) else 1

    remove_everything()  # a clean start: no state left from an earlier run
    try:
        start_container()
        health = wait_healthy()
        meta["localstack_version"] = health.get("version")
        meta["edition"] = health.get("edition")
        record("start pinned image on 127.0.0.1", "pass", f"version {health.get('version')}")
        for svc in ("apigatewayv2", "cognito-idp"):
            try:
                c = client(svc)
                c.create_api(Name="probe", ProtocolType="HTTP") if svc == "apigatewayv2" else c.create_user_pool(PoolName="probe")
                record(f"probe {svc}", "pass", "available")
            except Exception as err:  # noqa: BLE001 - the verbatim blocker is the evidence
                record(f"probe {svc}", "blocked", str(err)[:400])
        secret = secrets.token_urlsafe(48)  # fresh per run, never written to the evidence
        api_id, arch = deploy(secret)
        meta["lambda_architecture"] = arch
        url = find_api_url(api_id)
        record("deploy table, Lambda (python3.12) and REST v1 {proxy+} stand-in", "pass",
               url.replace(api_id, "<api-id>").replace(ENDPOINT, "<endpoint>"))
        state = scenarios(url, Dev(secret), TABLE, DEDUPE_SECONDS)
        restore_drill(url, state, lambda_env(secret))

        def url_for():
            ids = [i["id"] for i in client("apigateway").get_rest_apis()["items"]]
            return find_api_url(ids[0]) if ids else url
        persistence(url_for, state)
    except Exception as err:  # noqa: BLE001
        record("run", "blocked", f"{type(err).__name__}: {err}"[:600])
    finally:
        remove_everything()
        left = sh("docker", "ps", "-aq", "--filter", f"name={NAME}", check_rc=False)
        vol = sh("docker", "volume", "ls", "-q", "--filter", f"name={VOLUME}", check_rc=False)
        record("teardown: container and volume removed", "pass" if not left and not vol else "fail",
               f"containers left: {len(left.split())}, volumes left: {len(vol.split())}")
    meta["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    meta["summary"] = {r: sum(s["result"] == r for s in steps) for r in ("pass", "fail", "blocked", "skipped")}
    EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
    EVIDENCE.write_text(json.dumps({**meta, "steps": steps}, indent=2) + "\n")
    print(f"evidence: {EVIDENCE.relative_to(ROOT)}")
    return 0 if meta["summary"]["fail"] == 0 and not any(s["step"] == "run" for s in steps) else 1


if __name__ == "__main__":
    sys.exit(main())
