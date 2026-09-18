from pathlib import Path

from switch_hosted_controller import cli


def test_chart_liveness_age_is_accepted(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(cli, "_HEALTH_PATH", tmp_path / "health")
    cli._touch_health()
    assert cli._health(900) == 0
