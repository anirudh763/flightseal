"""tools/manifest.py: streaming digest parity with openssl, published vectors, check statuses, and a round trip
through the real C++ CLI. FSEAL_LARGE_HASH=1 adds a sparse > 2 GiB file (run locally; it reports seconds and
the child's peak RSS)."""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "manifest.py"
FIXTURES = ROOT / "tests" / "fixtures" / "manifest"
FSEAL = Path(os.environ.get("FSEAL_BIN", ROOT / "build" / "fseal"))
MiB = 1 << 20
sys.path.insert(0, str(ROOT / "tools"))
import fseal_py  # noqa: E402
import manifest  # noqa: E402


def tool(*args, stdin=None):
    return subprocess.run([sys.executable, str(TOOL), *map(str, args)], input=stdin, capture_output=True)


def openssl(path):
    if not shutil.which("openssl"):
        pytest.skip("openssl not on PATH")
    out = subprocess.run(["openssl", "dgst", "-sha256", "-r", str(path)], capture_output=True, text=True, check=True)
    return out.stdout.split()[0]


@pytest.mark.parametrize("size", [0, 1, 4 * MiB - 1, 4 * MiB, 4 * MiB + 1, 46 * MiB])
def test_digest_matches_openssl(tmp_path, size):
    p = tmp_path / "f.bin"
    p.write_bytes(os.urandom(size))
    r = tool("digest", p)
    assert r.returncode == 0, r.stderr
    assert r.stdout.decode().strip() == openssl(p)
    assert manifest.digest(p) == (size, openssl(p))


@pytest.mark.parametrize("name", ["basic", "minimal"])
def test_fixtures(name):
    spec = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    payload = (FIXTURES / f"{name}.payload").read_bytes()
    items = [(i["bytes"], i["sha256"], i["name"], i["note"]) for i in spec["items"]]
    assert manifest.encode(spec["salt"], items) == payload
    salt, parsed = manifest.parse(payload)
    assert salt == spec["salt"]
    assert [(i["bytes"], i["sha256"], i["name"], i["note"]) for i in parsed] == items
    assert fseal_py.link(bytes(32), 0, 0, payload).hex() == (FIXTURES / f"{name}.head").read_text().strip()


def test_strict_parse_and_limits():
    d, s = "a" * 64, "b" * 64
    good = f"hashwing-manifest v1 salt={s} items=1 item=1,3,{d},a%C3%A9,"
    assert manifest.parse(good.encode())[1][0]["name"] == "aé"
    for bad in [good.replace("%C3%A9", "%c3%a9"), good.replace("a%C3", "%61%C3"), good.replace(",3,", ",03,"),
                good + " ", good.replace("items=1", "items=2"), good.replace("a%C3%A9", "%FF"), good.replace("a%C3%A9", "%C3")]:
        with pytest.raises((ValueError, TypeError)):
            manifest.parse(bad.encode())
    with pytest.raises(ValueError):
        manifest.encode(s, [])
    with pytest.raises(ValueError):
        manifest.encode(s, [(3, d, "", "")] * 101)
    with pytest.raises(ValueError):
        manifest.encode(s, [(3, d, "", "€" * 333)] * 100)
    with pytest.raises(ValueError):
        manifest.encode(s, [(3, d, "é" * 128, "")])
    with pytest.raises(ValueError):
        manifest.encode(s, [(3, d, "", "a" * 1001)])
    with pytest.raises(TypeError):
        manifest.encode(s, [(3, d, "a\udc80", "")])


def test_base_name_matches_browser_file_name():
    for path, name in [("a/b.mp4", "b.mp4"), ("a\\b.mp4", "b.mp4"), ("dir/x\\y.bin", "y.bin"), ("plain.ulg", "plain.ulg")]:
        assert manifest.base_name(path) == name


def _seal(tmp_path, lines):
    if not FSEAL.exists():
        pytest.skip(f"{FSEAL} not built")
    key, log, rec = tmp_path / "k.pem", tmp_path / "m.manifest.fseal", tmp_path / "m.receipts"
    pub = subprocess.run([str(FSEAL), "keygen", str(key)], capture_output=True, text=True, check=True).stdout.strip()
    subprocess.run([str(FSEAL), "append", str(log), "--key", str(key), "--receipts", str(rec), "--every", "1"], input=lines, check=True)
    return log, rec, pub


def test_round_trip_and_check_statuses(tmp_path):
    a, b, c, gone = (tmp_path / n for n in ("a.mp4", "b.mp4", "noname.bin", "gone.mp4"))
    a.write_bytes(b"alpha" * 1000)
    b.write_bytes(b"bravo" * 1000)
    c.write_bytes(b"charlie")
    gone.write_bytes(b"delta")
    created = tool("create", "--include-names", "--note", "1=camera A", a, b, c, gone)
    assert created.returncode == 0, created.stderr
    assert created.stdout.startswith(b"0\thashwing-manifest v1 salt=") and created.stdout.count(b"\n") == 1
    log, rec, pub = _seal(tmp_path, created.stdout)
    v = subprocess.run([str(FSEAL), "verify", str(log), "--receipts", str(rec), "--pubkey", pub], capture_output=True, text=True)
    assert v.returncode == 0 and "RESULT: INTACT" in v.stdout
    assert rec.read_text().count("count=1 ") == 1

    ok = tool("check", log, a, b, c, gone)
    assert ok.returncode == 0, ok.stdout
    assert ok.stdout.decode().count(": Matches:") == 4
    assert "does not check the receipt signature" in ok.stdout.decode()

    b.write_bytes(b"bravo" * 999 + b"BRAVO")  # same name, different bytes
    extra = tmp_path / "extra.bin"
    extra.write_bytes(b"x")
    out = tool("check", log, b, a, extra)
    text = out.stdout.decode()
    assert out.returncode == 1
    assert "item 1: Matches: a.mp4" in text
    assert "item 2: Bytes differ: b.mp4" in text
    assert "item 3: Missing" in text and "item 4: Missing: gone.mp4" in text
    assert f"Not in manifest: {extra}" in text

    log.write_bytes(log.read_bytes() + b"junk")
    bad = tool("check", log, a)
    assert bad.returncode != 0 and b"exactly one record" in bad.stderr


@pytest.mark.skipif(os.environ.get("FSEAL_LARGE_HASH") != "1", reason="set FSEAL_LARGE_HASH=1 to hash a sparse > 2 GiB file")
def test_large_sparse_file(tmp_path):
    size = (1 << 31) + 5 * MiB + 7
    p = tmp_path / "large.bin"
    with open(p, "wb") as f:
        f.truncate(size)
        for at in ((1 << 31) - 1, 1 << 31, size - 1):
            f.seek(at)
            f.write(b"\x5a")
    # The child reports its own peak RSS, so earlier children of this pytest process cannot inflate it.
    probe = ("import resource,runpy,sys; sys.argv=['manifest.py','digest',sys.argv[1]]\n"
             "try: runpy.run_path(%r, run_name='__main__')\n"
             "except SystemExit: pass\n"
             "print(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)") % str(TOOL)
    start = time.perf_counter()
    r = subprocess.run([sys.executable, "-c", probe, str(p)], capture_output=True, text=True)
    seconds = time.perf_counter() - start
    assert r.returncode == 0, r.stderr
    digest, maxrss = r.stdout.split()
    maxrss_mib = int(maxrss) / MiB if sys.platform == "darwin" else int(maxrss) / 1024  # macOS reports bytes, Linux KiB
    assert digest == openssl(p)
    print(json.dumps({"bytes": size, "seconds": round(seconds, 2), "MiBps": round(size / MiB / seconds, 1), "childMaxRssMiB": round(maxrss_mib, 1)}))
