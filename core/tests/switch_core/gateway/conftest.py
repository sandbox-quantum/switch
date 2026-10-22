"""The `/chats` harness: real routes, `ChatService`, `RoomService` and
Postgres provisioning, shared by the chats test modules, and a second
switch-core process beside it for the tests across processes."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.connection_rows import SharedConnections
from switch_core.chats.service import ChatError, ChatService
from switch_core.chats.signals import ChatSignals
from switch_core.db.models import (
    Agent,
    Client,
    Message,
    User,
)
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.media_store import MediaStore
from switch_core.db.stores.message_store import MessageStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.chats import (
    chat_error_response,
    router,
)
from switch_core.process_identity import new_process_id
from switch_core.process_lease import ProcessLease
from switch_core.provisioning.postgres import PostgresProvisioning
from switch_core.room_service import RoomService
from switch_core.session_activity.listener import Change
from switch_core.signals import SignalBus
from switch_core.transport.invites import InviteBus
from switch_core.trust.client import NullTrustClient
from tests.conftest import TEST_KEYRING
from tests.routing import router_on
from tests.switch_core.gateway.agent_route_harness import add_agent

_MESSAGE_STORE = MessageStore()

# How long `two_processes` waits for each process's signal bus to connect.
_CONNECT_SECONDS = 10.0


class _FakeLifecycle:
    """The running-client registry, for agents that have no consumer here."""

    def __init__(self) -> None:
        self.agents: dict[str, SimpleNamespace] = {}

    def get_by_agent_id(self, agent_id: str) -> SimpleNamespace | None:
        return self.agents.get(agent_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


class _FakeListener:
    """Records subscriptions; a test rings a room by hand, or deliberately not."""

    def __init__(self) -> None:
        self.wakers: dict[str, set[Callable[[str], Awaitable[None]]]] = {}

    def subscribe(self, room_id: str, waker: Callable[[str], Awaitable[None]]) -> None:
        self.wakers.setdefault(room_id, set()).add(waker)

    def unsubscribe(
        self, room_id: str, waker: Callable[[str], Awaitable[None]]
    ) -> None:
        self.wakers.get(room_id, set()).discard(waker)

    async def ring(self, room_id: str) -> None:
        for waker in list(self.wakers.get(room_id, ())):
            await waker(room_id)


class _FakeActivityListener:
    """The session-activity listener; a test delivers changes by hand."""

    def __init__(self) -> None:
        self.subscribers: list[tuple[Any, Any]] = []

    def subscribe(self, tenant_id: str, on_change: Any, on_resync: Any) -> Any:
        entry = (on_change, on_resync)
        self.subscribers.append(entry)
        return lambda: self.subscribers.remove(entry)

    async def change(self, change: Change) -> None:
        for on_change, _ in list(self.subscribers):
            await on_change(change)

    async def resync(self) -> None:
        for _, on_resync in list(self.subscribers):
            await on_resync()


class _Harness(SimpleNamespace):
    client: httpx.AsyncClient
    factory: async_sessionmaker[AsyncSession]
    service: ChatService
    room_service: RoomService
    listener: _FakeListener
    activity: _FakeActivityListener
    lifecycle: _FakeLifecycle
    connections: AgentConnectionRegistry
    alice: User
    bob: User
    carol: User
    admin: User

    def as_user(self, user: User) -> dict[str, str]:
        return {"x-user": user.id}

    async def agent(
        self, name: str, *, owner: User, policy: dict | None = None
    ) -> Agent:
        async with self.factory() as session:
            agent = await add_agent(session, name=name, owner_id=owner.id)
            agent.addressing_policy = policy
            client = await session.get(Client, agent.client_id)
            assert client is not None
            self.lifecycle.agents[agent.id] = SimpleNamespace(
                client_id=client.id, transport_user_id=client.transport_user_id
            )
            await session.commit()
            return agent

    async def create_chat(
        self, user: User, agent: Agent, request_id: str, name: str | None = None
    ) -> httpx.Response:
        return await self.client.post(
            "/chats",
            json={"agentId": agent.id, "name": name, "requestId": request_id},
            headers=self.as_user(user),
        )

    async def new_chat(self, user: User, agent: Agent, request_id: str) -> str:
        response = await self.create_chat(user, agent, request_id)
        assert response.status_code == 200, response.text
        return str(response.json()["chat"]["roomId"])

    async def send(
        self, user: User, room_id: str, request_id: str, body: str, **extra: Any
    ) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/messages",
            json={"requestId": request_id, "body": body, **extra},
            headers=self.as_user(user),
        )

    async def invite(self, manager: User, room_id: str, user: User) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/members",
            json={"userId": user.id},
            headers=self.as_user(manager),
        )

    async def upload(
        self, user: User, room_id: str, upload_id: str, data: bytes, name: str
    ) -> httpx.Response:
        return await self.client.post(
            f"/chats/{room_id}/attachments",
            data={"uploadId": upload_id},
            files={"file": (name, data, "image/png")},
            headers=self.as_user(user),
        )

    async def message_rows(self, room_id: str) -> list[Message]:
        async with self.factory() as session:
            rows = await session.execute(
                select(Message)
                .where(
                    Message.room_id == room_id, Message.event_type == "m.room.message"
                )
                .order_by(Message.seq)
            )
            return list(rows.scalars().all())


async def _user(session: AsyncSession, name: str, role: str | None) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    if role is not None:
        await UserStore().add_membership(
            session,
            tenant_id="00000000-0000-0000-0000-000000000000",
            user_id=user.id,
            role=role,
        )
    return user


def _chat_service(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    lifecycle: _FakeLifecycle,
    listener: _FakeListener,
    activity: _FakeActivityListener,
    connections: AgentConnectionRegistry,
) -> tuple[ChatService, RoomService]:
    """A chat service and the room service it works through, built as one
    switch-core process builds them."""
    room_store = RoomStore()
    message_router = router_on(session_factory)
    provisioning = PostgresProvisioning(
        session_factory=session_factory,
        room_store=room_store,
        client_store=ClientStore(),
        router=message_router,
        invites=InviteBus(),
    )
    room_service = RoomService(
        provisioning=provisioning,
        room_store=room_store,
        agent_store=AgentStore(),
        client_lifecycle=lifecycle,  # type: ignore[arg-type]
        collab_lifecycle=None,  # type: ignore[arg-type]
        collab_bridge_store=CollaborationBridgeStore(),
        resource_service=None,  # type: ignore[arg-type]
        session_factory=session_factory,
        room_cache=MagicMock(),
    )
    service = ChatService(
        session_factory=session_factory,
        room_service=room_service,
        provisioning=provisioning,
        listener=listener,  # type: ignore[arg-type]
        activity_listener=activity,  # type: ignore[arg-type]
        room_store=room_store,
        agent_store=AgentStore(),
        user_store=UserStore(),
        message_store=_MESSAGE_STORE,
        router=message_router,
        media_store=MediaStore(),
        usage_store=UsageStore(),
        id_server_name="switch.test",
        media_max_bytes=1024,
        agent_chats_enabled=True,
        connections=connections,
        trust_client=NullTrustClient(),
    )
    room_service.on_room_agents_changed(service.sync_room)
    return service, room_service


@pytest.fixture
async def chats(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[_Harness]:
    async with session_factory() as session:
        alice = await _user(session, "alice", "member")
        bob = await _user(session, "bob", "member")
        carol = await _user(session, "carol", None)
        admin = await _user(session, "admin", "admin")
        await session.commit()

    lifecycle = _FakeLifecycle()
    listener = _FakeListener()
    activity = _FakeActivityListener()
    connections = AgentConnectionRegistry()
    service, room_service = _chat_service(
        session_factory,
        lifecycle=lifecycle,
        listener=listener,
        activity=activity,
        connections=connections,
    )

    app = FastAPI()
    app.state.chat_service = service
    app.add_exception_handler(ChatError, chat_error_response)
    app.include_router(router, prefix="/chats")

    async def user_from_header(request: Request) -> User:
        async with session_factory() as session:
            user = await session.get(User, request.headers["x-user"])
            assert user is not None
            return user

    app.dependency_overrides[get_current_user] = user_from_header
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://switch.test"
    ) as client:
        yield _Harness(
            client=client,
            factory=session_factory,
            service=service,
            room_service=room_service,
            listener=listener,
            activity=activity,
            lifecycle=lifecycle,
            connections=connections,
            alice=alice,
            bob=bob,
            carol=carol,
            admin=admin,
        )


@dataclass
class _Process:
    """One switch-core process's side of chats on the shared database: its
    chat service and agent connections, and the signal bus over which it
    tells the other process what changed."""

    service: ChatService
    connections: AgentConnectionRegistry
    signals: ChatSignals
    shared: SharedConnections
    bus: SignalBus
    lease: ProcessLease


def _process(
    session_factory: async_sessionmaker[AsyncSession],
    postgres_url: str,
    service: ChatService,
    connections: AgentConnectionRegistry,
) -> _Process:
    process_id = new_process_id("test-pod")
    bus = SignalBus(
        session_factory,
        lambda: create_async_engine(postgres_url, poolclass=NullPool),
        process_id=process_id,
    )
    lease = ProcessLease(
        process_id=process_id,
        session_factory=session_factory,
        processes=SwitchCoreProcessStore(),
        key_ids=[key.id for key in TEST_KEYRING.keys],
    )
    return _Process(
        service=service,
        connections=connections,
        signals=ChatSignals(service=service, bus=bus),
        shared=SharedConnections(
            registry=connections,
            session_factory=session_factory,
            store=AgentConnectionStore(),
            bus=bus,
            lease=lease,
        ),
        bus=bus,
        lease=lease,
    )


@pytest.fixture
async def two_processes(
    chats: _Harness, postgres_url: str
) -> AsyncIterator[tuple[_Process, _Process]]:
    """The harness's chat service as one switch-core process, and a second on
    the same database. Each tells the other what changed over its own signal
    bus on the real `NOTIFY` channel: people's chats (`ChatSignals`) and its
    agent connections (`SharedConnections`)."""
    connections = AgentConnectionRegistry()
    service, _ = _chat_service(
        chats.factory,
        lifecycle=chats.lifecycle,
        listener=_FakeListener(),
        activity=_FakeActivityListener(),
        connections=connections,
    )
    processes = [
        _process(chats.factory, postgres_url, chats.service, chats.connections),
        _process(chats.factory, postgres_url, service, connections),
    ]
    for process in processes:
        await process.lease.renew()
        await process.shared.start()
        await process.bus.start()
    # Each lease is renewed while the process runs, as in production, so the
    # other reads what it holds as held however long the test takes.
    runs = [
        asyncio.create_task(run())
        for process in processes
        for run in (process.lease.run, process.shared.run)
    ]
    try:
        for process in processes:
            await asyncio.wait_for(process.bus.connected.wait(), _CONNECT_SECONDS)
        yield processes[0], processes[1]
    finally:
        # The buses first, so no signal starts work after the processes
        # stopped running; then the runs, which wait for the work they started.
        for process in processes:
            await process.bus.stop()
        for run in runs:
            run.cancel()
        await asyncio.gather(*runs, return_exceptions=True)
