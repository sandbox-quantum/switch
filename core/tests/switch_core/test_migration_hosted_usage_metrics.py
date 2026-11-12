"""The hosted usage metrics migration (`eb7e622cf3b0`): up, down, up again.

`tenant_usage` and `usage_budgets` both take `awake_minutes` and
`hosted_ai_calls` (a `hosted_ai_calls` budget is the gateway's daily cap). The
downgrade refuses while either table uses a new value, and once they're gone
it restores the old checks, which the upgrade then widens again.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_MIGRATION_DB = "migration_hosted_usage_metrics"
_BEFORE = "d3a7f1c2b8e4"
_UNDER_TEST = "eb7e622cf3b0"
_TENANT = "00000000-0000-0000-0000-000000000000"


def _script(config: Config) -> ScriptDirectory:
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _move(revision: str, *, down: bool = False) -> Any:
    def move(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script(config)

        def step(current: str, context: Any) -> Any:
            if down:
                return script._downgrade_revs(revision, current)
            return script._upgrade_revs(revision, current)

        with EnvironmentContext(config, script, fn=step) as environment:
            environment.configure(connection=connection)
            with environment.begin_transaction():
                environment.run_migrations()

    return move


async def _engine(postgres_url: str) -> AsyncEngine:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
        await connection.execute(text(f'CREATE DATABASE "{_MIGRATION_DB}"'))
    await admin.dispose()
    base, _, _ = postgres_url.rpartition("/")
    return create_async_engine(f"{base}/{_MIGRATION_DB}")


async def _drop(postgres_url: str) -> None:
    admin = create_async_engine(postgres_url, isolation_level="AUTOCOMMIT")
    async with admin.connect() as connection:
        await connection.execute(text(f'DROP DATABASE IF EXISTS "{_MIGRATION_DB}"'))
    await admin.dispose()


def _usage(metric: str) -> str:
    return (
        "INSERT INTO tenant_usage (tenant_id, metric, bucket_start, client_id, model, amount) "
        f"VALUES ('{_TENANT}', '{metric}', date_trunc('hour', now()), 'c-1', '', 3)"
    )


def _budget(metric: str) -> str:
    return (
        "INSERT INTO usage_budgets (id, tenant_id, agent_id, metric, model, amount_limit, period_hours) "
        f"VALUES ('b-{metric}', '{_TENANT}', NULL, '{metric}', '', 600, 720)"
    )


async def test_up_down_up(postgres_url: str) -> None:
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_move(_BEFORE))
        # Before: neither table takes the new values.
        for statement in (_usage("awake_minutes"), _budget("awake_minutes")):
            with pytest.raises(IntegrityError):
                async with engine.begin() as connection:
                    await connection.execute(text(statement))

        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
        async with engine.begin() as connection:
            await connection.execute(text(_usage("awake_minutes")))
            await connection.execute(text(_usage("hosted_ai_calls")))
            await connection.execute(text(_budget("awake_minutes")))
        # The hosted daily cap is a budget row too; Core never
        # enforces it, which test_awake_budget.py covers.
        async with engine.begin() as connection:
            await connection.execute(text(_budget("hosted_ai_calls")))

        # Down refuses while rows use the new values, and changes nothing.
        with pytest.raises(RuntimeError, match="hosted usage metric"):
            async with engine.begin() as connection:
                await connection.run_sync(_move(_BEFORE, down=True))
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "DELETE FROM tenant_usage WHERE metric IN ('awake_minutes', 'hosted_ai_calls')"
                )
            )
            await connection.execute(
                text(
                    "DELETE FROM usage_budgets"
                    " WHERE metric IN ('awake_minutes', 'hosted_ai_calls')"
                )
            )
            await connection.run_sync(_move(_BEFORE, down=True))
        with pytest.raises(IntegrityError):
            async with engine.begin() as connection:
                await connection.execute(text(_usage("awake_minutes")))

        # And up again.
        async with engine.begin() as connection:
            await connection.run_sync(_move(_UNDER_TEST))
            await connection.execute(text(_usage("awake_minutes")))
    finally:
        await engine.dispose()
        await _drop(postgres_url)


def test_the_revision_is_expand_only() -> None:
    """An older Core may serve a database at this revision."""
    revision = _script(Config(str(_CORE / "alembic.ini"))).get_revision(_UNDER_TEST)
    assert revision is not None
    assert revision.module.expand_only is True
