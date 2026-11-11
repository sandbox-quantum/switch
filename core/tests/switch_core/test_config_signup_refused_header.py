"""GATEWAY_SIGNUP_REFUSED_HEADER: unset or blank turns the check off."""

from __future__ import annotations

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


def _config() -> SwitchConfig:
    return SwitchConfig(**_BASE_KWARGS)  # type: ignore[arg-type]


def test_unset_turns_the_check_off() -> None:
    assert _config().gateway_signup_refused_header is None


@pytest.mark.parametrize("blank", ["", " "])
def test_blank_turns_the_check_off(monkeypatch: pytest.MonkeyPatch, blank: str) -> None:
    monkeypatch.setenv("GATEWAY_SIGNUP_REFUSED_HEADER", blank)

    assert _config().gateway_signup_refused_header is None


def test_a_header_name_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GATEWAY_SIGNUP_REFUSED_HEADER", "x-amzn-waf-signup-refused")

    assert _config().gateway_signup_refused_header == "x-amzn-waf-signup-refused"
