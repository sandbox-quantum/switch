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


@pytest.mark.parametrize("blank", ["", "   "])
def test_an_empty_value_serves_no_dashboard(
    monkeypatch: pytest.MonkeyPatch, blank: str
) -> None:
    # `Path("")` is the working directory; an env file's `GATEWAY_UI_DIR=` means off.
    monkeypatch.setenv("GATEWAY_UI_DIR", blank)
    assert SwitchConfig(**_BASE_KWARGS).gateway_ui_dir is None  # type: ignore[arg-type]


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_the_dashboard_origin_defaults_to_the_servers_own() -> None:
    config = _config(
        gateway_ui_dir="/app/gateway-ui",
        gateway_public_url="https://switch.example.com/",
    )
    assert config.frontend_base_url == "https://switch.example.com"


def test_a_named_dashboard_origin_is_kept() -> None:
    config = _config(
        gateway_ui_dir="/app/gateway-ui",
        gateway_public_url="https://switch-api.example.com",
        frontend_base_url="https://switch-gateway.example.com",
    )
    assert config.frontend_base_url == "https://switch-gateway.example.com"


def test_no_dashboard_origin_is_assumed_when_switch_core_serves_none() -> None:
    config = _config(gateway_public_url="https://switch.example.com")
    assert config.frontend_base_url is None


def test_no_dashboard_origin_is_assumed_without_a_public_origin() -> None:
    assert _config(gateway_ui_dir="/app/gateway-ui").frontend_base_url is None


def test_invitation_mail_is_satisfied_by_the_servers_own_origin() -> None:
    # The SMTP check requires a dashboard origin to link to; the default is in
    # place before it runs.
    config = _config(
        gateway_ui_dir="/app/gateway-ui",
        gateway_public_url="https://switch.example.com",
        gateway_smtp_host="smtp.example.com",
        gateway_smtp_from="Switch <invites@example.com>",
    )
    assert config.frontend_base_url == "https://switch.example.com"


def test_invitation_mail_still_requires_a_dashboard_origin_otherwise() -> None:
    with pytest.raises(ValueError, match="FRONTEND_BASE_URL is required"):
        _config(
            gateway_public_url="https://switch.example.com",
            gateway_smtp_host="smtp.example.com",
            gateway_smtp_from="Switch <invites@example.com>",
        )
