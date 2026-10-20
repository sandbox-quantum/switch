"""One process listens for a collaboration bridge; every other runs it quietly.

Against real PostgreSQL, two "processes" on one database, each wired the way
`main` wires one for bridges: its own message listener and signal bus, process
lease, ownership and cursor writer, client lifecycle, room service and bridge
lifecycle. Both run the bridge. The platform here (`_Platform`) is the one
messaging service both copies talk to: it knows which copies listen to it and
records what is posted to it, so a test can say that a reply reached the
channel once and that only one process holds the connection.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, ClassVar
from unittest.mock import MagicMock

import pytest
from sqlalchemy import func, select, update
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
    TENANT_ZERO_ID,
    BridgeMessageMap,
    Client,
    CollaborationBridge,
    ExternalUser,
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
from switch_core.room_service import RoomCreateConfig, RoomService
from switch_core.signals import SignalBus
from switch_core.tenant_context import tenant_scope
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


class _Platform:
    """The messaging service every copy of the bridge talks to."""

    def __init__(self) -> None:
        self.listening: list[_Chat] = []
        self.posts: list[tuple[str, str, str]] = []

    async def say(self, *, user_id: str, text: str, ref: str) -> None:
        """Someone writes in the channel. Every open connection hears it, as
        Mattermost hands every post to every socket. A bridge connects in its
        own task once it is started, so this waits for a connection first."""
        async with asyncio.timeout(TIMEOUT):
            while not self.listening:
                await asyncio.sleep(0.01)
        for chat in list(self.listening):
            await chat.hear(_post(user_id=user_id, text=text, ref=ref))

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


def _post(*, user_id: str, text: str, ref: str) -> InboundMessage:
    return InboundMessage(
        channel_id=CHANNEL,
        channel_type="channel_public",
        sender_id=user_id,
        sender_name=user_id.lower(),
        content=text,
        message_ref=ref,
    )


class _ChatConfig(BridgeConnectionConfig):
    token: str


class _Chat(PlatformAdapter):
    """A platform that listens over a connection of its own, like Slack's
    Socket Mode or Mattermost's websocket, and keeps quiet when told to."""

    display_name: ClassVar[str] = "Fake Chat"
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True
    platform: ClassVar[_Platform]

    def __init__(self, *, config: _ChatConfig) -> None:
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
        self.platform.posts.append((channel_id, sender_name, content))
        return f"post-{len(self.platform.posts)}"

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


class _LoudChat(_Chat):
    """A platform whose adapter cannot keep quiet: every process's copy
    listens to it."""

    keeps_quiet_unless_listening: ClassVar[bool] = False


class _PublisherThatFailsToStop:
    """A bridge's session-activity publisher whose stop raises. Stands in for
    anything that can go wrong as a bridge stops, before its adapter does.
    It can be swapped in while the bridge is still starting: the adapter
    listens before the bridge starts its publisher, so `start` has to work."""

    def start(self) -> None:
        pass

    async def stop(self) -> None:
        raise RuntimeError("the publisher's task had died")


@dataclass
class _Process:
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


def _config() -> Any:
    config = MagicMock()
    config.gateway_public_url = "https://gw.example"
    config.messaging_public_url = None
    config.collaboration_callback_host = "127.0.0.1"
    config.collaboration_callback_port = 0
    config.keyring = Keyring.parse("test:" + "x" * 40, legacy_secret=None)
    config.agent_media_max_bytes = 1 << 20
    config.id_server_name = "test"
    return config


async def _process(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> _Process:
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
        config=_config(),
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
        config=_config(),
        client_factory=factory,
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=AgentConnectionRegistry(),
        ownership=ownership,
        cursor_writer=writer,
    )
    bridges.register_adapter(CHAT, _Chat, _ChatConfig)
    bridges.register_adapter(LOUD_CHAT, _LoudChat, _ChatConfig)
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
    return _Process(
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
class _Bridge:
    bridge_id: str
    client_id: str
    room_id: str
    transport_room_id: str
    speaker_id: str
    speaker: str


@pytest.fixture
def platform() -> AsyncIterator[_Platform] | Any:
    platform = _Platform()
    _Chat.platform = platform
    return platform


@pytest.fixture
async def bridge(session_factory: async_sessionmaker[AsyncSession]) -> _Bridge:
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
        return _Bridge(
            bridge_id=row.id,
            client_id=bridge_client.id,
            room_id=room.id,
            transport_room_id=room.transport_room_id,
            speaker_id=speaker.id,
            speaker=speaker.transport_user_id,
        )


@pytest.fixture
async def processes(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[list[_Process]]:
    started: list[_Process] = []
    try:
        yield started
    finally:
        for process in started:
            await process.stop()


async def _boot_two(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    processes: list[_Process],
) -> tuple[_Process, _Process]:
    for _ in range(2):
        process = await _process(postgres_url, session_factory)
        processes.append(process)
        await process.boot()
    # The first balance of each cannot see the other; balance once more now
    # that both leases are there, as the interval would.
    for process in processes:
        await process.ownership.balance()
    for process in processes:
        await process.settled()
    return processes[0], processes[1]


def _holder(
    two: tuple[_Process, _Process], bridge_id: str
) -> tuple[_Process, _Process]:
    a, b = two
    holders = [p for p in (a, b) if p.bridges.holds(bridge_id)]
    assert len(holders) == 1
    return (a, b) if holders[0] is a else (b, a)


async def _say(
    session_factory: async_sessionmaker[AsyncSession],
    bridge: _Bridge,
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


async def _eventually(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(TIMEOUT):
        while not check():
            await asyncio.sleep(0.02)


async def _posted(platform: _Platform, count: int) -> list[str]:
    await _eventually(lambda: len(platform.posts) >= count)
    # Long enough for a second relay, had there been one, to have posted.
    await asyncio.sleep(0.5)
    return platform.posted()


async def _room_bodies(
    session_factory: async_sessionmaker[AsyncSession], room_id: str, sender: str
) -> list[str | None]:
    async with session_factory() as session:
        rows = (
            await session.scalars(
                select(Message.body)
                .where(
                    Message.room_id == room_id,
                    Message.sender_id == sender,
                    Message.event_type == "m.room.message",
                )
                .order_by(Message.seq)
            )
        ).all()
    return list(rows)


class TestOneConnection:
    async def test_one_process_listens_and_the_other_runs_quietly(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        # A bridge connects in its own task, after it is started.
        await _eventually(lambda: len(platform.listening) == 1)
        await asyncio.sleep(0.5)
        assert len(platform.listening) == 1
        held = holder.bridges.get(bridge.bridge_id)
        copy = quiet.bridges.get(bridge.bridge_id)
        assert held is not None and held.active
        assert copy is not None and not copy.active
        assert platform.listening == [held.adapter]

    async def test_a_reply_is_posted_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        await _boot_two(postgres_url, session_factory, processes)

        await _say(session_factory, bridge, "hello channel")

        assert await _posted(platform, 1) == ["hello channel"]


class TestHandingOver:
    async def test_the_next_holder_resumes_with_no_repeat_and_no_gap(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        holder, other = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        await _say(session_factory, bridge, "one")
        await _posted(platform, 1)

        await holder.stop()
        # Said while no process listens for the bridge.
        await _say(session_factory, bridge, "two")
        await other.ownership.balance()
        await _say(session_factory, bridge, "three")

        assert await _posted(platform, 3) == ["one", "two", "three"]
        assert other.bridges.holds(bridge.bridge_id)
        assert len(platform.listening) == 1

    async def test_a_bridge_that_fails_to_stop_still_closes_its_connection(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        """The hand-over's stop raised before it reached the adapter. The
        lease is let go of all the same, so the connection is closed first:
        the next holder's must not run beside it."""
        holder, other = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        held = holder.bridges.get(bridge.bridge_id)
        assert held is not None
        await _eventually(lambda: platform.listening == [held.adapter])
        held._activity_publisher = _PublisherThatFailsToStop()  # type: ignore[assignment]

        # As `main` shuts a process down: its owned work, then its lease.
        await holder.ownership.stop()
        await holder.lease.stop()
        await other.ownership.balance()

        assert holder.bridges.get(bridge.bridge_id) is None
        taken = other.bridges.get(bridge.bridge_id)
        assert taken is not None and taken.active
        await _eventually(lambda: platform.listening == [taken.adapter])

    async def test_what_the_last_holder_posted_is_not_posted_again(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        """A holder that died after posting a message and before storing how
        far it had got leaves the message for the next holder to read again.
        Its claim on the post is what stops the second one."""
        posted = await _say(session_factory, bridge, "posted before it died")
        async with session_factory() as session:
            session.add(
                BridgeMessageMap(
                    bridge_id=bridge.bridge_id,
                    external_channel_id=CHANNEL,
                    transport_event_id=posted,
                    external_post_id="post-from-the-last-holder",
                )
            )
            await session.commit()

        await _boot_two(postgres_url, session_factory, processes)
        await _say(session_factory, bridge, "said after")

        assert await _posted(platform, 1) == ["said after"]

    async def test_a_post_the_last_holder_claimed_and_never_sent_is_posted(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        """A holder that died between claiming a message and posting it
        leaves a claim with no post. The next holder reaches it once that
        holder's lease has lapsed, by when the claim is long past any post in
        flight, and posts it. A claim as fresh as a post in flight is left."""
        claims = {
            "claimed before it died": func.now() - timedelta(seconds=30),
            "claimed just now": func.now(),
        }
        for body, claimed_at in claims.items():
            event_id = await _say(session_factory, bridge, body)
            async with session_factory() as session:
                session.add(
                    BridgeMessageMap(
                        bridge_id=bridge.bridge_id,
                        external_channel_id=CHANNEL,
                        transport_event_id=event_id,
                        external_post_id=None,
                        created_at=claimed_at,
                    )
                )
                await session.commit()

        await _boot_two(postgres_url, session_factory, processes)
        await _say(session_factory, bridge, "said after")

        assert await _posted(platform, 2) == ["claimed before it died", "said after"]

    async def test_a_post_delivered_again_to_the_next_holder_is_stored_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        """As Slack does with an event whose acknowledgement it did not get:
        the holder stored it and stopped before acknowledging it, and the
        platform delivers it again to whoever listens next."""
        holder, other = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        await platform.say(user_id="U1", text="only once", ref="m1")
        await holder.stop()
        await other.ownership.balance()

        await platform.say(user_id="U1", text="only once", ref="m1")

        async with session_factory() as session:
            people = (
                await session.scalars(
                    select(ExternalUser.client_id).where(
                        ExternalUser.bridge_id == bridge.bridge_id
                    )
                )
            ).all()
            person = await session.get(Client, people[0])
        assert len(people) == 1 and person is not None
        assert await _room_bodies(
            session_factory, bridge.room_id, person.transport_user_id
        ) == ["only once"]


class TestChangesMadeElsewhere:
    async def test_an_edit_through_the_quiet_process_reaches_the_holder(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        # What the gateway's edit route does: store the config, then restart.
        async with session_factory() as session:
            await session.execute(
                update(CollaborationBridge)
                .where(CollaborationBridge.id == bridge.bridge_id)
                .values(connection_config={"token": "second"})
            )
            await session.commit()
        await quiet.bridges.restart(bridge.bridge_id)

        await _eventually(
            lambda: [chat.config.token for chat in platform.listening] == ["second"]
        )
        held = holder.bridges.get(bridge.bridge_id)
        assert held is not None and held.active
        assert platform.listening == [held.adapter]

    async def test_what_a_bridge_learned_and_stored_restarts_no_copy(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        """Teams stores the service URL and each channel's team as it learns
        them from traffic, in the bridge's config. That is not an edit: the
        re-check restarts no copy of the bridge for it."""
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        await _eventually(lambda: quiet.bridges.is_connected(bridge.bridge_id))
        running = [p.bridges.get(bridge.bridge_id) for p in (holder, quiet)]

        await holder.bridges._persist_service_url(
            bridge.bridge_id, TENANT_ZERO_ID, "https://smba.example/emea/"
        )
        await holder.bridges._persist_channel_team(
            bridge.bridge_id, TENANT_ZERO_ID, "C9", "team-9"
        )
        for process in (holder, quiet):
            await process.bridges.reconcile_all()

        assert [p.bridges.get(bridge.bridge_id) for p in (holder, quiet)] == running

    async def test_a_bridge_removed_through_the_quiet_process_stops_listening(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        await quiet.bridges.remove(bridge.bridge_id)

        await _eventually(lambda: platform.listening == [])
        await _eventually(lambda: holder.bridges.get(bridge.bridge_id) is None)
        assert not holder.bridges.holds(bridge.bridge_id)

    async def test_a_room_bridged_through_the_quiet_process_is_relayed(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )

        with tenant_scope(TENANT_ZERO_ID):
            created = await quiet.bridges._room_service.create_room(
                RoomCreateConfig(
                    name="second",
                    description="",
                    bridge_id=bridge.bridge_id,
                    external_channel_id="C2",
                    channel_type="channel_public",
                    created_by_kind="system",
                )
            )
        async with session_factory() as session:
            await RoomStore().add_client(session, bridge.speaker_id, created.room.id)
            await session.commit()
        await _say(session_factory, bridge, "in the new room", room_id=created.room.id)

        await _eventually(lambda: len(platform.posts) >= 1)
        assert platform.posts[0][0] == "C2"
        assert platform.posted() == ["in the new room"]


class TestPeopleOnThePlatform:
    async def test_a_person_minted_by_the_quiet_process_is_known_to_the_holder(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        holder, quiet = _holder(
            await _boot_two(postgres_url, session_factory, processes),
            bridge.bridge_id,
        )
        copy = quiet.bridges.get(bridge.bridge_id)
        assert copy is not None
        # The copy comes up in its own task, after it is started.
        await _eventually(lambda: quiet.bridges.is_connected(bridge.bridge_id))

        # A webhook delivery reaching the quiet process: it mints the person.
        await copy.adapter.hear(_post(user_id="U7", text="first words", ref="m1"))  # type: ignore[attr-defined]
        await _say(session_factory, bridge, "answer")
        # The holder relays the room out: the person's own words are not
        # echoed back to them, though the holder never minted them.
        assert await _posted(platform, 1) == ["answer"]

        # Then the platform tells the holder about them: adopted, not minted
        # a second time.
        await platform.say(user_id="U7", text="second words", ref="m2")

        async with session_factory() as session:
            people = (
                await session.scalars(
                    select(ExternalUser.client_id).where(
                        ExternalUser.bridge_id == bridge.bridge_id
                    )
                )
            ).all()
            person = await session.get(Client, people[0])
        assert len(people) == 1 and person is not None
        assert await _room_bodies(
            session_factory, bridge.room_id, person.transport_user_id
        ) == ["first words", "second words"]
        assert platform.posted() == ["answer"]

    async def test_two_people_whose_names_read_alike_stay_two_people(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        """`ann.marie` and `ann-marie` sanitize to the same client localpart.
        The second to speak is a person of their own, not the first."""
        await _boot_two(postgres_url, session_factory, processes)

        await platform.say(user_id="Ann.Marie", text="from the first", ref="m1")
        await platform.say(user_id="Ann-Marie", text="from the second", ref="m2")

        async with session_factory() as session:
            people = dict(
                (
                    await session.execute(
                        select(ExternalUser.external_user_id, Client.transport_user_id)
                        .join(Client, Client.id == ExternalUser.client_id)
                        .where(ExternalUser.bridge_id == bridge.bridge_id)
                    )
                )
                .tuples()
                .all()
            )
        assert set(people) == {"Ann.Marie", "Ann-Marie"}
        assert people["Ann.Marie"] != people["Ann-Marie"]
        assert await _room_bodies(
            session_factory, bridge.room_id, people["Ann.Marie"]
        ) == ["from the first"]
        assert await _room_bodies(
            session_factory, bridge.room_id, people["Ann-Marie"]
        ) == ["from the second"]


class TestAPlatformThatCannotKeepQuiet:
    """Every process listens to it, so every process hears each post. The
    room still gets each one once: what a post writes is numbered from it."""

    async def test_a_post_every_process_hears_is_stored_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        await _loud(session_factory, bridge)
        await _boot_two(postgres_url, session_factory, processes)
        await _eventually(lambda: len(platform.listening) == 2)

        await platform.say(user_id="U3", text="heard twice", ref="m9")
        await platform.command(user_id="U3", command="help", ref="m10")

        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Message.event_type, Message.body).where(
                        Message.room_id == bridge.room_id,
                        Message.event_type.in_(
                            ["m.room.message", "com.switch.command"]
                        ),
                    )
                )
            ).all()
        assert sorted(event_type for event_type, _ in rows) == [
            "com.switch.command",
            "m.room.message",
        ]

    async def test_a_reply_is_still_posted_once(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        processes: list[_Process],
        platform: _Platform,
        bridge: _Bridge,
    ) -> None:
        await _loud(session_factory, bridge)
        await _boot_two(postgres_url, session_factory, processes)

        await _say(session_factory, bridge, "relayed by the holder alone")

        assert await _posted(platform, 1) == ["relayed by the holder alone"]


async def _loud(
    session_factory: async_sessionmaker[AsyncSession], bridge: _Bridge
) -> None:
    async with session_factory() as session:
        await session.execute(
            update(CollaborationBridge)
            .where(CollaborationBridge.id == bridge.bridge_id)
            .values(type=LOUD_CHAT)
        )
        await session.commit()
