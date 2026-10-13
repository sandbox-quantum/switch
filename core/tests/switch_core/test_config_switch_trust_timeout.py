"""The Switch Trust check timeout is the one piece of its config still fixed
at deploy time — see docs/design/switch-trust-guardrails-v1.md's Settings UI
section for why it stayed out of the DB-backed, admin-editable settings.
"""

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


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


def test_defaults_to_two_seconds() -> None:
    assert _config().switch_trust_timeout_seconds == 2.0


def test_a_non_positive_timeout_is_refused() -> None:
    with pytest.raises(ValueError, match="SWITCH_TRUST_TIMEOUT_SECONDS"):
        _config(switch_trust_timeout_seconds=0)
