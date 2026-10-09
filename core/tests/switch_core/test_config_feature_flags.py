"""FEATURE_FLAGS_ENABLED: which flags this deployment turns on."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig
from switch_core.feature_flags import ECOSYSTEM_SHOW_OWNERS

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key="jwt",
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
    secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
)


def test_unset_leaves_every_flag_off(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FEATURE_FLAGS_ENABLED", raising=False)
    assert SwitchConfig(**_BASE_KWARGS).feature_flags == {  # type: ignore[arg-type]
        ECOSYSTEM_SHOW_OWNERS: False
    }


def test_listed_flags_are_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", f" {ECOSYSTEM_SHOW_OWNERS} ,")
    assert SwitchConfig(**_BASE_KWARGS).feature_flags == {  # type: ignore[arg-type]
        ECOSYSTEM_SHOW_OWNERS: True
    }


def test_an_unknown_flag_is_a_startup_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", "ecosystem.show_ownres")
    with pytest.raises(ValidationError, match="ecosystem.show_ownres"):
        SwitchConfig(**_BASE_KWARGS)  # type: ignore[arg-type]
