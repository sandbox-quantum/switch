"""Agent management and cloud machine config: the flags and what they need."""

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
    secret_keys="test:" + "x" * 40,
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
        feature_flags_enabled="agent_management", controller_token_secret=_LONG_ENOUGH
    )
    assert config.agent_management_enabled is True
    assert config.controller_token_secret == _LONG_ENOUGH


def test_on_without_a_secret_raises() -> None:
    with pytest.raises(ValueError, match="CONTROLLER_TOKEN_SECRET is required"):
        _config(feature_flags_enabled="agent_management")


def test_on_with_a_short_secret_raises() -> None:
    with pytest.raises(ValueError, match="at least 32 characters"):
        _config(
            feature_flags_enabled="agent_management", controller_token_secret="x" * 31
        )


def test_the_status_interval_must_be_positive() -> None:
    with pytest.raises(ValueError, match="CONTROLLER_STATUS_INTERVAL_SECONDS"):
        _config(controller_status_interval_seconds=0)


def test_the_old_setting_turned_on_is_refused() -> None:
    with pytest.raises(ValueError, match="AGENT_MANAGEMENT_ENABLED has been replaced"):
        _config(agent_management_enabled=True, controller_token_secret=_LONG_ENOUGH)


def test_the_old_setting_left_off_is_accepted() -> None:
    assert _config(agent_management_enabled=False).agent_management_enabled is False


def test_the_old_setting_is_refused_from_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_MANAGEMENT_ENABLED", "true")
    with pytest.raises(ValueError, match="AGENT_MANAGEMENT_ENABLED has been replaced"):
        _config()


def test_cloud_machines_are_off_by_default() -> None:
    config = _config()
    assert config.hosted_agents_enabled is False
    assert config.hosted_launch_capacity == 0


def test_the_flag_offers_cloud_machines_on_a_server_that_cannot_run_them() -> None:
    config = _config(feature_flags_enabled="hosted_agents")
    assert config.hosted_agents_enabled is True
    assert config.hosted_launch_capacity == 0


def test_capacity_needs_agent_management() -> None:
    with pytest.raises(ValueError, match="HOSTED_LAUNCH_CAPACITY needs"):
        _config(hosted_launch_capacity=1)


def test_capacity_with_agent_management_is_accepted() -> None:
    config = _config(
        feature_flags_enabled="agent_management",
        controller_token_secret=_LONG_ENOUGH,
        hosted_launch_capacity=2,
    )
    assert config.hosted_launch_capacity == 2
