"""A tool step's input and output (`tool_io`) are stored only in a room that
shows them, decided on the room's row held against change. A tool step's
reported `text` is never stored, so leaving `tool_io` out gets no text past a
room's consent.

A switch-off changes only the room's setting and touches no stored row: what
was stored stays, and every read made while the room is off strips the tool
text. A switch-off and a report racing it end the same way whichever goes
first: no tool text read once the switch-off has committed. Every result is
read back on a session of its own.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api.activity_routes import ActivityReport
from switch_core.db.models import AgentSessionActivityItem
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.chats import ActivityItemView
from switch_core.sessions.errors import SessionError

from .conftest import AGENT, make_room
from .test_service import SESSION, _step

_STORE = RoomStore()
_LOCK_WAIT_SECONDS = 10.0

Factory = async_sessionmaker[AsyncSession]


async def _room(factory: Factory, *, shown: bool) -> str:
    async with factory() as db, db.begin():
        room = await make_room(db, member=AGENT)
        if shown:
            await _STORE.set_show_tool_io(db, room, True)
    return room


async def _texts(factory: Factory, room_id: str) -> dict[str, str]:
    async with factory() as db:
        rows = await db.execute(
            select(AgentSessionActivityItem.item_id, AgentSessionActivityItem.text)
            .where(AgentSessionActivityItem.room_id == room_id)
            .order_by(AgentSessionActivityItem.item_id)
        )
        return {item: body for item, body in rows.all()}


async def _shown(factory: Factory, room_id: str) -> bool:
    async with factory() as db:
        return await _STORE.show_tool_io(db, room_id)


async def _read(factory: Factory, room_id: str) -> dict[str, str]:
    """Each step's text as the activity routes send it (`ActivityItemView`),
    with the flag read from the room's row at the time of the read."""
    async with factory() as db:
        rows = (
            await db.execute(
                select(AgentSessionActivityItem)
                .where(AgentSessionActivityItem.room_id == room_id)
                .order_by(AgentSessionActivityItem.item_id)
            )
        ).scalars()
        shown = await _STORE.show_tool_io(db, room_id)
        views = [ActivityItemView.of(row, show_tool_io=shown) for row in rows]
    return {view.item_id: view.text for view in views}


@contextmanager
def _statements(factory: Factory) -> Iterator[list[str]]:
    """The SQL every connection of `factory` runs inside the block."""
    engine = factory.kw["bind"].sync_engine
    seen: list[str] = []

    def record(*args: Any) -> None:
        seen.append(args[2])

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", record)


def _held(statements: list[str]) -> list[str]:
    return [s for s in statements if "FOR SHARE" in s.upper()]


# ── The write gate ────────────────────────────────────────────────────────────


async def test_a_room_that_does_not_show_tool_io_stores_no_text(
    service, session_factory
) -> None:
    room = await _room(session_factory, shown=False)
    await service.report_item(
        AGENT, SESSION, **_step(room_id=room, text="", tool_io="$ ls\nsecret.txt")
    )
    assert await _texts(session_factory, room) == {"tool-1": ""}


async def test_a_room_that_shows_tool_io_stores_it(service, session_factory) -> None:
    room = await _room(session_factory, shown=True)
    await service.report_item(
        AGENT, SESSION, **_step(room_id=room, text="", tool_io="$ ls\nsecret.txt")
    )
    assert await _texts(session_factory, room) == {"tool-1": "$ ls\nsecret.txt"}


async def test_tool_io_with_no_room_stores_no_text(service, session_factory) -> None:
    await service.report_item(AGENT, SESSION, **_step(text="", tool_io="$ ls"))
    [step] = await service.turn_items(AGENT, SESSION, "turn-1")
    assert step.text == ""


async def test_tool_io_replaces_the_reported_text_in_a_room_that_hides_it(
    service, session_factory
) -> None:
    room = await _room(session_factory, shown=False)
    await service.report_item(
        AGENT, SESSION, **_step(room_id=room, text="from text", tool_io="from io")
    )
    assert await _texts(session_factory, room) == {"tool-1": ""}


@pytest.mark.parametrize(
    "overrides",
    [
        dict(kind="assistant-message", item_id="msg-1", status="completed"),
        dict(kind="user-message", item_id="msg-1", status="completed"),
        dict(kind="turn", item_id="turn", status="running"),
        dict(kind="notice", item_id="notice:1", status="info"),
    ],
    ids=["assistant-message", "user-message", "turn", "notice"],
)
async def test_tool_io_on_a_row_that_is_not_a_tool_step_is_refused(
    service, session_factory, overrides
) -> None:
    room = await _room(session_factory, shown=True)
    with pytest.raises(SessionError, match="Only a tool step") as refused:
        await service.report_item(
            AGENT, SESSION, **_step(room_id=room, tool_io="x", **overrides)
        )
    assert refused.value.code == "INVALID_EVENT"
    assert await _texts(session_factory, room) == {}
    # The same row without it is accepted: the refusal is about `tool_io`.
    assert await service.report_item(AGENT, SESSION, **_step(room_id=room, **overrides))


async def test_tool_io_longer_than_a_text_is_refused(service, session_factory) -> None:
    room = await _room(session_factory, shown=True)
    with pytest.raises(SessionError) as refused:
        await service.report_item(
            AGENT, SESSION, **_step(room_id=room, tool_io="x" * 8001)
        )
    assert refused.value.code == "INVALID_EVENT"


async def test_only_a_report_with_tool_io_holds_the_room(
    service, session_factory
) -> None:
    room = await _room(session_factory, shown=True)
    with _statements(session_factory) as plain:
        await service.report_item(
            AGENT, SESSION, **_step(room_id=room, text="as reported")
        )
    assert _held(plain) == []
    # Without tool_io a tool step stores no text, even in a room that shows it.
    assert await _texts(session_factory, room) == {"tool-1": ""}

    with _statements(session_factory) as with_io:
        await service.report_item(
            AGENT, SESSION, **_step(room_id=room, revision=2, text="", tool_io="io")
        )
    assert len(_held(with_io)) == 1
    assert await _texts(session_factory, room) == {"tool-1": "io"}


_PRIVATE = "OUTPUT-PRIVATE-4711"


@pytest.mark.parametrize("shown", [False, True], ids=["off", "on"])
@pytest.mark.parametrize(
    "tool_io",
    [{}, {"tool_io": None}, {"tool_io": "$ ls"}],
    ids=["tool_io-omitted", "tool_io-null", "tool_io-present"],
)
async def test_a_tool_steps_reported_text_is_never_stored(
    service, session_factory, shown, tool_io
) -> None:
    """The report as the API takes it: whether `tool_io` is left out, null or
    sent, the step's `text` is not what gets stored."""
    room = await _room(session_factory, shown=shown)
    report = ActivityReport.model_validate(
        {
            "turn_id": "t1",
            "item_id": "tool-1",
            "kind": "tool-activity",
            "revision": 1,
            "status": "completed",
            "title": "Command",
            "text": _PRIVATE,
            "command_id": None,
            "room_id": room,
            "thread_id": None,
            "message_id": None,
            "occurred_at": "2026-09-23T12:00:00Z",
            **tool_io,
        }
    )
    with _statements(session_factory) as statements:
        assert await service.report_item(
            AGENT, SESSION, **{**report.model_dump(), "usage": []}
        )
    stored = await _texts(session_factory, room)
    assert _PRIVATE not in stored["tool-1"]
    expected = "$ ls" if shown and tool_io.get("tool_io") else ""
    assert stored == {"tool-1": expected}
    # The room is read, held, only for a report that carries tool_io.
    assert len(_held(statements)) == (1 if tool_io.get("tool_io") else 0)


async def test_text_of_a_step_that_is_not_a_tool_step_is_stored_as_reported(
    service, session_factory
) -> None:
    room = await _room(session_factory, shown=False)
    await service.report_item(
        AGENT,
        SESSION,
        **_step(
            room_id=room,
            item_id="msg-1",
            kind="assistant-message",
            status="completed",
            text="prose",
        ),
    )
    assert await _texts(session_factory, room) == {"msg-1": "prose"}


# ── A switch-off racing a report ──────────────────────────────────────────────


async def _until_a_lock_wait(factory: Factory) -> None:
    deadline = asyncio.get_running_loop().time() + _LOCK_WAIT_SECONDS
    while True:
        async with factory() as db:
            waiting = (
                await db.execute(
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


async def _switch_off(factory: Factory, room_id: str) -> None:
    async with factory() as db:
        await _STORE.set_show_tool_io(db, room_id, False)
        await db.commit()


async def test_a_report_that_read_on_is_not_read_after_the_switch_off_it_held_up(
    service, session_factory, monkeypatch
) -> None:
    room = await _room(session_factory, shown=True)
    read_on = asyncio.Event()
    release = asyncio.Event()
    original = service._rooms.show_tool_io

    async def read_then_pause(db: AsyncSession, room_id: str, **kwargs: Any) -> bool:
        shown = await original(db, room_id, **kwargs)
        read_on.set()
        await release.wait()
        return shown

    monkeypatch.setattr(service._rooms, "show_tool_io", read_then_pause)
    report = asyncio.create_task(
        service.report_item(
            AGENT, SESSION, **_step(room_id=room, text="", tool_io="$ cat .env")
        )
    )
    off = None
    try:
        await asyncio.wait_for(read_on.wait(), _LOCK_WAIT_SECONDS)
        off = asyncio.create_task(_switch_off(session_factory, room))
        await _until_a_lock_wait(session_factory)
        assert not off.done()
    finally:
        release.set()
    assert await asyncio.wait_for(report, _LOCK_WAIT_SECONDS) is True
    await asyncio.wait_for(off, _LOCK_WAIT_SECONDS)

    assert await _shown(session_factory, room) is False
    # The report went first and stored its text; the switch-off left the row
    # alone, and no read after it shows that text.
    assert await _texts(session_factory, room) == {"tool-1": "$ cat .env"}
    assert await _read(session_factory, room) == {"tool-1": ""}

    # A report made after the switch-off has committed stores none.
    monkeypatch.undo()
    await service.report_item(
        AGENT,
        SESSION,
        **_step(room_id=room, revision=2, text="", tool_io="$ cat .env"),
    )
    assert await _texts(session_factory, room) == {"tool-1": ""}


async def test_a_report_waiting_on_a_switch_off_reads_it_and_stores_no_text(
    service, session_factory
) -> None:
    room = await _room(session_factory, shown=True)
    async with session_factory() as holder:
        await _STORE.set_show_tool_io(holder, room, False)
        report = asyncio.create_task(
            service.report_item(
                AGENT, SESSION, **_step(room_id=room, text="", tool_io="$ cat .env")
            )
        )
        try:
            await _until_a_lock_wait(session_factory)
            assert not report.done()
            await holder.commit()
        except BaseException:
            report.cancel()
            raise
    assert await asyncio.wait_for(report, _LOCK_WAIT_SECONDS) is True

    assert await _shown(session_factory, room) is False
    assert await _texts(session_factory, room) == {"tool-1": ""}


async def test_a_switch_off_rolled_back_leaves_the_room_and_its_text_as_they_were(
    service, session_factory
) -> None:
    room = await _room(session_factory, shown=True)
    await service.report_item(
        AGENT, SESSION, **_step(room_id=room, text="", tool_io="$ ls")
    )
    await service.report_item(
        AGENT,
        SESSION,
        **_step(
            room_id=room,
            item_id="msg-1",
            kind="assistant-message",
            status="completed",
            text="prose",
        ),
    )
    async with session_factory() as db:
        await _STORE.set_show_tool_io(db, room, False)
        await db.rollback()

    assert await _shown(session_factory, room) is True
    assert await _texts(session_factory, room) == {"msg-1": "prose", "tool-1": "$ ls"}

    with _statements(session_factory) as statements:
        await _switch_off(session_factory, room)
    # Only the room's row is written: no stored step is touched, so no change
    # is announced for any of them.
    assert [s for s in statements if "session_activity_items" in s] == []
    assert await _shown(session_factory, room) is False
    assert await _texts(session_factory, room) == {"msg-1": "prose", "tool-1": "$ ls"}
    # Read while off, the tool step shows no text; an assistant's prose does.
    assert await _read(session_factory, room) == {"msg-1": "prose", "tool-1": ""}

    # Switched back on, what is still stored is shown again.
    async with session_factory() as db:
        await _STORE.set_show_tool_io(db, room, True)
        await db.commit()
    assert await _read(session_factory, room) == {"msg-1": "prose", "tool-1": "$ ls"}
