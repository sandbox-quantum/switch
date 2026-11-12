"""Wiping your own test account (POST /auth/me/reset-test-account).

Against a real database, with the fakes `test_account_deletion.py` and
`test_organization_purge.py` use for what reaches outside it.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import get_service_broker
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    CloudMachine,
    MessagingInstall,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    Room,
    ServiceTokenIssuance,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.auth_routes import router
from tests.conftest import TEST_KEYRING, RLSHarness
from tests.switch_core.accounts.test_account_deletion import (
    ADMIN_EMAIL,
    _agent,
    _deletion,
    _SignInFlows,
)
from tests.switch_core.accounts.test_organization_purge import (
    _Installer,
    _purge,
    _Signals,
)
from tests.switch_core.hosted_machine_helpers import seed_machine


def _app(
    session_factory: async_sessionmaker[AsyncSession], *, enabled: bool
) -> tuple[FastAPI, _Installer, _Signals]:
    deletion, _, rooms = _deletion(session_factory)
    purge, installer, signals = _purge(session_factory)

    async def _session_dep():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.include_router(router)
    app.state.sign_in_flows = _SignInFlows()
    app.state.organization_purge = purge
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
    overrides[gw_deps.get_room_service] = lambda: rooms
    overrides[get_service_broker] = lambda: deletion.broker
    overrides[gw_deps.get_client_lifecycle] = lambda: deletion.clients
    overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=TEST_KEYRING,
        gateway_cookie_secure=False,
        gateway_admin_email=ADMIN_EMAIL,
        gateway_tenant_choice_enabled=False,
        gateway_allow_test_account_reset=enabled,
    )
    return app, installer, signals


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
    """A user alone in a workspace of an organization of their own, with the
    audit event creating it records. Returns the user's id and email, the
    workspace's id and the organization's."""
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
        await record_organization_audit_event(
            session,
            organization_id=organization_id,
            actor_user_id=user.id,
            action=OrganizationAuditAction.ORGANIZATION_CREATED,
            target_type="organization",
            target_id=organization_id,
            details=None,
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


async def test_what_account_deletion_refuses_is_refused_before_anything_changes(
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
    app, installer, _ = _app(session_factory, enabled=True)
    async with _client(app, user_id, email, solo) as client:
        mismatch = await client.post(
            "/auth/me/reset-test-account", json={"email": "wrong@example.test"}
        )
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )
    assert mismatch.status_code == 400
    assert response.status_code == 409
    assert "only admin" in response.json()["detail"]
    assert installer.released == []
    async with session_factory() as session:
        assert await session.get(User, user_id) is not None
    async with tenant_session(session_factory, solo) as session:
        assert await session.scalar(select(Room.id)) is not None


async def test_it_purges_an_organization_nobody_else_is_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, email, solo, organization_id = await _solo_workspace(session_factory)
    async with tenant_session(session_factory, solo) as session:
        user = await session.get(User, user_id)
        assert user is not None
        agent = await _agent(session, solo, user, "helper")
        session.add(
            MessagingInstall(
                tenant_id=solo,
                platform="slack",
                external_workspace_id=f"T-{solo}",
                scopes="chat:write",
                status="active",
                installed_by_user_id=user_id,
            )
        )
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
        agent_id = agent.id

    app, installer, signals = _app(session_factory, enabled=True)
    async with _client(app, user_id, email, solo) as client:
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True}
    assert 'switch_auth=""' in response.headers["set-cookie"]
    assert installer.released == [f"T-{solo}"]
    assert ("client.changed", {"tenant_id": solo}) in signals.published
    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Tenant, solo) is None
        assert await session.get(Agent, agent_id) is None
        assert await session.get(Organization, organization_id) is None
        for model in (Room, MessagingInstall):
            assert not await session.scalar(
                select(model.id).where(model.tenant_id == solo)
            )


async def test_the_runtime_role_purges_the_organization_and_keeps_its_history(
    rls_harness: RLSHarness,
) -> None:
    user_id, email, solo, organization_id = await _solo_workspace(rls_harness.owner)

    app, _, _ = _app(rls_harness.restricted, enabled=True)
    async with _client(app, user_id, email, solo) as client:
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 200, response.text
    async with rls_harness.owner() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Organization, organization_id) is None
        assert await session.scalar(
            select(OrganizationAuditEvent.id).where(
                OrganizationAuditEvent.organization_id == organization_id
            )
        )


async def _other_user(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, role: str
) -> str:
    async with session_factory() as session:
        other = User(
            name="other",
            email=f"other-{uuid.uuid4().hex[:6]}@example.test",
            role="user",
        )
        session.add(other)
        await session.flush()
        session.add(TenantMember(tenant_id=tenant_id, user_id=other.id, role=role))
        await session.commit()
        return other.id


async def test_it_leaves_the_default_workspace_and_purges_its_own(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, email, solo, organization_id = await _solo_workspace(session_factory)
    other_id = await _other_user(session_factory, TENANT_ZERO_ID, "admin")
    async with session_factory() as session:
        session.add(
            TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user_id, role="member")
        )
        await session.commit()

    app, _, _ = _app(session_factory, enabled=True)
    async with _client(app, user_id, email, solo) as client:
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 200, response.text
    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Tenant, solo) is None
        assert await session.get(Organization, organization_id) is None
        assert await session.get(Tenant, TENANT_ZERO_ID) is not None
        assert await session.get(TenantMember, (TENANT_ZERO_ID, other_id)) is not None


async def test_in_a_shared_organization_it_purges_only_what_the_caller_is_alone_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, email, mine, organization_id = await _solo_workspace(session_factory)
    theirs, shared = f"theirs-{mine}", f"shared-{mine}"
    async with session_factory() as session:
        for tenant_id in (theirs, shared):
            session.add(
                Tenant(
                    id=tenant_id,
                    slug=tenant_id,
                    name=tenant_id,
                    organization_id=organization_id,
                )
            )
        await session.commit()
    other_id = await _other_user(session_factory, theirs, "admin")
    async with session_factory() as session:
        session.add(TenantMember(tenant_id=shared, user_id=other_id, role="admin"))
        session.add(TenantMember(tenant_id=shared, user_id=user_id, role="member"))
        session.add(
            OrganizationMember(
                organization_id=organization_id, user_id=other_id, role="member"
            )
        )
        await session.commit()

    app, _, _ = _app(session_factory, enabled=True)
    async with _client(app, user_id, email, mine) as client:
        refused = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )
        assert refused.status_code == 409
        assert "only organization admin" in refused.json()["detail"]
        async with session_factory() as session:
            assert await session.get(Tenant, mine) is not None
            assert await session.get(User, user_id) is not None
            membership = await session.get(
                OrganizationMember, (organization_id, other_id)
            )
            assert membership is not None
            membership.role = "org_admin"
            await session.commit()
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 200, response.text
    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Tenant, mine) is None
        assert await session.get(Organization, organization_id) is not None
        assert await session.get(User, other_id) is not None
        assert await session.get(Tenant, theirs) is not None
        assert await session.get(Tenant, shared) is not None
        assert await session.get(TenantMember, (shared, other_id)) is not None
        assert await session.get(OrganizationMember, (organization_id, user_id)) is None


async def test_a_purge_that_must_wait_is_refused_with_nothing_deleted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, email, solo, organization_id = await _solo_workspace(session_factory)
    async with tenant_session(session_factory, solo) as session:
        session.add(
            ServiceTokenIssuance(
                tenant_id=solo,
                grant_id="g",
                agent_id="a",
                owner_id=user_id,
                service="github",
                principal="agent_key",
                permissions={},
                resources={},
                expires_at=datetime.now(UTC) + timedelta(hours=1),
                token_sha256="x",
                encrypted_token="sealed",
                revoke_requested=False,
                attempts=0,
            )
        )
        await session.commit()

    app, _, _ = _app(session_factory, enabled=True)
    async with _client(app, user_id, email, solo) as client:
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 409
    assert "service token(s) not yet revoked" in response.json()["detail"]
    async with session_factory() as session:
        assert await session.get(User, user_id) is not None
        assert await session.get(Tenant, solo) is not None
        assert await session.get(Organization, organization_id) is not None


async def _shared_organization(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str, str]:
    """A user alone in their workspace of an organization with another
    organization admin in it. Returns as `_solo_workspace` does."""
    user_id, email, mine, organization_id = await _solo_workspace(session_factory)
    theirs = f"theirs-{mine}"
    async with session_factory() as session:
        session.add(
            Tenant(id=theirs, slug=theirs, name=theirs, organization_id=organization_id)
        )
        await session.commit()
    other_id = await _other_user(session_factory, theirs, "admin")
    async with session_factory() as session:
        session.add(
            OrganizationMember(
                organization_id=organization_id, user_id=other_id, role="org_admin"
            )
        )
        await session.commit()
    return user_id, email, mine, organization_id


def _join_before_purging(
    monkeypatch: pytest.MonkeyPatch,
    app: FastAPI,
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    organization_id: str,
    joiner: str,
) -> None:
    """Have someone join `tenant_id`, as a member or as an organization
    admin with no membership there, and add a room to it, after the reset
    has checked who is in it and before anything outside Switch is touched."""
    purge = app.state.organization_purge
    original = purge._revoke_services

    async def joining(workspace, outcome):
        monkeypatch.setattr(purge, "_revoke_services", original)
        if joiner == "member":
            await _other_user(session_factory, tenant_id, "member")
        else:
            async with session_factory() as session:
                admin = User(
                    name="admin",
                    email=f"admin-{uuid.uuid4().hex[:6]}@example.test",
                    role="user",
                )
                session.add(admin)
                await session.flush()
                session.add(
                    OrganizationMember(
                        organization_id=organization_id,
                        user_id=admin.id,
                        role="org_admin",
                    )
                )
                await session.commit()
        async with tenant_session(session_factory, tenant_id) as session:
            session.add(
                Room(
                    tenant_id=tenant_id,
                    transport_room_id=f"!{uuid.uuid4().hex}:test",
                    name="theirs",
                    description="",
                )
            )
            await session.commit()
        await original(workspace, outcome)

    monkeypatch.setattr(purge, "_revoke_services", joining)


@pytest.mark.parametrize("joiner", ["member", "org_admin"])
@pytest.mark.parametrize("shared", [True, False])
async def test_a_member_who_joins_during_the_reset_keeps_the_workspace(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
    shared: bool,
    joiner: str,
) -> None:
    setup = _shared_organization if shared else _solo_workspace
    user_id, email, mine, organization_id = await setup(session_factory)
    async with tenant_session(session_factory, mine) as session:
        session.add(
            MessagingInstall(
                tenant_id=mine,
                platform="slack",
                external_workspace_id=f"T-{mine}",
                scopes="chat:write",
                status="active",
                installed_by_user_id=user_id,
            )
        )
        await session.commit()
    app, installer, _ = _app(session_factory, enabled=True)
    _join_before_purging(
        monkeypatch, app, session_factory, mine, organization_id, joiner
    )

    async with _client(app, user_id, email, mine) as client:
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 409, response.text
    assert "joined" in response.json()["detail"]
    assert installer.released == []
    async with session_factory() as session:
        assert await session.get(User, user_id) is not None
        assert await session.get(Tenant, mine) is not None
        assert await session.get(Organization, organization_id) is not None
    async with tenant_session(session_factory, mine) as session:
        assert await session.scalar(select(Room.id)) is not None
        assert await session.scalar(select(MessagingInstall.status)) == "active"


async def test_a_retry_after_the_workspaces_went_still_purges_the_organization(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id, email, solo, organization_id = await _solo_workspace(session_factory)
    app, _, _ = _app(session_factory, enabled=True)
    purge = app.state.organization_purge
    original = purge._delete_organization

    async def interrupted(plan, request):
        monkeypatch.setattr(purge, "_delete_organization", original)
        raise RuntimeError("interrupted")

    monkeypatch.setattr(purge, "_delete_organization", interrupted)
    async with _client(app, user_id, email, solo) as client:
        with pytest.raises(RuntimeError, match="interrupted"):
            await client.post("/auth/me/reset-test-account", json={"email": email})
        async with session_factory() as session:
            assert await session.get(Tenant, solo) is None
            assert await session.get(Organization, organization_id) is not None
            assert await session.get(User, user_id) is not None
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 200, response.text
    async with session_factory() as session:
        assert await session.get(Organization, organization_id) is None
        assert await session.get(User, user_id) is None


async def test_in_a_shared_organization_a_cloud_machine_is_torn_down_first(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    user_id, email, mine, organization_id = await _shared_organization(session_factory)
    async with tenant_session(session_factory, mine) as session:
        machine = await seed_machine(
            session,
            owner_id=user_id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        await session.commit()
        machine_id = machine.id

    app, _, _ = _app(session_factory, enabled=True)
    async with _client(app, user_id, email, mine) as client:
        waiting = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )
        assert waiting.status_code == 409, waiting.text
        assert "being torn down" in waiting.json()["detail"]
        async with session_factory() as session:
            assert await session.get(Tenant, mine) is not None
            assert await session.get(User, user_id) is not None
            machine = await session.get(CloudMachine, machine_id)
            assert machine is not None and machine.desired_state == "deleted"
            # The hosted controller terminates it.
            machine.state = "deleted"
            await session.commit()
        response = await client.post(
            "/auth/me/reset-test-account", json={"email": email}
        )

    assert response.status_code == 200, response.text
    async with session_factory() as session:
        assert await session.get(User, user_id) is None
        assert await session.get(Tenant, mine) is None
        assert await session.get(CloudMachine, machine_id) is None
        assert await session.get(Organization, organization_id) is not None
