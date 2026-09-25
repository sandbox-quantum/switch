"""Runs over real HTTP, against real Postgres: listing a user's runs as a
tree, and who may stop one or let a paused one continue."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from types import SimpleNamespace

import httpx
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_runs import RunService
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.auth import get_current_user, get_tenant_is_admin
from switch_core.gateway.dependencies import (
    get_agent_store,
    get_protocol,
    get_room_store,
    get_session,
)
from switch_core.gateway.template_runs import router


def _room(name: str, owner: User, **columns: object) -> Room:
    return Room(
        matrix_room_id=f"!{uuid.uuid4().hex}:test.local",
        name=name,
        description="",
        channel_type="channel_public",
        created_by=owner.id,
        owner_id=owner.id,
        **columns,
    )


@pytest_asyncio.fixture
async def seeded(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[dict[str, object]]:
    """Alice ran a template; her agent made a room from inside it. Bob's own
    room holds nothing of hers."""
    async with session_factory() as session:
        alice = User(name="alice", email="alice@test", role="user", password_hash="x")
        bob = User(name="bob", email="bob@test", role="user", password_hash="x")
        session.add_all([alice, bob])
        await session.flush()
        key = ApiKey(
            user_id=alice.id, key_hash="h", encrypted_key="e", label="a", type="agent"
        )
        client = Client(
            matrix_user_id="@helper:test.local", display_name="h", type="agent"
        )
        session.add_all([key, client])
        await session.flush()
        agent = Agent(
            name="helper",
            description="",
            agent_type="always_on",
            connector_type="claude_code",
            integration_profile={"connection_model": "always_on"},
            client_id=client.id,
            api_key_id=key.id,
            owner_id=alice.id,
        )
        session.add(agent)
        await session.flush()
        root = _room("triage", alice, template_name="Triage pair")
        session.add(root)
        await session.flush()
        child = _room(
            "repro",
            alice,
            created_by_agent_id=agent.id,
            parent_room_id=root.id,
            run_id=root.id,
        )
        session.add_all([child, _room("bob's own", bob)])
        await session.commit()
        yield {"alice": alice, "bob": bob, "root": root.id, "child": child.id}


def _client(
    session_factory: async_sessionmaker[AsyncSession],
    acting_as: User,
    *,
    is_admin: bool = False,
) -> httpx.AsyncClient:
    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    protocol = SimpleNamespace(
        run_service=lambda: RunService(
            room_store=RoomStore(),
            agent_store=AgentStore(),
            session_factory=session_factory,
        )
    )
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[get_protocol] = lambda: protocol
    app.dependency_overrides[get_room_store] = RoomStore
    app.dependency_overrides[get_agent_store] = AgentStore
    app.dependency_overrides[get_current_user] = lambda: acting_as
    app.dependency_overrides[get_tenant_is_admin] = lambda: is_admin
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


class TestListing:
    async def test_a_run_comes_back_as_its_tree(self, session_factory, seeded):
        async with _client(session_factory, seeded["alice"]) as client:
            response = await client.get("/template-runs")
        assert response.status_code == 200, response.text
        [run] = response.json()
        assert run["root_room_id"] == seeded["root"]
        assert run["template_name"] == "Triage pair"
        assert run["started_by_name"] == "alice"
        assert run["state"] == "running"
        assert run["can_control"] is True
        assert [
            (r["name"], r["parent_room_id"], r["created_by_agent_name"])
            for r in run["rooms"]
        ] == [("triage", None, None), ("repro", seeded["root"], "helper")]

    async def test_someone_elses_run_is_not_listed(self, session_factory, seeded):
        async with _client(session_factory, seeded["bob"]) as client:
            response = await client.get("/template-runs")
        assert response.json() == []

    async def test_an_admin_sees_every_run(self, session_factory, seeded):
        async with _client(session_factory, seeded["bob"], is_admin=True) as client:
            response = await client.get("/template-runs")
        [run] = response.json()
        assert run["can_control"] is True


class TestControl:
    async def test_the_owner_stops_a_run(self, session_factory, seeded):
        async with _client(session_factory, seeded["alice"]) as client:
            response = await client.post(f"/template-runs/{seeded['root']}/stop")
            assert response.status_code == 200, response.text
            assert response.json()["state"] == "stopped"
            assert response.json()["changed_by_name"] == "alice"
            again = await client.post(f"/template-runs/{seeded['root']}/continue")
        assert again.status_code == 409

    async def test_a_stranger_may_not(self, session_factory, seeded):
        async with _client(session_factory, seeded["bob"]) as client:
            response = await client.post(f"/template-runs/{seeded['root']}/stop")
        assert response.status_code == 403

    async def test_an_unknown_run(self, session_factory, seeded):
        async with _client(session_factory, seeded["alice"]) as client:
            response = await client.post("/template-runs/nope/stop")
        assert response.status_code == 404
