"""The per-message events, against real Postgres.

What these pin is what each event says about the room and the sender — the
platform, the room's size, who spoke — because those are read from the
database by the worker rather than handed over by the sender, and a wrong join
there would be a wrong chart with no error anywhere.
"""

from __future__ import annotations

import asyncio
import dataclasses
import time
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.chats import CHAT_OPERATION_ID_KEY, MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    Room,
    User,
)
from switch_core.telemetry import messages as messages_module
from switch_core.telemetry.messages import (
    MessageTelemetry,
    _RoomFacts,
    _Sender,
    _TtlCache,
)
from switch_core.telemetry.service import TelemetryService
from switch_core.telemetry.sink import TelemetryRecord
from switch_core.transport.observer import ParticipantMessage
from tests.session_counting import CountingSessionFactory
from tests.telemetry_records import declared

TENANT_ZERO = "00000000-0000-0000-0000-000000000000"


class _RecordingSink:
    def __init__(self) -> None:
        self.sent: list[TelemetryRecord] = []

    def send(self, record: TelemetryRecord) -> None:
        self.sent.append(record)

    async def aclose(self) -> None:
        return None


def _service(sink: _RecordingSink, *, enabled: bool = True) -> TelemetryService:
    return TelemetryService(
        sink=sink,
        enabled=enabled,
        client_id="deployment-uuid",
        version="1.0.0",
        telemetry_environment="prod",
        telemetry_internal=False,
        deployment_kind="self_hosted",
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
        sender_is_app=False,
        from_console=False,
        has_attachment=False,
        in_thread=False,
    )


def _said_in(
    room_id: str, *, sender_role: str = "human", sender_client_id: str = "someone"
) -> ParticipantMessage:
    return ParticipantMessage(
        tenant_id=TENANT_ZERO,
        room_id=room_id,
        sender_client_id=sender_client_id,
        sender_role=sender_role,
        sender_is_app=False,
        from_console=False,
        has_attachment=False,
        in_thread=False,
    )


async def _a_slack_room(tenant_id: str, room_id: str) -> _RoomFacts:
    return _RoomFacts(
        bridge_platform="slack",
        channel_type="channel_public",
        user_count=1,
        agent_count=1,
        console_chat="false",
    )


class _Unreachable:
    """A session factory for a database that will not answer."""

    def __init__(self) -> None:
        self.attempts = 0

    def __call__(self) -> object:
        self.attempts += 1
        raise ConnectionError("database unreachable")


def _one_at_a_time(messages: MessageTelemetry) -> None:
    """Leave out the read of the whole workspace (`MessageTelemetry._read_tenant`),
    so each room, sender and agent is looked up on its own, as these tests
    count."""

    async def _not_read(tenant_id: str) -> None:
        return None

    messages._read_tenant = _not_read  # type: ignore[method-assign]


async def _reported(
    messages: MessageTelemetry, service: TelemetryService, sink: _RecordingSink
) -> list[tuple[str, dict[str, object]]]:
    # What was queued, reported before shutdown: `aclose` gives the queue only
    # a fraction of a second, which a slow first lookup on a busy CI runner can
    # outlast. The tests about what shutdown drops close it themselves.
    async with asyncio.timeout(10):
        await messages._queue.join()
    await messages.aclose()
    await service.aclose()
    return [(record.name, declared(record)) for record in sink.sent]


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
                    "sender_surface": "messaging_app",
                    "bridge_platform": "slack",
                    "channel_type": "channel_private",
                    "console_chat": "false",
                    "room_user_count": 2,
                    "room_agent_count": 1,
                    "has_attachment": False,
                    "in_thread": False,
                },
            )
        ]

    async def test_an_integration_posting_is_a_bot_not_a_user(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The bridge writes an app's post through a human actor like anyone
        else's; its mark is what keeps it out of the people count."""
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(
            dataclasses.replace(
                _said(world, world.humans[0].id, "human"), sender_is_app=True
            )
        )

        reported = await _reported(messages, service, sink)
        assert [p["sender_kind"] for _, p in reported] == ["bot"]

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
                sender_is_app=False,
                from_console=False,
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
                sender_is_app=False,
                from_console=False,
                has_attachment=False,
                in_thread=False,
            )
        )

        [(_, properties)] = await _reported(messages, service, sink)
        assert properties["bridge_platform"] == "unknown"
        assert properties["channel_type"] == "unknown"
        assert properties["room_user_count"] == -1
        assert properties["room_agent_count"] == -1
        assert properties["console_chat"] == "unknown"

    async def test_a_console_chat_message_says_where_it_was_written(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A person writing in Switch Console writes through their `member`
        client, which is one of the room's people like a platform identity."""
        async with session_factory() as session:
            room = await _room(session, bridge_platform=None, channel_type="direct")
            room.metadata_ = {CHAT_OPERATION_ID_KEY: "op"}
            member = await _client(session, MEMBER_CLIENT_TYPE)
            agent = await _agent(session, "claude-code")
            await _join(session, member.id, room)
            await _join(session, agent.client_id, room)
            await session.commit()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(
            dataclasses.replace(
                _said_in(room.id, sender_client_id=member.id), from_console=True
            )
        )

        [(_, properties)] = await _reported(messages, service, sink)
        assert properties["sender_kind"] == "user"
        assert properties["sender_surface"] == "console"
        assert properties["console_chat"] == "true"
        assert properties["room_user_count"] == 1
        assert properties["room_agent_count"] == 1


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
            "console_chat": "false",
            "room_user_count": 2,
            "has_attachment": False,
            "in_thread": False,
        }

    async def test_an_agent_that_cannot_be_found_has_an_unknown_runtime(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Not `none`, which is a real answer — an agent that declares no
        runtime. A lookup problem must not read as a population of those."""
        world = await _world(session_factory)
        async with session_factory() as session:
            unregistered = await _client(session, "agent")
            await session.commit()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(_said(world, unregistered.id, "agent"))

        reported = await _reported(messages, service, sink)
        assert reported[1][1]["known_agent_type"] == "unknown"


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
            from_app=False,
            agent_metadata={"known_agent_type": "claude-code"},
            agent_live=True,
            has_attachment=False,
        )

        assert await _reported(messages, service, sink) == [
            (
                "switch_core.agent_message_received",
                {
                    "sender_kind": "user",
                    "sender_surface": "messaging_app",
                    "known_agent_type": "claude-code",
                    "bridge_platform": "slack",
                    "channel_type": "channel_private",
                    "console_chat": "false",
                    "has_attachment": False,
                    "agent_live": True,
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
                from_app=False,
                agent_metadata=None,
                agent_live=False,
                has_attachment=False,
            )

        reported = await _reported(messages, service, sink)
        assert [p["sender_kind"] for _, p in reported] == [
            "agent",
            "platform",
            "unknown",
        ]
        assert [p["sender_surface"] for _, p in reported] == [
            "none",
            "none",
            "unknown",
        ]
        assert {p["known_agent_type"] for _, p in reported} == {"none"}

    async def test_an_integration_asking_an_agent_is_a_bot(
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
            from_app=True,
            agent_metadata=None,
            agent_live=True,
            has_attachment=False,
        )

        reported = await _reported(messages, service, sink)
        assert [p["sender_kind"] for _, p in reported] == ["bot"]


class TestConsoleSenders:
    async def test_a_person_asking_from_console_is_a_user_in_console(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        async with session_factory() as session:
            member = await _client(session, MEMBER_CLIENT_TYPE)
            await session.commit()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.agent_addressed(
            tenant_id=TENANT_ZERO,
            room_id=world.room.id,
            sender_transport_user_id=member.transport_user_id,
            from_platform=False,
            from_app=False,
            agent_metadata=None,
            agent_live=True,
            has_attachment=False,
        )

        [(_, properties)] = await _reported(messages, service, sink)
        assert properties["sender_kind"] == "user"
        assert properties["sender_surface"] == "console"
        assert properties["console_chat"] == "false"


class TestFailingLookups:
    async def test_a_room_whose_lookup_failed_is_not_retried_and_warns_once(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """A busy room whose lookup fails must not cost a query, and a
        traceback, for every message said in it."""
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)
        attempts = 0

        async def _broken(tenant_id: str, room_id: str) -> None:
            nonlocal attempts
            attempts += 1
            raise ConnectionError("database unreachable")

        messages._load_room_facts = _broken  # type: ignore[method-assign]

        _one_at_a_time(messages)

        with caplog.at_level("WARNING"):
            for _ in range(3):
                messages.observe(_said(world, world.humans[0].id, "human"))
            reported = await _reported(messages, service, sink)

        assert attempts == 1
        assert [p["bridge_platform"] for _, p in reported] == ["unknown"] * 3
        assert (
            len([r for r in caplog.records if "could not look up" in r.getMessage()])
            == 1
        )

    async def test_one_failing_room_does_not_blank_the_others(self) -> None:
        """The pause is the failing key's: one tenant or room that keeps
        failing must not turn every other room's events into `unknown`."""
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        attempts: list[tuple[str, str]] = []

        async def _bad_room_fails(tenant_id: str, room_id: str) -> _RoomFacts:
            attempts.append((tenant_id, room_id))
            if room_id == "bad":
                raise ConnectionError("this room's lookup fails")
            return await _a_slack_room(tenant_id, room_id)

        messages._load_room_facts = _bad_room_fails  # type: ignore[method-assign]

        _one_at_a_time(messages)
        other_tenant = str(uuid.uuid4())

        messages.observe(_said_in("bad"))
        messages.observe(_said_in("good"))
        messages.observe(
            ParticipantMessage(
                tenant_id=other_tenant,
                room_id="elsewhere",
                sender_client_id="someone",
                sender_role="human",
                sender_is_app=False,
                from_console=False,
                has_attachment=False,
                in_thread=False,
            )
        )
        messages.observe(_said_in("bad"))
        reported = await _reported(messages, service, sink)

        assert [p["bridge_platform"] for _, p in reported] == [
            "unknown",
            "slack",
            "slack",
            "unknown",
        ]
        assert attempts == [
            (TENANT_ZERO, "bad"),
            (TENANT_ZERO, "good"),
            (other_tenant, "elsewhere"),
        ]

    async def test_failures_in_a_row_pause_every_lookup(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Failing for several different keys with nothing succeeding between
        is the database, not a bad row: then every lookup waits."""
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        attempts: list[str] = []

        async def _broken(tenant_id: str, room_id: str) -> None:
            attempts.append(room_id)
            raise ConnectionError("database unreachable")

        messages._load_room_facts = _broken  # type: ignore[method-assign]

        _one_at_a_time(messages)

        with caplog.at_level("WARNING"):
            for room in ("a", "b", "c", "d", "e"):
                messages.observe(_said_in(room))
            reported = await _reported(messages, service, sink)

        assert attempts == ["a", "b", "c"]
        assert [p["bridge_platform"] for _, p in reported] == ["unknown"] * 5
        assert "failed 3 times in a row, so every lookup pauses" in caplog.text

    async def test_a_lookup_that_succeeds_resets_the_count(self) -> None:
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        attempts: list[str] = []

        async def _only_good_answers(tenant_id: str, room_id: str) -> _RoomFacts:
            attempts.append(room_id)
            if room_id != "good":
                raise ConnectionError("this room's lookup fails")
            return await _a_slack_room(tenant_id, room_id)

        messages._load_room_facts = _only_good_answers  # type: ignore[method-assign]

        _one_at_a_time(messages)

        for room in ("a", "b", "good", "c", "d"):
            messages.observe(_said_in(room))
        await _reported(messages, service, sink)

        assert attempts == ["a", "b", "good", "c", "d"]


class TestCaching:
    async def test_a_senders_kind_is_read_once_while_cached(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        def _ask() -> None:
            messages.agent_addressed(
                tenant_id=TENANT_ZERO,
                room_id=world.room.id,
                sender_transport_user_id=world.humans[0].transport_user_id,
                from_platform=False,
                from_app=False,
                agent_metadata=None,
                agent_live=True,
                has_attachment=False,
            )

        _ask()
        await messages._queue.join()
        async with session_factory() as session:
            sender = await session.get(Client, world.humans[0].id)
            assert sender is not None
            sender.type = "agent"
            await session.commit()
        _ask()

        reported = await _reported(messages, service, sink)
        assert [p["sender_kind"] for _, p in reported] == ["user", "user"]

    async def test_an_agents_runtime_is_read_once_while_cached(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        messages.observe(_said(world, world.agent.client_id, "agent"))
        await messages._queue.join()
        async with session_factory() as session:
            agent = await session.get(Agent, world.agent.id)
            assert agent is not None
            agent.metadata_ = {"known_agent_type": "claude-code"}
            await session.commit()
        messages.observe(_said(world, world.agent.client_id, "agent"))

        reported = await _reported(messages, service, sink)
        assert [
            p["known_agent_type"]
            for name, p in reported
            if name == "switch_core.agent_message_sent"
        ] == ["codex", "codex"]

    async def test_a_room_that_cannot_be_found_is_looked_up_once(self) -> None:
        """A room deleted while its last messages were queued must not cost a
        query per message."""
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        loads = 0

        async def _gone(tenant_id: str, room_id: str) -> None:
            nonlocal loads
            loads += 1
            return None

        messages._load_room_facts = _gone  # type: ignore[method-assign]

        _one_at_a_time(messages)

        for _ in range(3):
            messages.observe(_said_in("deleted-room"))
        reported = await _reported(messages, service, sink)

        assert loads == 1
        assert [p["bridge_platform"] for _, p in reported] == ["unknown"] * 3

    async def test_a_sender_or_agent_that_cannot_be_found_is_looked_up_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The miss is cached like a hit: a row that appears afterwards is not
        seen until the entry expires."""
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)
        late_sender = f"@late-{uuid.uuid4().hex[:8]}:test"
        async with session_factory() as session:
            unregistered = await _client(session, "agent")
            await session.commit()

        def _activity() -> None:
            messages.agent_addressed(
                tenant_id=TENANT_ZERO,
                room_id=world.room.id,
                sender_transport_user_id=late_sender,
                from_platform=False,
                from_app=False,
                agent_metadata=None,
                agent_live=True,
                has_attachment=False,
            )
            messages.observe(_said(world, unregistered.id, "agent"))

        _activity()
        await messages._queue.join()
        async with session_factory() as session:
            session.add(
                Client(transport_user_id=late_sender, display_name="late", type="user")
            )
            owner = await _agent(session, "codex")
            owner.client_id = unregistered.id
            await session.commit()
        _activity()

        reported = await _reported(messages, service, sink)
        assert [
            p["sender_kind"]
            for name, p in reported
            if name == "switch_core.agent_message_received"
        ] == ["unknown", "unknown"]
        assert [
            p["known_agent_type"]
            for name, p in reported
            if name == "switch_core.agent_message_sent"
        ] == ["unknown", "unknown"]


class TestTheWholeWorkspace:
    """The first lookup that misses reads every open room, client and agent
    of the workspace at once (`MessageTelemetry._read_tenant`): in a workspace
    of thousands, a process reports on most of them before it reports a second
    message about any, so one lookup each missed for most messages."""

    async def test_other_rooms_senders_and_agents_cost_no_read(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        async with session_factory() as session:
            other = await _room(session, bridge_platform=None, channel_type="direct")
            await _join(session, world.humans[1].id, other)
            await session.commit()
        counting = CountingSessionFactory(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=counting)  # type: ignore[arg-type]

        messages.observe(_said(world, world.agent.client_id, "agent"))
        await messages._queue.join()
        assert counting.opened == 1
        messages.observe(_said_in(other.id, sender_client_id=world.humans[1].id))
        messages.agent_addressed(
            tenant_id=TENANT_ZERO,
            room_id=other.id,
            sender_transport_user_id=world.humans[1].transport_user_id,
            from_platform=False,
            from_app=False,
            agent_metadata=None,
            agent_live=True,
            has_attachment=False,
        )
        reported = await _reported(messages, service, sink)

        assert counting.opened == 1
        facts = {
            (name, p.get("bridge_platform"), p.get("room_user_count"))
            for name, p in reported
        }
        assert ("switch_core.room_message_sent", "slack", 2) in facts
        assert ("switch_core.room_message_sent", "none", 1) in facts
        assert [
            p["known_agent_type"]
            for name, p in reported
            if name == "switch_core.agent_message_sent"
        ] == ["codex"]
        assert [
            p["sender_kind"]
            for name, p in reported
            if name == "switch_core.agent_message_received"
        ] == ["user"]

    async def test_a_room_made_after_the_read_is_looked_up_on_its_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)
        messages.observe(_said(world, world.humans[0].id, "human"))
        await messages._queue.join()
        async with session_factory() as session:
            later = await _room(session, bridge_platform=None, channel_type="direct")
            await _join(session, world.humans[0].id, later)
            await session.commit()

        messages.observe(_said_in(later.id, sender_client_id=world.humans[0].id))
        reported = await _reported(messages, service, sink)

        assert [p["room_user_count"] for _, p in reported] == [2, 1]

    async def test_a_read_that_fails_is_the_lookups_failure(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Counted once, not followed by the lookup it was for, and not tried
        again while a failed lookup would not be."""
        database = _Unreachable()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=database,  # type: ignore[arg-type]
        )

        for _ in range(2):
            messages.observe(_said_in("room"))
        with caplog.at_level("WARNING"):
            reported = await _reported(messages, service, sink)

        assert [p["bridge_platform"] for _, p in reported] == ["unknown", "unknown"]
        assert database.attempts == 1


class TestHowLongLookupsAreKept:
    def test_a_room_for_a_quarter_hour_and_who_someone_is_for_an_hour(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clock = SimpleNamespace(now=100.0)
        monkeypatch.setattr(
            messages_module, "time", SimpleNamespace(monotonic=lambda: clock.now)
        )
        telemetry = MessageTelemetry(telemetry=MagicMock(), session_factory=MagicMock())
        room = _RoomFacts(
            bridge_platform="slack",
            channel_type="channel",
            user_count=2,
            agent_count=1,
            console_chat="false",
        )
        telemetry._rooms.put(("t", "room"), room)
        telemetry._senders.put(("t", "@alice:test"), _Sender("user", "messaging_app"))
        telemetry._agent_runtimes.put(("t", "client"), "claude_code")

        clock.now += 14 * 60
        assert telemetry._rooms.get(("t", "room")) == room
        clock.now += 2 * 60
        assert telemetry._rooms.get(("t", "room")) is None
        assert telemetry._senders.get(("t", "@alice:test")) == _Sender(
            "user", "messaging_app"
        )
        assert telemetry._agent_runtimes.get(("t", "client")) == "claude_code"
        clock.now += 45 * 60
        assert telemetry._senders.get(("t", "@alice:test")) is None
        assert telemetry._agent_runtimes.get(("t", "client")) is None


class TestTtlCache:
    def test_an_entry_expires_after_its_age(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        clock = SimpleNamespace(now=100.0)
        monkeypatch.setattr(
            messages_module, "time", SimpleNamespace(monotonic=lambda: clock.now)
        )
        cache: _TtlCache[str, int] = _TtlCache(ttl_seconds=10, max_entries=5)
        cache.put("a", 1)

        clock.now += 9
        assert cache.get("a") == 1
        clock.now += 2
        assert cache.get("a") is None

    def test_the_least_recently_used_entry_goes_first(self) -> None:
        cache: _TtlCache[str, int] = _TtlCache(ttl_seconds=60, max_entries=2)
        cache.put("a", 1)
        cache.put("b", 2)
        cache.get("a")
        cache.put("c", 3)

        assert cache.get("b") is None
        assert cache.get("a") == 1
        assert cache.get("c") == 3


class TestBackpressure:
    async def test_a_full_queue_drops_with_a_warning_and_a_final_count(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Bounded rather than growing inside the process it measures, and the
        loss is said out loud — including drops after the last warning."""
        monkeypatch.setattr(messages_module, "_QUEUE_SIZE", 1)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        messages._load_room_facts = _a_slack_room  # type: ignore[method-assign]
        _one_at_a_time(messages)

        with caplog.at_level("WARNING"):
            for _ in range(4):
                messages.observe(_said_in("room"))
            reported = await _reported(messages, service, sink)

        behind = [
            r.getMessage()
            for r in caplog.records
            if "Message telemetry is behind" in r.getMessage()
        ]
        assert len(reported) == 1
        assert len(behind) == 2
        assert "1 event(s) dropped" in behind[0]
        assert "2 event(s) dropped" in behind[1]


class TestFailingSenderAndRuntimeLookups:
    async def test_a_sender_lookup_that_fails_reports_unknown_and_pauses(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        database = _Unreachable()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=database,  # type: ignore[arg-type]
        )
        messages._load_room_facts = _a_slack_room  # type: ignore[method-assign]
        _one_at_a_time(messages)

        for sender in ("@alice:test", "@alice:test"):
            messages.agent_addressed(
                tenant_id=TENANT_ZERO,
                room_id="room",
                sender_transport_user_id=sender,
                from_platform=False,
                from_app=False,
                agent_metadata=None,
                agent_live=True,
                has_attachment=False,
            )
        with caplog.at_level("WARNING"):
            reported = await _reported(messages, service, sink)

        assert [p["sender_kind"] for _, p in reported] == ["unknown", "unknown"]
        assert database.attempts == 1
        assert "could not look up a message sender" in caplog.text

    async def test_a_runtime_lookup_that_fails_reports_unknown_and_pauses(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        database = _Unreachable()
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=database,  # type: ignore[arg-type]
        )
        messages._load_room_facts = _a_slack_room  # type: ignore[method-assign]
        _one_at_a_time(messages)

        for _ in range(2):
            messages.observe(
                _said_in("room", sender_role="agent", sender_client_id="agent-client")
            )
        with caplog.at_level("WARNING"):
            reported = await _reported(messages, service, sink)

        assert [
            p["known_agent_type"]
            for name, p in reported
            if name == "switch_core.agent_message_sent"
        ] == ["unknown", "unknown"]
        assert database.attempts == 1
        assert "could not look up an agent's runtime" in caplog.text

    async def test_failures_past_the_pause_still_warn_once_a_minute(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setattr(messages_module, "_LOOKUP_BACKOFF_SECONDS", 0.0)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        attempts = 0

        async def _broken(tenant_id: str, room_id: str) -> None:
            nonlocal attempts
            attempts += 1
            raise ConnectionError("database unreachable")

        messages._load_room_facts = _broken  # type: ignore[method-assign]

        _one_at_a_time(messages)

        with caplog.at_level("WARNING"):
            for _ in range(3):
                messages.observe(_said_in("room"))
            await _reported(messages, service, sink)

        assert attempts == 3
        assert (
            len([r for r in caplog.records if "could not look up" in r.getMessage()])
            == 1
        )

    async def test_rooms_that_cannot_be_found_warn_once(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )

        async def _gone(tenant_id: str, room_id: str) -> None:
            return None

        messages._load_room_facts = _gone  # type: ignore[method-assign]

        _one_at_a_time(messages)

        with caplog.at_level("WARNING"):
            messages.observe(_said_in("room-a"))
            messages.observe(_said_in("room-b"))
            reported = await _reported(messages, service, sink)

        assert [p["bridge_platform"] for _, p in reported] == ["unknown", "unknown"]
        assert (
            len([r for r in caplog.records if "found no room" in r.getMessage()]) == 1
        )


class TestFailingReports:
    async def test_an_event_that_cannot_be_reported_logs_once_not_per_message(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """A bug that breaks every event would otherwise write a traceback per
        message."""
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        async def _broken(item: object) -> None:
            raise RuntimeError("bug in building the event")

        messages._report = _broken  # type: ignore[method-assign]

        with caplog.at_level("WARNING"):
            for _ in range(3):
                messages.observe(_said(world, world.humans[0].id, "human"))
            await _reported(messages, service, sink)

        errors = [
            r
            for r in caplog.records
            if "Could not report a message event" in r.getMessage()
        ]
        assert len(errors) == 1
        assert errors[0].exc_info is not None
        # The two after it are counted at shutdown rather than lost.
        assert "2 more message event(s) could not be reported" in caplog.text

    async def test_a_sender_that_cannot_be_found_is_disclosed(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        world = await _world(session_factory)
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(telemetry=service, session_factory=session_factory)

        with caplog.at_level("WARNING"):
            messages.agent_addressed(
                tenant_id=TENANT_ZERO,
                room_id=world.room.id,
                sender_transport_user_id="@nobody-we-know:test",
                from_platform=False,
                from_app=False,
                agent_metadata=None,
                agent_live=True,
                has_attachment=False,
            )
            [(_, properties)] = await _reported(messages, service, sink)

        assert properties["sender_kind"] == "unknown"
        assert "found no client for a message sender" in caplog.text


class TestShutdown:
    async def test_events_after_shutdown_are_counted_not_silently_lost(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        await messages.aclose()

        with caplog.at_level("WARNING"):
            for _ in range(3):
                messages.observe(
                    ParticipantMessage(
                        tenant_id=TENANT_ZERO,
                        room_id="room",
                        sender_client_id="someone",
                        sender_role="human",
                        sender_is_app=False,
                        from_console=False,
                        has_attachment=False,
                        in_thread=False,
                    )
                )

        late = [
            r
            for r in caplog.records
            if "after message telemetry shut down" in r.getMessage()
        ]
        assert len(late) == 1

    async def test_events_dropped_during_the_drain_are_all_counted(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Senders keep running while shutdown drains the queue. The warning is
        rate-limited, so the drops after its first line are tallied when the
        drain ends rather than never."""
        release = asyncio.Event()

        async def _slow_room(tenant_id: str, room_id: str) -> _RoomFacts:
            await release.wait()
            return await _a_slack_room(tenant_id, room_id)

        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        messages._load_room_facts = _slow_room  # type: ignore[method-assign]
        _one_at_a_time(messages)
        messages.observe(_said_in("room"))
        with caplog.at_level("WARNING"):
            closing = asyncio.create_task(messages.aclose())
            await asyncio.sleep(0)
            for _ in range(3):
                messages.observe(_said_in("room"))
            release.set()
            await closing

        late = [
            r.getMessage()
            for r in caplog.records
            if "after message telemetry shut down" in r.getMessage()
        ]
        assert len(late) == 2
        assert "2 more message event(s)" in late[1]

    async def test_closing_stays_inside_the_callers_timeout(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The worker is cancelled mid-lookup and its cleanup outlasts the
        shutdown budget. The caller's timeout must still fire: swallowing its
        cancellation would let shutdown run past the forced-exit grace."""
        sink = _RecordingSink()
        service = _service(sink)
        messages = MessageTelemetry(
            telemetry=service,
            session_factory=None,  # type: ignore[arg-type]
        )
        looking_up = asyncio.Event()

        async def _slow_to_cancel(tenant_id: str, room_id: str) -> None:
            looking_up.set()
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                await asyncio.sleep(1.0)
                raise

        messages._load_room_facts = _slow_to_cancel  # type: ignore[method-assign]

        _one_at_a_time(messages)
        messages.observe(
            ParticipantMessage(
                tenant_id=TENANT_ZERO,
                room_id="room",
                sender_client_id="someone",
                sender_role="human",
                sender_is_app=False,
                from_console=False,
                has_attachment=False,
                in_thread=False,
            )
        )
        await looking_up.wait()

        started = time.monotonic()
        with caplog.at_level("WARNING"), pytest.raises(TimeoutError):
            async with asyncio.timeout(0.7):
                await messages.aclose()
        elapsed = time.monotonic() - started

        assert elapsed < 0.9
        # The one the worker was cancelled in the middle of is not in the
        # queue any more, and is still lost.
        assert "1 message event(s) still queued at shutdown were dropped" in (
            caplog.text
        )
        assert messages._worker is not None
        await asyncio.wait({messages._worker})


class TestOff:
    def test_enabled_follows_the_service(self) -> None:
        """What a caller with telemetry-only work checks before doing it."""
        for enabled in (True, False):
            messages = MessageTelemetry(
                telemetry=_service(_RecordingSink(), enabled=enabled),
                session_factory=None,  # type: ignore[arg-type]
            )
            assert messages.enabled is enabled

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
            from_app=False,
            agent_metadata=None,
            agent_live=False,
            has_attachment=False,
        )

        assert messages._worker is None
        assert await _reported(messages, service, sink) == []
