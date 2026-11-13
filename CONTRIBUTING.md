# Contributing

Thanks for helping. FlightSeal is a small reference format and tool, so the most useful contributions are careful
ones.

## Ways to help

- **Try it on your own flight logs** and open an issue if the converter or a verdict looks wrong. Say which
  autopilot and log format you used. Please don't attach logs that you are not allowed to share.
- **Break it.** A change after sealing that verification misses, or a hostile file that crashes the CLI or the page,
  is the most valuable report. See [SECURITY.md](SECURITY.md) for how to report one privately.
- **Write another reader.** The format is described in the README ("How it works"). A reader in another language that
  agrees with the CLI on the samples is a useful cross-check.

## Setting up

```bash
sudo apt-get install cmake g++ libssl-dev libsqlite3-dev
pip install pyulog pytest pyyaml
cmake -S . -B build && cmake --build build -j
ctest --test-dir build --output-on-failure    # C++ tests, --version, cmake --install
python -m pytest -q                            # CLI, Python reader, real PX4 flight, release checks
node --test tests/web/verifier.test.mjs tests/web/copy.test.mjs
(cd tests/web && npm ci && npx playwright install chromium) && node tests/web/e2e.mjs
```

CI also builds with AddressSanitizer and UBSan (`-DFSEAL_SANITIZE=ON -DCMAKE_BUILD_TYPE=Debug`).

## Before you open a pull request

- A new behaviour or a fix comes with a test that fails without it.
- The format and the verdicts are shared by three readers (C++, Python, JavaScript). If you change one, change all
  three and the tests that compare them, and say so in the pull request: it changes what a sealed log means.
- If you change the samples, regenerate them with `tools/make_web_samples.py`.
- Keep the README's limits on the README and the page (`tests/web/copy.test.mjs` checks them), and don't add
  numbers that were not measured.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under a `## Unreleased` heading at the top (start one if there is none).
- The verifier page needs 0 axe-core violations in light and dark, at 1280 and 375 px (`tests/web/e2e.mjs`).

## Reporting a problem

Open an issue. Say what you did, what you expected and what happened, and include `fseal --version` and the output
of `fseal verify`.
