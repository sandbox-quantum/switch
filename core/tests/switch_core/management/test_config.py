"""Agent management config: the flag needs its own token secret."""

from __future__ import annotations

import pytest

from switch_core.config import SwitchConfig

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_name="switch",
    id_server_name="switch.local",
    agent_registration_token="token",
    secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    gateway_admin_email="admin@example.com",
)

_LONG_ENOUGH = "x" * 32


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(  # type: ignore[arg-type]
        **{
            **_BASE_KWARGS,
            "db_password": "placeholder",  # gitleaks:allow
            "gateway_admin_password": "placeholder",  # gitleaks:allow
            **overrides,
        }
    )


def test_off_by_default_and_needs_no_secret() -> None:
    config = _config()
    assert config.agent_management_enabled is False
    assert config.controller_token_secret is None
    assert config.controller_status_interval_seconds == 60


def test_on_with_a_secret_is_accepted() -> None:
    config = _config(
        agent_management_enabled=True, controller_token_secret=_LONG_ENOUGH
    )
    assert config.controller_token_secret == _LONG_ENOUGH


def test_on_without_a_secret_raises() -> None:
    with pytest.raises(ValueError, match="CONTROLLER_TOKEN_SECRET is required"):
        _config(agent_management_enabled=True)


def test_on_with_a_short_secret_raises() -> None:
    with pytest.raises(ValueError, match="at least 32 characters"):
        _config(agent_management_enabled=True, controller_token_secret="x" * 31)


def test_the_status_interval_must_be_positive() -> None:
    with pytest.raises(ValueError, match="CONTROLLER_STATUS_INTERVAL_SECONDS"):
        _config(controller_status_interval_seconds=0)
