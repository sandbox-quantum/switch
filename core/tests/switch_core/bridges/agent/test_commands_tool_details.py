"""`!tool-details` for a room: whether expanding a tool call shows what it was
given and returned, against real Postgres. The per-agent form is covered with
the other commands that act on an agent, in `test_commands_rename_delete.py`."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_tool_details
from switch_core.db.stores.room_store import (
    TOOL_DETAILS_KEY,
    RoomStore,
    tool_details_shown,
)
from switch_core.transport import RoomRef

from .test_commands_follow_ups import _host, _room


async def _run(host: SimpleNamespace, args: str) -> None:
    event = SimpleNamespace(command="tool-details", args=args, thread_id=None)
    await _cmd_tool_details(host, RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]


async def _setting(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> bool | None:
    async with session_factory() as session:
        return await RoomStore().tool_details_setting(session, room_id)


def test_the_command_is_registered_for_admins() -> None:
    assert COMMANDS_BY_NAME["tool-details"].admin_owned


@pytest.mark.parametrize(
    ("room", "agent", "shown"),
    [
        (None, None, False),
        (None, False, False),
        (None, True, True),
        (True, None, True),
        (True, False, True),
        (False, True, False),
        (False, None, False),
    ],
)
def test_the_rooms_setting_wins_over_the_agents_and_the_default_is_off(
    room: bool | None, agent: bool | None, shown: bool
) -> None:
    assert tool_details_shown(room, agent) is shown


async def test_a_room_starts_with_it_unset(session_factory) -> None:
    room_id = await _room(session_factory)
    host, posted = _host(session_factory, room_id)

    await _run(host, "")

    assert await _setting(session_factory, room_id) is None
    assert "not set" in posted[-1]


async def test_on_off_and_default_set_and_clear_the_room(session_factory) -> None:
    room_id = await _room(session_factory)
    host, posted = _host(session_factory, room_id)

    await _run(host, "on")
    assert await _setting(session_factory, room_id) is True
    assert "**on**" in posted[-1]
    assert "best effort" in posted[-1]

    await _run(host, "off")
    assert await _setting(session_factory, room_id) is False
    assert "**off**" in posted[-1]
    assert "best effort" not in posted[-1]

    await _run(host, "default")
    assert await _setting(session_factory, room_id) is None
    async with session_factory() as session:
        room = await RoomStore().get(session, room_id)
    assert room is not None and TOOL_DETAILS_KEY not in (room.metadata_ or {})


async def test_anything_else_says_how_to_use_it_and_changes_nothing(
    session_factory,
) -> None:
    room_id = await _room(session_factory)
    host, posted = _host(session_factory, room_id)

    await _run(host, "maybe")

    assert posted[-1].startswith("Usage:")
    assert await _setting(session_factory, room_id) is None
