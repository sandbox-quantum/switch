"""The Python half of the fail-closed rule (CHOO-2623).

`require_tenant_id` (`db/models.py`) is the Python-side default on every
scoped column, and it replaced a fallback to tenant zero. Under row-level
security that fallback stopped being a safe default: a caller who forgot to
bind wrote into a *real* tenant, and `with check` cannot tell that apart from
a write tenant zero actually intended.

The raise is worth testing on its own rather than through the policies,
because it does something the policies cannot: it fails in Python, at the
write that forgot to bind, instead of at whatever error Postgres raises later
— and it fails on the owner connection every environment still uses today,
where no policy bites at all.

What is deliberately *not* tested here is the whole suite under
`no_ambient_tenant`. Applying that marker suite-wide turns 354 tests red,
which is the expected shape rather than a finding: most of them construct
scoped rows directly, with no request or unit of work behind them, and
binding tenant zero for them is what `session_factory` exists to do. What
must be pinned is the invariant itself, and the handful of paths that are
supposed to bind one.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import insert, select
from sqlalchemy.exc import StatementError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    RoomGroup,
    TenantMember,
    TenantNotBoundError,
    User,
    require_tenant_id,
    room_agents,
)
from switch_core.db.stores.user_store import UserStore
from switch_core.tenant_context import no_tenant, tenant_scope

pytestmark = pytest.mark.no_ambient_tenant


class TestRequireTenantId:
    def test_it_raises_when_nothing_is_bound(self) -> None:
        with pytest.raises(TenantNotBoundError, match="no tenant is bound"):
            require_tenant_id()

    def test_it_returns_the_bound_tenant(self) -> None:
        with tenant_scope("tenant-x"):
            assert require_tenant_id() == "tenant-x"

    def test_it_raises_again_inside_a_deliberate_unbind(self) -> None:
        """`no_tenant` is what every long-lived background task enters first,
        so this is the state a unit of work that forgot to bind runs in."""
        with tenant_scope("tenant-x"), no_tenant():
            with pytest.raises(TenantNotBoundError):
                require_tenant_id()


class TestTheOrmDefault:
    """Through SQLAlchemy the raise arrives wrapped.

    A column default is invoked while the statement is being compiled, so
    SQLAlchemy catches whatever it raises and re-raises it as a
    `StatementError` with the original as `__cause__`. That matters to a
    caller: a `except SQLAlchemyError` around a write — the store layer has
    several — swallows this, and the row simply never appears. The tests
    below assert the cause rather than the surface type, and say so, because
    the wrapping is easy to mistake for the invariant not firing.
    """

    async def test_a_scoped_row_with_nothing_bound_refuses_to_be_written(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Not a row in tenant zero, which is what this used to be."""
        async with session_factory() as session:
            session.add(RoomGroup(name="orphan"))
            with pytest.raises(StatementError) as excinfo:
                await session.flush()
        assert isinstance(excinfo.value.orig, TenantNotBoundError)

    async def test_a_bound_tenant_fills_the_column(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with tenant_scope(TENANT_ZERO_ID):
                group = RoomGroup(name="bound")
                session.add(group)
                await session.flush()
                assert group.tenant_id == TENANT_ZERO_ID

    async def test_an_explicit_tenant_still_bypasses_the_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The sanctioned hatch: system seeding names its tenant rather than
        binding one, and the default is not consulted at all."""
        async with session_factory() as session:
            group = RoomGroup(tenant_id=TENANT_ZERO_ID, name="named")
            session.add(group)
            await session.flush()
            assert group.tenant_id == TENANT_ZERO_ID

    async def test_a_plain_table_junction_insert_raises_the_same_way(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`room_agents` and its siblings are `Table()`s, not declarative
        classes, so they carry the default inline rather than through the
        mixin. Same rule, and easy to leave behind when only the mixin is
        edited."""
        async with session_factory() as session:
            with pytest.raises(StatementError) as excinfo:
                await session.execute(
                    insert(room_agents).values(
                        room_id=str(uuid.uuid4()), agent_id=str(uuid.uuid4())
                    )
                )
        assert isinstance(excinfo.value.orig, TenantNotBoundError)


class TestMembershipNeedsOneToo:
    """`tenant_members` is the one scoped write the model default cannot
    cover — its whole primary key is supplied by the caller — so `UserStore`
    asks for the tenant itself. It used to fall back to tenant zero here,
    a hand-rolled copy of exactly the default this change removed.
    """

    async def test_creating_a_user_with_nothing_bound_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(TenantNotBoundError):
                await UserStore().create(
                    session,
                    User(name="nobody", email="nobody@example.invalid", role="user"),
                )

    async def test_a_bound_tenant_is_the_one_they_join(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with tenant_scope(TENANT_ZERO_ID):
                user = User(name="joiner", email="joiner@example.invalid", role="user")
                await UserStore().create(session, user)
                await session.commit()
                memberships = await session.execute(
                    select(TenantMember.tenant_id).where(
                        TenantMember.user_id == user.id
                    )
                )
                assert list(memberships.scalars()) == [TENANT_ZERO_ID]

    async def test_an_admin_joins_as_owner(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with tenant_scope(TENANT_ZERO_ID):
                user = User(name="boss", email="boss@example.invalid", role="admin")
                await UserStore().create(session, user)
                await session.commit()
                roles = await session.execute(
                    select(TenantMember.role).where(TenantMember.user_id == user.id)
                )
                assert list(roles.scalars()) == ["owner"]
