"""A failed local bootstrap leaves the input configuration unchanged."""

import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy" / "local" / "generate-env-secrets.sh"
CONFIG_KEYS = (
    "DB_PASSWORD",
    "DB_OWNER_PASSWORD",
    "AGENT_REGISTRATION_TOKEN",
    "GATEWAY_ADMIN_PASSWORD",
    "CONTROLLER_TOKEN_SECRET",
    "MATTERMOST_ADMIN_PASSWORD",
    "MATTERMOST_USER_PASSWORD",
    "SECRET_KEYS",
)


@pytest.mark.parametrize("failure", ["missing-key", "generator"])
def test_incomplete_generation_preserves_the_input(
    tmp_path: Path, failure: str
) -> None:
    env_file = tmp_path / "fixture.env"
    keys = CONFIG_KEYS[:-1] if failure == "missing-key" else CONFIG_KEYS
    original = "".join(f"{key}=\n" for key in keys)
    env_file.write_text(original, encoding="utf-8")
    tool_dir = tmp_path / "bin"
    tool_dir.mkdir()
    openssl = tool_dir / "openssl"
    openssl.write_text(
        "#!/bin/sh\nexit 4\n"
        if failure == "generator"
        else "#!/bin/sh\nprintf '%*s\\n' \"$((2 * $3))\" '' | tr ' ' 0\n",
        encoding="utf-8",
    )
    openssl.chmod(0o700)

    run = subprocess.run(
        ["bash", str(SCRIPT), str(env_file), "fixture"],
        env={**os.environ, "PATH": f"{tool_dir}{os.pathsep}{os.environ['PATH']}"},
        capture_output=True,
        text=True,
        check=False,
    )

    assert run.returncode != 0
    assert env_file.read_text(encoding="utf-8") == original
    assert not (tmp_path / "fixture.env.bak").exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["bin", "fixture.env"]


def test_valid_input_is_filled_without_changing_unrelated_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / "fixture.env"
    env_file.write_text(
        "# keep this comment\n" + "".join(f"{key}=\n" for key in CONFIG_KEYS),
        encoding="utf-8",
    )
    tools = tmp_path / "bin"
    tools.mkdir()
    openssl = tools / "openssl"
    openssl.write_text(
        "#!/bin/sh\nprintf '%*s\\n' \"$((2 * $3))\" '' | tr ' ' 0\n",
        encoding="utf-8",
    )
    openssl.chmod(0o700)
    monkeypatch.setenv("PATH", f"{tools}{os.pathsep}{os.environ['PATH']}")

    subprocess.run(["bash", str(SCRIPT), str(env_file), "fixture"], check=True)

    lines = env_file.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "# keep this comment"
    assert all(line.endswith("=" + "0" * 48) for line in lines[1:-1])
    assert lines[-1] == "SECRET_KEYS=fixture:" + "0" * 64
    assert sorted(p.name for p in tmp_path.iterdir()) == ["bin", "fixture.env"]
