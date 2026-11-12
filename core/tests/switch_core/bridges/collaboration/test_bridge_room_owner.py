"""Who owns the room a channel becomes when someone adds Switch to it.

The platform account that added the app owns it through the Switch user who
linked that account. Otherwise nobody owns it, and only workspace admins may
change it: the platform didn't say who, nobody linked the account, or more than
one person did and nobody can tell which of them it was. Only people still in
the bridge's workspace count.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    TenantMember,
    User,
)
from switch_core.db.stores.external_user_store import ExternalUserStore


async def _user(
    session: AsyncSession, name: str, tenant_id: str, *, member: bool
) -> str:
    user = User(
        name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
    )
    session.add(user)
    await session.flush()
    if member:
        session.add(TenantMember(tenant_id=tenant_id, user_id=user.id, role="member"))
        await session.flush()
    return user.id


async def _bridge_with_account(
    session_factory: async_sessionmaker[AsyncSession],
    claimed_by: list[str],
    former_members: tuple[str, ...] = (),
) -> tuple[str, str]:
    """A Slack bridge and one of its accounts, `UALICE`, linked by `claimed_by`
    (Switch user names). Those in `former_members` have left the bridge's
    workspace. Returns the bridge id and the first claimant's id."""
    async with session_factory() as session:
        consumer = Client(
            transport_user_id=f"@ws-{uuid.uuid4().hex[:6]}:test",
            display_name="ws",
            type="collaboration_bridge",
        )
        person = Client(
            transport_user_id=f"@alice-{uuid.uuid4().hex[:6]}:test",
            display_name="alice",
            type="external_user",
        )
        session.add_all([consumer, person])
        await session.flush()
        bridge = CollaborationBridge(
            type="slack", display_name="Slack", client_id=consumer.id, status="active"
        )
        session.add(bridge)
        await session.flush()
        account = ExternalUser(
            bridge_id=bridge.id,
            external_user_id="UALICE",
            external_username="alice",
            client_id=person.id,
        )
        session.add(account)
        await session.flush()
        first: str | None = None
        for name in claimed_by:
            user_id = await _user(
                session, name, bridge.tenant_id, member=name not in former_members
            )
            first = first or user_id
            session.add(ExternalUserClaim(external_user_id=account.id, user_id=user_id))
        await session.commit()
        return bridge.id, first or ""


def _core(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str
) -> CollaborationCore:
    core = object.__new__(CollaborationCore)
    core._session_factory = session_factory  # type: ignore[assignment]
    core._external_user_store = ExternalUserStore()
    core._bridge_id = bridge_id
    core._bridge_tenant_id = TENANT_ZERO_ID
    return core


class TestTheRoomsOwner:
    async def test_the_linked_user_of_whoever_added_switch(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        bridge_id, alice = await _bridge_with_account(session_factory, ["alice"])

        owner = await _core(session_factory, bridge_id)._owner_from_platform_account(
            "UALICE"
        )

        assert owner == alice

    @pytest.mark.parametrize(
        ("claimed_by", "added_by"),
        [
            ([], "UALICE"),  # nobody linked the account
            (["alice", "alice-too"], "UALICE"),  # two people did
            (["alice"], None),  # the platform didn't say who
            (["alice"], "USOMEONE"),  # an account Switch hasn't seen
        ],
    )
    async def test_nobody_when_it_cant_tell_who(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        claimed_by: list[str],
        added_by: str | None,
    ) -> None:
        bridge_id, _ = await _bridge_with_account(session_factory, claimed_by)

        owner = await _core(session_factory, bridge_id)._owner_from_platform_account(
            added_by
        )

        assert owner is None

    async def test_a_former_member_does_not_own_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        bridge_id, _ = await _bridge_with_account(
            session_factory, ["alice"], former_members=("alice",)
        )

        owner = await _core(session_factory, bridge_id)._owner_from_platform_account(
            "UALICE"
        )

        assert owner is None

    async def test_a_former_members_claim_does_not_block_the_current_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        bridge_id, alice_old = await _bridge_with_account(
            session_factory, ["alice-old", "alice"], former_members=("alice-old",)
        )

        owner = await _core(session_factory, bridge_id)._owner_from_platform_account(
            "UALICE"
        )

        assert owner is not None and owner != alice_old
