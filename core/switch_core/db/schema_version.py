"""Refuse to serve on a schema this build's migrations have not brought to head,
unless the schema is ahead of it only by revisions it can serve on.

For a server that does not migrate at boot (`DB_MIGRATE_ON_BOOT=false`): the
migration ran somewhere else, as the schema owner, and this process holds only
the runtime role. The check is what stops a server whose migration step was
skipped or failed from serving against tables it does not expect.

During a rolling deploy, though, the newer release migrates while the older
one is still serving, and an older pod that restarts then (or a rollback)
finds a head it has no file for. It accepts that head when every revision
between it and its own head is recorded in `schema_expand_only_revisions`:
each was marked `expand_only` (it only added to the schema) and recorded as
Alembic applied it (`migrations/env.py`). Anything else is refused as before.
"""

from __future__ import annotations

import logging
from typing import Any

from alembic.config import Config as AlembicConfig
from alembic.runtime.migration import MigrationContext, MigrationInfo
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

# Far more revisions than one release ever runs ahead of another; a longer
# chain is a cycle in the table, not a deploy.
_MAX_CHAIN = 1000


def record_expand_only(
    ctx: MigrationContext,
    step: MigrationInfo,
    heads: set[str],
    run_args: dict[str, Any],
) -> None:
    """Keep `schema_expand_only_revisions` in step with what is applied.

    Runs after each revision, in its transaction. An upgrade through a
    revision whose module sets `expand_only = True` records it with the
    revision it follows; undoing one removes it. An older switch-core release,
    which has no copy of the revision's file, reads these rows to decide
    whether it can serve on the schema (`schema_ahead_through_expand_only`
    below). Alembic calls it as `on_version_apply`, from `migrations/env.py`.
    """
    if step.is_stamp or ctx.connection is None:
        return
    connection = ctx.connection
    if step.is_upgrade:
        # A `Script` in practice, which carries the revision file's module.
        script = step.up_revision
        if not getattr(getattr(script, "module", None), "expand_only", False):
            return
        (down_revision,) = step.down_revision_ids
        connection.execute(
            text(
                "INSERT INTO schema_expand_only_revisions (revision, down_revision) "
                "VALUES (:revision, :down_revision) ON CONFLICT (revision) DO NOTHING"
            ),
            {"revision": step.up_revision_id, "down_revision": down_revision},
        )
        return
    # The revision that created the table drops it as it is undone.
    if connection.scalar(text("SELECT to_regclass('schema_expand_only_revisions')")):
        connection.execute(
            text("DELETE FROM schema_expand_only_revisions WHERE revision = :revision"),
            {"revision": step.up_revision_id},
        )


class SchemaNotAtHeadError(RuntimeError):
    """The database's Alembic revision is not this build's head."""


def _current_heads(connection: Connection) -> set[str]:
    return set(MigrationContext.configure(connection).get_current_heads())


def _expand_only_parents(connection: Connection) -> dict[str, str]:
    """Each recorded expand-only revision, and the revision it follows. Empty
    on a schema from before the table existed."""
    if not connection.scalar(
        text("SELECT to_regclass('schema_expand_only_revisions')")
    ):
        return {}
    rows = connection.execute(
        text("SELECT revision, down_revision FROM schema_expand_only_revisions")
    )
    return {revision: down for revision, down in rows.all()}


def _ahead_through_expand_only(
    current: set[str],
    expected: set[str],
    known: set[str],
    parents: dict[str, str],
) -> bool:
    """Whether every head in `current` leads back to one of `expected` through
    revisions this build does not know, each recorded as expand-only, and
    every head in `expected` is reached."""
    if not current:
        return False
    reached: set[str] = set()
    for head in current:
        revision = head
        for _ in range(_MAX_CHAIN):
            if revision in known:
                break
            parent = parents.get(revision)
            if parent is None:
                return False
            revision = parent
        else:
            return False
        if revision not in expected:
            return False
        reached.add(revision)
    return reached == expected and current != expected


async def schema_ahead_through_expand_only(
    engine: AsyncEngine, alembic_cfg: AlembicConfig
) -> bool:
    """Whether the database is ahead of this build only by expand-only
    revisions: this build can serve on it, and has nothing to migrate."""
    script = ScriptDirectory.from_config(alembic_cfg)
    expected = set(script.get_heads())
    known = {revision.revision for revision in script.walk_revisions()}
    async with engine.connect() as connection:
        current = await connection.run_sync(_current_heads)
        parents = await connection.run_sync(_expand_only_parents)
    return _ahead_through_expand_only(current, expected, known, parents)


async def require_schema_at_head(
    engine: AsyncEngine, alembic_cfg: AlembicConfig
) -> None:
    expected = set(ScriptDirectory.from_config(alembic_cfg).get_heads())
    async with engine.connect() as connection:
        current = await connection.run_sync(_current_heads)
    if current == expected:
        return
    if await schema_ahead_through_expand_only(engine, alembic_cfg):
        logger.warning(
            "The database is at revision %s, ahead of this build's %s by "
            "expand-only revisions only. Serving on it: a newer release has "
            "migrated, and this one is still rolling out or being rolled back.",
            sorted(current),
            sorted(expected),
        )
        return
    raise SchemaNotAtHeadError(
        f"the database is at revision {sorted(current) or 'none'} but this "
        f"build expects {sorted(expected)}. DB_MIGRATE_ON_BOOT is false, so "
        "migrations must run before the server starts (switch-migrate, as "
        "the schema owner)."
    )
