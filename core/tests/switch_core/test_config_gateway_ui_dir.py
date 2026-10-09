from pathlib import Path

import pytest

from switch_core.config import SwitchConfig

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    id_server_name="switch.local",
    agent_registration_token="token",
    secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
)


def test_unset_serves_no_dashboard() -> None:
    assert SwitchConfig(**_BASE_KWARGS).gateway_ui_dir is None  # type: ignore[arg-type]


def test_read_from_the_environment_as_a_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GATEWAY_UI_DIR", "/app/gateway-ui")
    config = SwitchConfig(**_BASE_KWARGS)  # type: ignore[arg-type]
    assert config.gateway_ui_dir == Path("/app/gateway-ui")
