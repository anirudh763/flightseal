# Security policy

## Maintenance status

Beta, maintained by one student, on a best-effort basis. There is no bug bounty and no guaranteed response time.
Version 0.1.0 is a reference implementation of the format; it has not been used in a real investigation, and no user
or field validation has been done.

## Supported versions

Only the latest tagged version and `main` get fixes.

## How to report

- For a way to make `fseal verify` or the browser verifier report INTACT for a log that was changed, or to forge or
  replay a receipt, report it privately: open the repository's **Security** tab and choose **Report a
  vulnerability** ([direct link](https://github.com/anirudh763/flightseal/security/advisories/new)). Only if that
  button is missing for you, open an issue that says only "security report, please get in touch", without the
  details.
- Include the commit or version (`fseal --version`), the exact commands, and the files needed to reproduce it (a
  small log made with `fseal append` is best).
- Replies are best effort. Fixes go in a pull request with a test that fails before the fix, and the CHANGELOG names
  what was fixed.
- Please don't send reports by email or post the details publicly before a fix.

## Supported scope (in)

- The file format and its checks: the C++ library and CLI (`src/`), the browser verifier (`docs/`), and the
  independent Python reader (`tools/fseal_py.py`).
- Verification giving the wrong verdict: a change after sealing that is not caught when it should be (see the table
  in the README), or an honest log reported as tampered.
- Hostile input: a log, receipts file or key that crashes or hangs the CLI or the page, reads out of bounds, or runs
  code. The page should never send a file anywhere.
- `fseal recover` deleting anything other than a torn final record.
- The CI and release workflows (`.github/workflows/`).

## Out of scope

These are documented limits, not vulnerabilities (the full list is in [THREAT_MODEL.md](THREAT_MODEL.md)):

- Data that was false when it was sealed (spoofed sensors, edits before sealing).
- Records written after the last receipt.
- A leaked signing key together with a compromised receipt holder.
- A whole log rebuilt by its holder and checked without receipts (Attack 2 in the README).
- The PX4 converter not preserving every byte of the original `.ulg` file.
- Platforms other than Linux x86_64 for the release binary, and OpenSSL itself (report OpenSSL bugs to OpenSSL).
