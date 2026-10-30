"""Claiming a platform identity is non-exclusive (CHOO-2137), and takes the
account's own confirmation (CHOO-3881).

Several Switch users may claim the same messaging account. An exclusive claim
would let whoever got there first keep the real person from ever being
recognised by their own agents, so the store records claims as a set rather
than as a single owner column on `external_users`.

A claim is only written once the account confirms it, by posting the code its
Switch user was shown; until then it is a link request, which nothing trusts.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    ExternalUserLinkRequest,
    TenantMember,
    User,
)
from switch_core.db.stores.external_user_store import (
    ExternalUserStore,
    LinkRelease,
    NoSuchLink,
)

_STORE = ExternalUserStore()


async def _claim(
    session: AsyncSession, external_user: ExternalUser, user_id: str
) -> None:
    """A confirmed claim, the only kind the store writes."""
    request = await _STORE.request_link(
        session, external_user, user_id, requested_by_user_id=user_id
    )
    await _STORE.confirm_link_request(session, request)


async def _make_client(session: AsyncSession, *, client_type: str) -> str:
    client = Client(
        transport_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=f"{client_type} client",
        type=client_type,
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
    # A code only confirms a link for a member of the workspace.
    session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role="member"))
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

            await _claim(session, external_user, first)
            await _claim(session, external_user, second)
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

            await _claim(session, external_user, user_id)
            await _claim(session, external_user, user_id)
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
            await _claim(session, external_user, leaving)
            await _claim(session, external_user, staying)
            await session.commit()

        async with session_factory() as session:
            await _STORE.release(session, external_user, leaving)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, external_user.id) == [staying]

    async def test_releasing_a_claim_that_was_never_made_says_so(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            holder = await _make_user(session, name="holder")
            stranger = await _make_user(session, name="stranger")
            await _claim(session, external_user, holder)
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(NoSuchLink):
                await _STORE.release(session, external_user, stranger)

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, external_user.id) == [holder]

    async def test_claim_after_release_works_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            external_user = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="returning")
            await _claim(session, external_user, user_id)
            await _STORE.release(session, external_user, user_id)
            await _claim(session, external_user, user_id)
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
            await _claim(session, mine_a, me)
            await _claim(session, mine_b, me)
            await _claim(session, theirs, them)
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
            await _claim(session, shared, first)
            await _claim(session, shared, second)
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


class TestClaimsFor:
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
            await _claim(session, shared, first)
            await _claim(session, shared, second)
            await _claim(session, solo, first)
            await session.commit()

        async with session_factory() as session:
            claims = await _STORE.claims_for(
                session, [shared.id, solo.id, unclaimed.id]
            )
            assert sorted(c.user_id for c in claims[shared.id]) == sorted(
                [first, second]
            )
            assert [c.user_id for c in claims[solo.id]] == [first]
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
            await _claim(session, asked, user_id)
            await _claim(session, other, user_id)
            await session.commit()

        async with session_factory() as session:
            claims = await _STORE.claims_for(session, [asked.id])
            assert list(claims) == [asked.id]
            assert [c.user_id for c in claims[asked.id]] == [user_id]

    async def test_empty_input_short_circuits(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            assert await _STORE.claims_for(session, []) == {}


class TestLinkRequests:
    async def test_a_request_is_trusted_by_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="asker")
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            await _STORE.issue_link_code(session, request)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, account.id) == []
            assert await _STORE.get_by_user(session, user_id) == []
            assert [
                (ext.id, req.user_id)
                for ext, req in await _STORE.link_requests_of_user(session, user_id)
            ] == [(account.id, user_id)]

    async def test_the_code_from_its_own_account_confirms_the_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="asker")
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            code, _expires = await _STORE.issue_link_code(session, request)
            await session.commit()

        async with session_factory() as session:
            # Typed the way a person might: lower case, no hyphen, O for 0.
            typed = code.replace("-", "").lower().replace("0", "o")
            confirmed = await _STORE.redeem_link_code(session, account, typed)
            assert confirmed is not None
            assert confirmed.user_id == user_id
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, account.id) == [user_id]
            claim = await _STORE.get_claim(session, account.id, user_id)
            assert claim is not None
            assert claim.verified_at is not None
            assert await _STORE.get_link_request(session, account.id, user_id) is None

    async def test_a_code_is_single_use(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="asker")
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            code, _expires = await _STORE.issue_link_code(session, request)
            assert await _STORE.redeem_link_code(session, account, code) is not None
            await _STORE.release(session, account, user_id)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.redeem_link_code(session, account, code) is None
            assert await _STORE.claimant_ids(session, account.id) == []

    async def test_the_code_from_another_account_confirms_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Somebody else posting the code, having seen it in a channel, is the
        # case that makes posting it in a channel safe.
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            bystander = await _make_external_user(
                session, bridge_id=bridge_id, username="bystander"
            )
            user_id = await _make_user(session, name="asker")
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            code, _expires = await _STORE.issue_link_code(session, request)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.redeem_link_code(session, bystander, code) is None
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.claimant_ids(session, account.id) == []
            assert await _STORE.claimant_ids(session, bystander.id) == []
            assert await _STORE.get_link_request(session, account.id, user_id)

    async def test_an_expired_code_confirms_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="asker")
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            code, _expires = await _STORE.issue_link_code(session, request)
            request.code_expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.redeem_link_code(session, account, code) is None
            assert await _STORE.claimant_ids(session, account.id) == []

    async def test_a_new_code_replaces_the_old_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="asker")
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            old, _expires = await _STORE.issue_link_code(session, request)
            new, _expires = await _STORE.issue_link_code(session, request)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.redeem_link_code(session, account, old) is None
            assert await _STORE.redeem_link_code(session, account, new) is not None

    async def test_text_that_cannot_be_a_code_confirms_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="asker")
            # A request with no code yet, as an admin leaves one.
            await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            await session.commit()

        async with session_factory() as session:
            for text in ("", "hello", "@ABCD-EFGH", "ABCD-EFGH-JKMN"):
                assert await _STORE.redeem_link_code(session, account, text) is None

    async def test_confirming_upgrades_an_unverified_claim(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A claim from before links needed confirming keeps working, and
        # confirming it marks it verified in place rather than adding a row.
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="old-timer")
            session.add(ExternalUserClaim(external_user_id=account.id, user_id=user_id))
            await session.flush()
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            code, _expires = await _STORE.issue_link_code(session, request)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.redeem_link_code(session, account, code) is not None
            await session.commit()

        async with session_factory() as session:
            rows = (
                await session.scalars(
                    select(ExternalUserClaim).where(
                        ExternalUserClaim.external_user_id == account.id
                    )
                )
            ).all()
            assert [(r.user_id, r.verified_at is not None) for r in rows] == [
                (user_id, True)
            ]

    async def test_asking_again_keeps_the_waiting_code(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A second "This is me" must not invalidate a code someone is already
        # about to post; only asking for a new code does.
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="asker")
            admin_id = await _make_user(session, name="admin")
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            code, _expires = await _STORE.issue_link_code(session, request)
            again = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=admin_id
            )
            assert again.requested_by_user_id == admin_id
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.redeem_link_code(session, account, code) is not None

    async def test_release_cancels_a_waiting_request(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="asker")
            request = await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            code, _expires = await _STORE.issue_link_code(session, request)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.release(session, account, user_id) == LinkRelease(
                claim=False, request=True
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(NoSuchLink):
                await _STORE.release(session, account, user_id)
            assert await _STORE.redeem_link_code(session, account, code) is None

    async def test_deleting_the_switch_user_drops_their_requests(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            bridge_id = await _make_bridge(session)
            account = await _make_external_user(session, bridge_id=bridge_id)
            user_id = await _make_user(session, name="leaving")
            await _STORE.request_link(
                session, account, user_id, requested_by_user_id=user_id
            )
            await session.commit()

        async with session_factory() as session:
            await session.execute(
                delete(TenantMember).where(TenantMember.user_id == user_id)
            )
            await session.delete(await session.get(User, user_id))
            await session.commit()

        async with session_factory() as session:
            assert (
                await session.scalars(
                    select(ExternalUserLinkRequest).where(
                        ExternalUserLinkRequest.external_user_id == account.id
                    )
                )
            ).all() == []


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
            await _claim(session, external_user, leaving)
            await _claim(session, external_user, staying)
            await session.commit()

        async with session_factory() as session:
            await session.execute(
                delete(TenantMember).where(TenantMember.user_id == leaving)
            )
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
            await _claim(session, external_user, user_id)
            await session.commit()

        async with session_factory() as session:
            await _STORE.delete(session, external_user.id)
            await session.commit()

        async with session_factory() as session:
            assert await _STORE.get_by_user(session, user_id) == []
