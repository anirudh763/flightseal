---
name: wasm-edge-case-qa
description: Verify C++/OpenSSL/Wasm flight-log verification and sealing with reproducible real-engine edge cases and browser evidence.
---

# Domain acceptance

Use the exact repository engine, published fixtures and existing tests. Add reproducible cases for the following; record pass/fail/untested, versions and evidence for each.

1. Default 800-record synthetic demo: actual native result, counts and receipt coverage.
2. Small 2,422-record PX4 example: native result agrees with published fixture.
3. Full 64,542-record/28.9MiB PX4 example: native worker/streaming file access, bounded index, responsive UI and cancel; no full-sample automatic precache.
4. Single payload-byte flip: identify the real first failure; state whether CRC was recomputed.
5. Middle-record deletion: native sequence failure at the real boundary.
6. Torn final write: distinguish chain-only incomplete from a valid receipt proving a missing suffix; no automatic repair of originals.
7. Timestamp reversal: report the native reversal count; do not falsely label a valid hash chain as tampered just because a timestamp moved backward.
8. Malformed/non-log upload: explicit native parse failure, no stale positive result, clear retry with a valid file.
9. Custom timestamp<TAB>payload sealing with configurable receipt interval: actual native Writer/signatures, output downloads and re-verification, invalid intervals/rows rejected.

Run the relevant native/Python/Node/browser checks and inspect 320/768/1440 UI states. Zero errors/leaks means none observed in the named finite run, not a universal guarantee. Preserve meaningful assertion strength; diagnose platform/toolchain differences rather than skipping failing cases. No secrets or user payloads in reports.
