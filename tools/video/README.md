# Local video tools

The CLI inspects and converts a user-selected local file. It does not upload media or make network requests.
It uses Python's standard library and the external `ffprobe` and `ffmpeg` executables from FFmpeg; there is
no Python package named `ffmpeg` to install.

Install FFmpeg from a trusted OS package source and verify both `ffprobe` and `ffmpeg` are on `PATH`.

```sh
python3 tools/video/inspect_video.py inspect /path/to/clip.mov
python3 tools/video/inspect_video.py transcode /path/to/clip.mov --output /path/to/clip-h264.mp4
```

Inspection emits JSON with the container, duration, stream codec, dimensions, and stream durations. Conversion
produces a new H.264/AAC MP4 (audio is optional). Existing output files are never replaced. The CLI caps input
size at 2 GiB, video dimensions at 3840 pixels on the longest side and 8,294,400 total pixels, duration at 30
minutes, and converted output at 256 MiB. The output cap is monitored during encoding; a cap hit aborts the
process and the partial file is discarded. The output is probed before publication to confirm H.264/AAC codec
metadata and a source-matching duration. JSON response is capped at 1 MiB and errors at 16 KiB. All Python API
entry points validate timeouts from 1 to 3600 seconds (default 120), use no shell, disable stdin, limit encoder
threads, and restrict FFmpeg protocols to local-file-related protocols.

These checks make this a local-file utility, not a complete sandbox for processing untrusted uploads. Host-mode
execution does not impose a hard memory quota or isolate filesystem access. Use the container recipe below for
CPU, memory, process, filesystem, and network isolation. Do not expose this CLI as a server endpoint.

## Isolated container

Build once from this directory. At runtime mount only the selected source read-only and a destination folder
read-write; disable networking and drop Linux capabilities. The container image includes FFmpeg from Debian's
`bookworm` package repository. Pin the image digest and package version in managed deployments.

```sh
docker build -t flightseal-video:local tools/video
docker run --rm --network none --cap-drop ALL --read-only --user 65534:65534 \
  --cpus 2 --memory 1g --pids-limit 32 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount type=bind,src="/absolute/path/clip.mov",dst=/input/clip.mov,readonly \
  --mount type=bind,src="/absolute/path/output",dst=/output \
  flightseal-video:local inspect /input/clip.mov
docker run --rm --network none --cap-drop ALL --read-only --user 65534:65534 \
  --cpus 2 --memory 1g --pids-limit 32 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --mount type=bind,src="/absolute/path/clip.mov",dst=/input/clip.mov,readonly \
  --mount type=bind,src="/absolute/path/output",dst=/output \
  flightseal-video:local transcode /input/clip.mov --output /output/clip.mp4
```

Container bind mounts are explicit so the process cannot see unrelated host files. The destination must be
writable by UID 65534. CPU, memory, process, and temporary storage limits are included. The image itself is not
an online service and exposes no API.
