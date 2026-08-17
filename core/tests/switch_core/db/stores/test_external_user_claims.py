"""Claiming a platform identity is non-exclusive (CHOO-2137).

Several Switch users may claim the same messaging account. An exclusive claim
would let whoever got there first keep the real person from ever being
recognised by their own agents, so the store records claims as a set rather
than as a single owner column on `external_users`.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Client,
    CollaborationBridge,
    ExternalUser,
    User,
)
from switch_core.db.stores.external_user_store import ExternalUserStore

_STORE = ExternalUserStore()


async def _make_client(session: AsyncSession, *, client_type: str) -> str:
    client = Client(
        matrix_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=f"{client_type} client",
        type=client_type,
        password="x",
    )
    session.add(client)
    await session.flush()
    return client.id


async def _make_bridge(session: AsyncSession) -> str:
    bridge = CollaborationBridge(
        type="mattermost",
        display_name="MM",
        client_id=await _make_client(session, client_type="bridge"),
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _make_external_user(
    session: AsyncSession, *, bridge_id: str, username: str = "alice"
) -> ExternalUser:
    external_user = ExternalUser(
        bridge_id=bridge_id,
        external_user_id=f"U{uuid.uuid4().hex[:8]}",
        external_username=username,
        client_id=await _make_client(session, client_type="external_user"),
    )
    session.add(external_user)
    await session.flush()
    return external_user


async def _make_user(session: AsyncSession, *, name: str) -> str:
    user = User(
        name=name,
        email=f"{name}-{uuid.uuid4().hex[:8]}@test",
        role="user",
        password_hash="x",
    )
    session.add(user)
    await session.flush()
    return user.id


class TestClaimIsNonExclusive:
    async def test_two_users_claim_the_same_account(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            first = await _make_user(session, name="first")
            second = await _make_user(session, name="second")

            await _STORE.claim(session, external_user, first)
            await _STORE.claim(session, external_user, second)
            await session.commit()

        async with session_factory() as session:
            claimants = await _STORE.claimant_ids(session, external_user.id)
            assert sorted(claimants) == sorted([first, second])

    async def test_claim_is_idempotent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Re-claiming an account you already claimed is a no-op, not a
        # duplicate row and not a conflict.
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="repeat")

            await _STORE.claim(session, external_user, user_id)
            await _STORE.claim(session, external_user, user_id)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, external_user.id) == [user_id]

    async def test_unclaimed_account_has_no_claimants(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, external_user.id) == []


class TestRelease:
    async def test_release_drops_only_the_named_users_claim(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The point of non-exclusivity: one person walking away from a shared
        # account must not un-claim it for everyone else.
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            leaving = await _make_user(session, name="leaving")
            staying = await _make_user(session, name="staying")
            await _STORE.claim(session, external_user, leaving)
            await _STORE.claim(session, external_user, staying)
            await session.commit()

        async with session_factory() as session:
            await _STORE.release(session, external_user, leaving)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, external_user.id) == [staying]

    async def test_releasing_a_claim_that_was_never_made_is_a_no_op(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            holder = await _make_user(session, name="holder")
            stranger = await _make_user(session, name="stranger")
            await _STORE.claim(session, external_user, holder)
            await session.commit()

        async with session_factory() as session:
            await _STORE.release(session, external_user, stranger)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, external_user.id) == [holder]

    async def test_claim_after_release_works_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="returning")
            await _STORE.claim(session, external_user, user_id)
            await _STORE.release(session, external_user, user_id)
            await _STORE.claim(session, external_user, user_id)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, external_user.id) == [user_id]


class TestGetByUser:
    async def test_returns_every_identity_the_user_claimed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            mine_a = await _make_external_user(
                session, bridge_id=bridge_id, username="mine-a"
            )
            mine_b = await _make_external_user(
                session, bridge_id=bridge_id, username="mine-b"
            )
            theirs = await _make_external_user(
                session, bridge_id=bridge_id, username="theirs"
            )
            me = await _make_user(session, name="me")
            them = await _make_user(session, name="them")
            await _STORE.claim(session, mine_a, me)
            await _STORE.claim(session, mine_b, me)
            await _STORE.claim(session, theirs, them)
            await session.commit()

        async with session_factory() as session:
            got = await _STORE.get_by_user(session, me)
            assert sorted(u.id for u in got) == sorted([mine_a.id, mine_b.id])

    async def test_a_shared_account_is_returned_to_both_claimants(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            shared = await _make_external_user(session, bridge_id=bridge_id)
            first = await _make_user(session, name="first")
            second = await _make_user(session, name="second")
            await _STORE.claim(session, shared, first)
            await _STORE.claim(session, shared, second)
            await session.commit()

        async with session_factory() as session:
            assert [u.id for u in await _STORE.get_by_user(session, first)] == [
                shared.id
            ]
            assert [u.id for u in await _STORE.get_by_user(session, second)] == [
                shared.id
            ]

    async def test_user_without_claims_gets_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            await _make_external_user(session, bridge_id=bridge_id)
            nobody = await _make_user(session, name="nobody")
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.get_by_user(session, nobody) == []


class TestClaimantIdsFor:
    async def test_batches_claims_by_identity(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            shared = await _make_external_user(
                session, bridge_id=bridge_id, username="shared"
            )
            solo = await _make_external_user(
                session, bridge_id=bridge_id, username="solo"
            )
            unclaimed = await _make_external_user(
                session, bridge_id=bridge_id, username="unclaimed"
            )
            first = await _make_user(session, name="first")
            second = await _make_user(session, name="second")
            await _STORE.claim(session, shared, first)
            await _STORE.claim(session, shared, second)
            await _STORE.claim(session, solo, first)
            await session.commit()

        async with session_factory() as session:
            claims = await _STORE.claimant_ids_for(
                session, [shared.id, solo.id, unclaimed.id]
            )
            assert sorted(claims[shared.id]) == sorted([first, second])
            assert claims[solo.id] == [first]
            # An unclaimed identity is absent rather than mapped to []: callers
            # read it with .get(id, []).
            assert unclaimed.id not in claims

    async def test_only_the_requested_identities_are_returned(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            asked = await _make_external_user(
                session, bridge_id=bridge_id, username="asked"
            )
            other = await _make_external_user(
                session, bridge_id=bridge_id, username="other"
            )
            user_id = await _make_user(session, name="claimant")
            await _STORE.claim(session, asked, user_id)
            await _STORE.claim(session, other, user_id)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids_for(session, [asked.id]) == {
                asked.id: [user_id]
            }

    async def test_empty_input_short_circuits(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            assert await _STORE.claimant_ids_for(session, []) == {}


class TestClaimsAreCascaded:
    async def test_deleting_the_switch_user_drops_their_claims(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # ON DELETE CASCADE on users.id: closing a Switch account must not
        # leave a dangling claim that keeps satisfying an owner rule.
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            leaving = await _make_user(session, name="leaving")
            staying = await _make_user(session, name="staying")
            await _STORE.claim(session, external_user, leaving)
            await _STORE.claim(session, external_user, staying)
            await session.commit()

        async with session_factory() as session:
            await session.delete(await session.get(User, leaving))
            await session.commit()

        async with session_factory() as session:
            # The platform identity itself survives — only the claim goes.
            assert await _STORE.get(session, external_user.id) is not None
            assert await _STORE.claimant_ids(session, external_user.id) == [staying]

    async def test_deleting_the_identity_drops_its_claims(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="claimant")
            await _STORE.claim(session, external_user, user_id)
            await session.commit()

        async with session_factory() as session:
            await _STORE.delete(session, external_user.id)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.get_by_user(session, user_id) == []
