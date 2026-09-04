"""The `idle_in_transaction_session_timeout` guardrail.

Off by default, and it has to stay off until Matrix I/O moves out of the
RoomService transactions — enabling it before that converts a latency problem
into a membership-drift one. It must also never reach Alembic: a migration
killed between two statements is a much worse afternoon than a slow request.
"""

from __future__ import annotations

import pytest

from switch_core.config import SwitchConfig
from switch_core.db.engine import app_connect_args

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
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


class TestDefaultIsOff:
    def test_no_timeout_is_configured_by_default(self) -> None:
        assert _config().db_idle_in_transaction_session_timeout is None

    def test_the_engine_sends_no_server_setting_by_default(self) -> None:
        assert app_connect_args(_config()) == {}


class TestWhenEnabled:
    def test_it_reaches_asyncpg_as_a_server_setting(self) -> None:
        config = _config(db_idle_in_transaction_session_timeout="15s")

        assert app_connect_args(config) == {
            "server_settings": {"idle_in_transaction_session_timeout": "15s"}
        }

    def test_it_composes_with_tls(self) -> None:
        config = _config(
            db_ssl_mode="require", db_idle_in_transaction_session_timeout="15s"
        )

        assert app_connect_args(config) == {
            "ssl": "require",
            "server_settings": {"idle_in_transaction_session_timeout": "15s"},
        }

    def test_it_does_not_leak_into_db_connect_args(self) -> None:
        # `migrations/env.py` builds its engine straight from this property, so
        # anything added here would silently apply to migrations too.
        config = _config(db_idle_in_transaction_session_timeout="15s")

        assert config.db_connect_args == {}

    @pytest.mark.parametrize("value", ["15s", "500ms", "30000", "2min", "1h"])
    def test_accepted_values(self, value: str) -> None:
        assert (
            _config(
                db_idle_in_transaction_session_timeout=value
            ).db_idle_in_transaction_session_timeout
            == value
        )

    @pytest.mark.parametrize("value", ["", "soon", "15 seconds", "-5s", "15s;"])
    def test_a_value_postgres_would_reject_fails_at_startup(self, value: str) -> None:
        with pytest.raises(ValueError, match="DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT"):
            _config(db_idle_in_transaction_session_timeout=value)
