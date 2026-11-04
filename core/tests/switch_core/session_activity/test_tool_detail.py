"""A tool call's detail is kept and served only while its room shows it.

The host attaches a redacted preview of every call's input and output to the
call's row, whatever it believes the room's setting to be. Core decides: it
keeps the detail only while the room has `Room.tool_detail` on as the row is
written, and serves it only while the room still does.
"""

from __future__ import annotations

import pytest
from sqlalchemy import update

from switch_core.db.models import Room
from switch_core.db.stores.room_store import RoomStore
from switch_core.session_activity.bridge_turns import turn_view
from switch_core.session_activity.service import MAX_TOOL_DETAIL_CHARS
from switch_core.sessions.errors import SessionError

from .conftest import AGENT, make_room
from .test_service import SESSION, _step

DETAIL = "$ pytest -q\n12 passed in 0.4s"


async def _room(session_factory, *, shows: bool) -> str:
    async with session_factory() as db, db.begin():
        room = await make_room(db, member=AGENT)
        if shows:
            await _switch(db, room, on=True)
    return room


async def _switch(db, room: str, *, on: bool) -> None:
    await db.execute(update(Room).where(Room.id == room).values(tool_detail=on))


async def _report(service, room: str, *, revision: int = 1, detail=DETAIL) -> None:
    await service.report_item(
        AGENT,
        SESSION,
        **_step(
            room_id=room,
            revision=revision,
            status="completed",
            text="",
            tool_detail=detail,
        ),
    )
    await service.report_item(
        AGENT,
        SESSION,
        **_step(
            item_id="turn",
            kind="turn",
            revision=revision,
            status="running",
            title="",
            text="",
            room_id=room,
        ),
    )


async def _stored(service) -> str | None:
    rows = await service.turn_items(AGENT, SESSION, "turn-1")
    [call] = [row for row in rows if row.kind == "tool-activity"]
    return call.tool_detail


async def _served(service, session_factory, room: str) -> dict[str, str]:
    rows = await service.turn_items(AGENT, SESSION, "turn-1")
    async with session_factory() as db:
        shows = await RoomStore().shows_tool_detail(db, room, lock=False)
    view = turn_view(rows, shows_tool_detail=shows)
    assert view is not None
    return dict(view.tool_details)


async def test_a_room_starts_with_tool_detail_off_and_keeps_none(
    service, session_factory
):
    room = await _room(session_factory, shows=False)

    await _report(service, room)

    assert await _stored(service) is None
    assert await _served(service, session_factory, room) == {}


async def test_a_room_with_tool_detail_on_keeps_and_serves_it(service, session_factory):
    room = await _room(session_factory, shows=True)

    await _report(service, room)

    assert await _stored(service) == DETAIL
    assert await _served(service, session_factory, room) == {"tool-1": DETAIL}


async def test_switching_it_off_stops_serving_what_was_kept(service, session_factory):
    room = await _room(session_factory, shows=True)
    await _report(service, room)

    async with session_factory() as db, db.begin():
        await _switch(db, room, on=False)

    assert await _served(service, session_factory, room) == {}


async def test_a_host_holding_a_stale_setting_cannot_publish_into_a_room_that_turned_it_off(
    service, session_factory
):
    """The host always attaches the detail; only the room's switch as the row
    is written decides whether any of it is kept."""
    room = await _room(session_factory, shows=True)
    await _report(service, room)
    async with session_factory() as db, db.begin():
        await _switch(db, room, on=False)

    await _report(service, room, revision=2, detail="$ cat .env\nsecret-ish")

    assert await _stored(service) is None
    async with session_factory() as db, db.begin():
        await _switch(db, room, on=True)
    assert await _served(service, session_factory, room) == {}


async def test_a_step_in_no_room_keeps_no_detail(service):
    await service.report_item(
        AGENT, SESSION, **_step(status="completed", text="", tool_detail=DETAIL)
    )

    assert await _stored(service) is None


async def test_only_a_tool_call_carries_detail(service):
    with pytest.raises(SessionError, match="Only a tool call"):
        await service.report_item(
            AGENT,
            SESSION,
            **_step(
                item_id="said-1",
                kind="assistant-message",
                status="completed",
                tool_detail=DETAIL,
            ),
        )


async def test_detail_is_a_preview_with_a_ceiling(service):
    with pytest.raises(SessionError, match="detail is at most"):
        await service.report_item(
            AGENT,
            SESSION,
            **_step(tool_detail="x" * (MAX_TOOL_DETAIL_CHARS + 1)),
        )
