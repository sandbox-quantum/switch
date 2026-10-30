"""A room's auto-route in its detail and its toggle (`PUT /rooms/{id}/auto-route`),
through the real routes on Postgres.

The detail says whether auto-route is on, whether it can act (the server's
flag, and the workspace's decision backend) and why not, and the room's
triage agent; the toggle writes the same settings `!auto-route` does.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    Room,
    TenantMember,
    User,
    room_agents,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import (
    AUTO_ROUTE_FALLBACK_KEY,
    AUTO_ROUTE_ON_KEY,
    RoomStore,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.decision.settings import (
    FLAG_OFF_REASON,
    NO_BACKEND_REASON,
    DecisionAvailability,
    ServerDefault,
)
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.rooms import get_decision_availability
from switch_core.gateway.rooms import router as rooms_router
from switch_core.keys import Keyring

KEYRING = Keyring.parse("test:" + "r" * 40, legacy_secret=None)


class _Protocol:
    def __init__(self) -> None:
        self.room_role_store = RoomRoleStore()
        self.agent_store = AgentStore()
        self.connections = SimpleNamespace(live_connection_ids=lambda: set())

    async def get_agent_statuses_by_ids_in_session(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> dict[str, Any]:
        return {}


def _app(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    enabled: bool = True,
    server_url: str | None = "http://decision.test/decide",
) -> FastAPI:
    async def _session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(rooms_router, prefix="/rooms")
    protocol = _Protocol()
    app.dependency_overrides.update(
        {
            gw_deps.get_session: _session,
            gw_deps.get_session_factory: lambda: session_factory,
            gw_deps.get_user_store: UserStore,
            gw_deps.get_room_store: RoomStore,
            gw_deps.get_bridge_store: CollaborationBridgeStore,
            gw_deps.get_external_user_store: ExternalUserStore,
            gw_deps.get_protocol: lambda: protocol,
            gw_deps.get_config: lambda: SimpleNamespace(
                keyring=KEYRING, gateway_tenant_choice_enabled=False
            ),
            get_decision_availability: lambda: DecisionAvailability(
                enabled=enabled,
                server=ServerDefault(
                    endpoint_url=server_url, api_key=None, bedrock_enabled=False
                ),
                store=DecisionSettingsStore(),
                controllers=AgentControllerStore(),
            ),
        }
    )
    return app


async def _user(
    session_factory: async_sessionmaker[AsyncSession], name: str, role: str
) -> User:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@example.invalid", role="user")
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role=role))
        await session.commit()
        return user


async def _agent(session: AsyncSession, owner: User, name: str) -> Agent:
    client = Client(
        transport_user_id=f"@{name}-{uuid.uuid4().hex[:6]}:test",
        display_name=name,
        type="agent",
    )
    session.add(client)
    key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{uuid.uuid4().hex}",
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
    )
    session.add(agent)
    await session.flush()
    return agent


async def _room(
    session_factory: async_sessionmaker[AsyncSession], owner: User
) -> tuple[Room, Agent, Agent]:
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="ops",
            description="d",
            owner_id=owner.id,
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.flush()
        triage = await _agent(session, owner, "triage")
        other = await _agent(session, owner, "other")
        for agent in (triage, other):
            await session.execute(
                room_agents.insert().values(room_id=room.id, agent_id=agent.id)
            )
        await session.commit()
        return room, triage, other


def _as(app: FastAPI, user: User) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={
            "switch_auth": create_jwt(
                user.id, user.email, user.role, KEYRING, TENANT_ZERO_ID
            )
        },
    )


async def _metadata(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> dict[str, Any]:
    async with session_factory() as session:
        room = await session.get(Room, room_id)
        assert room is not None
        return dict(room.metadata_ or {})


class TestTheRoomDetail:
    async def test_available_with_a_server_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        room, _, _ = await _room(session_factory, owner)
        async with _as(_app(session_factory), owner) as client:
            detail = (await client.get(f"/rooms/{room.id}")).json()

        assert detail["auto_route"] == {
            "on": False,
            "available": True,
            "reason": None,
            "fallback_agent": None,
            "fallback_agent_name": None,
        }

    async def test_unavailable_with_the_flag_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        room, _, _ = await _room(session_factory, owner)
        async with _as(_app(session_factory, enabled=False), owner) as client:
            detail = (await client.get(f"/rooms/{room.id}")).json()

        assert detail["auto_route"]["available"] is False
        assert detail["auto_route"]["reason"] == FLAG_OFF_REASON

    async def test_unavailable_with_no_backend(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        room, _, _ = await _room(session_factory, owner)
        async with _as(_app(session_factory, server_url=None), owner) as client:
            detail = (await client.get(f"/rooms/{room.id}")).json()

        assert detail["auto_route"]["available"] is False
        assert detail["auto_route"]["reason"] == NO_BACKEND_REASON
        assert "Switch Console → Admin → Decision routing" in NO_BACKEND_REASON

    async def test_unavailable_when_the_workspace_chose_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        room, _, _ = await _room(session_factory, owner)
        async with session_factory() as session:
            await DecisionSettingsStore().save(
                session,
                TENANT_ZERO_ID,
                backend="none",
                endpoint=None,
                api_key_encrypted=None,
                threshold=None,
            )
            await session.commit()
        async with _as(_app(session_factory), owner) as client:
            detail = (await client.get(f"/rooms/{room.id}")).json()

        assert detail["auto_route"]["available"] is False
        assert "turned auto-route off" in detail["auto_route"]["reason"]


class TestTheToggle:
    async def test_the_owner_turns_it_on_and_names_a_triage_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        room, triage, _ = await _room(session_factory, owner)
        async with _as(_app(session_factory), owner) as client:
            put = await client.put(
                f"/rooms/{room.id}/auto-route",
                json={"on": True, "fallback_agent": triage.id},
            )
            detail = (await client.get(f"/rooms/{room.id}")).json()

        assert put.status_code == 200, put.text
        expected = {
            "on": True,
            "available": True,
            "reason": None,
            "fallback_agent": triage.id,
            "fallback_agent_name": "triage",
        }
        assert put.json() == expected
        assert detail["auto_route"] == expected
        metadata = await _metadata(session_factory, room.id)
        assert metadata[AUTO_ROUTE_ON_KEY] is True
        assert metadata[AUTO_ROUTE_FALLBACK_KEY] == triage.id

    async def test_leaving_a_field_out_keeps_it_and_null_clears_the_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        room, triage, _ = await _room(session_factory, owner)
        async with _as(_app(session_factory), owner) as client:
            await client.put(
                f"/rooms/{room.id}/auto-route",
                json={"on": True, "fallback_agent": triage.id},
            )
            off = await client.put(f"/rooms/{room.id}/auto-route", json={"on": False})
            cleared = await client.put(
                f"/rooms/{room.id}/auto-route", json={"fallback_agent": None}
            )

        assert off.json()["on"] is False
        assert off.json()["fallback_agent"] == triage.id
        assert cleared.json()["fallback_agent"] is None
        assert cleared.json()["on"] is False

    async def test_on_is_refused_where_it_cannot_act(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        room, _, _ = await _room(session_factory, owner)
        async with _as(_app(session_factory, server_url=None), owner) as client:
            refused = await client.put(
                f"/rooms/{room.id}/auto-route", json={"on": True}
            )

        assert refused.status_code == 409
        assert refused.json()["detail"] == NO_BACKEND_REASON
        assert AUTO_ROUTE_ON_KEY not in await _metadata(session_factory, room.id)

    async def test_the_assigned_agent_or_a_stranger_cannot_be_triage(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        room, triage, _ = await _room(session_factory, owner)
        async with session_factory() as session:
            await RoomStore().set_main_agent(session, room.id, triage.id)
            await session.commit()
        async with _as(_app(session_factory), owner) as client:
            assigned = await client.put(
                f"/rooms/{room.id}/auto-route", json={"fallback_agent": triage.id}
            )
            stranger = await client.put(
                f"/rooms/{room.id}/auto-route", json={"fallback_agent": "nobody-here"}
            )

        assert assigned.status_code == 422
        assert "assigned agent" in assigned.json()["detail"]
        assert stranger.status_code == 422

    @pytest.mark.parametrize("role", ["member"])
    async def test_someone_who_does_not_own_the_room_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession], role: str
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        other = await _user(session_factory, "other", role)
        room, _, _ = await _room(session_factory, owner)
        async with _as(_app(session_factory), other) as client:
            refused = await client.put(
                f"/rooms/{room.id}/auto-route", json={"on": True}
            )

        assert refused.status_code == 403
        assert AUTO_ROUTE_ON_KEY not in await _metadata(session_factory, room.id)

    async def test_a_workspace_admin_may(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _user(session_factory, "owner", "member")
        admin = await _user(session_factory, "admin", "admin")
        room, _, _ = await _room(session_factory, owner)
        async with _as(_app(session_factory), admin) as client:
            put = await client.put(f"/rooms/{room.id}/auto-route", json={"on": True})

        assert put.status_code == 200
        assert put.json()["on"] is True
