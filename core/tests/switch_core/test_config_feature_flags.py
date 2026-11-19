"""FEATURE_FLAGS_ENABLED: which flags this deployment turns on."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.config import SwitchConfig
from switch_core.feature_flags import (
    AGENT_CHATS,
    AGENT_MANAGEMENT,
    ALWAYS_ON_FEATURE_FLAGS,
    ECOSYSTEM_SHOW_OWNERS,
    GATEWAY_V2,
    GROUP_CHATS,
    KNOWN_FEATURE_FLAGS,
)

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


def test_unset_leaves_every_flag_off_but_the_always_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FEATURE_FLAGS_ENABLED", raising=False)
    assert SwitchConfig(**_BASE_KWARGS).feature_flags == {  # type: ignore[arg-type]
        key: key in ALWAYS_ON_FEATURE_FLAGS for key in KNOWN_FEATURE_FLAGS
    }


def test_listed_flags_are_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", f" {ECOSYSTEM_SHOW_OWNERS} ,")
    assert SwitchConfig(**_BASE_KWARGS).feature_flags == {  # type: ignore[arg-type]
        key: key == ECOSYSTEM_SHOW_OWNERS or key in ALWAYS_ON_FEATURE_FLAGS
        for key in KNOWN_FEATURE_FLAGS
    }


def test_the_dashboard_layout_flag_is_always_on_and_still_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Switch Console picks its links into the dashboard by gateway_v2, and
    # deployments that turned it on still name it.
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", GATEWAY_V2)
    assert SwitchConfig(**_BASE_KWARGS).feature_flags[GATEWAY_V2] is True  # type: ignore[arg-type]
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", "")
    assert SwitchConfig(**_BASE_KWARGS).feature_flags[GATEWAY_V2] is True  # type: ignore[arg-type]


def test_always_on_flags_listed_by_an_old_config_still_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "FEATURE_FLAGS_ENABLED", f"{AGENT_CHATS},{AGENT_MANAGEMENT},{GROUP_CHATS}"
    )
    flags = SwitchConfig(**_BASE_KWARGS).feature_flags  # type: ignore[arg-type]
    assert flags[AGENT_CHATS] is True
    assert flags[AGENT_MANAGEMENT] is True
    assert flags[GROUP_CHATS] is True
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", "")
    flags = SwitchConfig(**_BASE_KWARGS).feature_flags  # type: ignore[arg-type]
    assert flags[AGENT_CHATS] and flags[AGENT_MANAGEMENT] and flags[GROUP_CHATS]


def test_an_unknown_flag_is_a_startup_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", "ecosystem.show_ownres")
    with pytest.raises(ValidationError, match="ecosystem.show_ownres"):
        SwitchConfig(**_BASE_KWARGS)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("flags", "managed_by_console", "kind"),
    [
        ("", False, "self_hosted"),
        ("", True, "managed_by_console"),
        ("switch_cloud", False, "switch_cloud"),
        # The Cloud flag decides even if the managed setting is stray.
        ("switch_cloud", True, "switch_cloud"),
    ],
)
def test_the_deployment_kind_follows_the_cloud_flag_then_console(
    monkeypatch: pytest.MonkeyPatch, flags: str, managed_by_console: bool, kind: str
) -> None:
    monkeypatch.setenv("FEATURE_FLAGS_ENABLED", flags)
    config = SwitchConfig(**_BASE_KWARGS, managed_by_console=managed_by_console)  # type: ignore[arg-type]
    assert config.deployment_kind == kind
