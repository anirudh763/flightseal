import shlex
import shutil
import socket
import ssl
import struct
import subprocess
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_wasm_inner.sh"


class ResetThenTlsServer:
    def __init__(self, cert, key, resets):
        self.resets = resets
        self.connections = 0
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.listener.settimeout(0.25)
        self.url = f"https://127.0.0.1:{self.listener.getsockname()[1]}/archive"
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        self.context = context
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while True:
            try:
                connection, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.connections += 1
            if self.connections <= self.resets:
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                connection.close()
                continue
            try:
                with self.context.wrap_socket(connection, server_side=True) as tls:
                    tls.recv(4096)
                    tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nopenssl-ok")
            except (OSError, ssl.SSLError):
                connection.close()

    def close(self):
        self.listener.close()
        self.thread.join(timeout=1)


def curl_options():
    line = next(
        line.strip()
        for line in SCRIPT.read_text().splitlines()
        if line.lstrip().startswith("curl ")
    )
    args = shlex.split(line)[1:]
    output = args.index("--output")
    return args[:output]


def test_wasm_archive_download_retries_tls_reset_and_stops_after_limit(tmp_path):
    curl = shutil.which("curl")
    openssl = shutil.which("openssl")
    assert curl and openssl, "curl and openssl are required for the local download regression"
    options = curl_options()

    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
         "-out", str(cert), "-subj", "/CN=localhost", "-days", "1"],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    transient = ResetThenTlsServer(cert, key, resets=1)
    archive = tmp_path / "archive"
    try:
        result = subprocess.run(
            [
                curl, *options, "--connect-timeout", "2", "--max-time", "5",
                "--insecure", "--noproxy", "*", "--output", str(archive), transient.url,
            ],
            capture_output=True, text=True, timeout=15,
        )
        assert result.returncode == 0, result.stderr
        assert archive.read_bytes() == b"openssl-ok"
        assert transient.connections == 2
    finally:
        transient.close()
    assert "--retry-all-errors" in options
    assert all(flag in options for flag in ("--connect-timeout", "--max-time", "--retry-max-time"))
    assert options[options.index("--retry") + 1] == "3"
    for flag in ("--connect-timeout", "--max-time", "--retry-max-time"):
        assert int(options[options.index(flag) + 1]) > 0

    permanent = ResetThenTlsServer(cert, key, resets=99)
    started = time.monotonic()
    try:
        result = subprocess.run(
            [
                curl, *options, "--insecure", "--noproxy", "*",
                "--output", str(tmp_path / "never"), permanent.url,
            ],
            capture_output=True, text=True, timeout=15,
        )
        elapsed = time.monotonic() - started
        assert result.returncode != 0
        assert permanent.connections == 4  # initial request plus --retry 3
        assert elapsed < 15
    finally:
        permanent.close()
