#!/usr/bin/env python3
"""Seal any file byte for byte, and get it back out of a verified log.

  python3 tools/raw_file.py encode flight.ulg | build/fseal append flight.fseal --key drone.pem --receipts flight.receipts --every 1000000
  build/fseal verify flight.fseal --receipts flight.receipts --pubkey <key>      # must print RESULT: INTACT first
  python3 tools/raw_file.py extract flight.fseal restored.ulg

Line format (the same as docs/rawfile.js; the FLTSEAL1 format itself is unchanged):
  0<TAB>flightseal-file v1 name=<percent-encoded name> bytes=<n> sha256=<hex> chunk=<bytes per chunk>
  <byte offset><TAB><base64 of that chunk>
"""
import base64
import hashlib
import os
import re
import struct
import sys
from urllib.parse import quote, unquote

CHUNK = 48 * 1024
MANIFEST = re.compile(r"flightseal-file v1 name=([\x21-\x7e]*) bytes=(\d{1,15}) sha256=([0-9a-f]{64}) chunk=(\d{1,7})", re.ASCII)


def base_name(name):  # same as docs/rawfile.js: either slash separates folders
    return re.split(r"[\\/]", name)[-1] or "flight-log"


def encode(path, out):
    with open(path, "rb") as f:
        data = f.read()  # ponytail: whole file in memory; stream chunks if logs reach several GB
    if not data:
        sys.exit(f"{path}: empty file, nothing to seal")
    # A filename that is not valid UTF-8 gets U+FFFD, as a browser shows it.
    name = quote(base_name(os.path.basename(path)).encode("utf-8", "replace"), safe="-_.!~*'()")  # same as JavaScript encodeURIComponent
    out.write(f"0\tflightseal-file v1 name={name} bytes={len(data)} sha256={hashlib.sha256(data).hexdigest()} chunk={CHUNK}\n".encode())
    for at in range(0, len(data), CHUNK):  # bytes, so Windows never turns \n into \r\n
        out.write(f"{at}\t".encode() + base64.b64encode(data[at:at + CHUNK]) + b"\n")


def extract(log_path):
    """Returns (name, bytes) or raises ValueError. Only use on a log that verified as intact."""
    with open(log_path, "rb") as f:
        data = f.read()
    if data[:8] != b"FLTSEAL1":
        raise ValueError("not a FlightSeal log")
    at, manifest, out = 8, None, bytearray()
    while at + 20 <= len(data):
        length, _seq, ts = struct.unpack_from("<IQQ", data, at)
        if at + 20 + length + 36 > len(data):
            raise ValueError("truncated record")
        payload = data[at + 20:at + 20 + length]
        at += 20 + length + 36
        if manifest is None:
            try:
                manifest = MANIFEST.fullmatch(payload.decode("utf-8")) if ts == 0 else None
                if manifest and re.search(r"%(?![0-9A-Fa-f]{2})", manifest[1]):
                    manifest = None  # JavaScript decodeURIComponent rejects a broken escape too
                name = base_name(unquote(manifest[1], errors="strict")) if manifest else None
            except UnicodeDecodeError:
                manifest = None
            if not manifest:
                raise ValueError("this log does not hold a sealed file")
            if int(manifest[2]) > len(data) or int(manifest[4]) < 1:  # base64 only grows data
                raise ValueError("recorded size is impossible for this log")
            continue
        if ts != len(out):
            raise ValueError(f"chunk at offset {ts} out of place")
        chunk = base64.b64decode(payload, validate=True)
        if not chunk or len(chunk) > int(manifest[4]):
            raise ValueError("bad chunk size")
        if len(chunk) < int(manifest[4]) and len(out) + len(chunk) != int(manifest[2]):
            raise ValueError("only the last chunk may be short")
        out += chunk
    if manifest is None or at != len(data) or len(out) != int(manifest[2]):
        raise ValueError("the parts do not add up to the recorded size")
    if hashlib.sha256(out).hexdigest() != manifest[3]:
        raise ValueError("rebuilt file does not match the recorded SHA-256")
    return name, bytes(out)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "encode":
        encode(sys.argv[2], sys.stdout.buffer)
    elif len(sys.argv) == 4 and sys.argv[1] == "extract":
        try:
            name, body = extract(sys.argv[2])
        except ValueError as e:
            sys.exit(f"{sys.argv[2]}: {e}")
        with open(sys.argv[3], "wb") as f:
            f.write(body)
        print(f"wrote {len(body)} bytes of {name} to {sys.argv[3]}; it matches the SHA-256 recorded inside the log.")
        print("This alone proves nothing: only `fseal verify` with the receipts the witness kept shows the log is unchanged.")
    else:
        sys.exit(__doc__)
