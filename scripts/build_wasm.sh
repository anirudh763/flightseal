#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
build_dir=${FSEAL_WASM_BUILD_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/flightseal-wasm.XXXXXX")}
image=emscripten/emsdk:4.0.23@sha256:86537645c51e44899812d29820ee3b64b96c321ebb2aba4416a04ceeb1bcde62
mkdir -p "$build_dir" "$repo_dir/docs/wasm"
docker run --rm --mount "type=bind,source=$repo_dir,target=/src" --mount "type=bind,source=$build_dir,target=/build" "$image" bash /src/scripts/build_wasm_inner.sh
python3 - "$repo_dir" "$image" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
files=['src/fseal.cpp','src/fseal.h','wasm/bridge.cpp','CMakeLists.txt','wasm/CMakeLists.txt','scripts/build_wasm.sh','scripts/build_wasm_inner.sh','docs/wasm/flightseal.mjs','docs/wasm/flightseal.wasm']
provenance={'emscripten_image':sys.argv[2], 'openssl_version':'3.5.8', 'openssl_archive_sha256':'a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2', 'sha256':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in files}}
(root/'docs/wasm/provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
PY
