"""Downloads the public PX4 sample flight log used by the tests and the demo.

The file comes from the PX4/pyulog repository (BSD-3-Clause), pinned by commit and SHA-256, and is
not stored in this repository.
"""
import hashlib
import sys
import urllib.request
from pathlib import Path

URL = "https://raw.githubusercontent.com/PX4/pyulog/0b392f8444f843b796405b9766cc15a6dddedf62/test/sample.ulg"
SHA256 = "81952e6059bc095717e7911c010e07f85749d6b04d332a5ffc51575a3fd0a558"


def fetch(folder) -> Path:
    path = Path(folder) / "px4-sample.ulg"
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == SHA256:
        return path
    data = urllib.request.urlopen(URL, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise SystemExit("downloaded sample does not match the pinned SHA-256")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


if __name__ == "__main__":
    print(fetch(sys.argv[1] if len(sys.argv) > 1 else "."))
