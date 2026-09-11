"""An agent inherits exactly its owner's tenant-scoped power, never more
(CHOO-2726 role split, phase 2 design §2).

``_resolve_acting_identity`` used to compute ``owner_is_admin`` from
``owner.role == "admin"`` alone — the same global bit every other admin check
in the codebase used before this split. Once a person can hold ``owner`` in
one tenant and merely ``member`` (or nothing) in another, that global read is
wrong for an agent the same way it was wrong for a human acting directly: an
agent must not administer a tenant its owner does not administer, and must
administer one its owner does, purely because of the owner's role in *that*
tenant rather than any global bit.

``test_agent_administers_the_tenant_its_owner_owns`` is the one that actually
distinguishes old from new: the owner here holds no global admin bit at all,
so the pre-split code (`owner.role == "admin"`) denies it regardless of the
`tenant_members` row, and only reading that row grants it. The other two
tests hold under both the old and new code — they pin down that the fix does
not *overreach* (a workspace owner's agent must not gain cross-tenant power,
and a global operator's agent must not lose its bypass) rather than proving a
new grant.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    TaskProtocolConfig,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    Room,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.tenant_context import tenant_scope

TENANT_B = "tenant-b"

_PROFILE = IntegrationProfile(
    connection_model="session_passive",
    message_exchange=True,
    pre_invocation_mediation=[],
    post_invocation_mediation=[],
    event_reporting=[],
    task_protocol=TaskProtocolConfig(can_delegate=False, can_accept=False),
)


class _FakeClientLifecycle:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create_client(self, *, client_type: str, display_name: str) -> Client:
        async with self._session_factory() as session:
            client = Client(
                matrix_user_id=f"@{display_name}:test",
                display_name=display_name,
                type=client_type,
            )
            session.add(client)
            await session.commit()
            return client

    def start_client(self, client: Client) -> None:
        pass


class _NoBridges:
    def all_bridges(self) -> list[object]:
        return []


def _service(session_factory: async_sessionmaker[AsyncSession]) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.api_key_store = ApiKeyStore()  # type: ignore[attr-defined]
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.user_store = UserStore()  # type: ignore[attr-defined]
    svc.client_lifecycle = _FakeClientLifecycle(session_factory)  # type: ignore[attr-defined]
    svc.collab_lifecycle = _NoBridges()  # type: ignore[attr-defined]
    svc.config = SimpleNamespace(jwt_secret_key="test-secret")  # type: ignore[attr-defined]
    return svc


async def _make_user(
    session_factory: async_sessionmaker[AsyncSession], name: str, *, role: str = "user"
) -> str:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@test", role=role, password_hash="x")
        session.add(user)
        await session.commit()
        return user.id


async def _make_tenant(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()


async def _membership(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    user_id: str,
    role: str,
) -> None:
    async with session_factory() as session:
        session.add(TenantMember(tenant_id=tenant_id, user_id=user_id, role=role))
        await session.commit()


async def _register(svc: ProtocolService, name: str, owner_id: str) -> str:
    result = await svc.register_agent(
        name=name,
        description=f"{name} desc",
        connector_type="test",
        integration_profile=_PROFILE,
        owner_id=owner_id,
    )
    return result.agent_id


async def _private_room(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, owner_id: str
) -> str:
    async with session_factory() as session:
        room = Room(
            tenant_id=tenant_id,
            matrix_room_id=f"!{tenant_id}-private:test",
            name="private",
            description="",
            owner_id=owner_id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(room)
        await session.commit()
        return room.id


class TestAgentInheritsOwnerTenantScopedAdmin:
    async def test_agent_administers_the_tenant_its_owner_owns(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The owner holds no global admin bit — only `owner` in the bound
        tenant. Only reading `tenant_members` (not `users.role`) can grant
        this, so this is the one test that fails against the pre-split code.
        """
        svc = _service(session_factory)
        owner = await _make_user(session_factory, "workspace-owner")
        await _membership(session_factory, TENANT_ZERO_ID, owner, "owner")
        someone_else = await _make_user(session_factory, "tenant-zero-room-owner")
        agent_id = await _register(svc, "owner-agent", owner)
        room_id = await _private_room(session_factory, TENANT_ZERO_ID, someone_else)

        async with session_factory() as session:
            room = await svc._require_room_action(session, agent_id, room_id, "write")
            assert room.id == room_id

    async def test_agent_cannot_administer_a_tenant_where_owner_is_only_a_member(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Same owner, same agent: `owner` in tenant zero grants nothing in
        tenant B, where that owner only holds `member`."""
        svc = _service(session_factory)
        await _make_tenant(session_factory, TENANT_B)
        owner = await _make_user(session_factory, "cross-tenant-owner")
        await _membership(session_factory, TENANT_ZERO_ID, owner, "owner")
        await _membership(session_factory, TENANT_B, owner, "member")
        someone_else = await _make_user(session_factory, "tenant-b-room-owner")
        agent_id = await _register(svc, "cross-tenant-agent", owner)
        room_id = await _private_room(session_factory, TENANT_B, someone_else)

        async with session_factory() as session:
            with tenant_scope(TENANT_B), pytest.raises(PermissionError):
                await svc._require_room_action(session, agent_id, room_id, "write")

    async def test_operator_owned_agent_administers_every_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The deployment-operator bypass is unconditional and still applies
        through an agent, in a tenant the operator holds no membership in at
        all."""
        svc = _service(session_factory)
        await _make_tenant(session_factory, TENANT_B)
        operator = await _make_user(session_factory, "operator", role="admin")
        someone_else = await _make_user(session_factory, "tenant-b-room-owner-2")
        agent_id = await _register(svc, "operator-agent", operator)
        room_id = await _private_room(session_factory, TENANT_B, someone_else)

        async with session_factory() as session:
            with tenant_scope(TENANT_B):
                room = await svc._require_room_action(
                    session, agent_id, room_id, "write"
                )
            assert room.id == room_id
