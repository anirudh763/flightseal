#!/usr/bin/env python3
"""Seal a list of large files (sizes and SHA-256 digests) instead of the files themselves.

  python3 tools/manifest.py digest FILE
  python3 tools/manifest.py create [--salt HEX] [--include-names] [--note N=TEXT]... FILE... \\
      | build/fseal append videos.manifest.fseal --key drone.pem --receipts videos.receipts --every 1
  build/fseal verify videos.manifest.fseal --receipts videos.receipts --pubkey <trusted key>   # must print RESULT: INTACT
  python3 tools/manifest.py check videos.manifest.fseal FILE...

Payload (the same bytes as docs/manifest.mjs; see docs/MANIFEST_MODE.md):
  hashwing-manifest v1 salt=<64 hex> items=<n> item=<i>,<bytes>,<sha256>,<name>,<note> ...
A manifest is not a backup: the originals stay on your storage.
"""
import hashlib
import os
import re
import secrets
import sys
from urllib.parse import quote, unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fseal_py  # noqa: E402

CHUNK = 4 << 20
MAX_ITEMS, MAX_PAYLOAD, MAX_NAME, MAX_NOTE = 100, 65536, 255, 1000
SAFE = "-_.!~*'()"  # same as JavaScript encodeURIComponent
FIELD = r"[A-Za-z0-9%\-_.!~*'()]*"
HEAD = re.compile(r"hashwing-manifest v1 salt=([0-9a-f]{64}) items=([1-9][0-9]{0,2})((?: item=[^ ]*)*)", re.ASCII)
ITEM = re.compile(rf"([1-9][0-9]{{0,2}}),(0|[1-9][0-9]{{0,14}}),([0-9a-f]{{64}}),({FIELD}),({FIELD})", re.ASCII)
STATUS = {"match": "Matches", "bytes-differ": "Bytes differ", "missing": "Missing", "not-in-manifest": "Not in manifest"}


def base_name(path):
    """The platform's file name, as a browser File.name gives it: on macOS and Linux only `/` separates folders and a
    backslash is part of the name; on Windows either slash does."""
    return os.path.basename(path)


def digest(path):
    """Streaming SHA-256 of the file's bytes in order; memory stays at one 4 MiB buffer."""
    h, buf, size = hashlib.sha256(), bytearray(CHUNK), 0
    view = memoryview(buf)
    with open(path, "rb", buffering=0) as f:
        while n := f.readinto(buf):
            h.update(view[:n])
            size += n
    return size, h.hexdigest()


def _encode_text(value, label, limit):
    try:
        raw = value.encode("utf-8")  # a lone surrogate (e.g. an undecodable file name) is rejected here
    except UnicodeEncodeError:
        raise TypeError(f"{label} is not valid UTF-8")
    if len(raw) > limit:
        raise ValueError(f"{label} exceeds {limit} UTF-8 bytes")
    return quote(raw, safe=SAFE)


def encode(salt, items):
    """items: [(bytes, sha256, name, note)]. Returns the payload bytes."""
    if not re.fullmatch(r"[0-9a-f]{64}", salt or ""):
        raise TypeError("salt must be 64 lowercase hexadecimal digits")
    if not 1 <= len(items) <= MAX_ITEMS:
        raise ValueError(f"a manifest holds 1 to {MAX_ITEMS} files")
    parts = [f"hashwing-manifest v1 salt={salt} items={len(items)}"]
    for i, (size, sha, name, note) in enumerate(items, 1):
        if not 0 <= size <= 999_999_999_999_999:
            raise ValueError(f"file {i}: size out of range")
        name = _encode_text(name or "", f"file {i} name", MAX_NAME)
        note = _encode_text(note or "", f"file {i} note", MAX_NOTE)
        parts.append(f"item={i},{size},{sha},{name},{note}")
    payload = " ".join(parts).encode("ascii")
    if len(payload) > MAX_PAYLOAD:
        raise ValueError(f"manifest exceeds {MAX_PAYLOAD} bytes")
    return payload


def _decode_text(encoded, label, limit):
    try:
        value = unquote(encoded, errors="strict")
    except UnicodeDecodeError:
        raise TypeError(f"{label} is not valid percent-encoded UTF-8")
    if quote(value.encode("utf-8"), safe=SAFE) != encoded:  # unquote is lenient; demand the canonical form
        raise TypeError(f"{label} is not in canonical form")
    if len(value.encode("utf-8")) > limit:
        raise ValueError(f"{label} exceeds {limit} UTF-8 bytes")
    return value


def parse(payload):
    """Strict: only the exact bytes encode() writes. Returns (salt, [dict(id, bytes, sha256, name, note)])."""
    if len(payload) > MAX_PAYLOAD or any(b < 0x20 or b > 0x7E for b in payload):
        raise ValueError("not a manifest payload")
    m = HEAD.fullmatch(payload.decode("ascii"))
    if not m:
        raise ValueError("not a hashwing-manifest v1 payload")
    fields = m[3][len(" item="):].split(" item=") if m[3] else []
    if len(fields) != int(m[2]) or len(fields) > MAX_ITEMS:
        raise ValueError("manifest item count does not match its items")
    items = []
    for i, field in enumerate(fields, 1):
        f = ITEM.fullmatch(field)
        if not f or int(f[1]) != i:
            raise ValueError(f"manifest item {i} is malformed")
        items.append({"id": i, "bytes": int(f[2]), "sha256": f[3],
                      "name": _decode_text(f[4], f"item {i} name", MAX_NAME),
                      "note": _decode_text(f[5], f"item {i} note", MAX_NOTE)})
    return m[1], items


def compare(items, locals_):
    """Same pairing rule as compareFiles in docs/manifest.mjs. locals_: [(name, bytes, sha256)] in order."""
    status, paired, pending, extras = {}, {}, [], []
    for li, (_name, size, sha) in enumerate(locals_):
        it = next((it for it in items if it["id"] not in status and it["bytes"] == size and it["sha256"] == sha), None)
        if it:
            status[it["id"]], paired[it["id"]] = "match", li
        else:
            pending.append(li)
    for li in pending:
        it = next((it for it in items if it["id"] not in status and it["name"] and it["name"] == locals_[li][0]), None)
        if it:
            status[it["id"]], paired[it["id"]] = "bytes-differ", li
        else:
            extras.append(li)
    return {it["id"]: status.get(it["id"], "missing") for it in items}, paired, extras


def read_sealed(path):
    """Payload of record 0 of a one-record log. Does NOT check receipts or signatures."""
    if os.path.getsize(path) > 8 + 20 + MAX_PAYLOAD + 36:
        raise ValueError("too large to be a sealed manifest")
    s = fseal_py.scan(path)
    if s.problem or s.records != 1 or os.path.getsize(path) != 8 + 20 + len(s.items[0].payload) + 36:
        raise ValueError("a sealed manifest must be an intact log with exactly one record")
    if s.items[0].seq != 0 or s.items[0].timestamp_us != 0:
        raise ValueError("the manifest record is not in the expected form")
    return s.items[0].payload


def main(argv):
    if len(argv) == 2 and argv[0] == "digest":
        print(digest(argv[1])[1])
        return 0
    if argv and argv[0] == "create":
        salt, names, notes, files, args = None, False, {}, [], iter(argv[1:])
        for a in args:
            if a == "--salt":
                salt = next(args, None)
            elif a == "--include-names":
                names = True
            elif a == "--note":
                n, _, text = (next(args, None) or "").partition("=")
                if not n.isdigit():
                    sys.exit("--note needs N=TEXT, N being the 1-based file position")
                notes[int(n)] = text
            else:
                files.append(a)
        if not files or any(n < 1 or n > len(files) for n in notes):
            sys.exit(__doc__)
        items = []
        for i, path in enumerate(files, 1):
            size, sha = digest(path)
            items.append((size, sha, base_name(path) if names else "", notes.get(i, "")))
        try:
            payload = encode(salt or secrets.token_hex(32), items)
        except (TypeError, ValueError) as e:
            sys.exit(str(e))
        sys.stdout.buffer.write(b"0\t" + payload + b"\n")
        return 0
    if len(argv) >= 2 and argv[0] == "check":
        try:
            _salt, items = parse(read_sealed(argv[1]))
        except (OSError, ValueError, TypeError) as e:
            sys.exit(f"{argv[1]}: {e}")
        locals_ = [(base_name(p), *digest(p)) for p in argv[2:]]
        status, paired, extras = compare(items, locals_)
        for it in items:
            label = it["name"] or "(name not included)"
            local = f" <- {argv[2:][paired[it['id']]]}" if it["id"] in paired else ""
            print(f"item {it['id']}: {STATUS[status[it['id']]]}: {label}, {it['bytes']} bytes{local}")
        for li in extras:
            print(f"{STATUS['not-in-manifest']}: {argv[2:][li]}")
        print("This does not check the receipt signature: run `fseal verify` with the receipt and the trusted key first.")
        return 0 if not extras and all(s == "match" for s in status.values()) else 1
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
