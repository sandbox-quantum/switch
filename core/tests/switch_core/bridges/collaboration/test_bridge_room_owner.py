"""Who owns the room a channel becomes when someone adds Switch to it.

The platform account that added the app owns it through the Switch user who
linked that account. Otherwise nobody owns it, and only workspace admins may
change it: the platform didn't say who, nobody linked the account, or more than
one person did and nobody can tell which of them it was.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.db.models import (
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    User,
)
from switch_core.db.stores.external_user_store import ExternalUserStore


async def _user(session: AsyncSession, name: str) -> str:
    user = User(
        name=name, email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid", role="user"
    )
    session.add(user)
    await session.flush()
    return user.id


async def _bridge_with_account(
    session_factory: async_sessionmaker[AsyncSession], claimed_by: list[str]
) -> tuple[str, str]:
    """A Slack bridge and one of its accounts, `UALICE`, linked by `claimed_by`
    (Switch user names). Returns the bridge id and the first claimant's id."""
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
            user_id = await _user(session, name)
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
