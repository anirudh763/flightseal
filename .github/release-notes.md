`fseal-linux-x86_64` is the `fseal` command-line tool for Linux on x86_64, built on Ubuntu 24.04 by the release
workflow. It passed the C++ tests, then checked the shipped samples (intact, tampered, rewritten, truncated) and a
fresh seal-and-verify in a clean `ubuntu:24.04` container.

- The binary is **dynamically linked and needs OpenSSL 3** (`libcrypto.so.3`). On Ubuntu 24.04:
  `sudo apt-get install libssl3t64`. On other systems install OpenSSL 3, or build from source (see the README).
- Check the download: `sha256sum -c fseal-linux-x86_64.sha256`, then `chmod +x fseal-linux-x86_64`.
- What changed is in [CHANGELOG.md](https://github.com/anirudh763/flightseal/blob/main/CHANGELOG.md). What a pass does and does not prove is in the README and
  THREAT_MODEL.md.
