"""Prove public receipt/template exceptions still detect actual credential material."""
import base64
import hashlib
import json
from pathlib import Path
import re
import secrets
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

    marker = '-' * 5
    private_pem = (marker + 'BEGIN PRIVATE KEY' + marker + '\n' +
                   base64.b64encode(bytes.fromhex('302e020100300506032b657004220420') + secrets.token_bytes(32)).decode() +
                   '\n' + marker + 'END PRIVATE KEY' + marker + '\n')
    subprocess.run(['openssl', 'pkey', '-check', '-noout'], input=private_pem,
                   text=True, capture_output=True, check=True, timeout=10)
    paths = [root / 'newweb/src/signing-keys.mjs', *sorted((root / 'docs/console/assets').glob('index-*.js'))]
    templates = []
    for source in paths:
        matches = re.finditer(marker + r'BEGIN PRIVATE KEY' + marker + r'[^`]*?' + marker + 'END PRIVATE KEY' + marker,
                              source.read_text())
        template = next((match[0] for match in matches if '${' in match[0]), None)
        if template is None:
            continue
        templates.append(template)
        fixture = target / source.relative_to(root)
        fixture.parent.mkdir(parents=True, exist_ok=True)
        source_text = source.read_text()
        fixture.write_text(source_text)
        code, findings = scan()
        assert code == 0 and not findings, 'Only the exact dynamic serializer should be allowed'
        # Same physical JS line: a line-wide exception must not hide the literal key.
        fixture.write_text(source_text.replace(template, template + '`;const literal = `' +
                           private_pem.replace('\n', '\\n') + '`;const continued = `', 1))
        report.unlink()
        code, findings = scan()
        assert code == 1 and len(findings) == 1, 'A valid literal private key must still be detected in the same file'
        assert findings[0]['RuleID'] == 'private-key'
        assert findings[0]['File'].removeprefix('./') == str(source.relative_to(root))
        fixture.unlink()
        report.unlink()
    assert len(templates) >= 2, 'Source and built console serializers must both be exercised'

    # Registry wiring test: only the exact runtime expression over the public seed bytes 0..31 is allowed.
    seed_expr = (marker + 'BEGIN PRIVATE KEY' + marker + "\\n${Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), "
                 "Buffer.from([...Array(32).keys()])]).toString('base64')}\\n" + marker + 'END PRIVATE KEY' + marker)
    seed_line = 'const SEED_A_PEM = `' + seed_expr + '\\n`;\n'
    wiring = target / 'newweb/tests/registry-wiring.mjs'
    wiring.parent.mkdir(parents=True, exist_ok=True)
    wiring.write_text(seed_line)
    code, findings = scan()
    assert code == 0 and not findings, 'The exact public-seed fixture expression should be allowed'
    report.unlink()
    for text, why in (
        (seed_line + 'const literal = `' + private_pem.replace('\n', '\\n') + '`;\n', 'a valid literal private key in the same file'),
        (seed_line.replace('Array(32).keys()', 'Array(32).fill(7)'), 'a changed fixture expression'),
    ):
        wiring.write_text(text)
        code, findings = scan()
        assert code == 1 and len(findings) == 1 and findings[0]['RuleID'] == 'private-key', f'{why} must still be detected'
        report.unlink()
    wiring.unlink()
    elsewhere = target / 'newweb/tests/other.mjs'
    elsewhere.write_text(seed_line)
    code, findings = scan()
    assert code == 1 and len(findings) == 1 and findings[0]['RuleID'] == 'private-key', 'The fixture exception must stay path-scoped'
    elsewhere.unlink()
    report.unlink()
    unrelated = target / 'unrelated.js'
    unrelated.write_text((root / 'newweb/src/signing-keys.mjs').read_text())
    code, findings = scan()
    assert code == 1 and len(findings) == 1 and findings[0]['RuleID'] == 'private-key', 'The template exception must stay path-scoped'
print('Public receipts, exact serializers and the wiring test seed fixture allowed; API-shaped values, valid literal private keys in both paths, and unrelated paths detected')
