#!/usr/bin/env bash
set -euo pipefail
cd /build
archive=openssl-3.5.8.tar.gz
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 --output "$archive" "https://www.openssl.org/source/$archive"
fi
printf '%s  %s\n' a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2 "$archive" | sha256sum --check
if [[ ! -f /build/openssl/lib/libcrypto.a ]]; then
  tar -xzf "$archive"
  cd openssl-3.5.8
  emconfigure ./Configure linux-generic32 --cross-compile-prefix= CC=emcc CXX=em++ AR=emar RANLIB=emranlib no-asm no-threads no-shared no-tests no-module no-dso no-engine no-ui-console --prefix=/build/openssl --libdir=lib
  emmake make -j4 build_libs
  emmake make install_dev
fi
emcmake cmake -S /src -B /build/flightseal -DBUILD_WASM=ON -DFSEAL_HARDEN=OFF -DOPENSSL_ROOT_DIR=/build/openssl -DOPENSSL_CRYPTO_LIBRARY=/build/openssl/lib/libcrypto.a -DOPENSSL_INCLUDE_DIR=/build/openssl/include
cmake --build /build/flightseal --target fseal-wasm -j4
cp /build/flightseal/wasm/flightseal.mjs /build/flightseal/wasm/flightseal.wasm /src/docs/wasm/

cp /build/openssl-3.5.8/LICENSE.txt /src/docs/wasm/LICENSE-OpenSSL.txt
cp /emsdk/upstream/emscripten/LICENSE /src/docs/wasm/LICENSE-Emscripten.txt
