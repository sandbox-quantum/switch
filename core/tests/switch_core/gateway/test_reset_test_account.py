"""Wiping your own test account (POST /auth/me/reset-test-account).

Against a real database, with the fakes `test_account_deletion.py` uses for
the services with side effects outside it, plus a messaging-app service that
only ends the install row and a room service that only deletes the room row.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import get_service_broker
from switch_core.db.models import (
    Agent,
    MessagingInstall,
    Organization,
    OrganizationMember,
    Room,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.messaging_install_store import (
    INSTALL_DISCONNECTED,
    MessagingInstallStore,
)
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.auth_routes import router
from switch_core.tenant_context import current_tenant_id
from tests.conftest import TEST_KEYRING
from tests.switch_core.accounts.test_account_deletion import (
    ADMIN_EMAIL,
    _agent,
    _deletion,
    _Rooms,
    _SignInFlows,
)


class _RoomService(_Rooms):
    def __init__(
        self, session_factory: async_sessionmaker[AsyncSession], archived: list[str]
    ) -> None:
        self._session_factory = session_factory
        self.archived = archived
        self.deleted: list[str] = []

    async def delete_room(self, room_id: str, *, retire_channel: bool) -> None:
        assert not retire_channel
        tenant_id = current_tenant_id()
        assert tenant_id is not None
        async with tenant_session(self._session_factory, tenant_id) as session:
            await session.execute(delete(Room).where(Room.id == room_id))
            await session.commit()
        self.deleted.append(room_id)


class _Installs:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self.disconnected: list[str] = []

    async def disconnect(self, *, tenant_id: str, install_id: str) -> None:
        async with tenant_session(self._session_factory, tenant_id) as session:
            await MessagingInstallStore().end(
                session, install_id=install_id, status=INSTALL_DISCONNECTED
            )
            await session.commit()
        self.disconnected.append(install_id)


def _app(
    session_factory: async_sessionmaker[AsyncSession], *, enabled: bool
) -> tuple[FastAPI, _RoomService, _Installs]:
    deletion, _, rooms = _deletion(session_factory)
    room_service = _RoomService(session_factory, rooms.archived)
    installs = _Installs(session_factory)

    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.state.sign_in_flows = _SignInFlows()
    overrides = app.dependency_overrides
    overrides[gw_deps.get_system_session] = _session_dep
    overrides[gw_deps.get_session_factory] = lambda: session_factory
    overrides[gw_deps.get_user_store] = lambda: UserStore()
    overrides[gw_deps.get_organization_store] = lambda: OrganizationStore()
    overrides[gw_deps.get_agent_store] = lambda: AgentStore()
    overrides[gw_deps.get_api_key_store] = lambda: ApiKeyStore()
    overrides[gw_deps.get_template_store] = lambda: TemplateStore()
    overrides[gw_deps.get_protocol] = lambda: deletion.protocol
    overrides[gw_deps.get_resource_service] = lambda: deletion.resources
    overrides[gw_deps.get_room_service] = lambda: room_service
    overrides[gw_deps.get_install_service] = lambda: installs
    overrides[get_service_broker] = lambda: deletion.broker
    overrides[gw_deps.get_client_lifecycle] = lambda: deletion.clients
    overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING,
        gateway_cookie_secure=False,
        gateway_admin_email=ADMIN_EMAIL,
        gateway_tenant_choice_enabled=False,
        gateway_allow_test_account_reset=enabled,
    )
    return app, room_service, installs


def _client(
    app: FastAPI, user_id: str, email: str, tenant_id: str
) -> httpx.AsyncClient:
    token = create_jwt(
        user_id,
        email,
        "user",
        TEST_KEYRING,
        tenant_id,
        session_version=0,
        auth_time=datetime.now(UTC),
    )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _solo_workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str, str]:
    """A user alone in a workspace of an organization of their own. Returns
    the user's id and email, the workspace's id and the organization's."""
    solo = f"solo-{uuid.uuid4().hex[:6]}"
    organization_id = f"org-{solo}"
    async with session_factory() as session:
        session.add(
            Organization(id=organization_id, slug=organization_id, name="Solo Org")
        )
        await session.flush()
        session.add(
            Tenant(id=solo, slug=solo, name="Solo", organization_id=organization_id)
        )
        user = User(name=solo, email=f"{solo}@example.test", role="user")
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=solo, user_id=user.id, role="admin"))
        session.add(
            OrganizationMember(
                organization_id=organization_id, user_id=user.id, role="org_admin"
            )
        )
        await session.commit()
        return user.id, user.email, solo, organization_id


async def test_it_is_not_found_unless_the_server_allows_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, email, solo, _ = await _solo_workspace(session_factory)
    app, _, _ = _app(session_factory, enabled=False)
    async with _client(app, user_id, email, solo) as client:
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )
    assert response.status_code == 404
    assert (
        response.json()["detail"] == "Test-account reset is not enabled on this server."
    )
    async with session_factory() as session:
        assert await session.get(User, user_id) is not None


async def test_a_workspace_with_anyone_else_in_it_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, email, solo, _ = await _solo_workspace(session_factory)
    async with tenant_session(session_factory, solo) as session:
        session.add(
            Room(
                tenant_id=solo,
                transport_room_id=f"!{uuid.uuid4().hex}:test",
                name="kept",
                description="",
            )
        )
        await session.commit()
    async with session_factory() as session:
        other = User(name="other", email=f"other-{solo}@example.test", role="user")
        session.add(other)
        await session.flush()
        session.add(TenantMember(tenant_id=solo, user_id=other.id, role="member"))
        await session.commit()
    app, rooms, _ = _app(session_factory, enabled=True)
    async with _client(app, user_id, email, solo) as client:
        mismatch = await client.post(
            "/auth/me/reset-test-account", json={"email": "wrong@example.test"}
        )
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )
    assert mismatch.status_code == 400
    assert response.status_code == 409
    assert "other users" in response.json()["detail"]
    assert rooms.deleted == []
    async with session_factory() as session:
        assert await session.get(User, user_id) is not None
    async with tenant_session(session_factory, solo) as session:
        assert await session.scalar(select(Room.id)) is not None


async def test_it_wipes_the_apps_rooms_agents_workspace_and_organization(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, email, solo, organization_id = await _solo_workspace(session_factory)
    async with tenant_session(session_factory, solo) as session:
        user = await session.get(User, user_id)
        assert user is not None
        agent = await _agent(session, solo, user, "helper")
        install = MessagingInstall(
            tenant_id=solo,
            platform="slack",
            external_workspace_id=f"T-{solo}",
            scopes="chat:write",
            status="active",
            installed_by_user_id=user_id,
        )
        session.add(install)
        for archived_at in (None, datetime.now(UTC)):
            session.add(
                Room(
                    tenant_id=solo,
                    transport_room_id=f"!{uuid.uuid4().hex}:test",
                    name="room",
                    description="",
                    created_by=user_id,
                    owner_id=user_id,
                    archived_at=archived_at,
                )
            )
        await session.commit()
        agent_id, install_id = agent.id, install.id

    app, rooms, installs = _app(session_factory, enabled=True)
    async with _client(app, user_id, email, solo) as client:
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True}
    assert 'switch_auth=""' in response.headers["set-cookie"]
    assert installs.disconnected == [install_id]
    assert len(rooms.deleted) == 2
    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Tenant, solo) is None
        assert await session.get(Agent, agent_id) is None
        assert await session.get(Organization, organization_id) is None
