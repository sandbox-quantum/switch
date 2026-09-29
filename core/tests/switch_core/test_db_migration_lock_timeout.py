"""`lock_timeout` on the connection migrations run over.

A migration asks for ACCESS EXCLUSIVE on tables the running deployment is still
reading, and a lock request that queues makes every reader behind it queue too.
Bounding the wait turns "the deployment stalled for as long as one open
transaction lasted" into "the upgrade failed and the old schema is still
serving". It belongs on the migration connection and nowhere else: the
application engine's own statements take locks that waiting is the correct
response to.
"""

from __future__ import annotations

import pytest

from switch_core.config import SwitchConfig
from switch_core.db.engine import app_connect_args, migration_connect_args

_BASE_KWARGS = dict(
    db_host="db",
    db_port="5432",
    db_user="postgres",
    db_password="pw",
    db_name="switch",
    matrix_server_name="switch.local",
    agent_registration_token="token",
    jwt_secret_key="unit-test-jwt-key-unit-test-jwt-key-unit-test",
    gateway_admin_email="admin@example.com",
    gateway_admin_password="pw",
)


def _config(**overrides: object) -> SwitchConfig:
    return SwitchConfig(**{**_BASE_KWARGS, **overrides})  # type: ignore[arg-type]


class TestItIsOnByDefault:
    def test_a_bound_is_configured_without_anyone_asking(self) -> None:
        assert _config().db_migration_lock_timeout == "10s"

    def test_it_reaches_asyncpg_as_a_server_setting(self) -> None:
        assert migration_connect_args(_config()) == {
            "server_settings": {"lock_timeout": "10s"}
        }

    def test_it_composes_with_tls(self) -> None:
        config = _config(db_ssl_mode="require")

        assert migration_connect_args(config) == {
            "ssl": "require",
            "server_settings": {"lock_timeout": "10s"},
        }


class TestItAppliesToMigrationsOnly:
    def test_the_application_engine_never_sends_it(self) -> None:
        # A query killed for waiting on a busy row is a user-visible error for
        # no gain; only DDL escalates a wait into a queue behind it.
        assert "server_settings" not in app_connect_args(_config())

    def test_db_connect_args_stays_free_of_it(self) -> None:
        # `boot_lock` and `main._prepare_database` build their connections from
        # this property, and neither issues DDL that a bound would help.
        assert _config().db_connect_args == {}


class TestConfiguredValues:
    @pytest.mark.parametrize("value", ["10s", "500ms", "30000", "2min", "0"])
    def test_accepted_values(self, value: str) -> None:
        assert _config(db_migration_lock_timeout=value).db_migration_lock_timeout == (
            value
        )

    def test_zero_is_how_a_deployment_opts_out(self) -> None:
        # Postgres reads lock_timeout=0 as "wait forever", so this is the
        # pre-existing behaviour rather than a special case in our code.
        assert migration_connect_args(_config(db_migration_lock_timeout="0")) == {
            "server_settings": {"lock_timeout": "0"}
        }

    @pytest.mark.parametrize("value", ["", "soon", "10 seconds", "-5s", "10s;"])
    def test_a_value_postgres_would_reject_fails_at_startup(self, value: str) -> None:
        with pytest.raises(ValueError, match="DB_MIGRATION_LOCK_TIMEOUT"):
            _config(db_migration_lock_timeout=value)
