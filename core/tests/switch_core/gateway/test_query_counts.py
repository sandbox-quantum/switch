"""The list and detail routes Console reads run a fixed number of statements.

`GET /rooms`, `GET /agents` and `GET /agents/{id}` used to read one row at a
time per room, per agent, per owner and per bridge, all on one connection. The
time a request held it grew with the data, and under load every await between
those reads kept it held, which is how a pilot with a few hundred agents ran
its pool dry. Each route here is driven over a small dataset and again over a
larger one, through the real routes and real Postgres, and has to run exactly
as many statements both times.

The statements are counted at the engine (`tests/switch_core/statement_counts.py`)
and connections at the pool (`tests/switch_core/pool_checkouts.py`), so the
second contract holds too: the room list builds its channel deeplinks, which can
ask the messaging platform, holding no connection.
"""

from __future__ import annotations

import secrets
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentSession,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    Model,
    Room,
    RoomRole,
    TenantMember,
    Tool,
    User,
    room_agents,
)
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.agents import router as agents_router
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.rooms import router as rooms_router
from switch_core.keys import Keyring
from tests.switch_core.pool_checkouts import PoolCheckouts
from tests.switch_core.statement_counts import StatementCounts

_KEYRING = Keyring.parse("test:" + secrets.token_hex(32), legacy_secret=None)


@dataclass
class _Adapter:
    """A messaging platform's adapter, recording the connections held when asked."""

    tracker: PoolCheckouts
    held: list[int] = field(default_factory=list)

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        self.held.append(self.tracker.held_now())
        return f"platform://channel/{external_channel_id}"


@dataclass
class _CollabLifecycle:
    adapter: _Adapter

    def get_adapter(self, bridge_id: str) -> _Adapter:
        return self.adapter


def _protocol() -> SimpleNamespace:
    """The parts of `AgentCore` the agent detail reads: real stores and a real,
    empty connection registry, so presence is answered from the database."""
    return SimpleNamespace(
        agent_store=AgentStore(),
        agent_session_store=AgentSessionStore(),
        room_role_store=RoomRoleStore(),
        connections=AgentConnectionRegistry(),
    )


def _app(
    session_factory: async_sessionmaker[AsyncSession],
    counts: StatementCounts,
    tracker: PoolCheckouts,
) -> Any:
    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(rooms_router, prefix="/rooms")
    app.include_router(agents_router, prefix="/agents")
    protocol = _protocol()
    overrides: dict[Callable[..., Any], Callable[..., Any]] = {
        gw_deps.get_session: _session,
        gw_deps.get_session_factory: lambda: session_factory,
        gw_deps.get_user_store: UserStore,
        gw_deps.get_room_store: RoomStore,
        gw_deps.get_room_group_store: RoomGroupStore,
        gw_deps.get_bridge_store: CollaborationBridgeStore,
        gw_deps.get_external_user_store: ExternalUserStore,
        gw_deps.get_agent_store: AgentStore,
        gw_deps.get_protocol: lambda: protocol,
        gw_deps.get_config: lambda: SimpleNamespace(
            keyring=_KEYRING, gateway_tenant_choice_enabled=False
        ),
    }
    app.dependency_overrides.update(overrides)
    return tracker.wrap(counts.wrap(app))


def _client(app: Any, user: User) -> httpx.AsyncClient:
    token = create_jwt(user.id, user.email, user.role, _KEYRING, TENANT_ZERO_ID)
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


class _Seed:
    """Rows for the routes to read, added in batches so one test can measure
    the same route over a small dataset and then a larger one."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self._n = 0
        self.bridges: list[CollaborationBridge] = []
        self.subject: Agent | None = None

    def _next(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}-{self._n}"

    async def admin(self) -> User:
        async with self._session_factory() as session:
            user = User(name="owner", email="owner@example.com", role="user")
            session.add(user)
            await session.flush()
            session.add(
                TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="owner")
            )
            await session.commit()
            return user

    async def _user(self, session: AsyncSession) -> User:
        name = self._next("user")
        user = User(name=name, email=f"{name}@example.com", role="user")
        session.add(user)
        await session.flush()
        return user

    async def _client(self, session: AsyncSession, kind: str) -> Client:
        name = self._next(kind)
        client = Client(transport_user_id=f"@{name}:test", display_name=name, type=kind)
        session.add(client)
        await session.flush()
        return client

    async def _agent(
        self, session: AsyncSession, *, parent: Agent | None = None
    ) -> Agent:
        owner = await self._user(session)
        client = await self._client(session, "agent")
        name = self._next("agent")
        key = ApiKey(
            user_id=owner.id,
            key_hash=f"hash-{name}",
            encrypted_key="enc",
            label=name,
            type="agent",
        )
        session.add(key)
        await session.flush()
        agent = Agent(
            name=name,
            description="d",
            agent_type="session_addressable",
            connector_type="claude_code",
            integration_profile={"connection_model": "session_addressable"},
            client_id=client.id,
            api_key_id=key.id,
            owner_id=owner.id,
            parent_agent_id=parent.id if parent is not None else None,
        )
        session.add(agent)
        await session.flush()
        session.add_all(
            [
                Tool(name="search", description="s", agent_id=agent.id),
                Model(name="model", description="m", agent_id=agent.id),
            ]
        )
        await session.flush()
        return agent

    async def _bridges(self, session: AsyncSession) -> None:
        if self.bridges:
            return
        for platform in ("slack", "mattermost"):
            client = await self._client(session, "bridge")
            bridge = CollaborationBridge(
                type=platform,
                display_name=platform.title(),
                connection_config={},
                client_id=client.id,
                status="running",
            )
            session.add(bridge)
            await session.flush()
            self.bridges.append(bridge)

    async def rooms(self, count: int) -> None:
        """`count` rooms, each with its own owner and two member agents, every
        other one bridged with a connected platform user."""
        async with self._session_factory() as session:
            await self._bridges(session)
            for i in range(count):
                owner = await self._user(session)
                bridge = self.bridges[i % 2] if i % 3 else None
                name = self._next("room")
                room = Room(
                    transport_room_id=f"!{name}:test",
                    name=f"{bridge.display_name}: {name}" if bridge else name,
                    description="d",
                    owner_id=owner.id,
                    bridge_id=bridge.id if bridge else None,
                    external_channel_id=f"C-{name}" if bridge else None,
                )
                session.add(room)
                await session.flush()
                for _ in range(2):
                    agent = await self._agent(session)
                    await session.execute(
                        insert(room_agents).values(room_id=room.id, agent_id=agent.id)
                    )
                if bridge is not None:
                    person = await self._client(session, "external")
                    session.add(
                        ExternalUser(
                            bridge_id=bridge.id,
                            external_user_id=f"U-{person.id}",
                            external_username=person.display_name,
                            client_id=person.id,
                        )
                    )
                    session.add(ClientRoom(client_id=person.id, room_id=room.id))
                    await session.flush()
            await session.commit()

    async def agents(self, count: int) -> None:
        """`count` agents, each with its own owner, a tool and a model."""
        async with self._session_factory() as session:
            for _ in range(count):
                await self._agent(session)
            await session.commit()

    async def subject_agent(self, rooms: int) -> Agent:
        """One agent in `rooms` more rooms, each with a live session row and a
        role, and with one more subagent per room."""
        async with self._session_factory() as session:
            if self.subject is None:
                self.subject = await self._agent(session)
            subject = self.subject
            for _ in range(rooms):
                name = self._next("room")
                room = Room(
                    transport_room_id=f"!{name}:test", name=name, description="d"
                )
                session.add(room)
                await session.flush()
                await session.execute(
                    insert(room_agents).values(room_id=room.id, agent_id=subject.id)
                )
                session.add_all(
                    [
                        AgentSession(
                            agent_id=subject.id,
                            room_id=room.id,
                            lifecycle="heartbeat",
                            last_seen_at=datetime.now(UTC),
                        ),
                        RoomRole(room_id=room.id, name="lead", instructions="i"),
                    ]
                )
                await self._agent(session, parent=subject)
            await session.commit()
            return subject


@pytest.fixture
def adapter(pool_checkouts: PoolCheckouts, monkeypatch: pytest.MonkeyPatch) -> _Adapter:
    adapter = _Adapter(pool_checkouts)
    monkeypatch.setattr(
        rooms_module, "get_collab_lifecycle", lambda: _CollabLifecycle(adapter)
    )
    return adapter


async def _count(
    client: httpx.AsyncClient, counts: StatementCounts, path: str
) -> tuple[int, Any]:
    response = await client.get(path)
    assert response.status_code == 200, response.text
    return counts.last(f"GET {path}").count, response.json()


class TestRoomList:
    async def test_the_same_statements_for_one_room_and_many(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        statement_counts: StatementCounts,
        pool_checkouts: PoolCheckouts,
        adapter: _Adapter,
    ) -> None:
        seed = _Seed(session_factory)
        user = await seed.admin()
        app = _app(session_factory, statement_counts, pool_checkouts)

        async with _client(app, user) as client:
            await seed.rooms(3)
            few, few_rooms = await _count(client, statement_counts, "/rooms")
            await seed.rooms(9)
            many, many_rooms = await _count(client, statement_counts, "/rooms")

        assert (len(few_rooms), len(many_rooms)) == (3, 12)
        assert few == many, statement_counts.last("GET /rooms").statements
        bridged = [r for r in many_rooms if r["bridge_id"]]
        assert bridged and all(r["external_channel_url"] for r in bridged)
        assert all(r["agent_count"] == 2 for r in many_rooms)
        assert all(r["owner_name"] for r in many_rooms)
        assert all(r["connected_user_count"] == 1 for r in bridged)
        assert all(not r["name"].startswith("Slack: ") for r in bridged)

    async def test_the_platform_is_asked_for_deeplinks_holding_no_connection(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        statement_counts: StatementCounts,
        pool_checkouts: PoolCheckouts,
        adapter: _Adapter,
    ) -> None:
        seed = _Seed(session_factory)
        user = await seed.admin()
        await seed.rooms(4)
        app = _app(session_factory, statement_counts, pool_checkouts)

        async with _client(app, user) as client:
            assert (await client.get("/rooms")).status_code == 200

        assert adapter.held and set(adapter.held) == {0}


class TestAgentList:
    async def test_the_same_statements_for_one_agent_and_many(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        statement_counts: StatementCounts,
        pool_checkouts: PoolCheckouts,
    ) -> None:
        seed = _Seed(session_factory)
        user = await seed.admin()
        app = _app(session_factory, statement_counts, pool_checkouts)

        async with _client(app, user) as client:
            await seed.agents(1)
            few, few_agents = await _count(client, statement_counts, "/agents")
            await seed.agents(9)
            many, many_agents = await _count(client, statement_counts, "/agents")

        assert (len(few_agents), len(many_agents)) == (1, 10)
        assert few == many, statement_counts.last("GET /agents").statements
        assert [a["name"] for a in many_agents] == sorted(
            a["name"] for a in many_agents
        )
        assert all(
            (a["tool_count"], a["model_count"]) == (1, 1) and a["owner_name"]
            for a in many_agents
        )


class TestAgentDetail:
    async def test_the_same_statements_for_one_room_and_many(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        statement_counts: StatementCounts,
        pool_checkouts: PoolCheckouts,
    ) -> None:
        seed = _Seed(session_factory)
        user = await seed.admin()
        app = _app(session_factory, statement_counts, pool_checkouts)

        async with _client(app, user) as client:
            subject = await seed.subject_agent(1)
            path = f"/agents/{subject.id}"
            few, few_detail = await _count(client, statement_counts, path)
            await seed.subject_agent(6)
            many, many_detail = await _count(client, statement_counts, path)

        assert (len(few_detail["rooms"]), len(many_detail["rooms"])) == (1, 7)
        assert few == many, statement_counts.last(f"GET {path}").statements
        assert {m["status"] for m in many_detail["rooms"]} == {"live"}
        assert len(many_detail["sessions"]) == 7
        assert all(s["room_name"] for s in many_detail["sessions"])
        assert len(many_detail["children"]) == 7
        assert all(
            (c["tool_count"], c["model_count"]) == (1, 1) and c["owner_name"]
            for c in many_detail["children"]
        )
