"""--help/--version, version drift against the CHANGELOG, the release workflow's trigger and permissions, and the
release smoke check (which must fail on a broken binary)."""
import re
from pathlib import Path

import yaml

from conftest import ROOT, run

SHA = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


def changelog_version():
    m = re.search(r"^## (\d+\.\d+\.\d+) – (\d{4}-\d{2}-\d{2})$", (ROOT / "CHANGELOG.md").read_text(), re.M)
    assert m, "CHANGELOG.md has no '## X.Y.Z – YYYY-MM-DD' entry"
    return m.group(1)


def test_help_prints_usage_to_stdout_and_exits_0(fseal_bin):
    for flag in ("--help", "-h"):
        r = run(fseal_bin, flag)
        assert r.returncode == 0, r.stderr
        assert "fseal verify LOG" in r.stdout and r.stderr == ""


def test_version_prints_to_stdout_and_exits_0(fseal_bin):
    r = run(fseal_bin, "--version")
    assert r.returncode == 0 and r.stderr == ""
    assert re.fullmatch(r"fseal \d+\.\d+\.\d+\n", r.stdout), r.stdout


def test_usage_errors_still_exit_2_on_stderr(fseal_bin):
    for args in ((), ("--bogus",), ("verify",)):
        r = run(fseal_bin, *args)
        assert r.returncode == 2 and r.stdout == "" and "usage:" in r.stderr


def test_version_in_code_cmake_and_cli_matches_the_top_changelog_entry(fseal_bin):
    want = changelog_version()
    header = re.search(r'#define FSEAL_VERSION "([^"]+)"', (ROOT / "src" / "fseal.h").read_text())
    cmake = re.search(r"project\(flightseal VERSION (\S+)", (ROOT / "CMakeLists.txt").read_text())
    assert header and header.group(1) == want
    assert cmake and cmake.group(1) == want
    assert run(fseal_bin, "--version").stdout == f"fseal {want}\n"
    # The newest entry is at the top: only an "Unreleased" section may come before it.
    headings = re.findall(r"^## (.+)$", (ROOT / "CHANGELOG.md").read_text(), re.M)
    assert [h for h in headings if h != "Unreleased"][0].startswith(want + " ")


def load_release():
    path = ROOT / ".github" / "workflows" / "release.yml"
    assert path.exists(), "missing .github/workflows/release.yml"
    wf = yaml.safe_load(path.read_text())
    return wf, wf.get("on", wf.get(True))  # PyYAML reads the key `on` as True


def test_release_workflow_runs_only_on_v_tags():
    _, on = load_release()
    assert on == {"push": {"tags": ["v*"]}}, on


def test_release_workflow_write_permission_only_on_the_publishing_job():
    wf, _ = load_release()
    assert wf["permissions"] == {} or wf["permissions"] == {"contents": "read"}
    writers = [name for name, job in wf["jobs"].items() if job.get("permissions", {}).get("contents") == "write"]
    assert writers == ["publish"], writers
    for name, job in wf["jobs"].items():
        if name != "publish":
            assert job.get("permissions", {}).get("contents", "read") == "read", name


def test_every_action_in_every_workflow_is_pinned_to_a_commit_sha():
    for path in (ROOT / ".github" / "workflows").glob("*.yml"):
        for job in yaml.safe_load(path.read_text())["jobs"].values():
            for step in job.get("steps", []):
                if "uses" in step:
                    assert SHA.match(step["uses"]), f"{path.name}: {step['uses']} is not pinned to a commit SHA"




def test_release_smoke_passes_on_the_built_cli(fseal_bin):
    r = run("bash", ROOT / "tools" / "release_smoke.sh", fseal_bin)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "all release checks passed" in r.stdout


def test_release_smoke_fails_on_a_binary_that_always_says_intact(tmp_path):
    # A broken build that passes everything must not get through the release check.
    fake = tmp_path / "fseal"
    fake.write_text('#!/bin/sh\necho "fseal 0.1.0 fseal verify LOG RESULT: INTACT"\nexit 0\n')
    fake.chmod(0o755)
    r = run("bash", ROOT / "tools" / "release_smoke.sh", fake)
    assert r.returncode == 1, r.stdout
    assert "FAIL tampered sample" in r.stdout and "release checks FAILED" in r.stdout
