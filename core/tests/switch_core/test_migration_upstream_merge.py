"""The rebase onto upstream: one migration head, and the test server's way up.

Hosted agents v2's migrations started from upstream's `c7715ebb95c9`, and
upstream added 12 of its own from the same point. `4e634b519462` merges the two
heads. The test server's database is stamped `a90e3df4fe3f`, inside our chain,
so its next upgrade must run our remaining revision (`e11b7c3d9a2f`) and all 12
of upstream's, then the merge. This builds a database of its own (never the
shared test schema) and checks: one head; a fresh database upgrades to it; and
a database stopped at `a90e3df4fe3f` then upgrades to head, ending with one
object from each upstream revision that makes one, plus our `revoked_by`; and
rows already there at `a90e3df4fe3f` come through upstream's two revisions that
act on existing data (QA).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

_CORE = Path(__file__).resolve().parents[2]
_MIGRATION_DB = "migration_upstream_merge"
_HEAD = "4e634b519462"
_TEST_SERVER = "a90e3df4fe3f"
_OURS_AFTER_TEST_SERVER = "e11b7c3d9a2f"

# Upstream's 12 revisions between `9db12105a` and `473c2e64b`, each with what it
# leaves behind. A merge or a data-only revision leaves no object of its own, so
# it is checked by being on the path the upgrade ran (`_UPSTREAM` below).
_UPSTREAM = (
    "f68b679599ab",  # workspace services off by default
    "a4c1e7b93d20",  # template installs
    "b7e2f4a91c35",  # cascade room attachments
    "e5a9c3d71f08",  # merge: template installs and attachments
    "d4e8a1c5b7f3",  # console direct chats with people are groups (data only)
    "e2c7b9a4d816",  # chat reads
    "f4a9c2e7b153",  # rooms chat operation unique
    "ddd07a1fcdcb",  # session activity: room in announcements
    "b7e1d4c9a2f6",  # session activity: step in announcements
    "238c68b7306e",  # organizations
    "5c2e8f17a9d4",  # tenants bindable by user
    "9d41b7e2c6a3",  # organization audit events
)

# (revision, what to look for, SQL returning 1 when it is there)
_OBJECTS = (
    (
        "f68b679599ab",
        "tenants.services_on_by_default",
        "SELECT count(*) FROM information_schema.columns "
        "WHERE table_name = 'tenants' AND column_name = 'services_on_by_default'",
    ),
    (
        "a4c1e7b93d20",
        "table template_installs",
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'template_installs'",
    ),
    (
        "b7e2f4a91c35",
        "fk_room_agents_room ON DELETE CASCADE",
        "SELECT count(*) FROM pg_constraint "
        "WHERE conname = 'fk_room_agents_room' AND confdeltype = 'c'",
    ),
    (
        "e2c7b9a4d816",
        "table chat_reads",
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'chat_reads'",
    ),
    (
        "f4a9c2e7b153",
        "index uq_rooms_chat_operation_id",
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_rooms_chat_operation_id'",
    ),
    (
        "ddd07a1fcdcb",
        "switch_notify_session_activity() names room_id",
        "SELECT count(*) FROM pg_proc WHERE proname = 'switch_notify_session_activity' "
        "AND prosrc LIKE '%''room_id''%'",
    ),
    (
        "b7e1d4c9a2f6",
        "switch_notify_session_activity() names item_id",
        "SELECT count(*) FROM pg_proc WHERE proname = 'switch_notify_session_activity' "
        "AND prosrc LIKE '%''item_id''%'",
    ),
    (
        "238c68b7306e",
        "table organizations",
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'organizations'",
    ),
    (
        "5c2e8f17a9d4",
        "function tenants_bindable_by_user",
        "SELECT count(*) FROM pg_proc WHERE proname = 'tenants_bindable_by_user'",
    ),
    (
        "9d41b7e2c6a3",
        "table organization_audit_events",
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_name = 'organization_audit_events'",
    ),
    (
        _OURS_AFTER_TEST_SERVER,
        "agent_controllers.revoked_by",
        "SELECT count(*) FROM information_schema.columns "
        "WHERE table_name = 'agent_controllers' AND column_name = 'revoked_by'",
    ),
)


def _script() -> ScriptDirectory:
    config = Config(str(_CORE / "alembic.ini"))
    config.set_main_option("script_location", str(_CORE / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config)


def _upgrade(revision: str, ran: list[str] | None = None) -> Any:
    """Upgrade to `revision`, recording each revision applied in `ran`."""

    def move(connection: Connection) -> None:
        config = Config(str(_CORE / "alembic.ini"))
        script = _script()

        def step(current: Any, context: Any) -> Any:
            steps = script._upgrade_revs(revision, current)
            if ran is not None:
                ran.extend(s.revision.revision for s in steps)
            return steps

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


async def _version(engine: AsyncEngine) -> list[str]:
    async with engine.begin() as connection:
        rows = await connection.execute(text("SELECT version_num FROM alembic_version"))
        return sorted(row[0] for row in rows)


async def _missing(engine: AsyncEngine) -> list[str]:
    """The objects from `_OBJECTS` that aren't in the database."""
    missing = []
    async with engine.begin() as connection:
        for revision, what, query in _OBJECTS:
            if (await connection.execute(text(query))).scalar_one() != 1:
                missing.append(f"{revision}: {what}")
    return missing


def test_there_is_exactly_one_head_and_it_is_the_merge() -> None:
    script = _script()
    assert script.get_heads() == [_HEAD]
    merge = script.get_revision(_HEAD)
    assert merge is not None
    assert set(merge._all_down_revisions) == {"9d41b7e2c6a3", _OURS_AFTER_TEST_SERVER}


async def test_a_fresh_database_upgrades_to_the_head(postgres_url: str) -> None:
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade("head"))
        assert await _version(engine) == [_HEAD]
        assert await _missing(engine) == []
    finally:
        await engine.dispose()
        await _drop(postgres_url)


async def test_the_test_servers_database_upgrades_through_both_chains(
    postgres_url: str,
) -> None:
    """Stopped at `a90e3df4fe3f`, as the test server is: the next upgrade runs
    our `e11b7c3d9a2f`, all 12 of upstream's and the merge, and nothing else."""
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade(_TEST_SERVER))
        assert await _version(engine) == [_TEST_SERVER]
        # Nothing of upstream's new work, nor our last revision, is there yet.
        assert len(await _missing(engine)) == len(_OBJECTS)

        ran: list[str] = []
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade("head", ran))
        assert set(ran) == {*_UPSTREAM, _OURS_AFTER_TEST_SERVER, _HEAD}
        assert len(ran) == len(_UPSTREAM) + 2
        assert ran[-1] == _HEAD
        assert await _version(engine) == [_HEAD]
        assert await _missing(engine) == []
    finally:
        await engine.dispose()
        await _drop(postgres_url)


# Rows a database at `a90e3df4fe3f` may already hold, inserted as raw SQL in that
# revision's shape (`matrix_*` columns, every row in one workspace).
_SEED = (
    "INSERT INTO tenants (id, slug, name) VALUES ('t-mig', 't-mig', 'Mig')",
    "INSERT INTO users (id, name, email, role) VALUES "
    "('u-creator', 'Creator', 'creator@example.test', 'user'), "
    "('u-person', 'Person', 'person@example.test', 'user')",
    # A Console direct chat that another person has joined: upstream's
    # `d4e8a1c5b7f3` makes it a group. Beside it, one with nobody else in it,
    # which stays direct.
    "INSERT INTO rooms (id, matrix_room_id, name, description, tenant_id, channel_type, "
    "metadata, created_by) VALUES "
    "('r-joined', '!joined', 'Joined', '', 't-mig', 'direct', "
    """'{"chat_operation_id": "op-joined"}', 'u-creator'), """
    "('r-alone', '!alone', 'Alone', '', 't-mig', 'direct', "
    """'{"chat_operation_id": "op-alone"}', 'u-creator')""",
    "INSERT INTO clients (id, matrix_user_id, display_name, type, user_id, tenant_id) "
    "VALUES ('c-person', '@person', 'Person', 'member', 'u-person', 't-mig')",
    "INSERT INTO client_rooms (client_id, room_id, tenant_id) "
    "VALUES ('c-person', 'r-joined', 't-mig')",
    # A room with a document attached: upstream's `b7e2f4a91c35` makes deleting
    # the room take the attachment with it.
    "INSERT INTO rooms (id, matrix_room_id, name, description, tenant_id) "
    "VALUES ('r-docs', '!docs', 'Docs', '', 't-mig')",
    "INSERT INTO documents (id, name, description, instructions, content, "
    "read_visibility, write_visibility, tenant_id) "
    "VALUES ('d-one', 'Doc', '', '', 'text', 'private', 'private', 't-mig')",
    "INSERT INTO room_documents (room_id, document_id, tenant_id) "
    "VALUES ('r-docs', 'd-one', 't-mig')",
)


async def _scalar(engine: AsyncEngine, sql: str) -> Any:
    async with engine.begin() as connection:
        return (await connection.execute(text(sql))).scalar_one()


async def test_rows_already_there_come_through_upstreams_data_changes(
    postgres_url: str,
) -> None:
    """QA: the test server's database holds rows, so the upgrade from
    `a90e3df4fe3f` is checked with some in place, for the two upstream revisions
    that act on existing data."""
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade(_TEST_SERVER))
            for statement in _SEED:
                await connection.execute(text(statement))

        async with engine.begin() as connection:
            await connection.run_sync(_upgrade("head"))
        assert await _version(engine) == [_HEAD]

        # `d4e8a1c5b7f3`: the joined chat is now a group; the other stays direct.
        assert (
            await _scalar(
                engine, "SELECT channel_type FROM rooms WHERE id = 'r-joined'"
            )
            == "channel_private"
        )
        assert (
            await _scalar(engine, "SELECT channel_type FROM rooms WHERE id = 'r-alone'")
            == "direct"
        )

        # `b7e2f4a91c35`: deleting the room now removes its attachment row, and
        # leaves the document itself.
        async with engine.begin() as connection:
            await connection.execute(text("DELETE FROM rooms WHERE id = 'r-docs'"))
        assert (
            await _scalar(
                engine, "SELECT count(*) FROM room_documents WHERE room_id = 'r-docs'"
            )
            == 0
        )
        assert (
            await _scalar(engine, "SELECT count(*) FROM documents WHERE id = 'd-one'")
            == 1
        )
    finally:
        await engine.dispose()
        await _drop(postgres_url)
