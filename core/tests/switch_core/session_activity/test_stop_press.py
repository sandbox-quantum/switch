"""A press on a turn's Stop control, relayed to the session as `!interrupt` would be."""

from __future__ import annotations

import pytest
from sqlalchemy import update

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.protocol.connections import (
    SESSION_COMMAND_PROTOCOL_REVISION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.renderers import INTERRUPT_ACTION
from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.session_activity.bridge_publisher import StopTarget
from switch_core.tenant_context import current_tenant_id

from .conftest import AGENT, make_room

SESSION = "session-demo"
STATUS_POST = "1700000000.0005"


class Publisher:
    def __init__(self, target: StopTarget | None) -> None:
        self.target = target

    async def stop_target(self, channel_id: str, ref: str) -> StopTarget | None:
        return self.target if ref == STATUS_POST else None


class Platform:
    def __init__(self) -> None:
        self.told: list[str] = []

    async def tell_actor(self, channel_id, actor_ref, actor_name, thread_ref, text):
        self.told.append(text)


def _watching(registry: ConnectionRegistry):
    conn = registry.open(
        agent_id=AGENT,
        connection_id="watcher",
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=SESSION_COMMAND_PROTOCOL_REVISION),
        expected_generation=None,
    )
    conn.stream_attached = True
    return conn


@pytest.fixture
async def room(session_factory, people) -> str:
    async with session_factory() as db, db.begin():
        return await make_room(db, member=AGENT)


def _bridge(service, registry, target, mxid) -> tuple[BridgeCore, Platform]:
    bridge = BridgeCore.__new__(BridgeCore)
    platform = Platform()
    bridge._bridge_id = "bridge-1"
    bridge._bridge_type = "slack"
    bridge._adapter = platform  # type: ignore[assignment]
    bridge._activity_publisher = Publisher(target)  # type: ignore[assignment]
    bridge._session_activity_service = service
    bridge._connections = registry
    bridge._session_factory = service._sessions
    bridge._bridge_tenant_id = current_tenant_id()
    bridge._agent_store = AgentStore()

    async def identify(_actor) -> str | None:
        return mxid

    bridge._identify_actor = identify  # type: ignore[method-assign]
    return bridge, platform


def _press(turn_id: str = "turn-1", message_ref: str = STATUS_POST):
    return InboundInteraction(
        channel_id="C1",
        sender_id="U1",
        sender_name="person",
        action_id=INTERRUPT_ACTION,
        value=turn_id,
        message_ref=message_ref,
    )


def _target(room: str, running: str | None = "turn-1") -> StopTarget:
    return StopTarget(
        agent_id=AGENT,
        session_id=SESSION,
        room_id=room,
        thread_id="sw_asked",
        running_turn_id=running,
    )


async def test_a_press_is_relayed_to_the_session_as_an_interrupt(service, people, room):
    registry = ConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(service, registry, _target(room), people.owner)

    await bridge._handle_inbound_interaction(_press())
    await bridge._handle_inbound_interaction(_press())

    first, again = conn.session_commands
    assert first == again
    assert first["sessionId"] == SESSION
    assert first["epoch"] == "current"
    assert first["body"] == {"type": "turn.interrupt", "turnId": "current"}
    assert first["origin"] == {
        "surface": "slack",
        "actorId": people.owner,
        "roomId": room,
        "threadId": "sw_asked",
        "messageId": None,
    }
    assert "asked the agent to stop" in platform.told[0]


async def test_a_press_naming_a_turn_that_is_no_longer_running_is_refused(
    service, people, room
):
    registry = ConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(service, registry, _target(room, "turn-2"), people.owner)
    await bridge._handle_inbound_interaction(_press("turn-1"))
    assert conn.session_commands == []
    assert "TURN_NOT_RUNNING" in platform.told[0]


async def test_someone_who_may_not_address_the_agent_cannot_stop_it(
    service, session_factory, people, room
):
    async with session_factory() as db, db.begin():
        await db.execute(
            update(Agent)
            .where(Agent.id == AGENT)
            .values(addressing_policy=owner_only_policy([]).model_dump())
        )
    registry = ConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(service, registry, _target(room), people.stranger)
    await bridge._handle_inbound_interaction(_press())
    assert conn.session_commands == []
    assert "NOT_AUTHORIZED" in platform.told[0]


@pytest.mark.parametrize(
    ("target", "mxid", "said"),
    [
        (None, "@someone:test", "no longer connected to a live session"),
        ("room", None, "does not know who this account belongs to"),
    ],
)
async def test_a_press_nothing_resolves_says_why(service, room, target, mxid, said):
    registry = ConnectionRegistry()
    conn = _watching(registry)
    resolved = _target(room) if target == "room" else None
    bridge, platform = _bridge(service, registry, resolved, mxid)
    await bridge._handle_inbound_interaction(_press())
    assert conn.session_commands == []
    assert said in platform.told[0]


async def test_a_press_with_no_controller_attached_says_so(service, people, room):
    bridge, platform = _bridge(
        service, ConnectionRegistry(), _target(room), people.owner
    )
    await bridge._handle_inbound_interaction(_press())
    assert "controller is not connected" in platform.told[0]
