"""The operator/workspace-admin role split (CHOO-2726, phase 2 design §2).

Before this change, `authz.Principal.is_admin` came from `users.role ==
"admin"` alone — a global bit that `tenant_members.role` never fed into. So a
workspace's `owner` membership row granted nothing: every admin-gated route
checked the global bit, never the caller's role in the tenant the request is
bound to.

These tests pin the four behavioural claims that split makes true:

- a workspace `owner` can administer resources in *their own* tenant;
- the same person has no such power in a tenant they only hold a `member`
  row in — `UserStore.administers` must read the *bound* tenant's row, not
  any row belonging to the caller;
- a deployment operator (`users.role == "admin"`) keeps its unconditional
  bypass regardless of what `tenant_members` says, in every tenant, with or
  without a membership row at all;
- a plain `member` with no operator bit gains nothing.

Each is proven both at the pure-decision level (`authz.administers_tenant`,
covered in `test_authz.py`) and here, against a real Postgres session and a
real `tenant_members` row, through `UserStore.administers` — the one place
that turns "who is this" plus "what tenant is bound" into that bit — and
through `authz.can` on a real `Room`, so the wiring from a membership row to
an actual resource decision is exercised end to end, not just the boolean.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import Principal, can
from switch_core.db.models import TENANT_ZERO_ID, Room, Tenant, TenantMember, User
from switch_core.db.stores.user_store import UserStore
from switch_core.tenant_context import tenant_scope

TENANT_B = "tenant-b"


async def _make_user(session: AsyncSession, name: str, *, role: str = "user") -> User:
    user = User(
        name=name, email=f"{name}@example.invalid", role=role, password_hash="x"
    )
    session.add(user)
    await session.flush()
    return user


async def _make_tenant(session: AsyncSession, tenant_id: str) -> Tenant:
    tenant = Tenant(id=tenant_id, slug=tenant_id, name=tenant_id)
    session.add(tenant)
    await session.flush()
    return tenant


async def _membership(
    session: AsyncSession, tenant_id: str, user_id: str, role: str
) -> None:
    session.add(TenantMember(tenant_id=tenant_id, user_id=user_id, role=role))
    await session.flush()


class TestUserStoreAdministers:
    async def test_owner_administers_their_own_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            owner = await _make_user(session, "owner-of-zero")
            await _membership(session, TENANT_ZERO_ID, owner.id, "owner")
            await session.commit()

            # Ambient tenant is TENANT_ZERO_ID (see conftest.session_factory).
            assert await store.administers(session, owner) is True

    async def test_owner_has_no_power_in_a_tenant_they_only_belong_to_as_member(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Two sessions, one per tenant: `TenantCheckedSession` stamps a
        # session's transaction with whichever tenant is bound when it opens
        # and refuses to let it drift mid-transaction
        # (`db/tenant_session.py`), the same guard that would catch a request
        # rebinding a session it did not open scoped. A real cross-tenant
        # comparison goes through two sessions for the same reason.
        store = UserStore()
        async with session_factory() as session:
            tenant_b = await _make_tenant(session, TENANT_B)
            owner = await _make_user(session, "cross-tenant-owner")
            await _membership(session, TENANT_ZERO_ID, owner.id, "owner")
            await _membership(session, tenant_b.id, owner.id, "member")
            await session.commit()

            assert await store.administers(session, owner) is True

        with tenant_scope(tenant_b.id):
            async with session_factory() as session_b:
                assert await store.administers(session_b, owner) is False

    async def test_admin_membership_role_also_administers(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            admin_member = await _make_user(session, "admin-of-zero")
            await _membership(session, TENANT_ZERO_ID, admin_member.id, "admin")
            await session.commit()

            assert await store.administers(session, admin_member) is True

    async def test_operator_bypasses_regardless_of_tenant_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            tenant_b = await _make_tenant(session, TENANT_B)
            operator = await _make_user(session, "operator", role="admin")
            # A plain member in tenant zero...
            await _membership(session, TENANT_ZERO_ID, operator.id, "member")
            await session.commit()

            assert await store.administers(session, operator) is True

        # ...and no membership row at all in tenant B — a fresh session bound
        # there, per the note above.
        with tenant_scope(tenant_b.id):
            async with session_factory() as session_b:
                assert await store.administers(session_b, operator) is True

    async def test_plain_member_gains_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            member = await _make_user(session, "plain-member")
            await _membership(session, TENANT_ZERO_ID, member.id, "member")
            await session.commit()

            assert await store.administers(session, member) is False

    async def test_no_membership_row_in_the_bound_tenant_gains_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            stray = await _make_user(session, "no-membership")
            await session.commit()

            assert await store.administers(session, stray) is False


class TestRoomAuthzThroughTenantRole:
    """The same claims, one layer up: a real `authz.can` decision on a real
    `Room` neither party personally owns, built from `UserStore.administers`
    the way `gateway/rooms.py` and `gateway/auth.py` build it."""

    async def test_workspace_owner_can_delete_a_room_they_do_not_personally_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            owner = await _make_user(session, "room-admin-owner")
            someone_else = await _make_user(session, "room-creator")
            await _membership(session, TENANT_ZERO_ID, owner.id, "owner")
            room = Room(
                tenant_id=TENANT_ZERO_ID,
                matrix_room_id="!private-room:test",
                name="private room",
                description="desc",
                owner_id=someone_else.id,
                read_visibility="private",
                write_visibility="private",
            )
            session.add(room)
            await session.commit()

            principal = Principal(owner.id, await store.administers(session, owner))
            assert can(principal, "delete", room)

    async def test_workspace_owner_cannot_delete_the_same_room_from_another_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            tenant_b = await _make_tenant(session, TENANT_B)
            owner = await _make_user(session, "room-admin-owner-2")
            someone_else = await _make_user(session, "room-creator-2")
            await _membership(session, TENANT_ZERO_ID, owner.id, "owner")
            await _membership(session, tenant_b.id, owner.id, "member")
            room = Room(
                tenant_id=TENANT_ZERO_ID,
                matrix_room_id="!private-room-2:test",
                name="private room",
                description="desc",
                owner_id=someone_else.id,
                read_visibility="private",
                write_visibility="private",
            )
            session.add(room)
            await session.commit()

        with tenant_scope(tenant_b.id):
            async with session_factory() as session_b:
                principal = Principal(
                    owner.id, await store.administers(session_b, owner)
                )
        assert not can(principal, "delete", room)

    async def test_plain_member_cannot_delete_a_room_they_do_not_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            member = await _make_user(session, "room-member")
            someone_else = await _make_user(session, "room-creator-3")
            await _membership(session, TENANT_ZERO_ID, member.id, "member")
            room = Room(
                tenant_id=TENANT_ZERO_ID,
                matrix_room_id="!private-room-3:test",
                name="private room",
                description="desc",
                owner_id=someone_else.id,
                read_visibility="private",
                write_visibility="private",
            )
            session.add(room)
            await session.commit()

            principal = Principal(member.id, await store.administers(session, member))
            assert not can(principal, "delete", room)
