"""InvitationStore, and the row-level-security isolation it depends on.

The store tests run against `session_factory`, the ambient-tenant fixture
every other store test in this package uses. The isolation tests run against
`rls_harness`, the same harness `test_row_level_security.py` uses to connect
as a role the policies actually apply to — the point being made here is
exactly the one that module states: an invitation belonging to tenant A must
be invisible to a session bound to tenant B, through the ordinary store layer,
with no tenant filter of the store's own doing the work.
"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Invitation, Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.invitation_store import (
    InvitationNotUsableError,
    InvitationStore,
    generate_invitation_token,
)
from tests.conftest import RLSHarness

_STORE = InvitationStore()


async def _make_user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}-{uuid.uuid4().hex[:8]}@test", role="user")
    session.add(user)
    await session.flush()
    return user


def _expires_soon() -> datetime:
    return datetime.now(UTC) + timedelta(days=7)


async def _make_invitation(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    uses_remaining: int = 1,
    expires_at: datetime | None = None,
    revoked: bool = False,
) -> tuple[str, str]:
    """An invitation in the state the test needs, as `(id, token_hash)`."""
    async with session_factory() as session:
        owner = await _make_user(session, "alice")
        invitation, token = await _STORE.create(
            session,
            role="member",
            email=None,
            expires_at=expires_at if expires_at is not None else _expires_soon(),
            uses_remaining=uses_remaining,
            created_by=owner.id,
        )
        if revoked:
            invitation.revoked_at = datetime.now(UTC)
        await session.commit()
        return invitation.id, hashlib.sha256(token.encode()).hexdigest()


# The three independent ways an invitation stops working. Shared by the two
# classes below so that a fourth gate cannot be added to one and forgotten in
# the other.
_UNUSABLE: list[dict[str, object]] = [
    {"revoked": True},
    {"expires_at": datetime.now(UTC) - timedelta(seconds=1)},
    {"uses_remaining": 0},
]
_UNUSABLE_IDS = ["revoked", "expired", "spent"]


async def _consume_racing(
    session_factory: async_sessionmaker[AsyncSession],
    invitation_id: str,
    barrier: asyncio.Barrier,
) -> bool:
    """Consume in a session of its own, timed to collide with the other one.

    The `SELECT 1` before the barrier is what makes the collision real. A
    session that has not spoken to the database yet has no connection: the
    second acceptance would spend the race connecting and authenticating, land
    after the first has already committed, and read the state it was supposed
    to read *concurrently with*. That test passes against a double-spending
    implementation, which is the opposite of the point.
    """
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
        await barrier.wait()
        try:
            await _STORE.consume(session, invitation_id)
        except InvitationNotUsableError:
            return False
        await session.commit()
        return True


class TestTokenGeneration:
    def test_the_token_and_its_hash_are_not_the_same_string(self) -> None:
        token, token_hash = generate_invitation_token()
        assert token != token_hash
        assert hashlib.sha256(token.encode()).hexdigest() == token_hash

    def test_two_calls_never_collide(self) -> None:
        first_token, first_hash = generate_invitation_token()
        second_token, second_hash = generate_invitation_token()
        assert first_token != second_token
        assert first_hash != second_hash


class TestInvitationStoreRoundTrip:
    async def test_create_returns_the_token_exactly_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The row this call persists carries no plaintext at all — only what
        `create` hands back in the same call ever exists in the clear."""
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            invitation, token = await _STORE.create(
                session,
                role="member",
                email=None,
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner.id,
            )
            await session.commit()

        assert token
        assert invitation.token_hash == hashlib.sha256(token.encode()).hexdigest()
        assert not hasattr(invitation, "token")

    async def test_created_invitation_is_found_by_the_hash_of_its_token(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            invitation, token = await _STORE.create(
                session,
                role="admin",
                email="invitee@example.test",
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner.id,
            )
            await session.commit()

        token_hash = hashlib.sha256(token.encode()).hexdigest()
        async with session_factory() as session:
            found = await _STORE.get_by_token_hash(session, token_hash)
            assert found is not None
            assert found.id == invitation.id
            assert found.role == "admin"
            assert found.email == "invitee@example.test"

    async def test_an_unknown_token_hash_resolves_to_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            assert await _STORE.get_by_token_hash(session, "no-such-hash") is None

    async def test_listing_reports_every_invitation_of_the_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            await _STORE.create(
                session,
                role="member",
                email=None,
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner.id,
            )
            await _STORE.create(
                session,
                role="admin",
                email="second@example.test",
                expires_at=_expires_soon(),
                uses_remaining=5,
                created_by=owner.id,
            )
            listed = await _STORE.list_for_tenant(session)
            assert {i.role for i in listed} == {"member", "admin"}

    async def test_revoke_stamps_revoked_at(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            invitation, _token = await _STORE.create(
                session,
                role="member",
                email=None,
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner.id,
            )
            await session.commit()
            assert invitation.revoked_at is None

            revoked = await _STORE.revoke(session, invitation.id)
            assert revoked.revoked_at is not None

    async def test_revoking_a_missing_invitation_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Invitation not found"):
                await _STORE.revoke(session, "nope")


class TestAskingWhetherAnInvitationIsUsable:
    """`get_by_token_hash` finds the row; it says nothing about the token.

    Revoked, expired and spent are three independent gates, and the reason
    they are expressed once in the store rather than at each call site is that
    a caller checking two of the three looks exactly like a caller checking
    all three until the day it doesn't.
    """

    @pytest.mark.parametrize("kwargs", _UNUSABLE, ids=_UNUSABLE_IDS)
    async def test_an_unusable_invitation_is_found_but_not_valid(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        kwargs: dict[str, object],
    ) -> None:
        _id, token_hash = await _make_invitation(session_factory, **kwargs)  # type: ignore[arg-type]
        async with session_factory() as session:
            assert await _STORE.get_by_token_hash(session, token_hash) is not None, (
                "an unusable invitation is still an ordinary row"
            )
            assert await _STORE.get_valid_by_token_hash(session, token_hash) is None, (
                "an unusable invitation must not read back as usable"
            )

    async def test_a_usable_invitation_reads_back_from_both(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        invitation_id, token_hash = await _make_invitation(session_factory)
        async with session_factory() as session:
            valid = await _STORE.get_valid_by_token_hash(session, token_hash)
            assert valid is not None
            assert valid.id == invitation_id


class TestConsume:
    async def test_consuming_spends_one_use(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        invitation_id, _hash = await _make_invitation(session_factory, uses_remaining=3)
        async with session_factory() as session:
            consumed = await _STORE.consume(session, invitation_id)
            assert consumed.uses_remaining == 2
            await session.commit()

    @pytest.mark.parametrize("kwargs", _UNUSABLE, ids=_UNUSABLE_IDS)
    async def test_an_unusable_invitation_refuses_to_be_consumed(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        kwargs: dict[str, object],
    ) -> None:
        """The gates are in the `UPDATE`'s `WHERE`, so each of the three is
        enforced by the statement that would have granted membership rather
        than by whatever the caller remembered to check first."""
        invitation_id, _hash = await _make_invitation(session_factory, **kwargs)  # type: ignore[arg-type]
        async with session_factory() as session:
            with pytest.raises(InvitationNotUsableError):
                await _STORE.consume(session, invitation_id)

    async def test_consuming_an_invitation_that_does_not_exist_refuses(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(InvitationNotUsableError):
                await _STORE.consume(session, "no-such-invitation")

    async def test_two_concurrent_acceptances_of_one_use_grant_exactly_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The race this whole shape exists for.

        Read the row, check `uses_remaining > 0`, decrement in Python, flush:
        both transactions read `1`, both write `0`, read-committed lets both
        commit, and one single-use invitation grants two memberships. One
        conditional `UPDATE` cannot do that — the second blocks on the row
        lock, re-evaluates its `WHERE` against the committed version, matches
        nothing, and refuses.
        """
        invitation_id, _hash = await _make_invitation(session_factory, uses_remaining=1)

        barrier = asyncio.Barrier(2)
        outcomes = await asyncio.gather(
            _consume_racing(session_factory, invitation_id, barrier),
            _consume_racing(session_factory, invitation_id, barrier),
        )

        assert sorted(outcomes) == [False, True], (
            f"exactly one acceptance should have won, got {outcomes}"
        )
        async with session_factory() as session:
            invitation = await session.get(Invitation, invitation_id)
            assert invitation is not None
            assert invitation.uses_remaining == 0

    async def test_the_database_refuses_a_negative_remaining_count(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`>= 0` and not `> 0`: a spent invitation is a `0`, and it has to
        stay representable. What the constraint rules out is the state below
        that, which no correct decrement produces and any careless one
        would."""
        async with session_factory() as session:
            owner = await _make_user(session, "alice")
            with pytest.raises(IntegrityError, match="ck_invitations_uses_remaining"):
                await _STORE.create(
                    session,
                    role="member",
                    email=None,
                    expires_at=_expires_soon(),
                    uses_remaining=-1,
                    created_by=owner.id,
                )


class TestInvitationIsolation:
    """The property the design doc calls out by name: an invitation belonging
    to tenant A must be invisible to a session bound to tenant B."""

    async def test_tenant_b_cannot_read_tenant_as_invitation_by_token_hash(
        self, rls_harness: RLSHarness
    ) -> None:
        tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
        tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
        async with rls_harness.owner() as session:
            session.add_all(
                [
                    Tenant(id=tenant_a, slug=tenant_a, name=tenant_a),
                    Tenant(id=tenant_b, slug=tenant_b, name=tenant_b),
                ]
            )
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            owner = await _make_user(session, "alice")
            _invitation, token = await _STORE.create(
                session,
                role="member",
                email=None,
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner.id,
            )
            await session.commit()

        token_hash = hashlib.sha256(token.encode()).hexdigest()
        async with tenant_session(rls_harness.restricted, tenant_b) as session:
            found = await _STORE.get_by_token_hash(session, token_hash)

        assert found is None, (
            "tenant B's session read tenant A's invitation through "
            "InvitationStore.get_by_token_hash — the policy's USING clause "
            "should have hidden it"
        )

    async def test_tenant_bs_listing_never_includes_tenant_as_invitations(
        self, rls_harness: RLSHarness
    ) -> None:
        tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
        tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
        async with rls_harness.owner() as session:
            session.add_all(
                [
                    Tenant(id=tenant_a, slug=tenant_a, name=tenant_a),
                    Tenant(id=tenant_b, slug=tenant_b, name=tenant_b),
                ]
            )
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            owner_a = await _make_user(session, "alice")
            await _STORE.create(
                session,
                role="member",
                email=None,
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner_a.id,
            )
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_b) as session:
            owner_b = await _make_user(session, "bob")
            await _STORE.create(
                session,
                role="admin",
                email=None,
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner_b.id,
            )
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_b) as session:
            listed = await _STORE.list_for_tenant(session)

        assert [i.tenant_id for i in listed] == [tenant_b], (
            "list_for_tenant issues no tenant filter of its own; tenant A's "
            "invitation reaching this listing means the policy let it through"
        )

    async def test_tenant_b_cannot_consume_tenant_as_invitation(
        self, rls_harness: RLSHarness
    ) -> None:
        """`consume` is an `UPDATE`, and the policy's `USING` clause applies to
        the rows it may reach the same way it applies to a `SELECT`. Knowing
        the id is not knowing the tenant."""
        tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
        tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
        async with rls_harness.owner() as session:
            session.add_all(
                [
                    Tenant(id=tenant_a, slug=tenant_a, name=tenant_a),
                    Tenant(id=tenant_b, slug=tenant_b, name=tenant_b),
                ]
            )
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            owner = await _make_user(session, "alice")
            invitation, _token = await _STORE.create(
                session,
                role="member",
                email=None,
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner.id,
            )
            invitation_id = invitation.id
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_b) as session:
            with pytest.raises(InvitationNotUsableError):
                await _STORE.consume(session, invitation_id)

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            still_there = await session.get(Invitation, invitation_id)
            assert still_there is not None
            assert still_there.uses_remaining == 1

    async def test_a_session_with_no_tenant_bound_cannot_read_invitations(
        self, rls_harness: RLSHarness
    ) -> None:
        """Populated on purpose: Postgres does not evaluate a policy for a
        scan that yields no rows, so this would pass vacuously against an
        empty table even with no policy installed at all."""
        tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
        async with rls_harness.owner() as session:
            session.add(Tenant(id=tenant_a, slug=tenant_a, name=tenant_a))
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            owner = await _make_user(session, "alice")
            await _STORE.create(
                session,
                role="member",
                email=None,
                expires_at=_expires_soon(),
                uses_remaining=1,
                created_by=owner.id,
            )
            await session.commit()

        async with rls_harness.restricted() as session:
            with pytest.raises(DBAPIError, match="app.tenant_id is not set"):
                await _STORE.list_for_tenant(session)
