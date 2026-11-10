import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))


@pytest.fixture(scope="session")
def fseal_bin():
    path = Path(os.environ.get("FSEAL_BIN", ROOT / "build" / "fseal"))
    if not path.exists():
        pytest.fail(f"build the CLI first (cmake --build build); missing {path}")
    return str(path)


@pytest.fixture(scope="session")
def sample_ulg():
    """The public PX4 sample flight log, downloaded once by pinned commit and checked by SHA-256."""
    from fetch_sample import fetch

    return fetch(ROOT / "tests" / ".data")


def run(*args, stdin=None):
    return subprocess.run([str(a) for a in args], input=stdin, capture_output=True, text=True)
