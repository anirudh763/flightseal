import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "video"))
import inspect_video as video


def input_file(tmp_path: Path) -> Path:
    path = tmp_path / "clip.mov"
    path.write_bytes(b"video")
    return path


def test_inspection_normalizes_metadata(monkeypatch, tmp_path):
    path = input_file(tmp_path)
    monkeypatch.setattr(video, "_binary", lambda name: name)
    monkeypatch.setattr(video, "_run", lambda args, timeout, **kwargs: json.dumps({
        "format": {"format_name": "mov,mp4", "duration": "2.5"},
        "streams": [
            {"index": 0, "codec_type": "video", "codec_name": "hevc", "width": 1280, "height": 720},
            {"index": 1, "codec_type": "audio", "codec_name": "aac"},
        ],
    }).encode())
    result = video.inspect_video(path)
    assert result["container"] == "mov,mp4"
    assert result["duration_seconds"] == 2.5
    assert result["streams"][0]["width"] == 1280
    assert result["streams"][1]["codec"] == "aac"


def test_missing_binary_is_clear(monkeypatch, tmp_path):
    monkeypatch.setattr(video.shutil, "which", lambda _: None)
    with pytest.raises(video.VideoError, match="ffprobe.*not found"):
        video.inspect_video(input_file(tmp_path))


def test_invalid_media_is_reported(monkeypatch, tmp_path):
    monkeypatch.setattr(video, "_binary", lambda name: name)
    monkeypatch.setattr(video, "_run", lambda *args, **kwargs: (_ for _ in ()).throw(
        video.VideoError("Unsupported or corrupt media file: Invalid data found")))
    with pytest.raises(video.VideoError, match="Unsupported or corrupt"):
        video.inspect_video(input_file(tmp_path))


def test_input_limits_and_regular_file(tmp_path):
    empty = tmp_path / "empty"
    empty.write_bytes(b"")
    with pytest.raises(video.VideoError, match="empty"):
        video._input_file(empty)
    with pytest.raises(video.VideoError, match="regular local file"):
        video._input_file(tmp_path)


def test_transcode_refuses_existing_output_and_same_file(tmp_path):
    source = tmp_path / "clip.mp4"
    source.write_bytes(b"video")
    with pytest.raises(video.VideoError, match="cannot replace"):
        video.transcode_video(source, source)
    existing = tmp_path / "exists.mp4"
    existing.write_bytes(b"keep")
    with pytest.raises(video.VideoError, match="already exists"):
        video.transcode_video(source, existing)
    assert existing.read_bytes() == b"keep"


def test_command_uses_no_shell_and_protocol_restriction(monkeypatch, tmp_path):
    path = input_file(tmp_path)
    observed = {}

    monkeypatch.setattr(video, "_binary", lambda name: f"/bin/{name}")
    class FakeStream:
        def __init__(self, payload):
            self.payload = payload

        def read(self, _size):
            payload, self.payload = self.payload, b""
            return payload

    class FakeProcess:
        def __init__(self, args, **kwargs):
            observed.update(args=args, kwargs=kwargs)
            self.stdout = FakeStream(b'{"format":{"format_name":"mov"},"streams":[{"codec_type":"video"}]}')
            self.stderr = FakeStream(b"")
            self.returncode = 0

        def poll(self):
            return self.returncode

        def wait(self):
            return self.returncode

    monkeypatch.setattr(video.subprocess, "Popen", FakeProcess)
    video.inspect_video(path)
    assert "file,crypto,data" in observed["args"]
    assert observed["kwargs"]["shell"] is False
    assert observed["kwargs"]["stdin"] == subprocess.DEVNULL


@pytest.mark.integration
def test_real_conversion_roundtrip(tmp_path):
    source = tmp_path / "tiny-source.mp4"
    docker = video.shutil.which("docker")
    if video.shutil.which("ffmpeg") and video.shutil.which("ffprobe"):
        generated = subprocess.run(
            [video.shutil.which("ffmpeg"), "-nostdin", "-v", "error", "-f", "lavfi", "-i",
             "color=c=blue:s=64x64:d=0.2", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
             "-shortest", "-c:v", "libx264", "-c:a", "aac", str(source)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
        )
        if generated.returncode:
            pytest.skip("FFmpeg build lacks the lavfi/libx264 components required by this test")
        output = video.transcode_video(source, tmp_path / "tiny-converted.mp4")
        info = video.inspect_video(output)
    elif docker and subprocess.run(
        [docker, "image", "inspect", "flightseal-video:local"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    ).returncode == 0:
        tmp_path.chmod(0o777)
        mount = f"type=bind,src={tmp_path.resolve()},dst=/data"
        shared = [docker, "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--read-only",
                  "--cpus", "2", "--memory", "1g", "--pids-limit", "32",
                  "--user", "65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m,uid=65534,gid=65534",
                  "--mount", mount]
        generated = subprocess.run(
            shared + ["--entrypoint", "ffmpeg", "flightseal-video:local", "-nostdin", "-v", "error",
                      "-f", "lavfi", "-i", "color=c=blue:s=64x64:d=0.2", "-f", "lavfi", "-i",
                      "anullsrc=r=44100:cl=stereo", "-shortest", "-c:v", "libx264", "-c:a", "aac",
                      "/data/tiny-source.mp4"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
        )
        assert generated.returncode == 0, generated.stderr.decode("utf-8", "replace")
        inspected = subprocess.run(
            shared + ["flightseal-video:local", "inspect", "/data/tiny-source.mp4"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
        )
        assert inspected.returncode == 0, inspected.stderr.decode("utf-8", "replace")
        converted = subprocess.run(
            shared + ["flightseal-video:local", "transcode", "/data/tiny-source.mp4", "--output", "/data/tiny-converted.mp4"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
        )
        assert converted.returncode == 0, converted.stderr.decode("utf-8", "replace")
        verified = subprocess.run(
            shared + ["flightseal-video:local", "inspect", "/data/tiny-converted.mp4"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False,
        )
        assert verified.returncode == 0, verified.stderr.decode("utf-8", "replace")
        info = json.loads(verified.stdout)
    else:
        pytest.skip("install FFmpeg or build the flightseal-video:local Docker image for real conversion")
    assert info["container"] and "mp4" in info["container"]
    assert {stream["codec"] for stream in info["streams"]} >= {"h264", "aac"}


def test_cli_emits_bounded_json_error(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(video, "inspect_video", lambda *_: (_ for _ in ()).throw(video.VideoError("x" * 20000)))
    assert video.main(["inspect", str(input_file(tmp_path))]) == 2
    captured = capsys.readouterr()
    assert len(captured.err.encode()) < video.MAX_ERROR_BYTES + 100
    assert json.loads(captured.err)["ok"] is False


def test_subprocess_timeout_and_stdout_limit():
    with pytest.raises(video.VideoError, match="time limit"):
        video._run([sys.executable, "-c", "import time; time.sleep(2)"], timeout=1)
    with pytest.raises(video.VideoError, match="response limit"):
        video._run([sys.executable, "-c", "print('x' * 10000)"], timeout=5, max_stdout=32)


def test_public_functions_validate_timeout(tmp_path):
    source = input_file(tmp_path)
    with pytest.raises(video.VideoError, match="1 to 3600"):
        video.inspect_video(source, timeout=0)
    with pytest.raises(video.VideoError, match="1 to 3600"):
        video.transcode_video(source, tmp_path / "out.mp4", timeout=3601)


@pytest.mark.parametrize(
    ("streams", "duration", "message"),
    [
        ([{"type": "video", "width": 4000, "height": 2160}], 1.0, "exceeds"),
        ([{"type": "video", "width": 1920, "height": 1080}], 1801.0, "duration"),
        ([{"type": "audio", "width": None, "height": None}], 1.0, "no video stream"),
    ],
)
def test_transcode_rejects_oversized_or_nonvideo_input(monkeypatch, tmp_path, streams, duration, message):
    source = input_file(tmp_path)
    monkeypatch.setattr(video, "inspect_video", lambda *_: {"streams": streams, "duration_seconds": duration})
    with pytest.raises(video.VideoError, match=message):
        video.transcode_video(source, tmp_path / "out.mp4")


def test_subprocess_aborts_when_converted_file_exceeds_cap(tmp_path):
    output = tmp_path / "partial.mp4"
    code = "import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_bytes(b'x'*4096); time.sleep(5)"
    with pytest.raises(video.VideoError, match="output limit"):
        video._run(
            [sys.executable, "-c", code, str(output)],
            timeout=10,
            monitored_file=output,
            max_file_bytes=1024,
        )
