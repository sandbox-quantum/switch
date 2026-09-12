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

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Tenant, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.invitation_store import (
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
