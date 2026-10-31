"""The admin's consumer runs in one process, and answers once.

Against real PostgreSQL, two "processes" on one database, each wired the way
`main` wires one: its own message listener, client factory, lifecycle,
process lease, ownership and cursor writer. Both run the tenant's admin actor,
so either can write as Switch, but only the one that owns the admin client
runs its `CommandConsumer`. A `!help` is answered once, not once per process,
and one typed while no process read for the admin is answered by the next
owner, once.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.clients.actor import AgentActor, SystemActor
from switch_core.clients.admin_messages import ADMIN_MARKER, AdminMessageType
from switch_core.clients.agent_admin import AgentAdministration, AgentDeletionRequests
from switch_core.clients.client_factory import ClientFactory
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.clients.command_consumer import CommandConsumer
from switch_core.db.models import TENANT_ZERO_ID, Client, Message, Room
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.delivery_cursor_store import DeliveryCursorStore
from switch_core.db.stores.document_store import DocumentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.stores.reference_store import ReferenceStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.messages.notify import MessageListener
from switch_core.ownership import Ownership
from switch_core.process_lease import ProcessLease
from switch_core.signals import SignalBus
from switch_core.transport.cursors import CursorWriter
from switch_core.transport.ephemeral import EphemeralBus
from switch_core.transport.invites import InviteBus
from switch_core.transport.observer import IgnoreParticipantMessages
from switch_core.transport.room_cache import RoomCacheLimits, RoomDeliveryCache
from tests.ownership import process_lease_on
from tests.routing import router_on

TIMEOUT = 10.0


@dataclass
class _Process:
    lifecycle: ClientLifecycleService
    ownership: Ownership
    lease: ProcessLease
    listener: MessageListener
    writer_task: asyncio.Task[None]

    async def stop(self) -> None:
        """Shut down as `main` does: owned work first, then the lease."""
        await self.ownership.stop()
        await self.lease.stop()
        await self.lifecycle.stop_all()
        await self.listener.stop()
        self.writer_task.cancel()
        await asyncio.gather(self.writer_task, return_exceptions=True)


def _never_listening() -> Any:
    raise AssertionError("these processes' signal buses are never started")


async def _process(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> _Process:
    listener = MessageListener(
        lambda: create_async_engine(postgres_url, poolclass=NullPool)
    )
    await listener.start()
    await asyncio.wait_for(listener.connected.wait(), TIMEOUT)
    factory = ClientFactory(
        client_store=ClientStore(),
        session_factory=session_factory,
        config=MagicMock(),
        room_store=RoomStore(),
        message_store=MessageStore(),
        usage_store=UsageStore(),
        media_store=MediaStore(),
        listener=listener,
        invites=InviteBus(),
        ephemeral=EphemeralBus(),
        room_cache=RoomDeliveryCache(
            session_factory=session_factory,
            message_store=MessageStore(),
            limits=RoomCacheLimits(
                max_bytes=1 << 24,
                max_rooms=100,
                max_rows_per_room=200,
                max_age_seconds=60.0,
            ),
        ),
        message_observer=IgnoreParticipantMessages(),
        router=router_on(session_factory),
    )
    # The agent tagged in the room is a client too; it reads nothing here.
    factory.register("agent", AgentActor)
    factory.register(
        "admin",
        SystemActor,
        CommandConsumer,
        agent_store=AgentStore(),
        room_store=RoomStore(),
        room_role_store=RoomRoleStore(),
        external_user_store=ExternalUserStore(),
        document_store=DocumentStore(),
        reference_store=ReferenceStore(),
        agent_session_store=AgentSessionStore(),
        room_service=MagicMock(),
        user_store=UserStore(),
        agent_admin=AgentAdministration(),
        deletion_requests=AgentDeletionRequests(),
        connections=AgentConnectionRegistry(),
        frontend_base_url=None,
        follow_the_conversation_enabled=False,
    )
    lease = process_lease_on(session_factory)
    ownership = Ownership(
        lease=lease,
        session_factory=session_factory,
        bus=SignalBus(session_factory, _never_listening, process_id=lease.process_id),
        store=OwnershipLeaseStore(),
        processes=SwitchCoreProcessStore(),
    )
    writer = CursorWriter(
        session_factory=session_factory,
        cursors=DeliveryCursorStore(),
        leases=OwnershipLeaseStore(),
        process_id=lease.process_id,
    )
    lifecycle = ClientLifecycleService(
        provisioning=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=factory,
        session_factory=session_factory,
        config=MagicMock(),
        tenants_isolated=True,
        ownership=ownership,
        cursor_writer=writer,
    )
    return _Process(
        lifecycle=lifecycle,
        ownership=ownership,
        lease=lease,
        listener=listener,
        writer_task=asyncio.create_task(writer.run()),
    )


@dataclass
class _Room:
    room_id: str
    transport_room_id: str
    admin_id: str
    speaker_id: str
    speaker: str


@pytest.fixture
async def room(session_factory: async_sessionmaker[AsyncSession]) -> _Room:
    """A room with the admin client in it, a person who speaks there, and an
    agent that is not in it, for the person to tag."""
    suffix = uuid.uuid4().hex[:8]
    async with session_factory() as session:
        admin = Client(
            transport_user_id=f"@switch-admin-{suffix}:test",
            display_name="admin",
            type="admin",
        )
        speaker = Client(
            transport_user_id=f"@person-{suffix}:test",
            display_name="person",
            type="user",
        )
        room = Room(transport_room_id=f"!room-{suffix}:test", name="r", description="")
        session.add_all([admin, speaker, room])
        await session.flush()
        await RoomStore().add_client(session, admin.id, room.id)
        await RoomStore().add_client(session, speaker.id, room.id)
        await session.commit()
        return _Room(
            room_id=room.id,
            transport_room_id=room.transport_room_id,
            admin_id=admin.id,
            speaker_id=speaker.id,
            speaker=speaker.transport_user_id,
        )


@pytest.fixture
async def two(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession], room: _Room
) -> AsyncIterator[tuple[_Process, _Process]]:
    processes = [await _process(postgres_url, session_factory) for _ in range(2)]
    for process in processes:
        await process.lifecycle.start_all()
        await process.ownership.start()
    # The first balance of each cannot see the other; balance once more now
    # that both leases are there, as the interval would.
    for process in processes:
        await process.ownership.balance()
    try:
        yield processes[0], processes[1]
    finally:
        for process in processes:
            await process.stop()


async def _type_help(
    session_factory: async_sessionmaker[AsyncSession], room: _Room
) -> None:
    """`!help` typed in the room, as the command row a bridge writes."""
    async with session_factory() as session:
        await MessageStore().create(
            session,
            Message(
                room_id=room.room_id,
                transport_event_id=f"sw_{uuid.uuid4().hex}",
                sender_id=room.speaker,
                sender_client_id=room.speaker_id,
                sender_name="person",
                event_type="com.switch.command",
                msgtype=None,
                body=None,
                formatted_body=None,
                content={
                    "command": "help",
                    "args": "",
                    "user_id": room.speaker,
                    "user_name": "person",
                },
            ),
            [],
        )
        await session.commit()


async def _answers(
    session_factory: async_sessionmaker[AsyncSession], room: _Room
) -> list[Message]:
    async with session_factory() as session:
        rows = (
            await session.scalars(
                select(Message)
                .where(Message.room_id == room.room_id)
                .order_by(Message.seq)
            )
        ).all()
    return [
        row
        for row in rows
        if (row.content or {}).get(ADMIN_MARKER, {}).get("type")
        == AdminMessageType.COMMAND_RESULT.value
    ]


async def _eventually_answered(
    session_factory: async_sessionmaker[AsyncSession], room: _Room, count: int
) -> list[Message]:
    async with asyncio.timeout(TIMEOUT):
        while len(await _answers(session_factory, room)) < count:
            await asyncio.sleep(0.05)
    # Long enough for a second reader, had there been one, to have answered.
    await asyncio.sleep(0.5)
    return await _answers(session_factory, room)


class TestOneAdminConsumer:
    async def test_two_processes_run_one_command_consumer_between_them(
        self, two: tuple[_Process, _Process], room: _Room
    ) -> None:
        a, b = two

        owners = [p for p in (a, b) if p.lifecycle.owns(room.admin_id)]

        assert len(owners) == 1
        assert owners[0].lifecycle.running_count() == 1
        other = b if owners[0] is a else a
        assert other.lifecycle.running_count() == 0
        # Both can write as Switch.
        for process in (a, b):
            assert process.lifecycle.get_by_type("admin", TENANT_ZERO_ID)

    async def test_a_message_is_answered_once(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
        room: _Room,
    ) -> None:
        await _type_help(session_factory, room)

        answers = await _eventually_answered(session_factory, room, 1)

        assert len(answers) == 1

    async def test_the_next_owner_answers_what_was_said_while_nobody_read(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        two: tuple[_Process, _Process],
        room: _Room,
    ) -> None:
        a, b = two
        owner, other = (a, b) if a.lifecycle.owns(room.admin_id) else (b, a)
        await _type_help(session_factory, room)
        await _eventually_answered(session_factory, room, 1)

        await owner.stop()
        await _type_help(session_factory, room)
        await other.ownership.balance()

        answers = await _eventually_answered(session_factory, room, 2)

        assert other.lifecycle.owns(room.admin_id)
        assert len(answers) == 2
