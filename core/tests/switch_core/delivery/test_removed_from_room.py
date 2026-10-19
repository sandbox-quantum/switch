"""What taking an agent out of a room does to what it holds.

Its own events are kept for the retention window and served to a long poll,
to the notification stream, and to a stream resuming from an old position,
none of which has a membership of its own to apply. So the removal deletes
the agent's own events in the room, in the transaction that removes the
membership, and lets go of the room in this process's memory once it
commits: the connections that claimed it, and a controller streaming the
agent.

A message written while the agent is being removed must not leave an event
behind in a room it is no longer in: the removal and the router lock the same
row of the agent's (`agent_event_heads`), and the router stores an event only
for a member. Nor may it leave the agent anything to say there: what a row
leaves an agent to say is said after the row commits, and only by a member.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.models import TENANT_ZERO_ID, Agent, Client, Message, Room
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from switch_core.provisioning.postgres import ProvisioningError
from switch_core.transport.postgres import new_event_id
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
    said_by,
)

# Lets no person address the agent, so whoever names it is refused.
_REFUSES_EVERYONE = {"rules": [{"agents": ["nobody"], "users": []}]}


@pytest.fixture
async def scene(session_factory: async_sessionmaker[AsyncSession]):  # type: ignore[no-untyped-def]
    """An agent in two rooms, addressed once in each by alice."""
    process = process_on(session_factory)
    left = await make_room(session_factory, "left")
    kept = await make_room(session_factory, "kept")
    alice = await make_person(session_factory, "alice")
    agent, client = await make_agent(session_factory, "fixer")
    for room in (left, kept):
        await add_member(session_factory, room, alice)
        await add_member(session_factory, room, client, agent=agent)
        await process.say(room, f"@fixer said in {room.name}", sender=alice)
    await process.idle()
    return process, left, kept, alice, agent, client


async def test_the_rooms_retained_events_are_forgotten(
    session_factory: async_sessionmaker[AsyncSession], scene
) -> None:  # type: ignore[no-untyped-def]
    process, left, kept, _, agent, client = scene

    await process.provisioning.kick_user(
        left.transport_room_id, client.transport_user_id
    )

    # Read at the level every reader is built on, filter or no filter: this is
    # what closes it for the stream, which has no membership of its own to
    # apply and would otherwise replay the room on every resume.
    assert [
        item.room_id
        for item in await process.buffer.read_from(TENANT_ZERO_ID, agent.id, 0)
    ] == [kept.id]


async def test_the_rooms_claim_is_released(scene) -> None:  # type: ignore[no-untyped-def]
    process, left, _, _, agent, client = scene
    conn = process.connections.open(
        agent_id=agent.id,
        connection_id="c1",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    process.connections.claim_room(conn, left.id)

    await process.provisioning.kick_user(
        left.transport_room_id, client.transport_user_id
    )

    assert conn.rooms == set()


async def test_a_room_that_cannot_be_resolved_drops_nothing(scene) -> None:  # type: ignore[no-untyped-def]
    """Rather than guessing which room was meant and emptying the wrong one."""
    process, left, kept, _, agent, client = scene

    with pytest.raises(ProvisioningError):
        await process.provisioning.kick_user("!unknown:test", client.transport_user_id)

    assert sorted(
        item.room_id
        for item in await process.buffer.read_from(TENANT_ZERO_ID, agent.id, 0)
    ) == sorted([left.id, kept.id])


async def test_a_message_routed_while_the_agent_is_removed_leaves_nothing(
    session_factory: async_sessionmaker[AsyncSession], scene
) -> None:  # type: ignore[no-untyped-def]
    """The message's transaction holds the agent's row in `agent_event_heads`
    when the removal starts, so the removal waits for it and deletes what it
    stored."""
    process, left, kept, alice, agent, client = scene

    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        routed = await process.router.store(
            session,
            tenant_id=TENANT_ZERO_ID,
            room_id=left.id,
            transport_room_id=left.transport_room_id,
            message=_message(left.id, alice, "@fixer one more"),
            attachments=[],
        )
        removal = asyncio.create_task(
            process.provisioning.kick_user(
                left.transport_room_id, client.transport_user_id
            )
        )
        await asyncio.sleep(0.3)
        assert not removal.done(), "the removal did not wait for the message"
        await session.commit()
    routed.committed()
    await removal

    assert [row.room_id for row in await own_events(session_factory, agent.id)] == [
        kept.id
    ]


async def test_a_message_decided_before_the_removal_stores_nothing_after_it(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
    scene,  # type: ignore[no-untyped-def]
) -> None:
    """Decided while the agent was a member, written once it no longer is:
    the event is stored only for a member, so nothing is."""
    process, left, kept, alice, agent, client = scene
    decided = asyncio.Event()
    removed = asyncio.Event()
    create = MessageStore.create

    async def create_after_the_removal(self, session, message, attachments):  # type: ignore[no-untyped-def]
        if message.room_id == left.id and message.body == "@fixer late":
            decided.set()
            await removed.wait()
        return await create(self, session, message, attachments)

    monkeypatch.setattr(MessageStore, "create", create_after_the_removal)
    sending = asyncio.create_task(process.say(left, "@fixer late", sender=alice))
    await decided.wait()
    await process.provisioning.kick_user(
        left.transport_room_id, client.transport_user_id
    )
    removed.set()
    await sending
    await process.idle()

    assert {row.room_id for row in await own_events(session_factory, agent.id)} == {
        kept.id
    }


async def _names_it(process: Process, room: Room, sender: Client) -> None:
    await process.say(room, "@fixer late", sender=sender)


async def _sends_it_a_file(process: Process, room: Room, sender: Client) -> None:
    await process.send_file(room, "late.png", sender=sender, caption="@fixer late")


async def _resets_it(process: Process, room: Room, sender: Client) -> None:
    await process.command(room, "reset", "@fixer", sender=sender)


@pytest.mark.parametrize(
    ("policy", "write"),
    [
        # Named while it is offline: it owes an offline notice.
        (None, _names_it),
        # Named by a sender its policy refuses: it owes a refusal.
        (_REFUSES_EVERYONE, _names_it),
        # Sent a file by a sender its policy refuses: it owes a refusal.
        (_REFUSES_EVERYONE, _sends_it_a_file),
        # Told to reset, which it cannot do: it owes the command's answer.
        (None, _resets_it),
    ],
    ids=["offline-notice", "refusal", "file-refusal", "command-answer"],
)
async def test_a_row_decided_before_the_removal_leaves_the_agent_nothing_to_say(
    policy: dict[str, Any] | None,
    write: Callable[[Process, Room, Client], Coroutine[Any, Any, None]],
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
    scene,  # type: ignore[no-untyped-def]
) -> None:
    """Decided while the agent was a member, committed once it no longer is:
    what the row left the agent to say is not said, as the agent, in a room
    it has left."""
    process, left, _, alice, agent, client = scene
    if policy is not None:
        await _set_policy(session_factory, agent, policy)
    said_before = await _said(session_factory, left, client)
    decided = asyncio.Event()
    removed = asyncio.Event()
    create = MessageStore.create

    async def create_after_the_removal(self, session, message, attachments):  # type: ignore[no-untyped-def]
        if message.room_id == left.id and message.sender_client_id == alice.id:
            decided.set()
            await removed.wait()
        return await create(self, session, message, attachments)

    monkeypatch.setattr(MessageStore, "create", create_after_the_removal)
    sending = asyncio.create_task(write(process, left, alice))
    await decided.wait()
    await process.provisioning.kick_user(
        left.transport_room_id, client.transport_user_id
    )
    removed.set()
    await sending
    await process.idle()

    assert await _said(session_factory, left, client) == said_before


async def test_an_agent_taken_out_before_its_greeting_does_not_greet(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
    scene,  # type: ignore[no-untyped-def]
) -> None:
    """Its arrival committed and left it a greeting to say, and it was taken
    out of the room before the greeting's turn came: the room's earlier work
    runs first, and a removal does not wait for it."""
    process, _, _, _, _, client = scene
    visited = await make_room(session_factory, "visited")
    # The work the arrival leaves is held back, as a room still busy with
    # earlier work would hold it, and handed on once the agent is out.
    owed: list[tuple[Any, ...]] = []
    owe = process.router.after_commit
    monkeypatch.setattr(process.router, "after_commit", lambda *work: owed.append(work))

    await process.provisioning.invite_to_room(
        visited.transport_room_id, client.transport_user_id
    )
    await process.provisioning.kick_user(
        visited.transport_room_id, client.transport_user_id
    )
    assert owed, "the arrival left the agent no greeting to say"
    for work in owed:
        owe(*work)
    await process.idle()

    assert await _said(session_factory, visited, client) == []


async def _set_policy(
    session_factory: async_sessionmaker[AsyncSession],
    agent: Agent,
    policy: dict[str, Any],
) -> None:
    async with tenant_session(session_factory, agent.tenant_id) as session:
        await session.execute(
            update(Agent).where(Agent.id == agent.id).values(addressing_policy=policy)
        )
        await session.commit()


async def _said(
    session_factory: async_sessionmaker[AsyncSession], room: Room, client: Client
) -> list[str | None]:
    """What `client` has said in `room`, oldest first."""
    return [said.body for said in await said_by(session_factory, room, client)]


def _message(room_id: str, sender, body: str) -> Message:  # type: ignore[no-untyped-def]
    return Message(
        room_id=room_id,
        transport_event_id=new_event_id(),
        sender_id=sender.transport_user_id,
        sender_client_id=sender.id,
        sender_name=sender.display_name,
        event_type="m.room.message",
        msgtype="m.text",
        body=body,
        content={"body": body, "msgtype": "m.text"},
    )
