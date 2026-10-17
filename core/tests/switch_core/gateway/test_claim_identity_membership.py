"""An admin can link a messaging identity only to a member of their own tenant.

`users` is deployment-wide, so a user id that exists is not necessarily one
this tenant has any business recognising. The claim decides who an account is
treated as inside the tenant — owner-only addressing reads it — so the target
must be a member, and a non-member gets the same 404 as an id that does not
exist.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.collaborations import claim_bridge_identity
from switch_core.gateway.schemas import ClaimIdentityRequest

_EXTERNAL_USERS = ExternalUserStore()


async def _make_client(session: AsyncSession, client_type: str) -> str:
    client = Client(
        transport_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=client_type,
        type=client_type,
    )
    session.add(client)
    await session.flush()
    return client.id


async def _make_user(session: AsyncSession, *, tenant_id: str, role: str) -> User:
    name = f"user-{uuid.uuid4().hex[:8]}"
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role=role))
    await session.flush()
    return user


async def _setup(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, ExternalUser, User, User, User]:
    other_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Tenant(id=other_tenant, slug=other_tenant, name=other_tenant))
        await session.flush()
        bridge = CollaborationBridge(
            type="mattermost",
            display_name="MM",
            client_id=await _make_client(session, "bridge"),
            status="active",
        )
        session.add(bridge)
        await session.flush()
        external_user = ExternalUser(
            bridge_id=bridge.id,
            external_user_id=f"U{uuid.uuid4().hex[:8]}",
            external_username="alice",
            client_id=await _make_client(session, "external_user"),
        )
        session.add(external_user)
        admin = await _make_user(session, tenant_id=TENANT_ZERO_ID, role="admin")
        member = await _make_user(session, tenant_id=TENANT_ZERO_ID, role="member")
        outsider = await _make_user(session, tenant_id=other_tenant, role="owner")
        await session.commit()
        return bridge.id, external_user, admin, member, outsider


async def _claim(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    bridge_id: str,
    external_user: ExternalUser,
    caller: User,
    target_user_id: str,
) -> object:
    async with session_factory() as session:
        return await claim_bridge_identity(
            bridge_id,
            ClaimIdentityRequest(
                external_user_id=external_user.external_user_id,
                username=external_user.external_username,
                user_id=target_user_id,
            ),
            session,
            CollaborationBridgeStore(),
            _EXTERNAL_USERS,
            UserStore(),
            None,  # type: ignore[arg-type]
            caller,
            True,
        )


async def test_admin_cannot_claim_an_identity_for_another_tenants_user(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    bridge_id, external_user, admin, _member, outsider = await _setup(session_factory)

    with pytest.raises(HTTPException) as refused:
        await _claim(
            session_factory,
            bridge_id=bridge_id,
            external_user=external_user,
            caller=admin,
            target_user_id=outsider.id,
        )

    assert refused.value.status_code == 404
    async with session_factory() as session:
        assert await _EXTERNAL_USERS.claimant_ids(session, external_user.id) == []


async def test_admin_can_claim_an_identity_for_a_member(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    bridge_id, external_user, admin, member, _outsider = await _setup(session_factory)

    await _claim(
        session_factory,
        bridge_id=bridge_id,
        external_user=external_user,
        caller=admin,
        target_user_id=member.id,
    )

    async with session_factory() as session:
        assert await _EXTERNAL_USERS.claimant_ids(session, external_user.id) == [
            member.id
        ]


class _Candidate:
    def __init__(self, external_user_id: str) -> None:
        self.external_user_id = external_user_id


class _DirectoryAdapter:
    def __init__(self, external_user_id: str) -> None:
        self._external_user_id = external_user_id

    async def search_directory_users(self, username: str) -> list[_Candidate]:
        return [_Candidate(self._external_user_id)]


class _ProvisioningCore:
    """Provisions the identity in its own session, as the bridge's core does."""

    def __init__(
        self, session_factory: async_sessionmaker[AsyncSession], bridge_id: str
    ) -> None:
        self._session_factory = session_factory
        self._bridge_id = bridge_id

    async def ensure_external_user(
        self, *, external_user_id: str, external_username: str
    ) -> ExternalUser:
        async with self._session_factory() as session:
            external_user = ExternalUser(
                bridge_id=self._bridge_id,
                external_user_id=external_user_id,
                external_username=external_username,
                client_id=await _make_client(session, "external_user"),
            )
            session.add(external_user)
            await session.commit()
            return external_user


class _Lifecycle:
    def __init__(self, adapter: _DirectoryAdapter, core: _ProvisioningCore) -> None:
        self._adapter = adapter
        self._core = core

    def get_adapter(self, bridge_id: str) -> _DirectoryAdapter:
        return self._adapter

    def get(self, bridge_id: str) -> _ProvisioningCore:
        return self._core


async def test_claiming_an_unseen_identity_answers_with_the_claim(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The caller is loaded in the request's own session, as `get_current_user`
    loads it, so provisioning the unseen identity must not leave the handler
    reading an expired caller afterwards."""
    bridge_id, _seen, admin, _member, _outsider = await _setup(session_factory)
    external_user_id = f"U{uuid.uuid4().hex[:8]}"
    lifecycle = _Lifecycle(
        _DirectoryAdapter(external_user_id),
        _ProvisioningCore(session_factory, bridge_id),
    )

    async with session_factory() as session:
        caller = await session.get(User, admin.id)
        assert caller is not None
        summary = await claim_bridge_identity(
            bridge_id,
            ClaimIdentityRequest(external_user_id=external_user_id, username="bob"),
            session,
            CollaborationBridgeStore(),
            _EXTERNAL_USERS,
            UserStore(),
            lifecycle,  # type: ignore[arg-type]
            caller,
            True,
        )

    assert summary.external_user_id == external_user_id
    assert [claimant.user_id for claimant in summary.claimed_by] == [admin.id]
