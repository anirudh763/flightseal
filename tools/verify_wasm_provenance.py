"""Reject stale or altered shipped native modules before release."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
provenance = json.loads((root / "docs/wasm/provenance.json").read_text())
for name, expected in provenance["sha256"].items():
    actual = hashlib.sha256((root / name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"Stale WebAssembly provenance: {name}; rebuild with scripts/build_wasm.sh")
print(f"Verified {len(provenance['sha256'])} WebAssembly source/artifact hashes")
