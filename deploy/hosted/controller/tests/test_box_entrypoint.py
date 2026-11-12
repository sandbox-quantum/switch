"""The box image's entrypoint (`deploy/hosted/box/image/entrypoint.sh`): what it does with the controller's exit code.

After a pause and resume, the box's controller ends as revoked (exit 3), and the entrypoint must then keep the
old identity aside and enrol afresh with the code in the box's Secret. With no code it exits, so a revoked box never
loops. Any other exit, such as 2 (a configuration error), is passed on with no re-enrolment. The real script runs
here under `sh`, with stand-ins for the controller's CLI and `node` on PATH, and its fixed code path pointed at a
temporary file. No cluster, no Switch."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[2] / "box" / "image" / "entrypoint.sh"
CODE = "swce_SECRET-code-value-0123456789"

CLI = """#!/bin/sh
case "$1" in
  status) exit 0 ;;
  enroll) echo enroll >> "$FAKE_LOG"; exit 0 ;;
esac
exit 9
"""

NODE = """#!/bin/sh
echo "run" >> "$FAKE_LOG"
runs=$(cat "$FAKE_DIR/runs" 2>/dev/null || echo 0)
runs=$((runs + 1))
echo "$runs" > "$FAKE_DIR/runs"
if [ "$runs" = 1 ]; then exit "$FAKE_FIRST_RC"; fi
exit 0
"""


def _tool(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def _boot(
    tmp_path: Path, first_rc: int, code: str | None
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _tool(bin_dir / "switch-agent-controller", CLI)
    _tool(bin_dir / "node", NODE)
    code_file = tmp_path / "enrol-code"
    if code is not None:
        code_file.write_text(code)
    script = tmp_path / "entrypoint.sh"
    text = ENTRYPOINT.read_text()
    assert text.count("code_file=/etc/switch/enrol/code") == 1
    script.write_text(text.replace("code_file=/etc/switch/enrol/code", f"code_file={code_file}"))
    base = tmp_path / "data" / "controller"
    (base / "state").mkdir(parents=True)
    (base / "state" / "identity").write_text("the revoked controller's state")
    log = tmp_path / "calls"
    env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "HOME": str(tmp_path / "home"),
        "SWITCH_CONTROLLER_DATA_DIR": str(base),
        "SWITCH_SERVER": "https://switch.example.com",
        "SWITCH_MACHINE_NAME": "box",
        "FAKE_LOG": str(log),
        "FAKE_DIR": str(tmp_path),
        "FAKE_FIRST_RC": str(first_rc),
    }
    done = subprocess.run(["sh", str(script)], env=env, capture_output=True, text=True, timeout=30)
    calls = log.read_text().split() if log.exists() else []
    return done, calls


def test_a_revoked_run_with_a_code_keeps_the_old_state_and_enrols_again(tmp_path: Path) -> None:
    done, calls = _boot(tmp_path, first_rc=3, code=CODE)
    assert done.returncode == 0, done.stderr
    assert calls == ["run", "enroll", "run"]
    retired = list((tmp_path / "data" / "controller" / "state" / ".retired").iterdir())
    assert len(retired) == 1 and (retired[0] / "identity").exists()
    assert CODE not in done.stdout + done.stderr


def test_a_revoked_run_with_no_code_exits_without_looping(tmp_path: Path) -> None:
    done, calls = _boot(tmp_path, first_rc=3, code=None)
    assert done.returncode == 3
    assert calls == ["run"]
    assert (tmp_path / "data" / "controller" / "state" / "identity").exists()


@pytest.mark.parametrize("rc", [2, 1])
def test_any_other_exit_is_passed_on_with_no_new_enrolment(tmp_path: Path, rc: int) -> None:
    """Why the controller must end a revoked-and-wiped start with 3, not 2."""
    done, calls = _boot(tmp_path, first_rc=rc, code=CODE)
    assert done.returncode == rc
    assert calls == ["run"]
    assert (tmp_path / "data" / "controller" / "state" / "identity").exists()
