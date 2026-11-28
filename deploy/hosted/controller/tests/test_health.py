import os
import subprocess
import sys
from pathlib import Path
from time import time

import pytest

from switch_hosted_controller import cli
from switch_hosted_controller.health import check_health


def test_chart_liveness_age_is_accepted(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(cli, "_HEALTH_PATH", tmp_path / "health")
    cli._touch_health()
    assert cli._health(900) == 0


def test_the_heartbeat_is_not_written_through_a_planted_link(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "_HEALTH_PATH", tmp_path / "health")
    victim = tmp_path / "victim"
    victim.write_text("untouched")
    (tmp_path / f"health.{os.getpid()}").symlink_to(victim)

    cli._touch_health()

    assert victim.read_text() == "untouched"
    assert cli._health(900) == 0
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "health",
        f"health.{os.getpid()}",
        "victim",
    ]


@pytest.mark.parametrize("contents", [None, "invalid", "nan", "0", str(time() + 7200)])
def test_probe_rejects_missing_invalid_or_stale_heartbeat(tmp_path, contents):
    path = tmp_path / "health"
    if contents is not None:
        path.write_text(contents)
    assert check_health(path, 600) == 1


def test_probe_does_not_load_aws_sdk():
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import switch_hosted_controller.health; "
            "assert 'boto3' not in sys.modules; assert 'botocore' not in sys.modules",
        ],
        check=True,
        timeout=5,
    )
