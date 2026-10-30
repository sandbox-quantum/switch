"""The message router on the test database, and the rooms, agents and people
it routes between.

A row is decided as it is written, so a test of what an agent receives writes
the row the way production does: through a client's transport, which routes
it (`delivery/router.py`). What the agent was given is then read back from
`agent_events`, and what was said in the room from `messages`, because both
are the record: a fake standing in for either would test the fake.

A `Process` is one switch-core process's worth of routing: its own router,
client factory, event buffer and connection registry, on the shared
database. Two of them are two processes, which is how the tests show a row is
routed once, by the process that wrote it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from sqlalchemy import insert, select

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import (
    EventBuffer,
    RoomAnnouncements,
)
from switch_core.clients.client_factory import ClientFactory
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentEventRow,
    ApiKey,
    Client,
    ClientRoom,
    Message,
    Room,
    User,
    room_agents,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.decision.client import DynamicDecisionClient
from switch_core.delivery.conversation import ConversationRules, ConversationSettings
from switch_core.delivery.recipient import RecipientServices
from switch_core.delivery.router import MessageRouter
from switch_core.messages.notify import MessageListener
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.postgres import PostgresTransport
from switch_core.transport.room_cache import (
    DELIVERY_PAGE,
    RoomCacheLimits,
    RoomDeliveryCache,
)
from tests.db_buffer import db_buffer_on

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.transport.observer import ParticipantMessage


class RecordedTelemetry:
    """Message telemetry that records what it was told: the agents asked for
    something (`addressed`) and the messages people and agents sent
    (`observed`)."""

    def __init__(self) -> None:
        self.enabled = True
        self.addressed: list[dict[str, Any]] = []
        self.observed: list[ParticipantMessage] = []

    def agent_addressed(self, **report: Any) -> None:
        self.addressed.append(report)

    def observe(self, message: ParticipantMessage) -> None:
        self.observed.append(message)


@dataclass
class Process:
    """One switch-core process's routing on the test database."""

    session_factory: async_sessionmaker[AsyncSession]
    router: MessageRouter
    factory: ClientFactory
    buffer: EventBuffer
    connections: AgentConnectionRegistry
    telemetry: RecordedTelemetry
    invites: InviteBus
    provisioning: PostgresProvisioning
    transports: dict[str, PostgresTransport] = field(default_factory=dict)

    def transport(self, client: Client) -> PostgresTransport:
        """The transport `client` writes through in this process."""
        transport = self.transports.get(client.id)
        if transport is None:
            transport = self.factory.transport_for(
                SimpleNamespace(  # type: ignore[arg-type]
                    transport_user_id=client.transport_user_id,
                    client_id=client.id,
                    tenant_id=client.tenant_id,
                    display_name=client.display_name,
                    role="agent" if client.type == "agent" else "human",
                )
            )
            assert isinstance(transport, PostgresTransport)
            self.transports[client.id] = transport
        return transport

    async def say(
        self,
        room: Room,
        body: str,
        *,
        sender: Client,
        thread_root_id: str | None = None,
        extra_content: dict[str, object] | None = None,
    ) -> str:
        """Write a message as `sender`, and return its event id."""
        result = await self.transport(sender).send_message(
            room.transport_room_id,
            body,
            sender_name=sender.display_name,
            metered=False,
            format="markdown",
            thread_root_id=thread_root_id,
            extra_content=extra_content,
        )
        return result.event_id

    async def send_file(
        self,
        room: Room,
        filename: str,
        *,
        sender: Client,
        caption: str | None = None,
        group: dict[str, object] | None = None,
    ) -> str:
        """Write one file as `sender`, a part of a multi-file post when
        `group` says so, and return its event id."""
        result = await self.transport(sender).send_media(
            room.transport_room_id,
            f"switch-media://{uuid.uuid4().hex}",
            filename,
            "image/png",
            5,
            sender_name=sender.display_name,
            metered=False,
            msgtype="m.image",
            caption=caption,
            group=group,
        )
        return result.event_id

    async def command(
        self, room: Room, command: str, args: str, *, sender: Client
    ) -> str:
        """Type a room command as `sender`, and return its event id."""
        result = await self.transport(sender).send_event(
            room.transport_room_id,
            "com.switch.command",
            {
                "command": command,
                "args": args,
                "user_id": sender.transport_user_id,
                "user_name": sender.display_name,
            },
        )
        return result.event_id

    async def idle(self) -> None:
        """Wait for every reply the routed rows owe to have been posted."""
        await self.router.idle()


def router_on(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    buffer: EventBuffer | None = None,
    connections: AgentConnectionRegistry | None = None,
    telemetry: RecordedTelemetry | None = None,
    conversation: ConversationSettings | None = None,
    decisions: DynamicDecisionClient | None = None,
) -> MessageRouter:
    """A router on the test database with real stores. A test that has no
    agent in its rooms can write through it with nothing else set up.
    Following the conversation is off unless `conversation` turns it on, and
    routing by decision unless `decisions` is the decision service."""
    return MessageRouter(
        services=RecipientServices(
            session_factory=session_factory,
            event_buffer=buffer
            if buffer is not None
            else db_buffer_on(session_factory),
            agent_store=AgentStore(),
            room_store=RoomStore(),
            document_store=DocumentStore(),
            reference_store=ReferenceStore(),
            package_store=PackageStore(),
            agent_session_store=AgentSessionStore(),
            room_role_store=RoomRoleStore(),
            external_user_store=ExternalUserStore(),
            connections=connections
            if connections is not None
            else AgentConnectionRegistry(),
            frontend_base_url=None,
            message_telemetry=telemetry  # type: ignore[arg-type]
            if telemetry is not None
            else RecordedTelemetry(),
        ),
        message_store=MessageStore(),
        client_store=ClientStore(),
        budget_store=BudgetStore(),
        conversation=ConversationRules(
            settings=conversation
            if conversation is not None
            else ConversationSettings(enabled=False, window_seconds=300),
            message_store=MessageStore(),
            room_store=RoomStore(),
            agent_store=AgentStore(),
            room_role_store=RoomRoleStore(),
        ),
        decisions=decisions,
        decision_max_age_seconds=120,
    )


def process_on(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    rooms: RoomAnnouncements | None = None,
    connections: AgentConnectionRegistry | None = None,
    conversation: ConversationSettings | None = None,
    decisions: DynamicDecisionClient | None = None,
) -> Process:
    """A process's routing on the test database: real stores, its own
    registry and buffer, telemetry that records. A test of presence across
    processes hands it a registry that sees the other processes'
    connections (`connection_rows.SharedConnections`)."""
    if connections is None:
        connections = AgentConnectionRegistry()
    buffer = db_buffer_on(session_factory, rooms=rooms)
    telemetry = RecordedTelemetry()
    message_store = MessageStore()
    room_store = RoomStore()
    client_store = ClientStore()
    router = router_on(
        session_factory,
        buffer=buffer,
        connections=connections,
        telemetry=telemetry,
        conversation=conversation,
        decisions=decisions,
    )
    invites = InviteBus()
    factory = ClientFactory(
        client_store=client_store,
        session_factory=session_factory,
        config=SimpleNamespace(),  # type: ignore[arg-type]
        room_store=room_store,
        message_store=message_store,
        usage_store=UsageStore(),
        media_store=MediaStore(),
        # Never started: these transports only write, and nothing they
        # deliver to is listening.
        listener=MessageListener(lambda: None),  # type: ignore[arg-type, return-value]
        invites=invites,
        ephemeral=EphemeralBus(),
        room_cache=RoomDeliveryCache(
            session_factory=session_factory,
            message_store=message_store,
            limits=RoomCacheLimits(
                max_bytes=64 * 1024 * 1024,
                max_rooms=1000,
                max_rows_per_room=1000,
                max_age_seconds=300.0,
            ),
            page=DELIVERY_PAGE,
        ),
        message_observer=telemetry,
        router=router,
    )
    provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=room_store,
        client_store=client_store,
        router=router,
        invites=invites,
    )
    return Process(
        session_factory=session_factory,
        router=router,
        factory=factory,
        buffer=buffer,
        connections=connections,
        telemetry=telemetry,
        invites=invites,
        provisioning=provisioning,
    )


# ── Rooms, agents and people ──────────────────────────────────────────────────


async def make_room(
    session_factory: async_sessionmaker[AsyncSession],
    name: str = "room",
    *,
    channel_type: str | None = "channel_public",
    bridge_id: str | None = None,
    tenant_id: str = TENANT_ZERO_ID,
) -> Room:
    async with tenant_session(session_factory, tenant_id) as session:
        room = Room(
            transport_room_id=f"!{name}-{uuid.uuid4().hex[:8]}:test",
            name=name,
            description="",
            channel_type=channel_type,
            bridge_id=bridge_id,
        )
        session.add(room)
        await session.commit()
        await session.refresh(room)
    return room


async def make_person(
    session_factory: async_sessionmaker[AsyncSession],
    name: str = "alice",
    *,
    tenant_id: str = TENANT_ZERO_ID,
) -> Client:
    """A person on another platform, as the client their messages come from."""
    async with tenant_session(session_factory, tenant_id) as session:
        client = Client(
            transport_user_id=f"@{name}-{uuid.uuid4().hex[:6]}:test",
            display_name=name,
            type="user",
        )
        session.add(client)
        await session.commit()
        await session.refresh(client)
    return client


async def make_agent(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    *,
    connection_model: str = "always_on",
    addressing_policy: dict[str, Any] | None = None,
    tenant_id: str = TENANT_ZERO_ID,
) -> tuple[Agent, Client]:
    """An agent, its client, and the owner and key it needs."""
    async with tenant_session(session_factory, tenant_id) as session:
        suffix = uuid.uuid4().hex[:8]
        user = User(name=f"owner-{suffix}", email=f"{suffix}@test.local", role="user")
        session.add(user)
        await session.flush()
        key = ApiKey(
            user_id=user.id,
            key_hash=f"hash-{suffix}",
            encrypted_key="enc",
            label=name,
            type="agent",
        )
        client = Client(
            transport_user_id=f"@{name}-{suffix}:test",
            display_name=name,
            type="agent",
        )
        session.add_all([key, client])
        await session.flush()
        agent = Agent(
            name=name,
            description="",
            agent_type=connection_model,
            connector_type="claude_code",
            integration_profile={"connection_model": connection_model},
            client_id=client.id,
            api_key_id=key.id,
            owner_id=user.id,
            addressing_policy=addressing_policy,
        )
        session.add(agent)
        await session.commit()
        await session.refresh(agent)
        await session.refresh(client)
    return agent, client


async def add_member(
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    client: Client,
    *,
    agent: Agent | None = None,
    alias: str | None = None,
    listening: bool = False,
) -> None:
    """Put a client in a room, written straight to the tables as a member
    from before the test would be: no arrival is written, so nobody is
    greeted. An agent's `room_agents` row says its alias and whether it
    listens for joins."""
    async with tenant_session(session_factory, room.tenant_id) as session:
        session.add(ClientRoom(client_id=client.id, room_id=room.id))
        if agent is not None:
            await session.execute(
                insert(room_agents).values(
                    room_id=room.id,
                    agent_id=agent.id,
                    alias=alias,
                    receives_join_events=listening,
                )
            )
        await session.commit()


async def own_events(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
) -> list[AgentEventRow]:
    """The agent's own events, oldest first."""
    async with tenant_session(session_factory, tenant_id) as session:
        return list(
            (
                await session.scalars(
                    select(AgentEventRow)
                    .where(AgentEventRow.agent_id == agent_id)
                    .order_by(AgentEventRow.seq)
                )
            ).all()
        )


async def said_by(
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    client: Client,
) -> list[Message]:
    """What `client` has said in `room`, oldest first."""
    async with tenant_session(session_factory, room.tenant_id) as session:
        return list(
            (
                await session.scalars(
                    select(Message)
                    .where(
                        Message.room_id == room.id,
                        Message.sender_client_id == client.id,
                        Message.event_type == "m.room.message",
                    )
                    .order_by(Message.seq)
                )
            ).all()
        )
