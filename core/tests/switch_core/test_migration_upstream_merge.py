"""The rebase onto upstream: one migration head, and the test server's way up.

Hosted agents v2's migrations started from upstream's `c7715ebb95c9`, and
upstream added 12 of its own from the same point. `4e634b519462` merges the two
heads, and `f3b937246dcd` joins that merge with main's later head (`10f6d02ac5bc`).
`31ab60609360` then joins `f3b937246dcd` with main's next head (`689d7d8ff913`),
after main's ten revisions from `10f6d02ac5bc`; a database at `f3b937246dcd`
(the test server since 9 Nov) upgrades through exactly those ten, that merge,
main's `95b5d17f4519` and the head. The head, `9b1630d39363`, joins
`31ab60609360` with main's `95b5d17f4519`, so a database at `31ab60609360`
upgrades through exactly `95b5d17f4519` and then the head.
The test server's database is stamped `a90e3df4fe3f`, inside our chain,
so its next upgrade must run our remaining revision (`e11b7c3d9a2f`) and all 12
of upstream's, then the merge. This builds a database of its own (never the
shared test schema) and checks: one head; a fresh database upgrades to it; and
a database stopped at `a90e3df4fe3f` then upgrades to head, ending with one
object from each upstream revision that makes one, plus our `revoked_by`; and
rows already there at `a90e3df4fe3f` come through upstream's two revisions that
act on existing data.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from switch_core.db.schema_version import record_expand_only

_CORE = Path(__file__).resolve().parents[2]
_MIGRATION_DB = "migration_upstream_merge"
_HEAD = "9b1630d39363"
_SECOND_MAIN_MERGE = "31ab60609360"
_THIRD_MAIN_HEAD = "95b5d17f4519"
_FIRST_MAIN_MERGE = "f3b937246dcd"
_SECOND_MAIN_HEAD = "689d7d8ff913"
_UPSTREAM_MERGE = "4e634b519462"
_MAIN_HEAD = "10f6d02ac5bc"
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

# Main's 8 revisions between `473c2e64b` and `0f7f96732`, which the merge
# head `_HEAD` brings in beside ours. Checked by being on the upgrade's path.
_MAIN = (
    "f2a9c7d41e08",  # announce each message's type
    "bad5099ef32b",  # auth_rows_notify
    "063652bcb450",  # index room_agents on agent_id
    "4103210581d6",  # room_access_notify
    "ad15e53358fe",  # announce after commit
    "3b81c0e5d9a7",  # external user link requests
    "22e1d92cfd4c",  # drop older links to shared accounts
    _MAIN_HEAD,  # organization connector apps
)

# Main's 10 revisions between `0f7f96732` and `807a1f94d`, from `_MAIN_HEAD` to
# `_SECOND_MAIN_HEAD`, which `_SECOND_MAIN_MERGE` joins with `_FIRST_MAIN_MERGE`.
# `_HEAD` then joins `_SECOND_MAIN_MERGE` with main's next, `_THIRD_MAIN_HEAD`.
_MAIN_AGAIN = (
    "f2b8d6c1a4e9",  # directory organizations of a user
    "a7c3e9f15b20",  # directory mirror
    "c3d9a1f7b246",  # tenants of organization
    "a3c5e7f9b1d2",  # merge owner into admin
    "a3d9f6c2b871",  # audit events outlive their tenant
    "d8a4e2c61f07",  # data retention
    "e5c1b7a93d28",  # person erasures
    "c7b2e9f4a1d6",  # session version
    "f3a8d1c6b927",  # api key expiry
    _SECOND_MAIN_HEAD,  # decision settings and pending decisions
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
    (
        _THIRD_MAIN_HEAD,
        "index ix_tenant_members_user_id",
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'ix_tenant_members_user_id'",
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
            # As `migrations/env.py` runs it, so a revision the hook can't
            # record fails here too.
            environment.configure(
                connection=connection, on_version_apply=[record_expand_only]
            )
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
    head = script.get_revision(_HEAD)
    assert head is not None
    assert set(head._all_down_revisions) == {_SECOND_MAIN_MERGE, _THIRD_MAIN_HEAD}
    merge = script.get_revision(_SECOND_MAIN_MERGE)
    assert merge is not None
    assert set(merge._all_down_revisions) == {_FIRST_MAIN_MERGE, _SECOND_MAIN_HEAD}
    first = script.get_revision(_FIRST_MAIN_MERGE)
    assert first is not None
    assert set(first._all_down_revisions) == {_UPSTREAM_MERGE, _MAIN_HEAD}
    upstream_merge = script.get_revision(_UPSTREAM_MERGE)
    assert upstream_merge is not None
    assert set(upstream_merge._all_down_revisions) == {
        "9d41b7e2c6a3",
        _OURS_AFTER_TEST_SERVER,
    }


def test_only_a_revision_with_one_parent_is_marked_expand_only() -> None:
    """`record_expand_only` records a revision with its one parent, so a merge
    marked `expand_only` would fail every real upgrade through it."""
    marked_merges = [
        script.revision
        for script in _script().walk_revisions()
        if getattr(script.module, "expand_only", False)
        and len(script._all_down_revisions) != 1
    ]
    assert marked_merges == []


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
    """Stopped at `a90e3df4fe3f`, as the test server was: the next upgrade runs
    our `e11b7c3d9a2f`, all 12 of upstream's and their merge, main's 8 and the
    merge with main, main's next 10 and the second merge, main's
    `95b5d17f4519` and the head, and nothing else."""
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
        assert set(ran) == {
            *_UPSTREAM,
            _OURS_AFTER_TEST_SERVER,
            _UPSTREAM_MERGE,
            *_MAIN,
            _FIRST_MAIN_MERGE,
            *_MAIN_AGAIN,
            _SECOND_MAIN_MERGE,
            _THIRD_MAIN_HEAD,
            _HEAD,
        }
        assert len(ran) == len(_UPSTREAM) + len(_MAIN) + len(_MAIN_AGAIN) + 6
        assert ran[-1] == _HEAD
        assert await _version(engine) == [_HEAD]
        assert await _missing(engine) == []
    finally:
        await engine.dispose()
        await _drop(postgres_url)


async def test_a_database_at_the_first_merge_runs_mains_ten_then_the_merges(
    postgres_url: str,
) -> None:
    """At `f3b937246dcd`, as the test server is since 9 November: the next
    upgrade runs main's ten revisions and the second merge, then main's
    `95b5d17f4519` and the head, and nothing else."""
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade(_FIRST_MAIN_MERGE))
        ran: list[str] = []
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade("head", ran))
        # Main's ten are one line, so run in order. `_SECOND_MAIN_MERGE` and
        # `_THIRD_MAIN_HEAD` both follow `_SECOND_MAIN_HEAD`, and nothing fixes
        # which of the two runs first; the head comes last.
        assert ran[: len(_MAIN_AGAIN)] == list(_MAIN_AGAIN)
        assert set(ran[len(_MAIN_AGAIN) : -1]) == {_SECOND_MAIN_MERGE, _THIRD_MAIN_HEAD}
        assert len(ran) == len(_MAIN_AGAIN) + 3
        assert ran[-1] == _HEAD
        assert await _version(engine) == [_HEAD]
    finally:
        await engine.dispose()
        await _drop(postgres_url)


async def test_a_database_at_the_second_merge_runs_mains_index_then_the_head(
    postgres_url: str,
) -> None:
    """At `31ab60609360`: the next upgrade runs main's `95b5d17f4519`, then
    the head, and nothing else."""
    engine = await _engine(postgres_url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade(_SECOND_MAIN_MERGE))
        assert await _version(engine) == [_SECOND_MAIN_MERGE]
        ran: list[str] = []
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade("head", ran))
        assert ran == [_THIRD_MAIN_HEAD, _HEAD]
        assert await _version(engine) == [_HEAD]
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
    """The test server's database holds rows, so the upgrade from
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
