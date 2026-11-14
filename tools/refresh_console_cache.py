"""List only the console shell/assets for offline use; never precache large examples."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
docs = root / "docs"
console = docs / "console"
files = [console / "index.html"] + sorted((console / "assets").rglob("*"))
files = [path for path in files if path.is_file()]
if not files or not (console / "index.html").is_file():
    raise SystemExit("Build the console before creating its cache manifest")
manifest = {
    "files": ["console/"] + [path.relative_to(docs).as_posix() for path in files],
    "sha256": {path.relative_to(docs).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
}
(console / "precache.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Offline manifest: {len(files)} console assets; full PX4 example excluded")
