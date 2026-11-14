#!/usr/bin/env python3
"""Local-only video inspection and H.264/AAC MP4 conversion using FFmpeg tools."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import tempfile
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024
MAX_JSON_BYTES = 1024 * 1024
MAX_ERROR_BYTES = 16 * 1024
MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_VIDEO_PIXELS = 3840 * 2160
MAX_VIDEO_DIMENSION = 3840
MAX_DURATION_SECONDS = 30 * 60
DEFAULT_TIMEOUT = 120
LOCAL_PROTOCOLS = "file,crypto,data"


class VideoError(Exception):
    """An actionable error suitable for the CLI's JSON error response."""


def _binary(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise VideoError(f"Required executable '{name}' was not found; install FFmpeg and ensure {name} is on PATH")
    return path


def _input_file(value: str | os.PathLike[str]) -> Path:
    try:
        path = Path(value).expanduser().resolve(strict=True)
        info = path.stat()
    except (OSError, RuntimeError) as exc:
        raise VideoError(f"Input file cannot be accessed: {exc}") from exc
    if not path.is_file():
        raise VideoError("Input must be a regular local file")
    if info.st_size <= 0:
        raise VideoError("Input file is empty")
    if info.st_size > MAX_INPUT_BYTES:
        raise VideoError(f"Input exceeds the {MAX_INPUT_BYTES}-byte size limit")
    return path


def _validate_timeout(timeout: int) -> None:
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 3600:
        raise VideoError("Timeout must be an integer from 1 to 3600 seconds")


def _run(
    args: list[str],
    timeout: int,
    *,
    max_stdout: int = MAX_JSON_BYTES,
    monitored_file: Path | None = None,
    max_file_bytes: int | None = None,
) -> bytes:
    _validate_timeout(timeout)
    try:
        process = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
        )
    except FileNotFoundError as exc:
        raise VideoError(f"Required executable is unavailable: {args[0]}") from exc

    stdout_parts: list[bytes] = []
    stdout_size = 0
    stderr_tail = bytearray()
    output_limit_hit = threading.Event()
    file_limit_hit = threading.Event()

    def drain_stdout() -> None:
        nonlocal stdout_size
        assert process.stdout is not None
        while chunk := process.stdout.read(8192):
            remaining = max_stdout + 1 - stdout_size
            if remaining > 0:
                stdout_parts.append(chunk[:remaining])
                stdout_size += min(len(chunk), remaining)
            if stdout_size > max_stdout:
                output_limit_hit.set()

    def drain_stderr() -> None:
        assert process.stderr is not None
        while chunk := process.stderr.read(8192):
            stderr_tail.extend(chunk)
            if len(stderr_tail) > MAX_ERROR_BYTES:
                del stderr_tail[:-MAX_ERROR_BYTES]

    readers = [threading.Thread(target=drain_stdout, daemon=True), threading.Thread(target=drain_stderr, daemon=True)]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        if monitored_file is not None and max_file_bytes is not None:
            try:
                if monitored_file.stat().st_size > max_file_bytes:
                    file_limit_hit.set()
            except FileNotFoundError:
                pass
            if file_limit_hit.is_set():
                process.kill()
                break
        if output_limit_hit.is_set():
            process.kill()
            break
        if time.monotonic() >= deadline:
            process.kill()
            for reader in readers:
                reader.join()
            raise VideoError(f"Media operation exceeded its {timeout}-second time limit")
        time.sleep(0.01)
    process.wait()
    for reader in readers:
        reader.join()
    if file_limit_hit.is_set():
        raise VideoError(f"Converted media exceeded the {max_file_bytes}-byte output limit")
    if output_limit_hit.is_set():
        raise VideoError(f"FFmpeg output exceeded the {max_stdout}-byte response limit")
    if process.returncode:
        detail = bytes(stderr_tail).decode("utf-8", "replace").strip()
        if "Invalid data found" in detail or "moov atom not found" in detail:
            reason = "Unsupported or corrupt media file"
        else:
            reason = "FFmpeg could not process this media file"
        raise VideoError(f"{reason}{': ' + detail if detail else ''}")
    return b"".join(stdout_parts)


def inspect_video(input_path: str | os.PathLike[str], timeout: int = DEFAULT_TIMEOUT) -> dict[str, Any]:
    _validate_timeout(timeout)
    path = _input_file(input_path)
    raw = _run(
        [
            _binary("ffprobe"), "-v", "error", "-protocol_whitelist", LOCAL_PROTOCOLS,
            "-show_entries",
            "format=format_name,duration:stream=index,codec_type,codec_name,width,height,duration",
            "-of", "json", str(path),
        ],
        timeout,
    )
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise VideoError("ffprobe returned invalid JSON") from exc
    fmt = data.get("format") or {}
    streams = data.get("streams")
    if not isinstance(streams, list) or not streams:
        raise VideoError("Unsupported media file: no audio or video streams were found")

    def number(value: Any) -> float | None:
        try:
            parsed = float(value)
            return parsed if parsed >= 0 and parsed != float("inf") else None
        except (TypeError, ValueError):
            return None

    normalized = []
    for stream in streams:
        if not isinstance(stream, dict):
            continue
        normalized.append({
            "index": stream.get("index"),
            "type": stream.get("codec_type"),
            "codec": stream.get("codec_name"),
            "width": stream.get("width"),
            "height": stream.get("height"),
            "duration_seconds": number(stream.get("duration")),
        })
    return {
        "container": fmt.get("format_name"),
        "duration_seconds": number(fmt.get("duration")) or max(
            (stream["duration_seconds"] or 0 for stream in normalized), default=0
        ) or None,
        "streams": normalized,
    }


def transcode_video(
    input_path: str | os.PathLike[str],
    output_path: str | os.PathLike[str] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Path:
    _validate_timeout(timeout)
    source = _input_file(input_path)
    destination = Path(output_path).expanduser().absolute() if output_path else source.with_name(f"{source.stem}-transcoded.mp4")
    if destination.suffix.lower() != ".mp4":
        raise VideoError("Output filename must end in .mp4")
    if destination == source:
        raise VideoError("Output must be a new file and cannot replace the input")
    if destination.exists():
        raise VideoError("Output already exists; choose a new path to preserve existing files")
    if not destination.parent.is_dir():
        raise VideoError("Output directory does not exist")

    source_info = inspect_video(source, timeout)
    video_streams = [stream for stream in source_info["streams"] if stream["type"] == "video"]
    if not video_streams:
        raise VideoError("Unsupported media file: no video stream was found")
    for stream in video_streams:
        width, height = stream["width"], stream["height"]
        if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
            raise VideoError("Video has missing or invalid dimensions")
        if max(width, height) > MAX_VIDEO_DIMENSION or width * height > MAX_VIDEO_PIXELS:
            raise VideoError(f"Video exceeds the {MAX_VIDEO_DIMENSION}-pixel-dimension / {MAX_VIDEO_PIXELS}-pixel limit")
    duration = source_info["duration_seconds"]
    if not isinstance(duration, (int, float)) or duration <= 0 or duration > MAX_DURATION_SECONDS:
        raise VideoError(f"Video duration must be greater than zero and no longer than {MAX_DURATION_SECONDS} seconds")

    try:
        private_temp_dir = Path(tempfile.mkdtemp(prefix=".flightseal-", dir=destination.parent))
        temporary = private_temp_dir / "converted.mp4"
    except OSError as exc:
        raise VideoError(f"Cannot create output in the selected directory: {exc}") from exc
    try:
        _run(
            [
                _binary("ffmpeg"), "-nostdin", "-hide_banner", "-v", "error",
                "-protocol_whitelist", LOCAL_PROTOCOLS, "-i", str(source),
                "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264",
                "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-threads", "2", "-movflags", "+faststart",
                "-f", "mp4", "-n", str(temporary),
            ],
            timeout,
            max_stdout=0,
            monitored_file=temporary,
            max_file_bytes=MAX_OUTPUT_BYTES,
        )
        if not temporary.is_file() or temporary.stat().st_size == 0:
            raise VideoError("FFmpeg reported success but produced no output file")
        if temporary.stat().st_size > MAX_OUTPUT_BYTES:
            raise VideoError(f"Converted media exceeded the {MAX_OUTPUT_BYTES}-byte output limit")
        output_info = inspect_video(temporary, timeout)
        output_streams = output_info["streams"]
        output_video = [stream for stream in output_streams if stream["type"] == "video"]
        output_audio = [stream for stream in output_streams if stream["type"] == "audio"]
        output_duration = output_info["duration_seconds"]
        if not output_video or output_video[0]["codec"] != "h264":
            raise VideoError("FFmpeg output did not contain an H.264 video stream")
        if any(stream["codec"] != "aac" for stream in output_audio):
            raise VideoError("FFmpeg output contained an audio codec other than AAC")
        if not isinstance(output_duration, (int, float)) or abs(output_duration - duration) > max(2.0, duration * 0.02):
            raise VideoError("Converted video duration did not match the source duration")
        # link() publishes atomically and fails if another process created destination.
        os.link(temporary, destination)
        return destination
    except FileExistsError as exc:
        raise VideoError("Output appeared during conversion; existing file was preserved") from exc
    except OSError as exc:
        raise VideoError(f"Cannot publish converted video: {exc}") from exc
    finally:
        shutil.rmtree(private_temp_dir, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    inspect = sub.add_parser("inspect", help="Inspect local media metadata")
    inspect.add_argument("input")
    transcode = sub.add_parser("transcode", help="Convert local video to a new H.264/AAC MP4")
    transcode.add_argument("input")
    transcode.add_argument("--output")
    for command in (inspect, transcode):
        command.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, choices=range(1, 3601))
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            result = inspect_video(args.input, args.timeout)
        else:
            result = {"output": str(transcode_video(args.input, args.output, args.timeout))}
        print(json.dumps({"ok": True, **result}, separators=(",", ":")))
        return 0
    except VideoError as exc:
        print(json.dumps({"ok": False, "error": str(exc)[:MAX_ERROR_BYTES]}, separators=(",", ":")), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
