FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 \
    && rm -rf /var/lib/apt/lists/*

COPY inspect_video.py /usr/local/bin/flightseal-video
RUN chmod 0555 /usr/local/bin/flightseal-video && mkdir -p /input /output
USER 65534:65534
ENTRYPOINT ["python3", "/usr/local/bin/flightseal-video"]
