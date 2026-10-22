"""Deleting an emptied workspace, and the route its owner calls.

Against a real database where it matters: the refusals count rows, and the
deletion only works if every foreign key into `tenants` is gone first.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import switch_core.db.models  # noqa: F401
from switch_core.accounts.workspace_deletion import (
    REFUSED,
    WORKSPACE_TABLES,
    WorkspaceDeletionRefused,
    delete_workspace,
    refusal,
)
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.base import Base
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    ApiKey,
    AuditEvent,
    Invitation,
    MessagingInstall,
    Room,
    ServerAuditEvent,
    Tenant,
    TenantJoinDomain,
    TenantMember,
)
from switch_core.db.rls_ddl import HISTORY_TABLES, scoped_tables
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from tests.switch_core.accounts.test_account_deletion import (
    _agent,
    _invitation,
    _member,
    _user,
)
from tests.switch_core.gateway.test_tenant_api_routes import (
    _app,
    _client,
    _make_member,
    _make_tenant,
    _token,
)
from tests.switch_core.hosted_machine_helpers import seed_machine


def test_every_scoped_table_says_what_deleting_a_workspace_does_with_it() -> None:
    assert set(WORKSPACE_TABLES) == set(scoped_tables(Base.metadata)), (
        "accounts/workspace_deletion.py must say what happens to every "
        "tenant-scoped table when a workspace is deleted"
    )
    assert {name for name, h in WORKSPACE_TABLES.items() if h == "refused"} == set(
        REFUSED
    )
    assert {name for name, h in WORKSPACE_TABLES.items() if h == "kept"} == set(
        HISTORY_TABLES
    )


async def _workspace(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    """A workspace with only its owner in it."""
    tenant_id = f"ws-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name="Doomed"))
        await session.flush()
        owner = await _user(session, "owner")
        await _member(session, tenant_id, owner, "owner")
        await session.commit()
        return tenant_id, owner.id


async def test_the_refusal_lists_what_is_left_by_kind_and_count(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant_id, owner_id = await _workspace(session_factory)
    async with tenant_session(session_factory, tenant_id) as session:
        owner = await session.get(switch_core.db.models.User, owner_id)
        assert owner is not None
        for name, archived in (("live", None), ("old", datetime.now(UTC))):
            session.add(
                Room(
                    tenant_id=tenant_id,
                    transport_room_id=f"!{uuid.uuid4().hex}:test",
                    name=name,
                    description="",
                    archived_at=archived,
                )
            )
        await _agent(session, tenant_id, owner, "helper")
        other = await _user(session, "other")
        await _member(session, tenant_id, other, "member")
        await session.commit()

        reason = await refusal(session, tenant_id, owner_id)
    assert reason is not None
    assert "2 rooms (1 archived)" in reason
    assert "1 agent" in reason
    assert "1 other member" in reason


async def test_the_default_workspace_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        reason = await refusal(session, TENANT_ZERO_ID, "anyone")
    assert reason is not None and "default workspace" in reason


async def test_an_emptied_workspace_goes_and_its_history_stays(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant_id, owner_id = await _workspace(session_factory)
    async with tenant_session(session_factory, tenant_id) as session:
        owner = await session.get(switch_core.db.models.User, owner_id)
        assert owner is not None
        await _invitation(session, tenant_id, owner)
        session.add(
            TenantJoinDomain(
                tenant_id=tenant_id, domain="example.test", created_by=owner_id
            )
        )
        key = ApiKey(
            tenant_id=tenant_id,
            user_id=owner_id,
            key_hash=uuid.uuid4().hex,
            encrypted_key="enc",
            label="mine",
            type="registration",
        )
        session.add(key)
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=owner_id,
            action=AuditAction.API_KEY_CREATED,
            target_type="api_key",
            target_id=key.id,
            details=None,
        )
        await session.commit()

        hashes = await delete_workspace(session, tenant_id, owner_id, owner_id)
        await session.commit()

    assert hashes == [key.key_hash]
    async with session_factory() as session:
        assert await session.get(Tenant, tenant_id) is None
    async with tenant_session(session_factory, tenant_id) as session:
        assert await session.scalar(select(Invitation.id)) is None
        assert await session.scalar(select(TenantJoinDomain.domain)) is None
        assert await session.scalar(select(TenantMember.user_id)) is None
        actions = list(
            await session.scalars(
                select(AuditEvent.action)
                .where(AuditEvent.tenant_id == tenant_id)
                .order_by(AuditEvent.occurred_at)
            )
        )
    assert sorted(actions) == ["api_key.created", "tenant.deleted"]


async def test_a_workspace_with_something_left_is_not_touched(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant_id, owner_id = await _workspace(session_factory)
    async with tenant_session(session_factory, tenant_id) as session:
        session.add(
            Room(
                tenant_id=tenant_id,
                transport_room_id=f"!{uuid.uuid4().hex}:test",
                name="kept",
                description="",
            )
        )
        await session.commit()
        with pytest.raises(WorkspaceDeletionRefused):
            await delete_workspace(session, tenant_id, owner_id, owner_id)
        await session.rollback()
    async with session_factory() as session:
        assert await session.get(Tenant, tenant_id) is not None


async def _ended_and_live(
    session: AsyncSession, tenant_id: str, owner_id: str, *, live: bool
) -> None:
    """A removed machine, a disconnected messaging app and a cloud machine
    since torn down; with `live`, one of each still in use as well."""
    now = datetime.now(UTC)
    for ended in (True, False) if live else (True,):
        session.add(
            AgentController(
                tenant_id=tenant_id,
                owner_id=owner_id,
                name="laptop",
                kind="console",
                revoked_at=now if ended else None,
            )
        )
        session.add(
            MessagingInstall(
                tenant_id=tenant_id,
                platform="slack",
                external_workspace_id=f"T-{uuid.uuid4().hex[:6]}",
                scopes="chat:write",
                status="disconnected" if ended else "active",
                installed_by_user_id=owner_id,
            )
        )
        await seed_machine(
            session,
            owner_id=owner_id,
            state="deleted" if ended else "ready",
            desired_state="deleted" if ended else "running",
            stop_reason=None,
            revision=1,
        )
    await session.commit()


async def test_records_of_what_has_ended_neither_block_nor_survive(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant_id, owner_id = await _workspace(session_factory)
    async with tenant_session(session_factory, tenant_id) as session:
        await _ended_and_live(session, tenant_id, owner_id, live=False)

        assert await refusal(session, tenant_id, owner_id) is None
        await delete_workspace(session, tenant_id, owner_id, owner_id)
        await session.commit()

    async with session_factory() as session:
        assert await session.get(Tenant, tenant_id) is None
    async with tenant_session(session_factory, tenant_id) as session:
        assert await session.scalar(select(AgentController.id)) is None
        assert await session.scalar(select(MessagingInstall.id)) is None


async def test_what_is_still_in_use_blocks_beside_what_has_ended(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant_id, owner_id = await _workspace(session_factory)
    async with tenant_session(session_factory, tenant_id) as session:
        await _ended_and_live(session, tenant_id, owner_id, live=True)
        reason = await refusal(session, tenant_id, owner_id)
    assert reason is not None
    assert "1 machine" in reason
    assert "1 messaging app connection" in reason
    assert "1 cloud machine" in reason


async def test_a_workspace_deleted_meanwhile_is_not_found(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A second request for the same deletion, which the first finished while
    this one was being authorized."""
    token = await _route_people(session_factory, "owner")
    tenant_role = UserStore.tenant_role

    async def deleted_meanwhile(
        store: UserStore, session: AsyncSession, tenant_id: str, user_id: str
    ) -> str | None:
        role = await tenant_role(store, session, tenant_id, user_id)
        async with tenant_session(session_factory, tenant_id) as other:
            await delete_workspace(other, tenant_id, user_id, user_id)
            await other.commit()
        return role

    monkeypatch.setattr(UserStore, "tenant_role", deleted_meanwhile)
    async with _client(_app(session_factory, client_lifecycle=_Clients()), token) as c:
        response = await c.request(
            "DELETE", f"/tenants/{TENANT}", json={"name": TENANT}
        )
    assert response.status_code == 404, response.text


class _Clients:
    def __init__(self) -> None:
        self.reconciled: list[str] = []

    async def reconcile_tenant(self, tenant_id: str) -> None:
        self.reconciled.append(tenant_id)

    def announce(self, tenant_id: str) -> None:
        pass


TENANT = "workspace-deletion-route"


async def _route_people(
    session_factory: async_sessionmaker[AsyncSession], role: str
) -> str:
    await _make_tenant(session_factory, TENANT)
    user_id = await _make_member(
        session_factory, name=f"ws-{role}", tenant_id=TENANT, role=role
    )
    return _token(user_id, f"ws-{role}@example.invalid", TENANT)


async def test_the_owner_deletes_an_empty_workspace_by_typing_its_name(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = await _route_people(session_factory, "owner")
    clients = _Clients()
    async with _client(_app(session_factory, client_lifecycle=clients), token) as c:
        wrong = await c.request("DELETE", f"/tenants/{TENANT}", json={"name": "nope"})
        done = await c.request("DELETE", f"/tenants/{TENANT}", json={"name": TENANT})
    assert wrong.status_code == 400, wrong.text
    assert done.status_code == 200, done.text
    assert clients.reconciled == [TENANT]
    async with session_factory() as session:
        assert await session.get(Tenant, TENANT) is None
        event = await session.scalar(
            select(ServerAuditEvent).where(ServerAuditEvent.target_id == TENANT)
        )
    assert event is not None and event.action == "workspace.deleted"


async def test_an_admin_who_is_not_an_owner_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = await _route_people(session_factory, "admin")
    async with _client(_app(session_factory, client_lifecycle=_Clients()), token) as c:
        response = await c.request(
            "DELETE", f"/tenants/{TENANT}", json={"name": TENANT}
        )
    assert response.status_code == 403, response.text
    async with session_factory() as session:
        assert await session.get(Tenant, TENANT) is not None


async def test_a_workspace_with_others_in_it_is_refused_with_what_is_left(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    token = await _route_people(session_factory, "owner")
    await _make_member(session_factory, name="stays", tenant_id=TENANT, role="member")
    async with _client(_app(session_factory, client_lifecycle=_Clients()), token) as c:
        response = await c.request(
            "DELETE", f"/tenants/{TENANT}", json={"name": TENANT}
        )
    assert response.status_code == 409, response.text
    assert "1 other member" in response.json()["detail"]
