"""Refuse to serve on a schema this build's migrations have not brought to head.

For a server that does not migrate at boot (`DB_MIGRATE_ON_BOOT=false`): the
migration ran somewhere else, as the schema owner, and this process holds only
the runtime role. The check is what stops a server whose migration step was
skipped or failed from serving against tables it does not expect.
"""

from __future__ import annotations

from alembic.config import Config as AlembicConfig
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine


class SchemaNotAtHeadError(RuntimeError):
    """The database's Alembic revision is not this build's head."""


def _current_heads(connection: Connection) -> set[str]:
    return set(MigrationContext.configure(connection).get_current_heads())


async def require_schema_at_head(
    engine: AsyncEngine, alembic_cfg: AlembicConfig
) -> None:
    expected = set(ScriptDirectory.from_config(alembic_cfg).get_heads())
    async with engine.connect() as connection:
        current = await connection.run_sync(_current_heads)
    if current != expected:
        raise SchemaNotAtHeadError(
            f"the database is at revision {sorted(current) or 'none'} but this "
            f"build expects {sorted(expected)}. DB_MIGRATE_ON_BOOT is false, so "
            "migrations must run before the server starts (switch-migrate, as "
            "the schema owner)."
        )
