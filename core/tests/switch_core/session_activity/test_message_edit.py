"""A platform post corrected after it was relayed, carried to the turn it started.

The room keeps what was said. What a correction can still reach is a turn no
agent has picked up, so the whole of this is: find the turn that message
started, and either replace the words it will run or say that it is too late.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundMessageEdit
from switch_core.db.models import BridgeMessageMap, Client, CollaborationBridge, Message
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.session_activity_store import AgentSessionActivityStore
from switch_core.tenant_context import current_tenant_id

from .conftest import AGENT, make_room

SESSION = "session-demo"
CHANNEL = "C1"
POST = f"{CHANNEL}:1700000000.000100"
ASKED = "$asked"
TURN = "turn-1"


class Platform:
    """As much of an adapter as a correction touches."""

    def __init__(self) -> None:
        self.told: list[str] = []

    def translate_inbound(self, text: str) -> str:
        return text

    async def tell_actor(self, channel_id, actor_ref, actor_name, thread_ref, text):
        self.told.append(text)


def _watching(registry: AgentConnectionRegistry):
    conn = registry.open(
        agent_id=AGENT,
        connection_id="watcher",
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    conn.stream_attached = True
    return conn


def _bridge(
    service, registry, room_id, actor, bridge_id
) -> tuple[CollaborationCore, Platform]:
    bridge = CollaborationCore.__new__(CollaborationCore)
    platform = Platform()
    bridge._bridge_id = bridge_id
    bridge._bridge_type = "slack"
    bridge._adapter = platform  # type: ignore[assignment]
    bridge._connections = registry
    bridge._session_factory = service._sessions
    bridge._bridge_tenant_id = current_tenant_id()
    bridge._agent_store = AgentStore()
    bridge._bridge_message_map_store = BridgeMessageMapStore()
    bridge._channel_to_room = {CHANNEL: (room_id, f"!{room_id}:test")}

    async def identify(_actor) -> str | None:
        return actor

    bridge._identify_actor = identify  # type: ignore[method-assign]
    return bridge, platform


async def _asked(session_factory, room_id: str, sender: str, bridge_id: str) -> None:
    """The post as the room and the bridge both recorded it."""
    async with session_factory() as db, db.begin():
        db.add(
            Message(
                seq=1,
                room_id=room_id,
                transport_event_id=ASKED,
                sender_id=sender,
                event_type="m.room.message",
                msgtype="m.text",
                body="deploy to prod",
                content={},
            )
        )
        db.add(
            BridgeMessageMap(
                bridge_id=bridge_id,
                external_channel_id=CHANNEL,
                transport_event_id=ASKED,
                external_post_id=POST,
            )
        )


async def _turn(service, room_id: str, status: str, revision: int) -> None:
    await service.report_item(
        AGENT,
        SESSION,
        turn_id=TURN,
        item_id="turn",
        kind="turn",
        revision=revision,
        status=status,
        title="",
        text="",
        command_id="command-1",
        room_id=room_id,
        thread_id=ASKED,
        message_id=ASKED,
        occurred_at=datetime.now(UTC),
        usage=[],
    )


def _edit(content: str = "deploy to staging", revision: str = "1700000001.000200"):
    return InboundMessageEdit(
        channel_id=CHANNEL,
        sender_id="U1",
        sender_name="person",
        content=content,
        message_ref=POST,
        revision=revision,
        root_id=None,
    )


@pytest.fixture
async def room(session_factory, people) -> str:
    async with session_factory() as db, db.begin():
        return await make_room(db, member=AGENT)


@pytest.fixture
async def bridge_id(session_factory) -> str:
    async with session_factory() as db, db.begin():
        client = Client(
            transport_user_id="@bridge-edit:test", display_name="bridge", type="bridge"
        )
        db.add(client)
        await db.flush()
        bridge = CollaborationBridge(
            type="slack", display_name="Slack", client_id=client.id, status="active"
        )
        db.add(bridge)
        await db.flush()
        return bridge.id


async def test_the_turn_a_corrected_post_started_is_found_by_its_message(
    service, people, room
):
    await _turn(service, room, "queued", 1)

    async with service._sessions() as db:
        turns = await AgentSessionActivityStore().turns_for_message(db, room, ASKED)

    assert [(turn.agent_id, turn.turn_id, turn.status) for turn in turns] == [
        (AGENT, TURN, "queued")
    ]


async def test_a_correction_to_a_queued_turn_replaces_what_it_will_run(
    service, people, room, bridge_id
):
    registry = AgentConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(service, registry, room, people.owner, bridge_id)
    await _asked(service._sessions, room, people.owner, bridge_id)
    await _turn(service, room, "queued", 1)

    await bridge._handle_message_edit(_edit())

    [(_, frame)] = [(AGENT, f) for f in conn.session_commands]
    assert frame["sessionId"] == SESSION
    assert frame["body"] == {
        "type": "turn.revise",
        "turnId": TURN,
        "text": "deploy to staging",
    }
    assert frame["origin"]["messageId"] == ASKED
    assert frame["origin"]["roomId"] == room
    assert platform.told == ["Updated that message — I hadn't started it yet."]


async def test_two_corrections_of_one_post_are_two_commands(
    service, people, room, bridge_id
):
    registry = AgentConnectionRegistry()
    conn = _watching(registry)
    bridge, _ = _bridge(service, registry, room, people.owner, bridge_id)
    await _asked(service._sessions, room, people.owner, bridge_id)
    await _turn(service, room, "queued", 1)

    await bridge._handle_message_edit(_edit("once", "1700000001.000200"))
    await bridge._handle_message_edit(_edit("twice", "1700000002.000300"))

    first, second = conn.session_commands
    assert first["commandId"] != second["commandId"]
    assert [frame["body"]["text"] for frame in (first, second)] == ["once", "twice"]


async def test_a_turn_already_under_way_is_left_alone_and_said_so(
    service, people, room, bridge_id
):
    registry = AgentConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(service, registry, room, people.owner, bridge_id)
    await _asked(service._sessions, room, people.owner, bridge_id)
    await _turn(service, room, "running", 2)

    await bridge._handle_message_edit(_edit())

    assert conn.session_commands == []
    assert platform.told == [
        f"I'd already started that one — send a new message, or use "
        f"`!interrupt @{AGENT}`."
    ]


async def test_a_post_that_started_no_turn_is_left_alone(
    service, people, room, bridge_id
):
    registry = AgentConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(service, registry, room, people.owner, bridge_id)
    await _asked(service._sessions, room, people.owner, bridge_id)

    await bridge._handle_message_edit(_edit())

    assert conn.session_commands == []
    assert platform.told == []


async def test_an_edit_from_anyone_but_the_sender_changes_nothing(
    service, people, room, bridge_id
):
    registry = AgentConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(service, registry, room, people.stranger, bridge_id)
    await _asked(service._sessions, room, people.owner, bridge_id)
    await _turn(service, room, "queued", 1)

    await bridge._handle_message_edit(_edit())

    assert conn.session_commands == []
    assert platform.told == []
