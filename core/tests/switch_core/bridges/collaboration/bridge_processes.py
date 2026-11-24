"""Two switch-core processes running one collaboration bridge, on one database.

Each process is wired the way `main` wires one for bridges: its own message
listener and signal bus, process lease, ownership and cursor writer, client
lifecycle, room service and bridge lifecycle. The platform (`Platform`) is the
one messaging service every copy talks to: it knows which copies listen to it
and records what is posted to it. Used by `test_bridge_ownership.py` and the
bridge property machine.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, ClassVar
from unittest.mock import MagicMock

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.bridge_signals import BridgeSignals
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.actor import Actor, HumanActor
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    Message,
    Room,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.package_store import PackageStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.reference_type_store import ReferenceTypeStore
from switch_core.db.stores.room_link_store import RoomLinkStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.keys import Keyring
from switch_core.messages.notify import MessageListener
from switch_core.ownership import Ownership
from switch_core.process_lease import ProcessLease
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_service import RoomService
from switch_core.signals import SignalBus
from switch_core.transport.cursors import CursorWriter
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.membership_signals import MembershipSignals
from switch_core.transport.observer import IgnoreParticipantMessages
from switch_core.transport.room_cache import RoomCacheLimits, RoomDeliveryCache
from tests.ownership import process_lease_on
from tests.routing import router_on

TIMEOUT = 10.0
CHAT = "fakechat"
LOUD_CHAT = "loudchat"
CHANNEL = "C1"


class Platform:
    """The messaging service every copy of the bridge talks to."""

    def __init__(self) -> None:
        self.listening: list[Chat] = []
        self.posts: list[tuple[str, str, str]] = []
        # How many of the next posts the platform refuses.
        self.refusing = 0

    async def say(self, *, user_id: str, text: str, ref: str) -> None:
        """Someone writes in the channel. Every open connection hears it, as
        Mattermost hands every post to every socket. A bridge connects in its
        own task once it is started, so this waits for a connection first."""
        async with asyncio.timeout(TIMEOUT):
            while not self.listening:
                await asyncio.sleep(0.01)
        for chat in list(self.listening):
            await chat.hear(inbound_post(user_id=user_id, text=text, ref=ref))

    async def command(self, *, user_id: str, command: str, ref: str) -> None:
        """Someone types a command in the channel, heard like a post."""
        async with asyncio.timeout(TIMEOUT):
            while not self.listening:
                await asyncio.sleep(0.01)
        for chat in list(self.listening):
            await chat.hear_command(
                InboundCommand(
                    channel_id=CHANNEL,
                    channel_type="channel_public",
                    sender_id=user_id,
                    sender_name=user_id.lower(),
                    command=command,
                    args="",
                    message_ref=ref,
                )
            )

    def posted(self) -> list[str]:
        return [text for _, _, text in self.posts]

    async def receive(self, channel_id: str, sender_name: str, content: str) -> str:
        """A copy of the bridge posts: recorded, and its ref returned."""
        if self.refusing:
            self.refusing -= 1
            raise RuntimeError("the platform refused the post")
        self.posts.append((channel_id, sender_name, content))
        return f"post-{len(self.posts)}"


def inbound_post(*, user_id: str, text: str, ref: str) -> InboundMessage:
    return InboundMessage(
        channel_id=CHANNEL,
        channel_type="channel_public",
        sender_id=user_id,
        sender_name=user_id.lower(),
        content=text,
        message_ref=ref,
    )


class ChatConfig(BridgeConnectionConfig):
    token: str


class Chat(PlatformAdapter):
    """A platform that listens over a connection of its own, like Slack's
    Socket Mode or Mattermost's websocket, and keeps quiet when told to."""

    display_name: ClassVar[str] = "Fake Chat"
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True
    platform: ClassVar[Platform]

    def __init__(self, *, config: ChatConfig) -> None:
        super().__init__()
        self.config = config

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._on_message = on_message
        self._on_command = on_command
        if self._listening or not self.keeps_quiet_unless_listening:
            self.platform.listening.append(self)

    async def stop(self) -> None:
        if self in self.platform.listening:
            self.platform.listening.remove(self)

    async def hear(self, message: InboundMessage) -> None:
        """A delivery from the platform: over the connection where this copy
        listens, or a webhook reaching a quiet one."""
        assert self._on_message is not None
        await self._on_message(message)

    async def hear_command(self, command: InboundCommand) -> None:
        assert self._on_command is not None
        await self._on_command(command)

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        return await self.platform.receive(channel_id, sender_name, content)

    async def update_message(self, *a: Any, **k: Any) -> Any:
        return None

    async def delete_message(self, *a: Any, **k: Any) -> Any:
        return None

    async def send_typing(self, *a: Any, **k: Any) -> Any:
        return None

    async def create_channel(self, *a: Any, **k: Any) -> Any:
        raise NotImplementedError

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_public"

    async def add_agents_to_channel(self, *a: Any, **k: Any) -> Any:
        return None

    async def add_users_to_channel(self, *a: Any, **k: Any) -> Any:
        return None

    async def create_agent_identity(self, *a: Any, **k: Any) -> Any:
        return None

    async def remove_agent_identity(self, *a: Any, **k: Any) -> Any:
        return None

    async def get_channel_agent_names(self, *a: Any, **k: Any) -> Any:
        return []

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw: Any) -> str:
        return str(raw)


class LoudChat(Chat):
    """A platform whose adapter cannot keep quiet: every process's copy
    listens to it."""

    keeps_quiet_unless_listening: ClassVar[bool] = False


@dataclass
class Process:
    lease: ProcessLease
    ownership: Ownership
    bus: SignalBus
    writer: CursorWriter
    listener: MessageListener
    clients: ClientLifecycleService
    bridges: CollaborationBridgeLifecycleService
    tasks: list[asyncio.Task[None]] = field(default_factory=list)
    stopped: bool = False

    async def boot(self) -> None:
        """Start as `main` does: every client, every bridge wanted, the first
        balance starting what this process holds, then the quiet copies."""
        await self.clients.start_all()
        await self.bridges.start_all()
        await self.ownership.start()
        await self.bridges.start_quiet_copies()

    async def settled(self) -> None:
        """Wait out the quiet copies a hand-over starts in the background."""
        async with asyncio.timeout(TIMEOUT):
            while self.bridges._quiet_starts:
                await asyncio.sleep(0.01)

    async def stop(self) -> None:
        """Shut down as `main` does: owned work first, then the rest."""
        if self.stopped:
            return
        self.stopped = True
        await self.ownership.stop()
        await self.bridges.stop_all()
        await self.lease.stop()
        await self.clients.stop_all()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.bus.stop()
        await self.listener.stop()


def bridge_config() -> Any:
    config = MagicMock()
    config.gateway_public_url = "https://gw.example"
    config.messaging_public_url = None
    config.collaboration_callback_host = "127.0.0.1"
    config.collaboration_callback_port = 0
    config.keyring = Keyring.parse("test:" + "x" * 40, legacy_secret=None)
    config.agent_media_max_bytes = 1 << 20
    config.id_server_name = "test"
    return config


async def process_on(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> Process:
    def engine() -> Any:
        return create_async_engine(postgres_url, poolclass=NullPool)

    listener = MessageListener(engine)
    await listener.start()
    await asyncio.wait_for(listener.connected.wait(), TIMEOUT)
    lease = process_lease_on(session_factory)
    await lease.renew()
    bus = SignalBus(session_factory, engine, process_id=lease.process_id)
    ownership = Ownership(
        lease=lease,
        session_factory=session_factory,
        bus=bus,
        store=OwnershipLeaseStore(),
        processes=SwitchCoreProcessStore(),
    )
    writer = CursorWriter(
        session_factory=session_factory,
        cursors=DeliveryCursorStore(),
        leases=OwnershipLeaseStore(),
        process_id=lease.process_id,
    )
    invites = InviteBus()
    # This process's own router: the rows it writes are routed here.
    router = router_on(session_factory)
    MembershipSignals(invites=invites, bus=bus, router=router)
    room_cache = RoomDeliveryCache(
        session_factory=session_factory,
        message_store=MessageStore(),
        limits=RoomCacheLimits(
            max_bytes=1 << 24,
            max_rooms=100,
            max_rows_per_room=200,
            max_age_seconds=60.0,
        ),
    )
    factory = ClientFactory(
        client_store=ClientStore(),
        session_factory=session_factory,
        config=MagicMock(),
        room_store=RoomStore(),
        message_store=MessageStore(),
        usage_store=UsageStore(),
        media_store=MediaStore(),
        listener=listener,
        invites=invites,
        ephemeral=EphemeralBus(),
        room_cache=room_cache,
        message_observer=IgnoreParticipantMessages(),
        router=router,
    )
    factory.register("user", HumanActor)
    factory.register("bridge", Actor)
    provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=RoomStore(),
        client_store=ClientStore(),
        router=router,
        invites=invites,
    )
    clients = ClientLifecycleService(
        provisioning=provisioning,
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=factory,
        session_factory=session_factory,
        # The server name the bridges read back clients' ids with.
        config=bridge_config(),
        tenants_isolated=True,
        ownership=ownership,
        cursor_writer=writer,
    )
    bridges = CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        bridge_message_map_store=BridgeMessageMapStore(),
        room_store=RoomStore(),
        agent_store=AgentStore(),
        client_store=ClientStore(),
        client_lifecycle=clients,
        room_service=None,  # type: ignore[arg-type]  # set below
        provisioning=provisioning,
        session_factory=session_factory,
        config=bridge_config(),
        client_factory=factory,
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=AgentConnectionRegistry(),
        ownership=ownership,
        cursor_writer=writer,
    )
    bridges.register_adapter(CHAT, Chat, ChatConfig)
    bridges.register_adapter(LOUD_CHAT, LoudChat, ChatConfig)
    bridges._room_service = RoomService(
        provisioning=provisioning,
        room_store=RoomStore(),
        agent_store=AgentStore(),
        client_lifecycle=clients,
        collab_lifecycle=bridges,
        collab_bridge_store=CollaborationBridgeStore(),
        resource_service=ResourceService(
            reference_store=ReferenceStore(),
            reference_type_store=ReferenceTypeStore(),
            document_store=DocumentStore(),
            package_store=PackageStore(),
            room_link_store=RoomLinkStore(),
            session_factory=session_factory,
        ),
        session_factory=session_factory,
        room_cache=room_cache,
    )
    BridgeSignals(lifecycle=bridges, bus=bus)
    clients.add_agents_changed_listener(bridges.agents_changed)
    await bus.start()
    await asyncio.wait_for(bus.connected.wait(), TIMEOUT)
    return Process(
        lease=lease,
        ownership=ownership,
        bus=bus,
        writer=writer,
        listener=listener,
        clients=clients,
        bridges=bridges,
        tasks=[
            asyncio.create_task(lease.run()),
            asyncio.create_task(writer.run()),
        ],
    )


@dataclass
class Bridge:
    bridge_id: str
    client_id: str
    room_id: str
    transport_room_id: str
    speaker_id: str
    speaker: str


async def add_bridge(session_factory: async_sessionmaker[AsyncSession]) -> Bridge:
    """A bridge on the fake platform carrying one room, bridged to `CHANNEL`,
    and someone in the room whose messages the bridge relays out."""
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        bridge_client = Client(
            transport_user_id=f"@switch-bridge-{suffix}:test",
            display_name="bridge",
            type="bridge",
        )
        speaker = Client(
            transport_user_id=f"@speaker-{suffix}:test",
            display_name="speaker",
            type="user",
        )
        session.add_all([bridge_client, speaker])
        await session.flush()
        row = CollaborationBridge(
            type=CHAT,
            display_name="Fake",
            connection_config={"token": "first"},
            client_id=bridge_client.id,
            status="active",
            channel_creation_enabled=False,
            preconfigured=False,
        )
        session.add(row)
        await session.flush()
        room = Room(
            transport_room_id=f"!room-{suffix}:test",
            name="bridged",
            description="",
            bridge_id=row.id,
            external_channel_id=CHANNEL,
            channel_type="channel_public",
        )
        session.add(room)
        await session.flush()
        await RoomStore().add_client(session, bridge_client.id, room.id)
        await RoomStore().add_client(session, speaker.id, room.id)
        await session.commit()
        return Bridge(
            bridge_id=row.id,
            client_id=bridge_client.id,
            room_id=room.id,
            transport_room_id=room.transport_room_id,
            speaker_id=speaker.id,
            speaker=speaker.transport_user_id,
        )


async def say_in_room(
    session_factory: async_sessionmaker[AsyncSession],
    bridge: Bridge,
    body: str,
    *,
    room_id: str | None = None,
) -> str:
    """Someone in Switch writes in the room, for the bridge to relay out."""
    event_id = f"sw_{uuid.uuid4().hex}"
    async with session_factory() as session:
        await MessageStore().create(
            session,
            Message(
                room_id=room_id or bridge.room_id,
                transport_event_id=event_id,
                sender_id=bridge.speaker,
                sender_client_id=bridge.speaker_id,
                sender_name="speaker",
                event_type="m.room.message",
                msgtype="m.text",
                body=body,
                formatted_body=None,
                content={"body": body, "sender_name": "speaker"},
            ),
            [],
        )
        await session.commit()
    return event_id
