FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates cmake build-essential libssl-dev libsqlite3-dev python3 python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY . .
RUN python3 -m venv /opt/test-env \
    && /opt/test-env/bin/pip install --no-cache-dir pyulog==1.3.0 pytest==8.4.2 pyyaml==6.0.2
ENV PATH="/opt/test-env/bin:${PATH}"
RUN cmake -S . -B /tmp/fseal-build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/fseal-build -j2

FROM build AS verification
ENV FSEAL_BIN=/tmp/fseal-build/fseal
RUN ctest --test-dir /tmp/fseal-build --output-on-failure \
    && python -m pytest -q \
    && node --test tests/web/verifier.test.mjs tests/web/copy.test.mjs \
    && node --test tests/wasm/bridge.test.mjs tests/wasm/enterprise-edge.test.mjs \
    && python tools/verify_wasm_provenance.py \
    && npm --prefix newweb ci \
    && npm --prefix newweb run build \
    && python tools/package_static.py

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /data && chown 65534:65534 /data
COPY --from=build /tmp/fseal-build/fseal /usr/local/bin/fseal
USER 65534:65534
WORKDIR /data
ENTRYPOINT ["fseal"]
CMD ["--help"]
