# Proposed README additions (for the conductor to merge)

Suggested placement: a new section right after "See it work", plus one bullet under "Tests" and one under
"Quick start". The URL assumes GitHub Pages is enabled on `main`, folder `/docs`.

---

## Check a log in your browser

**[Open the verifier](https://anirudh763.github.io/flightseal/)**: drop a sealed log, and optionally its receipts and
the public key you trust. Verification runs in the page with your browser's WebCrypto (SHA-256, Ed25519); the files
are read locally and never uploaded.

![The verifier on the tampered sample: the chain breaks at record 150, expected and stored link side by side](docs/screenshots/verifier-tampered.png)

- It opens on a built-in sample with one altitude changed by 10 m, and shows the first record where the chain
  breaks, the expected and the stored link, and a paged list of every record checked.
- Three more samples: the intact log, a full rewrite that only the receipts catch, and a log with its last 150
  records deleted that only the receipts catch. They are a synthetic 8-second flight (800 records) sealed by the
  real CLI with [`tools/make_web_samples.py`](tools/make_web_samples.py).
- A hash chain pinpoints the first record where the chain breaks, not every altered record. Truncation of the tail
  is only caught with receipts, and the page says so when none are loaded.
- If the browser's WebCrypto has no Ed25519, the page says the receipt signatures were not checked and still
  verifies the chain.
- The verifier ([docs/verifier.js](docs/verifier.js)) is about 400 lines of plain JavaScript with no dependencies
  and no build step. On the 64,542-record PX4 flight it took 1.4 to 3.8 s in Node 22 on the 2-vCPU benchmark VM
  (5 runs); browser timing was not measured.

## Tests (additional bullet)

- **JavaScript** ([tests/web/verifier.test.mjs](tests/web/verifier.test.mjs)): a third reader, the browser
  verifier, must print exactly the same report as `fseal verify`, and find the same problem, record and head as the
  Python reader. It is checked on the 7 attacks above (with and without receipts), a full rewrite, a deleted tail,
  receipts from another key, an altered signature and count, 13 hostile files (impossible lengths, a torn header,
  64-bit sequence numbers, random bytes), 8 malformed receipt files, the shipped samples and the real PX4 flight:
  67 tests. Each of 8 deliberate bugs in the verifier (skipping the CRC, sequence, key or truncation check, among
  others) made at least one of them fail.
- **Browser** ([tests/web/e2e.mjs](tests/web/e2e.mjs), Playwright): the page shows the same broken record and
  receipt as the CLI for every sample, survives hostile files, and passes automated axe-core checks with 0
  violations in light and dark themes, with no horizontal scrolling at 320 px wide.

## Quick start (additional lines)

```
FSEAL_BIN=build/fseal node --test tests/web/verifier.test.mjs   # JS verifier against the CLI and Python reader
cd tests/web && npm ci && npx playwright install chromium && cd ../..
node tests/web/e2e.mjs                                          # the page, with axe-core
python3 tools/make_web_samples.py                               # rebuild docs/samples with the CLI
```

## Security notes (new short section, or append to THREAT_MODEL.md)

Scanned with semgrep (rule packs from semgrep/semgrep-rules for C, JavaScript, Python, HTML, Bash, GitHub Actions
and secrets), `npm audit` (0 vulnerabilities) and the existing AddressSanitizer/UBSan build; the parsing code was read
by hand for hostile input. No high-severity findings. Fixed:

- `parse_line()` threw `std::out_of_range` on a receipt count above 2^64-1 instead of returning false (the CLI
  caught it and printed `fseal: stoull`). It now rejects the line, and the CLI reports `FILE:N: not a receipt`.
- `scan()` and `recover()` threw when the path could not be read (for example a directory) instead of returning
  `IoError`.
- The CI workflow pins its GitHub Actions to commit SHAs and has read-only permissions.

The browser page treats dropped files as hostile: it reads the log in 16 MB slices, never trusts a length field
over 1 MiB, caps receipts files at 16 MB and the table index at 2,000,000 records, shows file contents only as
text, and ships a Content-Security-Policy that allows no inline script and no network access beyond the page's
own files.
