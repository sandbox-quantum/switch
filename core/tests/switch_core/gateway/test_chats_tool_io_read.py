"""`GET /chats/{room}/activity` and the activity stream show a tool step's text
only while its room shows tool input and output, read from the room's row at
the time of the read.

While a room is off, every read shows a tool step without its text, whatever
its row holds; stored text is left as it is and shows again if the room is
switched back on. Other steps' text is never touched.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import update

from switch_core.db.models import Agent, AgentSessionActivityItem, Room
from switch_core.db.stores.room_store import SHOW_TOOL_IO_KEY, RoomStore
from switch_core.gateway.chats import _activity_frames
from tests.switch_core.gateway.conftest import _Harness
from tests.switch_core.gateway.test_chats_routes import _turn_change
from tests.switch_core.statement_counts import StatementCounts

TENANT = "00000000-0000-0000-0000-000000000000"
_STEPS = (
    ("turn", "turn", "running", ""),
    ("tool-1", "tool-activity", "completed", "$ cat .env\nTOKEN=abc"),
    ("tool-2", "tool-activity", "in-progress", ""),
    ("said-1", "assistant-message", "completed", "Reading the config"),
    ("asked-1", "user-message", "completed", "What is in .env?"),
)
_ALL_TEXT = {item_id: body for item_id, _kind, _status, body in _STEPS}
_NO_TOOL_TEXT = {**_ALL_TEXT, "tool-1": ""}


async def _turn_with_text(chats: _Harness, agent: Agent, room_id: str) -> None:
    """Every step written with its text, as a room showing tool text stores it."""
    async with chats.factory() as session:
        for item_id, kind, status, body in _STEPS:
            session.add(
                AgentSessionActivityItem(
                    tenant_id=TENANT,
                    agent_id=agent.id,
                    session_id="s1",
                    turn_id="t1",
                    item_id=item_id,
                    kind=kind,
                    revision=1,
                    status=status,
                    title=item_id,
                    text=body,
                    room_id=room_id,
                    occurred_at=datetime.now(UTC),
                )
            )
        await session.commit()


async def _set_shown(chats: _Harness, room_id: str, shown: bool) -> None:
    async with chats.factory() as session:
        await RoomStore().set_show_tool_io(session, room_id, shown)
        await session.commit()


async def _switch_off(chats: _Harness, room_id: str) -> None:
    """The room switched off by dropping its flag; its stored rows are left as they are."""
    async with chats.factory() as session:
        await session.execute(
            update(Room)
            .where(Room.id == room_id)
            .values(metadata_=Room.metadata_.op("-")(SHOW_TOOL_IO_KEY))
        )
        await session.commit()


async def _rest(chats: _Harness, room_id: str) -> dict[str, str]:
    response = await chats.client.get(
        f"/chats/{room_id}/activity", headers=chats.as_user(chats.alice)
    )
    assert response.status_code == 200, response.text
    return {item["itemId"]: item["text"] for item in response.json()["items"]}


async def _stream(chats: _Harness, agent: Agent, room_id: str) -> dict[str, str]:
    """What a fresh stream sends for the whole turn."""
    frames = await _activity_frames(
        chats.service, TENANT, chats.alice, _turn_change(agent, room_id, "t1"), {}
    )
    assert frames is not None
    texts = {}
    for frame in frames:
        event, data = frame.decode().strip().split("\n")
        assert event == "event: activity"
        item = json.loads(data.removeprefix("data: "))
        texts[item["itemId"]] = item["text"]
    return texts


async def _room(chats: _Harness) -> tuple[Agent, str]:
    agent = await chats.agent("helper", owner=chats.alice)
    room_id = await chats.new_chat(chats.alice, agent, "c1")
    return agent, room_id


async def test_a_room_that_shows_tool_text_sends_it(chats: _Harness) -> None:
    agent, room_id = await _room(chats)
    await _set_shown(chats, room_id, True)
    await _turn_with_text(chats, agent, room_id)

    assert await _rest(chats, room_id) == _ALL_TEXT
    assert await _stream(chats, agent, room_id) == _ALL_TEXT


async def test_a_room_that_does_not_show_tool_text_sends_none_even_if_stored(
    chats: _Harness,
) -> None:
    agent, room_id = await _room(chats)
    await _turn_with_text(chats, agent, room_id)

    assert await _rest(chats, room_id) == _NO_TOOL_TEXT
    assert await _stream(chats, agent, room_id) == _NO_TOOL_TEXT


async def test_a_row_written_before_the_switch_off_sends_none(
    chats: _Harness,
) -> None:
    agent, room_id = await _room(chats)
    await _set_shown(chats, room_id, True)
    await _turn_with_text(chats, agent, room_id)
    assert await _rest(chats, room_id) == _ALL_TEXT

    await _switch_off(chats, room_id)

    assert await _rest(chats, room_id) == _NO_TOOL_TEXT
    assert await _stream(chats, agent, room_id) == _NO_TOOL_TEXT


async def test_switching_back_on_sends_what_is_still_stored(chats: _Harness) -> None:
    agent, room_id = await _room(chats)
    await _set_shown(chats, room_id, True)
    await _turn_with_text(chats, agent, room_id)
    await _switch_off(chats, room_id)
    assert await _rest(chats, room_id) == _NO_TOOL_TEXT

    await _set_shown(chats, room_id, True)

    assert await _rest(chats, room_id) == _ALL_TEXT
    assert await _stream(chats, agent, room_id) == _ALL_TEXT


async def test_a_switch_off_after_the_access_check_hides_the_step_read_after_it(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The access check sees the room on; another session switches it off
    before the step is read; the step's frame carries no text."""
    agent, room_id = await _room(chats)
    await _set_shown(chats, room_id, True)
    await _turn_with_text(chats, agent, room_id)
    read_step = chats.service.turn_item
    seen: list[bool] = []

    async def switched_off_first(*args: Any, **kwargs: Any) -> Any:
        async with chats.factory() as other:
            seen.append(await RoomStore().show_tool_io(other, room_id))
        await _switch_off(chats, room_id)
        return await read_step(*args, **kwargs)

    monkeypatch.setattr(chats.service, "turn_item", switched_off_first)
    change = replace(_turn_change(agent, room_id, "t1"), item_id="tool-1", revision=1)

    frames = await _activity_frames(chats.service, TENANT, chats.alice, change, {})

    assert seen == [True]
    assert frames is not None and len(frames) == 1
    item = json.loads(frames[0].decode().strip().split("\n")[1].removeprefix("data: "))
    assert (item["itemId"], item["text"]) == ("tool-1", "")


async def test_a_switch_off_after_the_access_check_hides_the_turn_read_after_it(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same order for an announcement that rereads the whole turn."""
    agent, room_id = await _room(chats)
    await _set_shown(chats, room_id, True)
    await _turn_with_text(chats, agent, room_id)
    read_turn = chats.service.turn_items
    seen: list[bool] = []

    async def switched_off_first(*args: Any, **kwargs: Any) -> Any:
        async with chats.factory() as other:
            seen.append(await RoomStore().show_tool_io(other, room_id))
        await _switch_off(chats, room_id)
        return await read_turn(*args, **kwargs)

    monkeypatch.setattr(chats.service, "turn_items", switched_off_first)

    assert await _stream(chats, agent, room_id) == _NO_TOOL_TEXT
    assert seen == [True]


async def test_the_stream_reads_the_flag_once_after_the_steps(
    chats: _Harness, statement_counts: StatementCounts
) -> None:
    """One statement is added per delivered batch holding a tool step, none
    for a batch without one."""
    agent, room_id = await _room(chats)
    await _set_shown(chats, room_id, True)
    await _turn_with_text(chats, agent, room_id)

    with statement_counts.scope("turn") as turn:
        texts = await _stream(chats, agent, room_id)
    assert texts == _ALL_TEXT
    # The tenant binding, the access check, the turn, and the flag.
    assert turn.count == 4

    change = replace(_turn_change(agent, room_id, "t1"), item_id="said-1", revision=1)
    with statement_counts.scope("said") as said:
        frames = await _activity_frames(chats.service, TENANT, chats.alice, change, {})
    assert frames is not None and len(frames) == 1
    # The tenant binding, the access check, and the step.
    assert said.count == 3
