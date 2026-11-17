"""DEV ONLY. Serves the real registry App over MemoryTable for the outbox browser tests. Never deploy this.

python3 registry/devserver/server.py [--host 127.0.0.1] [--port 0]
Prints `READY http://<host>:<port>` once listening. Refuses any non-loopback bind.

  /v1/*                   the registry, as an HTTP API v2 event (dev-hs256 tokens)
  /src/<name>.mjs         newweb/src modules
  /harness.html           newweb/tests/fixtures/outbox-harness.html
  /__dev/token?org=&sub=&role=&ttl=     a dev token
  /__dev/receipt?count=&seed=A|B        a signed receipt v1 line
  /__dev/advance?s=       move the server clock forward
  /__dev/hold?ms=         delay the next registration before it is handled
  /__dev/drop?route=register|create_share   the next such request commits, then the socket closes unanswered
  /__dev/cors?origins=    replace the CORS allowlist (comma list; default http://127.0.0.1:*)
  /__dev/log              [{route, status, org, sub, receipt}] for every /v1 request
  /__dev/registrations?org=   the stored registrations of one org
  /__dev/reset            a fresh table; orgA (SEED_A) and orgB (SEED_B) enrolled again
"""
import argparse
import base64
import hashlib
import ipaddress
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "registry" / "tests"))

import registry_helpers as rh  # noqa: E402  (also puts registry/ on sys.path)
from registry.app import _cors_allowlist  # noqa: E402

SRC = ROOT / "newweb" / "src"
HARNESS = ROOT / "newweb" / "tests" / "fixtures" / "outbox-harness.html"
MAX_REQUEST = 64 * 1024
DEV_CORS = "http://127.0.0.1:*"  # dev servers only; the stack sets exact https origins


def loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def unverified_claims(auth):
    try:
        part = auth.split(" ", 1)[1].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        return {}
    return claims if isinstance(claims, dict) else {}


class Dev:
    def __init__(self):
        self.lock = threading.Lock()
        self.cors = DEV_CORS
        self.reset()

    def reset(self):
        self.cors = DEV_CORS
        self.app, self.table, self.clock = rh.make_app(CORS_ORIGINS=self.cors)
        self.offset = 0
        self.hold_ms = 0
        self.drop = None  # the route name whose next request is dropped after it commits
        self.log = []
        self.sync_clock()
        for seed, org in ((rh.SEED_A, "orgA"), (rh.SEED_B, "orgB")):
            status, out, _ = rh.enroll(self.app, self.clock, seed=seed, org=org)
            assert status == 201, out

    def sync_clock(self):
        self.clock.t = int(time.time()) + self.offset


DEV = None  # created in main(), after the bind check


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0: one request per connection, so the browser never silently re-sends a dropped request on a reused socket
    protocol_version = "HTTP/1.0"

    def log_message(self, *_args):
        pass

    def send(self, status, body, ctype="application/json", headers=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        try:
            self.send_response(status)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(data)))
            self.send_header("cache-control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client aborted (an outbox closed mid-request)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_DELETE(self):
        self.route("DELETE")

    def do_OPTIONS(self):
        self.route("OPTIONS")

    def route(self, method):
        url = urlsplit(self.path)
        query = {k: v[-1] for k, v in parse_qs(url.query).items()}
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_REQUEST:
            return self.send(413, {"error": "body_too_large"})
        raw = self.rfile.read(length) if length else b""
        path = url.path
        if path.startswith("/v1/"):
            return self.registry(method, path, query, raw)
        if path.startswith("/__dev/"):
            return self.dev(path[7:], query)
        hit = re.fullmatch(r"/src/([a-z0-9-]+\.mjs)", path)
        if method == "GET" and hit and (SRC / hit[1]).is_file():
            return self.send(200, (SRC / hit[1]).read_bytes(), "text/javascript; charset=utf-8")
        if method == "GET" and path == "/harness.html":
            return self.send(200, HARNESS.read_bytes(), "text/html; charset=utf-8")
        return self.send(404, {"error": "not_found"})

    def registry(self, method, path, query, raw):
        is_reg = method == "POST" and path == "/v1/registrations"
        target = "register" if is_reg else "create_share" if (method, path) == ("POST", "/v1/shares") else None
        hold = drop = False
        with DEV.lock:
            if is_reg:
                hold, DEV.hold_ms = DEV.hold_ms, 0
            if target and DEV.drop == target:
                drop, DEV.drop = True, None
        if hold:
            time.sleep(hold / 1000)
        try:
            body = raw.decode("utf-8")
            b64 = False
        except UnicodeDecodeError:
            body, b64 = base64.b64encode(raw).decode(), True
        headers = {k.lower(): v for k, v in self.headers.items()}
        event = {"version": "2.0", "rawPath": path, "requestContext": {"http": {"method": method}}, "headers": headers,
                 "body": body, "isBase64Encoded": b64, "queryStringParameters": query or None}
        with DEV.lock:
            DEV.sync_clock()
            out = DEV.app.handle(event)
            route = DEV.app._route(method, path)
            claims = unverified_claims(headers.get("authorization", ""))
            entry = {"route": route[0] if route else ("preflight" if method == "OPTIONS" else "unrouted"),
                     "method": method, "origin": headers.get("origin"), "status": out["statusCode"],
                     "org": claims.get("org_id"), "sub": claims.get("sub"), "dropped": drop}
            if is_reg:
                try:
                    text = json.loads(raw).get("receipt", "")
                    entry["receipt"] = hashlib.sha256(str(text).encode()).hexdigest()
                except (ValueError, AttributeError):
                    entry["receipt"] = None
            DEV.log.append(entry)
        if drop:  # committed; the client never sees the answer
            self.close_connection = True
            return
        self.send(out["statusCode"], out["body"].encode(), headers={k: v for k, v in out["headers"].items()
                                                                     if k != "content-type"})

    def dev(self, name, query):
        with DEV.lock:
            if name == "token":
                DEV.sync_clock()
                tok = rh.token(DEV.clock, org=query.get("org", "orgA"), role=query.get("role", "pilot"),
                               sub=query.get("sub", "pilot-1"), ttl=int(query.get("ttl", 3600)))
                return self.send(200, {"token": tok})
            if name == "receipt":
                seed = rh.SEED_B if query.get("seed") == "B" else rh.SEED_A
                return self.send(200, {"receipt": rh.line(seed, int(query.get("count", 1)))})
            if name == "advance":
                DEV.offset += int(query.get("s", 0))
                DEV.sync_clock()
                return self.send(200, {"offset": DEV.offset, "now": DEV.clock.t})
            if name == "hold":
                DEV.hold_ms = int(query.get("ms", 0))
                return self.send(200, {"hold_ms": DEV.hold_ms})
            if name == "drop":
                DEV.drop = query.get("route", "register")
                return self.send(200, {"drop": DEV.drop})
            if name == "cors":
                DEV.cors = query.get("origins", DEV_CORS)
                DEV.app.cors = _cors_allowlist(DEV.cors)
                return self.send(200, {"cors": DEV.cors})
            if name == "log":
                return self.send(200, {"log": DEV.log})
            if name == "registrations":
                items, _ = DEV.table.query("ORG#" + query.get("org", "orgA"), "REG#", 1000)
                regs = [{"registration_id": r["SK"][4:], "state": r["state"], "shares": len(r.get("share_hashes", [])),
                         "received_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(r["received_at"]))
                         if "received_at" in r else None} for r in items]
                return self.send(200, {"registrations": regs})
            if name == "reset":
                DEV.reset()
                return self.send(200, {"reset": True})
        return self.send(404, {"error": "not_found"})


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    if not loopback(args.host):
        sys.exit(f"refusing non-loopback bind {args.host!r}: this server is for local tests only")
    global DEV
    DEV = Dev()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"READY http://{args.host}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
