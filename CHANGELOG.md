# Changelog

## Unreleased

### Verifier page: light rebuild with separate screens

The file format, the C++ core and every verdict are unchanged; `docs/verifier.js` is unchanged.

- Screens with their own hash addresses: Verify a file, Findings, Records (`#/records/N`), Receipts
  (`#/receipts/N`), Trust help, Examples, and Not found for unknown addresses. Old `?sample=...&record=N` links open
  the same view. Findings, Records and Receipts show an empty state with the Verify action until a file is checked.
- Evidence chain: records drawn as a vertical hash chain with the first break, the end of the covered prefix and
  each receipt marked on it in words.
- A real PX4 flight example (1,650 records selected from the pyulog sample log, BSD-3-Clause) and a tampered copy,
  made by `tools/make_px4_samples.py`.
- Light by default, also under an OS dark preference; dark only through the "Dark theme" button. FlightSeal primary
  #174b5a, 16px text, 44px controls, a 216px rail on wide screens and a Menu sheet below 1000px.
- Service worker cache version 0.1.0-3-ui (adds theme.js and the PX4 examples). CSP unchanged.
- tests/web/routes.mjs: 24 checks for the screens (23 of them fail on the previous page).

## 0.1.0 – 2026-11-13

First tagged version. The file format (`FLTSEAL1`, receipt `v1`) and every verdict are the ones described in the
README; nothing in this list changes them.

### Usability

- `fseal --help` and `fseal --version` print to stdout and exit 0. Usage errors still print to stderr and exit 2.
- CMake project version 0.1.0 and an install rule: `cmake --install build --prefix ~/.local` installs `bin/fseal`.
  ctest checks `fseal --version`, and that an installed `fseal` verifies the samples exactly as the build tree does.
- `FSEAL_VERSION` in `src/fseal.h`; a test checks it matches CMakeLists.txt, `fseal --version` and this file.
- A release workflow that runs only on `v*` tags: it builds the Linux x86_64 binary, runs the tests, checks the
  samples in a clean `ubuntu:24.04` container, and attaches the binary and a SHA-256 file. Only its publishing job
  can write to the repository. CI runs the same build and container check on every push as a dry run.
- Verifier page: the file pickers show the loaded sample's name instead of the browser's "No file chosen", the
  public-key advice appears once, an SVG favicon, and a message when JavaScript is off.
- README: the first line says what this is (a seal applied after download and a reference format), and two
  sentences that claimed more than the evidence shows are reworded (see the pull request).
- SECURITY.md (maintenance status, how to report, scope), CONTRIBUTING.md and two issue templates.
- Verifier page: works offline after one visit and can be installed (web app manifest, SVG and PNG icons, a
  service worker with a versioned cache, network first). Files you check are never cached.

### Fixes from a second review

- Verifier page: Cancel now stops the receipt checks, and no verdict is shown after Cancel. Before, all receipts
  were still checked and the verdict appeared anyway.
- Verifier page: a receipt count with more than 20 significant digits is rejected before it is converted, so a
  crafted receipts file can no longer block the page for seconds. Leading zeros are still accepted, as in the CLI.
- CLI and page: "log is shorter than the receipt" now also says the receipts may belong to another log sealed with
  the same key, as the head-mismatch message already did.

### Audit fixes (before this version)

- `recover` and `append` trimmed complete records after one corrupted length field; now reported as corruption and
  left in place.
- `verify` ignored a misspelt `--receipt`, a lone `--pubkey` or an empty receipts file and printed INTACT; now exit 2.
- `append` could leave sealed records without a receipt when the key was missing or a line was bad.
- Receipts from another log sealed with the same key were called a rewrite; the message now names both causes.
- Verifier page: keyboard focus on the records table after paging.

### First version

- C++17 library and `fseal` CLI (`keygen`, `append`, `verify`, `recover`): CRC-32 per record, SHA-256 hash chain,
  Ed25519-signed receipts, crash recovery that trims only a torn final record.
- An independent Python reader, a tamper simulator and a PX4 ULog converter (`tools/`).
- A browser verifier on GitHub Pages (`docs/`), cross-checked against the CLI and the Python reader.
- Tests under AddressSanitizer and UBSan, kill -9 crash tests, a demo on a public PX4 flight, and an ingest
  benchmark against SQLite.
