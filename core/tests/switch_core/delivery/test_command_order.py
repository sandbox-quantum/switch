"""A session command reaches the agent in the order it was written.

`!reset`, `!compact` and `!interrupt` are queued for the agent's controller
as own events. They are decided in the transaction that writes the command,
like every other row, so a message written after the command is numbered
after it for the agent: the agent is never handed a new task before the reset
that was meant to come first. Only the answer in the room waits for the
commit.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent
from switch_core.db.session_scope import tenant_session
from switch_core.delivery.recipient import AgentRecipient
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
    said_by,
)

ACKS = {
    "reset": "Resetting my session",
    "compact": "Compacting my session",
    "interrupt": "Interrupted my current turn",
}


@pytest.mark.parametrize("command", ["reset", "compact", "interrupt"])
async def test_a_message_written_after_a_command_reaches_the_agent_after_it(
    command: str,
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    await add_member(session_factory, room, alice)
    agent, client = await make_agent(session_factory, "worker")
    async with tenant_session(session_factory, agent.tenant_id) as session:
        await session.execute(
            update(Agent)
            .where(Agent.id == agent.id)
            .values(
                integration_profile={
                    "connection_model": "always_on",
                    "command_capabilities": {command: "always"},
                }
            )
        )
        await session.commit()
    await add_member(session_factory, room, client, agent=agent)

    # The command's answer in the room is held until the next message has
    # been written, as a slow post of the acknowledgement would.
    answering = asyncio.Event()
    written = asyncio.Event()
    reply = AgentRecipient.reply_command

    async def held_reply(self: AgentRecipient, *args: Any, **kwargs: Any) -> None:
        answering.set()
        await written.wait()
        await reply(self, *args, **kwargs)

    monkeypatch.setattr(AgentRecipient, "reply_command", held_reply)

    await process.command(room, command, "@worker", sender=alice)
    await answering.wait()
    await process.say(room, "@worker start this task", sender=alice)
    written.set()
    await process.idle()

    events = await own_events(session_factory, agent.id)
    assert [e.type for e in events] == ["command", "message"]
    assert events[0].seq < events[1].seq
    # The command was answered in the room once it had committed.
    said = [m.body or "" for m in await said_by(session_factory, room, client)]
    assert any(body.startswith(ACKS[command]) for body in said), said
