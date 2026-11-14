"""Prove public receipt exceptions still report a credential in the same file."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="fseal-secret-check-") as directory:
    target = Path(directory)
    public_lines = (root / "docs/samples/flight.receipts").read_text()
    report = target / "report.json"

    def scan():
        result = subprocess.run(
            [binary, "dir", ".", "--config", str(root / ".gitleaks.toml"),
             "--redact=100", "--report-format", "json", "--report-path", str(report), "--no-banner"],
            cwd=target, capture_output=True, text=True, timeout=30,
        )
        if result.returncode not in (0, 1):
            raise SystemExit("Gitleaks could not run the receipt exception check")
        return result.returncode, json.loads(report.read_text())

    synthetic = hashlib.sha256(b"negative scanner fixture; not an issued credential").hexdigest()
    for path in ("docs/samples/flight.receipts", "dist/static/flightseal/samples/flight.receipts"):
        fixture = target / path
        fixture.parent.mkdir(parents=True)
        fixture.write_text(public_lines)
        code, findings = scan()
        assert code == 0 and not findings, "Public receipt fixture should be allowed"
        fixture.write_text(public_lines + '\napi_key = "' + synthetic + '"\n')
        report.unlink()
        code, findings = scan()
        assert code == 1 and len(findings) == 1, "A credential-shaped line must still be detected"
        assert findings[0]["RuleID"] == "generic-api-key"
        assert findings[0]["StartLine"] > len(public_lines.splitlines())
        fixture.unlink()
        report.unlink()
print("Source/packaged public receipts allowed; credential-shaped lines in both files detected")
