"""The router reports each message an agent was actually asked to act on.

"Asked" means addressed *and* let through: a message the addressing policy or a
budget turned away was not a request the agent received, and Switch's own
auto-replies are not anyone asking for anything. Whether the agent was there
to take it is reported alongside, not used to leave the message out.
"""

from __future__ import annotations

import dataclasses
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import (
    HEARTBEAT_LAPSED,
    PROTOCOL_VERSION,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.clients.admin_messages import AUTO_REPLY_FLAG, PLATFORM_MARKER
from switch_core.db.models import Agent, Client, Room
from switch_core.delivery import recipient as recipient_module
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.throttle import WarningThrottle
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)


class _BrokenMessageTelemetry:
    enabled = True

    def agent_addressed(self, **kwargs: Any) -> None:
        raise RuntimeError("telemetry bug")

    def observe(self, message: object) -> None:
        return None


@dataclasses.dataclass
class _Scene:
    process: Process
    room: Room
    alice: Client
    agent: Agent


@pytest.fixture
async def scene(session_factory: async_sessionmaker[AsyncSession]) -> _Scene:
    """`agent-a` in a room with alice, connected and so live there."""
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    agent, client = await make_agent(session_factory, "agent-a")
    await add_member(session_factory, room, alice)
    await add_member(session_factory, room, client, agent=agent)
    process.connections.open(
        agent_id=agent.id,
        connection_id="c1",
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    return _Scene(process, room, alice, agent)


async def _say(scene: _Scene, body: str, **content: object) -> None:
    await scene.process.say(
        scene.room, body, sender=scene.alice, extra_content=content or None
    )
    await scene.process.idle()


async def test_an_addressed_message_is_reported_once(scene: _Scene) -> None:
    await _say(scene, "@agent-a can you help")

    assert scene.process.telemetry.addressed == [
        {
            "tenant_id": scene.room.tenant_id,
            "room_id": scene.room.id,
            "sender_transport_user_id": scene.alice.transport_user_id,
            "from_platform": False,
            "agent_metadata": None,
            "agent_live": True,
            "has_attachment": False,
        }
    ]


async def test_room_chatter_is_not_reported(scene: _Scene) -> None:
    await _say(scene, "just talking")

    assert scene.process.telemetry.addressed == []


async def test_a_message_the_policy_turned_away_is_not_reported(
    session_factory: async_sessionmaker[AsyncSession], scene: _Scene
) -> None:
    restricted, client = await make_agent(
        session_factory,
        "restricted",
        addressing_policy={"rules": [{"agents": ["nobody"], "users": []}]},
    )
    await add_member(session_factory, scene.room, client, agent=restricted)

    await _say(scene, "@restricted can you help")

    assert scene.process.telemetry.addressed == []


async def test_an_auto_reply_is_not_reported(scene: _Scene) -> None:
    await _say(scene, "@agent-a can you help", **{AUTO_REPLY_FLAG: True})

    assert scene.process.telemetry.addressed == []


async def test_a_platform_message_says_it_came_from_the_platform(
    scene: _Scene,
) -> None:
    # Said by a person here rather than the admin client, which leaves the
    # open policy admitting it; the marker is what the report reads.
    await _say(scene, "@agent-a can you help", **{PLATFORM_MARKER: {}})

    [report] = scene.process.telemetry.addressed
    assert report["from_platform"] is True


async def test_a_message_to_an_offline_agent_is_reported_as_not_live(
    scene: _Scene,
) -> None:
    scene.process.connections.close("c1", HEARTBEAT_LAPSED)

    await _say(scene, "@agent-a can you help")

    [report] = scene.process.telemetry.addressed
    assert report["agent_live"] is False


async def test_a_telemetry_failure_does_not_cost_the_agent_the_message(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    session_factory: async_sessionmaker[AsyncSession],
    scene: _Scene,
) -> None:
    """Caught, so it is counted, and logged once rather than once per
    message."""
    router = scene.process.router
    router.services = dataclasses.replace(
        router.services,
        message_telemetry=_BrokenMessageTelemetry(),  # type: ignore[arg-type]
    )
    registry = MetricsRegistry()
    install(registry)
    monkeypatch.setattr(recipient_module, "_report_failures", WarningThrottle(60.0))

    try:
        with caplog.at_level("ERROR"):
            await _say(scene, "@agent-a first")
            await _say(scene, "@agent-a second")
        failures = next(
            p
            for p in registry.collect()
            if p.name == "switch.messages.observer_failures"
        )
    finally:
        uninstall()

    assert len(await own_events(session_factory, scene.agent.id)) == 2
    assert failures.numbers[0].value == 2.0
    assert dict(failures.numbers[0].attributes) == {"actor": "agent"}
    assert (
        len(
            [
                r
                for r in caplog.records
                if "Could not report a message addressed" in r.getMessage()
            ]
        )
        == 1
    )
