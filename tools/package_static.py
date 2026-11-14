"""Package the existing Pages paths for static hosting without provisioning resources."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
target = root / "dist/static"
if not (root / "docs/console/index.html").is_file():
    raise SystemExit("Build the console first: npm --prefix newweb run build")
target.mkdir(parents=True, exist_ok=True)
application = target / "flightseal"
if application.exists():
    shutil.rmtree(application)
shutil.copytree(root / "docs", application, ignore=shutil.ignore_patterns(".DS_Store"))
(target / "index.html").write_text(
    '<!doctype html><html lang="en"><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width">'
    '<meta http-equiv="refresh" content="0;url=/flightseal/console/">'
    '<title>FlightSeal</title><a href="/flightseal/console/">Open FlightSeal</a></html>\n'
)
shutil.copyfile(root / "customHttp.yml", target / "customHttp.yml")
print(f"Static hosting artifact: {target}; this command creates no cloud resources")
