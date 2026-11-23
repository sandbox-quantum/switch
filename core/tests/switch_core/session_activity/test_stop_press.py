"""A press on a turn's Stop control, relayed to the session as `!interrupt` would be."""

from __future__ import annotations

import pytest
from sqlalchemy import update

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundInteraction
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    SESSION_STOP_ACTION,
)
from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.session_activity.publisher import StopTarget
from switch_core.tenant_context import current_tenant_id

from .conftest import AGENT, make_room

SESSION = "session-demo"
STATUS_POST = "1700000000.0005"


class Publisher:
    def __init__(self, target: StopTarget | None) -> None:
        self.target = target
        self.stoppers: list[tuple[str, str, str]] = []

    async def stop_target(self, channel_id: str, ref: str) -> StopTarget | None:
        return self.target if ref == STATUS_POST else None

    async def record_stopper(
        self, channel_id: str, ref: str, turn_id: str, name: str
    ) -> None:
        self.stoppers.append((ref, turn_id, name))


class Platform:
    def __init__(self) -> None:
        self.told: list[str] = []
        self.told_in: list[str | None] = []
        self.restored: list[tuple[str, bool]] = []

    async def tell_actor(self, channel_id, actor_ref, actor_name, thread_ref, text):
        self.told.append(text)
        self.told_in.append(thread_ref)

    async def restore_session(self, channel_id, message_ref, *, working):
        self.restored.append((message_ref, working))


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


@pytest.fixture
async def room(session_factory, people) -> str:
    async with session_factory() as db, db.begin():
        return await make_room(db, member=AGENT)


def _bridge(service, registry, target, mxid) -> tuple[CollaborationCore, Platform]:
    bridge = CollaborationCore.__new__(CollaborationCore)
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
        sender_display_name="person",
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
    registry = AgentConnectionRegistry()
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
    registry = AgentConnectionRegistry()
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
    registry = AgentConnectionRegistry()
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
    registry = AgentConnectionRegistry()
    conn = _watching(registry)
    resolved = _target(room) if target == "room" else None
    bridge, platform = _bridge(service, registry, resolved, mxid)
    await bridge._handle_inbound_interaction(_press())
    assert conn.session_commands == []
    assert said in platform.told[0]


async def test_a_press_with_no_controller_attached_says_so(service, people, room):
    bridge, platform = _bridge(
        service, AgentConnectionRegistry(), _target(room), people.owner
    )
    await bridge._handle_inbound_interaction(_press())
    assert "controller is not connected" in platform.told[0]


def _session_stop(message_ref: str = STATUS_POST) -> InboundInteraction:
    """Slack's own Stop on an agent session: no turn, only the message."""
    return InboundInteraction(
        channel_id="C1",
        sender_id="U1",
        sender_name="person",
        sender_display_name="person",
        action_id=SESSION_STOP_ACTION,
        value="",
        message_ref=message_ref,
    )


def _shown(
    room: str, shows: str, running: str | None, thread_ref: str | None = None
) -> StopTarget:
    return StopTarget(
        agent_id=AGENT,
        session_id=SESSION,
        room_id=room,
        thread_id="sw_asked",
        running_turn_id=running,
        turn_id=shows,
        thread_ref=thread_ref,
    )


async def test_slacks_own_stop_stops_the_turn_its_message_shows(service, people, room):
    registry = AgentConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(
        service, registry, _shown(room, "turn-1", "turn-1"), people.owner
    )
    await bridge._handle_inbound_interaction(_session_stop())
    [command] = conn.session_commands
    assert command["body"] == {"type": "turn.interrupt", "turnId": "current"}
    assert "asked the agent to stop" in platform.told[0]


async def test_slacks_own_stop_leaves_a_later_turn_running(service, people, room):
    registry = AgentConnectionRegistry()
    conn = _watching(registry)
    bridge, platform = _bridge(
        service, registry, _shown(room, "turn-1", "turn-2"), people.owner
    )
    await bridge._handle_inbound_interaction(_session_stop())
    assert conn.session_commands == []
    assert "TURN_NOT_RUNNING" in platform.told[0]


async def test_who_stopped_the_turn_is_remembered_for_its_ending(service, people, room):
    registry = AgentConnectionRegistry()
    _watching(registry)
    bridge, _platform = _bridge(service, registry, _target(room), people.owner)
    await bridge._handle_inbound_interaction(_press())
    publisher = bridge._activity_publisher
    assert publisher.stoppers == [(STATUS_POST, "turn-1", "person")]  # type: ignore[union-attr]


async def test_a_refused_stop_remembers_nobody(service, people, room):
    registry = AgentConnectionRegistry()
    _watching(registry)
    bridge, _platform = _bridge(
        service, registry, _target(room, "turn-2"), people.owner
    )
    await bridge._handle_inbound_interaction(_press("turn-1"))
    assert bridge._activity_publisher.stoppers == []  # type: ignore[union-attr]


async def test_slacks_own_stop_not_acted_on_puts_the_session_back_to_working(
    service, people, room
):
    """Slack shows "Stopping…" until told otherwise: a press refused while a
    turn still runs puts the session back to working, and says why in the
    thread the turn is drawn in."""
    registry = AgentConnectionRegistry()
    _watching(registry)
    bridge, platform = _bridge(
        service, registry, _shown(room, "turn-1", "turn-2", "C1:1.0"), people.owner
    )
    await bridge._handle_inbound_interaction(_session_stop())
    assert platform.restored == [(STATUS_POST, True)]
    assert platform.told_in == ["C1:1.0"]


async def test_slacks_own_stop_with_nothing_behind_it_puts_the_session_to_rest(
    service, people, room
):
    """A thread whose turn is gone: the session is set done, and the answer
    goes to that thread rather than the channel."""
    registry = AgentConnectionRegistry()
    bridge, platform = _bridge(service, registry, None, people.owner)
    await bridge._handle_inbound_interaction(_session_stop("C1:2.0"))
    assert "no longer connected" in platform.told[0]
    assert platform.told_in == ["C1:2.0"]
    assert platform.restored == [("C1:2.0", False)]


async def test_switchs_own_stop_never_touches_the_session(service, people, room):
    registry = AgentConnectionRegistry()
    bridge, platform = _bridge(service, registry, _target(room, None), people.owner)
    await bridge._handle_inbound_interaction(_press())
    assert "TURN_NOT_RUNNING" in platform.told[0]
    assert platform.restored == []
    assert platform.told_in == [None]
