#!/usr/bin/env bash
# Builds the Linux x86_64 release binary, runs the tests, checks the binary in a clean ubuntu:24.04 container
# against the samples, and writes the binary and its SHA-256 file to OUT_DIR.
#   tools/release_build.sh OUT_DIR
# CI runs this on every push as a dry run; the release workflow (v* tags only) runs it and attaches the files.
# FSEAL_SKIP_CONTAINER=1 skips the container step (for machines without a Docker daemon) and says so.
set -euo pipefail
OUT=$(mkdir -p "${1:?usage: release_build.sh OUT_DIR}" && cd "$1" && pwd)
cd "$(dirname "$0")/.."
NAME=fseal-linux-x86_64

[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { echo "this builds the Linux x86_64 binary; run it on Linux x86_64" >&2; exit 2; }
cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release
cmake --build build-release -j "$(nproc)"
ctest --test-dir build-release --output-on-failure
install -m 755 build-release/fseal "$OUT/$NAME"

# The release notes say the binary is dynamically linked against OpenSSL 3: check that is still true.
echo "--- shared libraries:"
ldd "$OUT/$NAME"
ldd "$OUT/$NAME" | grep -q 'libcrypto\.so\.3 ' || { echo "expected a dynamic link to OpenSSL 3 (libcrypto.so.3)" >&2; exit 1; }

if [ "${FSEAL_SKIP_CONTAINER:-0}" = 1 ]; then
  echo "--- SKIPPED: clean ubuntu:24.04 container check (FSEAL_SKIP_CONTAINER=1); running the checks on this host instead"
  tools/release_smoke.sh "$OUT/$NAME"
else
  echo "--- clean ubuntu:24.04 container, with only the OpenSSL 3 runtime library added:"
  docker run --rm -v "$PWD:/src:ro" -v "$OUT:/out:ro" -w /src ubuntu:24.04 bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends libssl3t64 >/dev/null
    tools/release_smoke.sh /out/'"$NAME"
fi

(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" && sha256sum -c "$NAME.sha256")
echo "--- wrote $OUT/$NAME and $OUT/$NAME.sha256"
