"""The per-message events, against real Postgres.

What these pin is what each event says about the room and the sender — the
platform, the room's size, who spoke — because those are read from the
database by the worker rather than handed over by the sender, and a wrong join
there would be a wrong chart with no error anywhere.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    Room,
    User,
)
from switch_core.telemetry.messages import MessageTelemetry
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord
from switch_core.transport.observer import ParticipantMessage

TENANT_ZERO = "00000000-0000-0000-0000-000000000000"


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    async def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _service(sink: _RecordingSink, *, enabled: bool = True) -> TelemetryService:
    return TelemetryService(
        sink=sink,
        enabled=enabled,
        client_id="deployment-uuid",
        service_name="switch-core",
        version="1.0.0",
        environment=None,
        telemetry_environment="prod",
        telemetry_internal=False,
    )


async def _client(session: AsyncSession, client_type: str) -> Client:
    client = Client(
        transport_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=f"{client_type} client",
        type=client_type,
    )
    session.add(client)
    await session.flush()
    return client


async def _agent(session: AsyncSession, runtime: str) -> Agent:
    slug = uuid.uuid4().hex[:10]
    owner = User(
        name="owner", email=f"owner-{slug}@test", role="user", password_hash="x"
    )
    session.add(owner)
    await session.flush()
    key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{slug}",
        encrypted_key="enc",
        label="test",
        type="agent",
    )
    backing = await _client(session, "agent")
    session.add(key)
    await session.flush()
    agent = Agent(
        name=f"agent-{slug[:6]}",
        description="d",
        agent_type="session_addressable",
        connector_type="http",
        integration_profile={},
        client_id=backing.id,
        api_key_id=key.id,
        metadata_={"known_agent_type": runtime},
    )
    session.add(agent)
    await session.flush()
    return agent


async def _room(
    session: AsyncSession, *, bridge_platform: str | None, channel_type: str
) -> Room:
    bridge_id: str | None = None
    if bridge_platform is not None:
        bridge = CollaborationBridge(
            type=bridge_platform,
            display_name="workspace",
            client_id=(await _client(session, "bridge")).id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        bridge_id = bridge.id
    room = Room(
        transport_room_id=f"!{uuid.uuid4().hex[:10]}:test",
        name="a room",
        description="",
        channel_type=channel_type,
        bridge_id=bridge_id,
    )
    session.add(room)
    await session.flush()
    return room


async def _join(session: AsyncSession, client_id: str, room: Room) -> None:
    session.add(ClientRoom(client_id=client_id, room_id=room.id))
    await session.flush()


class _World:
    """A Slack-bridged private room with two people, one Codex agent, and the
    bridge's own member — which is neither, and must count as neither."""

    room: Room
    humans: list[Client]
    agent: Agent


async def _world(session_factory: async_sessionmaker[AsyncSession]) -> _World:
    world = _World()
    async with session_factory() as session:
        world.room = await _room(
            session, bridge_platform="slack", channel_type="channel_private"
        )
        world.humans = [await _client(session, "user") for _ in range(2)]
        world.agent = await _agent(session, "codex")
        for human in world.humans:
            await _join(session, human.id, world.room)
        await _join(session, world.agent.client_id, world.room)
        await _join(session, (await _client(session, "bridge")).id, world.room)
        await session.commit()
    return world


def _said(world: _World, sender_client_id: str, role: str) -> ParticipantMessage:
    return ParticipantMessage(
        tenant_id=TENANT_ZERO,
        room_id=world.room.id,
        sender_client_id=sender_client_id,
        sender_role=role,
        has_attachment=False,
        in_thread=False,
    )


async def _reported(
    messages: MessageTelemetry, service: TelemetryService, sink: _RecordingSink
) -> list[tuple[str, dict[str, object]]]:
    await messages.aclose()
    await service.aclose()
    return [(record.name, record.properties) for record in sink.sent]


class TestRoomMessageSent:
    async def test_a_person_speaking_is_reported_with_the_room_it_was_said_in(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(_said(world, world.humans[0].id, "human"))

        assert await _reported(messages, service, sink) == [
            (
                "switch_core.room_message_sent",
                {
                    "sender_kind": "user",
                    "bridge_platform": "slack",
                    "channel_type": "channel_private",
                    "room_user_count": 2,
                    "room_agent_count": 1,
                    "has_attachment": False,
                    "in_thread": False,
                },
            )
        ]

    async def test_an_internal_room_has_no_platform(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _room(session, bridge_platform=None, channel_type="direct")
            human = await _client(session, "user")
            await _join(session, human.id, room)
            await session.commit()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(
            ParticipantMessage(
                tenant_id=TENANT_ZERO,
                room_id=room.id,
                sender_client_id=human.id,
                sender_role="human",
                has_attachment=True,
                in_thread=True,
            )
        )

        [(_, properties)] = await _reported(messages, service, sink)
        assert properties["bridge_platform"] == "none"
        assert properties["channel_type"] == "direct"
        assert properties["has_attachment"] is True
        assert properties["in_thread"] is True

    async def test_a_room_that_cannot_be_found_is_reported_as_unknown(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Still counted: a lookup problem must read as `unknown` in the chart,
        # not as fewer messages.
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(
            ParticipantMessage(
                tenant_id=TENANT_ZERO,
                room_id=str(uuid.uuid4()),
                sender_client_id="whoever",
                sender_role="human",
                has_attachment=False,
                in_thread=False,
            )
        )

        [(_, properties)] = await _reported(messages, service, sink)
        assert properties["bridge_platform"] == "unknown"
        assert properties["channel_type"] == "unknown"
        assert properties["room_user_count"] == -1
        assert properties["room_agent_count"] == -1


class TestAgentMessageSent:
    async def test_an_agent_speaking_is_also_reported_with_its_runtime(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(_said(world, world.agent.client_id, "agent"))

        reported = await _reported(messages, service, sink)
        assert [name for name, _ in reported] == [
            "switch_core.room_message_sent",
            "switch_core.agent_message_sent",
        ]
        assert reported[0][1]["sender_kind"] == "agent"
        assert reported[1][1] == {
            "known_agent_type": "codex",
            "bridge_platform": "slack",
            "channel_type": "channel_private",
            "room_user_count": 2,
            "has_attachment": False,
            "in_thread": False,
        }


class TestAgentMessageReceived:
    async def test_a_person_asking_an_agent_is_reported(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.agent_addressed(
            tenant_id=TENANT_ZERO,
            room_id=world.room.id,
            sender_transport_user_id=world.humans[0].transport_user_id,
            from_platform=False,
            agent_metadata={"known_agent_type": "claude-code"},
            has_attachment=False,
        )

        assert await _reported(messages, service, sink) == [
            (
                "switch_core.agent_message_received",
                {
                    "sender_kind": "user",
                    "known_agent_type": "claude-code",
                    "bridge_platform": "slack",
                    "channel_type": "channel_private",
                    "has_attachment": False,
                },
            )
        ]

    async def test_who_asked_is_told_apart(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)
        async with session_factory() as session:
            sender_agent = await _client(session, "agent")
            await session.commit()

        for sender, from_platform in (
            (sender_agent.transport_user_id, False),
            ("@admin:test", True),
            ("@nobody-we-know:test", False),
        ):
            messages.agent_addressed(
                tenant_id=TENANT_ZERO,
                room_id=world.room.id,
                sender_transport_user_id=sender,
                from_platform=from_platform,
                agent_metadata=None,
                has_attachment=False,
            )

        reported = await _reported(messages, service, sink)
        assert [p["sender_kind"] for _, p in reported] == [
            "agent",
            "platform",
            "unknown",
        ]
        assert {p["known_agent_type"] for _, p in reported} == {"none"}


class TestOff:
    async def test_nothing_is_queued_or_looked_up_when_telemetry_is_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink, enabled=False)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(_said(world, world.humans[0].id, "human"))
        messages.agent_addressed(
            tenant_id=TENANT_ZERO,
            room_id=world.room.id,
            sender_transport_user_id=world.humans[0].transport_user_id,
            from_platform=False,
            agent_metadata=None,
            has_attachment=False,
        )

        assert messages._worker is None
        assert await _reported(messages, service, sink) == []
