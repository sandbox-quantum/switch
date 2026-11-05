"""The additive subagent migration preserves legacy rows and can be rolled back."""

from importlib import import_module

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import create_async_engine

migration = import_module(
    "switch_core.migrations.versions.e8a2c9d04f16_session_activity_subagent"
)


def _migrate(connection: Connection, *, upgrade: bool) -> None:
    with Operations.context(MigrationContext.configure(connection)):
        if upgrade:
            migration.upgrade()
        else:
            migration.downgrade()


async def test_subagent_migration_preserves_legacy_rows(postgres_url):
    engine = create_async_engine(postgres_url)
    try:
        async with engine.begin() as connection:
            # A temporary table shadows the application's table for this connection.
            await connection.execute(
                text(
                    "CREATE TEMPORARY TABLE session_activity_items (item_id text PRIMARY KEY) ON COMMIT DROP"
                )
            )
            await connection.execute(
                text("INSERT INTO session_activity_items VALUES ('legacy-tool')")
            )
            await connection.run_sync(lambda conn: _migrate(conn, upgrade=True))
            row = (
                await connection.execute(
                    text("SELECT item_id, subagent FROM session_activity_items")
                )
            ).one()
            assert tuple(row) == ("legacy-tool", None)
            await connection.execute(
                text(
                    "UPDATE session_activity_items SET subagent = '{\"child_id\": null}'::jsonb"
                )
            )
            assert (
                await connection.execute(
                    text("SELECT subagent FROM session_activity_items")
                )
            ).scalar_one() == {"child_id": None}
            await connection.run_sync(lambda conn: _migrate(conn, upgrade=False))
            assert (
                await connection.execute(text("SELECT * FROM session_activity_items"))
            ).one() == ("legacy-tool",)
    finally:
        await engine.dispose()
