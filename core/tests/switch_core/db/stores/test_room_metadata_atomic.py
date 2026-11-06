"""Every write to a room's `metadata` is one `UPDATE` computed on the row.

Two writers of different keys cannot undo each other: the second waits on the
row and then works on what the first committed. In particular nothing written
alongside can bring back a room's `show_tool_io` after it was switched off.
Metadata that is not a JSON object (SQL NULL, JSON `null`, anything else) is
taken as `{}`. Every result is read back on a session of its own.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room
from switch_core.db.stores.room_store import (
    FOLLOW_UPS_OFF_KEY,
    LINKED_CHANNEL_NAME_KEY,
    MAIN_AGENT_KEY,
    NAME_SOURCE_KEY,
    SHOW_TOOL_IO_KEY,
    RoomStore,
    show_tool_io_in,
)

_STORE = RoomStore()
_LOCK_WAIT_SECONDS = 10.0

Factory = async_sessionmaker[AsyncSession]


async def _room(factory: Factory, metadata_sql: str | None = None) -> str:
    """A room whose `metadata` is set by the SQL expression given, if any."""
    async with factory() as session:
        room = Room(
            transport_room_id=f"!{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="",
        )
        session.add(room)
        await session.flush()
        if metadata_sql is not None:
            await session.execute(
                text(f"UPDATE rooms SET metadata = {metadata_sql} WHERE id = :r"),
                {"r": room.id},
            )
        await session.commit()
        return room.id


async def _metadata(factory: Factory, room_id: str) -> Any:
    async with factory() as session:
        return (
            await session.execute(
                text("SELECT metadata FROM rooms WHERE id = :r"), {"r": room_id}
            )
        ).scalar_one()


async def _json_type(factory: Factory, room_id: str, key: str) -> str | None:
    async with factory() as session:
        return (
            await session.execute(
                text("SELECT jsonb_typeof(metadata -> :k) FROM rooms WHERE id = :r"),
                {"k": key, "r": room_id},
            )
        ).scalar_one()


# ── The helper on every shape of stored metadata ─────────────────────────────


@pytest.mark.parametrize(
    "metadata_sql",
    ["NULL", "'null'::jsonb", "'[1, 2]'::jsonb", "'\"text\"'::jsonb", "'7'::jsonb"],
    ids=["sql-null", "json-null", "array", "string", "number"],
)
async def test_metadata_that_is_not_an_object_is_taken_as_empty(
    session_factory: Factory, metadata_sql: str
) -> None:
    room_id = await _room(session_factory, metadata_sql)
    async with session_factory() as session:
        await _STORE.set_follow_ups_enabled(session, room_id, False)
        await session.commit()
    assert await _metadata(session_factory, room_id) == {FOLLOW_UPS_OFF_KEY: True}


@pytest.mark.parametrize(
    "metadata_sql",
    ["NULL", "'null'::jsonb", "'[1, 2]'::jsonb"],
    ids=["sql-null", "json-null", "array"],
)
async def test_removing_a_key_from_metadata_that_is_not_an_object_leaves_empty(
    session_factory: Factory, metadata_sql: str
) -> None:
    room_id = await _room(session_factory, metadata_sql)
    async with session_factory() as session:
        await _STORE.set_follow_ups_enabled(session, room_id, True)
        await session.commit()
    assert await _metadata(session_factory, room_id) == {}


async def test_other_keys_are_kept_and_types_preserved(
    session_factory: Factory,
) -> None:
    room_id = await _room(
        session_factory, """'{"keep": "x", "count": 3, "nested": {"a": [1]}}'::jsonb"""
    )
    async with session_factory() as session:
        await _STORE.set_show_tool_io(session, room_id, True)
        await _STORE.set_main_agent(session, room_id, "agent-1")
        await _STORE.record_channel_name(session, room_id, "true")
        await session.commit()

    assert await _metadata(session_factory, room_id) == {
        "keep": "x",
        "count": 3,
        "nested": {"a": [1]},
        SHOW_TOOL_IO_KEY: True,
        MAIN_AGENT_KEY: "agent-1",
        LINKED_CHANNEL_NAME_KEY: "true",
    }
    assert await _json_type(session_factory, room_id, SHOW_TOOL_IO_KEY) == "boolean"
    assert await _json_type(session_factory, room_id, MAIN_AGENT_KEY) == "string"
    # A string that reads like JSON stays a string.
    assert await _json_type(session_factory, room_id, LINKED_CHANNEL_NAME_KEY) == (
        "string"
    )


async def test_a_key_is_removed_and_the_rest_kept(session_factory: Factory) -> None:
    room_id = await _room(
        session_factory,
        """'{"keep": "x", "show_tool_io": true, "main_agent_id": "a"}'::jsonb""",
    )
    async with session_factory() as session:
        await _STORE.set_show_tool_io(session, room_id, False)
        await _STORE.set_main_agent(session, room_id, None)
        await session.commit()
    assert await _metadata(session_factory, room_id) == {"keep": "x"}


async def test_the_sessions_own_room_is_refreshed(session_factory: Factory) -> None:
    room_id = await _room(session_factory, """'{"keep": "x"}'::jsonb""")
    async with session_factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        await _STORE.set_show_tool_io(session, room_id, True)
        # Read straight off the object: no lazy load, so a stale copy shows.
        assert room.metadata_ == {"keep": "x", SHOW_TOOL_IO_KEY: True}
        await _STORE.update_fields(session, room_id, name="named")
        assert room.name == "named"
        assert room.metadata_ == {
            "keep": "x",
            SHOW_TOOL_IO_KEY: True,
            NAME_SOURCE_KEY: "custom",
        }
        await session.commit()
    async with session_factory() as session:
        assert await _STORE.show_tool_io(session, room_id) is True


async def test_update_fields_marks_the_name_custom_only_when_it_changes(
    session_factory: Factory,
) -> None:
    room_id = await _room(session_factory, """'{"keep": "x"}'::jsonb""")
    async with session_factory() as session:
        await _STORE.update_fields(session, room_id, name="room", description="d")
        await session.commit()
    assert await _metadata(session_factory, room_id) == {"keep": "x"}


async def test_set_platform_name_writes_both_keys(session_factory: Factory) -> None:
    room_id = await _room(session_factory, "'null'::jsonb")
    async with session_factory() as session:
        await _STORE.set_platform_name(session, room_id, "Slack: chan", "chan")
        await session.commit()
    assert await _metadata(session_factory, room_id) == {
        NAME_SOURCE_KEY: "channel",
        LINKED_CHANNEL_NAME_KEY: "chan",
    }


@pytest.mark.parametrize(
    ("write", "message"),
    [
        (lambda s, r: _STORE.set_follow_ups_enabled(s, r, False), "does not exist"),
        (lambda s, r: _STORE.set_main_agent(s, r, None), "does not exist"),
        (lambda s, r: _STORE.set_show_tool_io(s, r, True), "Room not found"),
        (lambda s, r: _STORE.set_show_tool_io(s, r, False), "Room not found"),
        (lambda s, r: _STORE.record_channel_name(s, r, "c"), "Room not found"),
        (lambda s, r: _STORE.set_platform_name(s, r, "n", "c"), "Room not found"),
        (lambda s, r: _STORE.update_fields(s, r, name="n"), "Room not found"),
    ],
    ids=[
        "follow-ups",
        "main-agent",
        "tool-io-on",
        "tool-io-off",
        "record-channel-name",
        "set-platform-name",
        "update-fields",
    ],
)
async def test_a_missing_room_raises_value_error(
    session_factory: Factory,
    write: Callable[[AsyncSession, str], Awaitable[None]],
    message: str,
) -> None:
    async with session_factory() as session:
        with pytest.raises(ValueError, match=message):
            await write(session, "no-such-room")


async def test_show_tool_io_is_off_unless_exactly_true(
    session_factory: Factory,
) -> None:
    assert show_tool_io_in(None) is False
    assert show_tool_io_in([]) is False
    assert show_tool_io_in({}) is False
    assert show_tool_io_in({SHOW_TOOL_IO_KEY: "true"}) is False
    assert show_tool_io_in({SHOW_TOOL_IO_KEY: 1}) is False
    assert show_tool_io_in({SHOW_TOOL_IO_KEY: True}) is True
    async with session_factory() as session:
        assert await _STORE.show_tool_io(session, "no-such-room") is False
    room_id = await _room(session_factory, """'{"show_tool_io": "true"}'::jsonb""")
    async with session_factory() as session:
        assert await _STORE.show_tool_io(session, room_id) is False


# ── Switching off against every other metadata writer ────────────────────────


async def _until_a_lock_wait(factory: Factory) -> None:
    """Return once some backend is waiting on a lock; fail after a while."""
    deadline = asyncio.get_running_loop().time() + _LOCK_WAIT_SECONDS
    while True:
        async with factory() as session:
            waiting = (
                await session.execute(
                    text(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE wait_event_type = 'Lock' "
                        "AND datname = current_database()"
                    )
                )
            ).scalar_one()
        if waiting:
            return
        assert asyncio.get_running_loop().time() < deadline, "nobody waited"
        await asyncio.sleep(0.02)


Write = Callable[[AsyncSession, str], Awaitable[Any]]


async def _off(session: AsyncSession, room_id: str) -> None:
    await _STORE.set_show_tool_io(session, room_id, False)


# Each other writer, with the keys it must have left behind.
_WRITERS: dict[str, tuple[Write, dict[str, Any]]] = {
    "follow-ups": (
        lambda s, r: _STORE.set_follow_ups_enabled(s, r, False),
        {FOLLOW_UPS_OFF_KEY: True},
    ),
    "update-fields": (
        lambda s, r: _STORE.update_fields(s, r, name="renamed"),
        {NAME_SOURCE_KEY: "custom"},
    ),
    "set-platform-name": (
        lambda s, r: _STORE.set_platform_name(s, r, "Slack: chan", "chan"),
        {NAME_SOURCE_KEY: "channel", LINKED_CHANNEL_NAME_KEY: "chan"},
    ),
    "record-channel-name": (
        lambda s, r: _STORE.record_channel_name(s, r, "chan-2"),
        {LINKED_CHANNEL_NAME_KEY: "chan-2"},
    ),
}


async def _first_holds_then_second(
    factory: Factory, room_id: str, first: Write, second: Write
) -> None:
    """`first` writes and holds the row; `second` is started and must wait on
    it before `first` commits."""

    async def run_second() -> None:
        async with factory() as session:
            await second(session, room_id)
            await session.commit()

    async with factory() as holder:
        await first(holder, room_id)
        waiter = asyncio.create_task(run_second())
        try:
            await _until_a_lock_wait(factory)
            assert not waiter.done()
            await holder.commit()
        except BaseException:
            waiter.cancel()
            raise
    await asyncio.wait_for(waiter, _LOCK_WAIT_SECONDS)


@pytest.mark.parametrize("off_first", [True, False], ids=["off-first", "off-second"])
@pytest.mark.parametrize("writer", list(_WRITERS))
async def test_a_switch_off_survives_a_concurrent_metadata_write(
    session_factory: Factory, writer: str, off_first: bool
) -> None:
    room_id = await _room(
        session_factory, """'{"show_tool_io": true, "keep": "x"}'::jsonb"""
    )
    other, written = _WRITERS[writer]
    if off_first:
        await _first_holds_then_second(session_factory, room_id, _off, other)
    else:
        await _first_holds_then_second(session_factory, room_id, other, _off)

    metadata = await _metadata(session_factory, room_id)
    assert metadata == {"keep": "x", **written}
    assert show_tool_io_in(metadata) is False
    async with session_factory() as session:
        assert await _STORE.show_tool_io(session, room_id) is False
