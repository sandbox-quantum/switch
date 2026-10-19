"""A multi-file post completed while a room is being read is not split.

`read_conversation` reads the room's rows, then the agent's own events, and
holds back a post whose files are still arriving. Under READ COMMITTED each
statement sees what has committed by then, so whether a post is pending is
read with the rows, in one statement: the file that completes a post commits
its row and deletes the pending one together, and a reader that took the
pending state from a later statement would hand out the first file alone (and
the agent would get it again inside the addressed event).
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import MessagePayload
from switch_core.db.models import TENANT_ZERO_ID
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    process_on,
)


async def test_a_post_completed_during_a_read_is_not_split(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    agent, client = await make_agent(session_factory, "reader")
    await add_member(session_factory, room, alice)
    await add_member(session_factory, room, client, agent=agent)

    group = {"id": "grp-race", "index": 0, "total": 2}
    await process.send_file(
        room, "one.png", sender=alice, caption="two files", group=group
    )

    real = EventBuffer._conversation_in
    completed: list[bool] = []

    async def complete_the_post_first(
        self: EventBuffer, *args: Any, **kwargs: Any
    ) -> Any:
        # The second file commits after the reader has read the room's rows
        # but before it asks which posts are pending.
        if not completed:
            completed.append(True)
            await process.send_file(
                room,
                "two.png",
                sender=alice,
                group={"id": "grp-race", "index": 1, "total": 2},
            )
        return await real(self, *args, **kwargs)

    monkeypatch.setattr(EventBuffer, "_conversation_in", complete_the_post_first)

    first = await process.buffer.read_conversation(
        TENANT_ZERO_ID, agent.id, {room.id: 0}, limit=100
    )
    bodies = [
        e.event.payload.body
        for e in first.events
        if isinstance(e.event.payload, MessagePayload)
    ]
    # Expected: the post is held (nothing yet) or delivered whole. Not the
    # first file alone, flagged as an incomplete post.
    assert not any("incomplete attachment group" in (b or "") for b in bodies), bodies
