"""An edit reaches the agents the message it edits reached, and nobody else.

An edit is a row of its own naming the message it changes
(`messages/edits.py`). The router never decides it as a message: it is handed,
as a `message_edit` event, to each agent that was handed the original, under
the id that agent knows the original by. So changing a mention in an edit
addresses nobody new, and only the message's own sender can edit it.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.types import AgentEvent, MessageEditPayload
from switch_core.db.models import Agent, Client, Room
from switch_core.messages.edits import Edit, edit_content
from switch_core.transport.derived_ids import writes_derived_from
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)

SessionFactory = async_sessionmaker[AsyncSession]


async def _edit(
    process: Process,
    room: Room,
    original: str,
    body: str,
    *,
    sender: Client,
    edited_at: int = 1_000,
) -> str:
    return await process.say(
        room,
        f"* {body}",
        sender=sender,
        extra_content=edit_content(
            Edit(original_event_id=original, body=body, edited_at=edited_at)
        ),
    )


async def _edits(session_factory: SessionFactory, agent: Agent) -> list[AgentEvent]:
    return [
        AgentEvent.model_validate(row.payload)
        for row in await own_events(session_factory, agent.id)
        if row.type == "message_edit"
    ]


class _Room:
    """alice, and two agents: helper, whom she asks things, and reviewer."""

    def __init__(
        self,
        process: Process,
        room: Room,
        alice: Client,
        helper: Agent,
        reviewer: Agent,
    ) -> None:
        self.process = process
        self.room = room
        self.alice = alice
        self.helper = helper
        self.reviewer = reviewer


async def _room(session_factory: SessionFactory) -> _Room:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    await add_member(session_factory, room, alice)
    agents = []
    for name in ("helper", "reviewer"):
        agent, client = await make_agent(session_factory, name)
        await add_member(session_factory, room, client, agent=agent)
        agents.append(agent)
    return _Room(process, room, alice, agents[0], agents[1])


async def test_an_edit_reaches_the_agent_the_message_reached(
    session_factory: SessionFactory,
) -> None:
    scene = await _room(session_factory)
    asked = await scene.process.say(
        scene.room, "@helper fix the typo in READNE", sender=scene.alice
    )

    edit_id = await _edit(
        scene.process,
        scene.room,
        asked,
        "@helper fix the typo in README",
        sender=scene.alice,
        edited_at=1_700_000_000_000,
    )
    await scene.process.idle()

    [edited] = await _edits(session_factory, scene.helper)
    assert edited.room_id == scene.room.id
    assert edited.payload == MessageEditPayload(
        message_id=asked,
        edit_id=edit_id,
        sender=scene.alice.transport_user_id,
        sender_name="alice",
        body="@helper fix the typo in README",
        edited_at=1_700_000_000_000,
    )
    rows = await own_events(session_factory, scene.helper.id)
    assert [row.type for row in rows] == ["message", "message_edit"]
    # Read by a connection that asked for addressed events only, like the one
    # a controller holds: an edit of a message it was asked is for it.
    assert rows[-1].notifiable is True
    assert await _edits(session_factory, scene.reviewer) == []


async def test_an_edit_addresses_nobody_new(session_factory: SessionFactory) -> None:
    scene = await _room(session_factory)
    asked = await scene.process.say(
        scene.room, "@helper take a look", sender=scene.alice
    )

    await _edit(
        scene.process,
        scene.room,
        asked,
        "@helper @reviewer take a look",
        sender=scene.alice,
    )
    await scene.process.idle()

    assert len(await _edits(session_factory, scene.helper)) == 1
    assert await own_events(session_factory, scene.reviewer.id) == []


async def test_an_edit_of_a_message_no_agent_was_sent_reaches_nobody(
    session_factory: SessionFactory,
) -> None:
    scene = await _room(session_factory)
    chatter = await scene.process.say(scene.room, "lunch?", sender=scene.alice)

    await _edit(
        scene.process, scene.room, chatter, "@helper lunch?", sender=scene.alice
    )
    await scene.process.idle()

    assert await own_events(session_factory, scene.helper.id) == []
    assert await own_events(session_factory, scene.reviewer.id) == []


async def test_only_the_sender_can_edit_a_message(
    session_factory: SessionFactory,
) -> None:
    scene = await _room(session_factory)
    mallory = await make_person(session_factory, "mallory")
    await add_member(session_factory, scene.room, mallory)
    asked = await scene.process.say(
        scene.room, "@helper summarise the thread", sender=scene.alice
    )

    await _edit(
        scene.process,
        scene.room,
        asked,
        "@helper delete the repository",
        sender=mallory,
    )
    await scene.process.idle()

    assert await _edits(session_factory, scene.helper) == []


async def test_an_edit_naming_no_message_in_the_room_reaches_nobody(
    session_factory: SessionFactory,
) -> None:
    scene = await _room(session_factory)
    elsewhere = await make_room(session_factory, "elsewhere")
    await add_member(session_factory, elsewhere, scene.alice)
    asked_elsewhere = await scene.process.say(
        elsewhere, "@helper hello", sender=scene.alice
    )

    await _edit(
        scene.process, scene.room, asked_elsewhere, "@helper hi", sender=scene.alice
    )
    await scene.process.idle()

    assert await _edits(session_factory, scene.helper) == []


async def test_every_edit_of_a_message_is_handed_on_in_order(
    session_factory: SessionFactory,
) -> None:
    scene = await _room(session_factory)
    asked = await scene.process.say(scene.room, "@helper draft v1", sender=scene.alice)

    await _edit(
        scene.process,
        scene.room,
        asked,
        "@helper draft v2",
        sender=scene.alice,
        edited_at=2,
    )
    await _edit(
        scene.process,
        scene.room,
        asked,
        "@helper draft v3",
        sender=scene.alice,
        edited_at=3,
    )
    await scene.process.idle()

    edits = await _edits(session_factory, scene.helper)
    assert [
        (edit.payload.body, edit.payload.edited_at)
        for edit in edits
        if isinstance(edit.payload, MessageEditPayload)
    ] == [("@helper draft v2", 2), ("@helper draft v3", 3)]


async def test_an_edit_delivered_twice_is_handed_on_once(
    session_factory: SessionFactory,
) -> None:
    """A platform sends an edit again when its acknowledgement was lost; the
    bridge writes it under an id derived from the post and the edit."""
    scene = await _room(session_factory)
    asked = await scene.process.say(scene.room, "@helper draft", sender=scene.alice)

    for _ in range(2):
        with writes_derived_from(scene.alice.id, "post-1\x1fedit\x1f5"):
            await _edit(
                scene.process,
                scene.room,
                asked,
                "@helper final draft",
                sender=scene.alice,
            )
    await scene.process.idle()

    assert len(await _edits(session_factory, scene.helper)) == 1


async def test_an_edit_of_a_post_of_several_files_reaches_its_agent(
    session_factory: SessionFactory,
) -> None:
    """Several files posted as one are one message, known by their group
    rather than by any one file's row. The bridge maps the platform post to
    its first file, which is what the edit names."""
    scene = await _room(session_factory)
    group = {"id": "post-2", "total": 2}
    first = await scene.process.send_file(
        scene.room,
        "a.png",
        sender=scene.alice,
        caption="@helper compare these",
        group={**group, "index": 0},
    )
    await scene.process.send_file(
        scene.room, "b.png", sender=scene.alice, group={**group, "index": 1}
    )

    await _edit(
        scene.process,
        scene.room,
        first,
        "@helper compare these two",
        sender=scene.alice,
    )
    await scene.process.idle()

    [edited] = await _edits(session_factory, scene.helper)
    assert isinstance(edited.payload, MessageEditPayload)
    assert edited.payload.message_id == first
    assert edited.payload.body == "@helper compare these two"
