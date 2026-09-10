"""`tenant_session` and `unscoped_session` (`db/session_scope.py`): the two
named ways background code may open a session with no request behind it.

`tenant_session` is sugar over `tenant_context.bind_tenant_id` plus opening a
session, so what these tests pin is the composition — bound inside the block,
released on the way out, even on an exception — rather than the binding
mechanics themselves, which `test_tenant_session_hook.py` already covers.
`unscoped_session` is tested here for the one thing its name promises and its
callers depend on: that a session opened through it has no tenant set, no
matter what the caller had bound. Its callers are pinned separately, in
`test_unscoped_session_allowlist.py`.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, Tenant
from switch_core.db.session_scope import tenant_session, unscoped_session
from switch_core.tenant_context import current_tenant_id, tenant_scope

TENANT_A = "tenant-session-scope-a"
TENANT_B = "tenant-session-scope-b"


async def _current_setting(session: AsyncSession) -> str | None:
    result = await session.execute(
        text("SELECT current_setting('app.tenant_id', true)")
    )
    value = result.scalar_one()
    return value or None


class TestTenantSession:
    async def test_the_tenant_is_bound_inside_the_block(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with tenant_session(session_factory, TENANT_A) as session:
            assert current_tenant_id() == TENANT_A
            assert await _current_setting(session) == TENANT_A
            await session.commit()

    @pytest.mark.no_ambient_tenant
    async def test_the_tenant_is_unbound_once_the_block_exits(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert current_tenant_id() is None
        async with tenant_session(session_factory, TENANT_A):
            pass
        assert current_tenant_id() is None

    @pytest.mark.no_ambient_tenant
    async def test_an_exception_still_unbinds(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        with pytest.raises(RuntimeError, match="boom"):
            async with tenant_session(session_factory, TENANT_A):
                raise RuntimeError("boom")
        assert current_tenant_id() is None

    @pytest.mark.no_ambient_tenant
    async def test_it_restores_an_outer_binding_rather_than_clearing_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A call site reached from an already-tenant-bound context (a
        request, an outer tenant_scope) must not leave that context's own
        tenant cleared once its own, possibly-redundant, binding ends."""
        with tenant_scope(TENANT_A):
            async with tenant_session(session_factory, TENANT_B):
                assert current_tenant_id() == TENANT_B
            assert current_tenant_id() == TENANT_A
        assert current_tenant_id() is None

    async def test_sequential_uses_do_not_leak_into_each_other(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with tenant_session(session_factory, TENANT_A) as session:
            assert await _current_setting(session) == TENANT_A
            await session.commit()
        async with tenant_session(session_factory, TENANT_B) as session:
            assert await _current_setting(session) == TENANT_B
            await session.commit()


class TestUnscopedSession:
    async def test_no_tenant_is_bound_when_nothing_was_bound_going_in(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with unscoped_session(session_factory) as session:
            assert current_tenant_id() is None
            assert await _current_setting(session) is None

    @pytest.mark.no_ambient_tenant
    async def test_it_unbinds_an_outer_tenant_for_the_duration(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The whole contract. A caller already inside a bound context — a
        request, an outer `tenant_scope`, a task that inherited one — still
        gets a session with nothing set, because otherwise "unscoped" would
        mean "scoped to whoever happened to call me" and the allowlist that
        pins these call sites would be certifying a cross-tenant read that
        never happens."""
        with tenant_scope(TENANT_A):
            async with unscoped_session(session_factory) as session:
                assert current_tenant_id() is None
                assert await _current_setting(session) is None
            assert current_tenant_id() == TENANT_A
        assert current_tenant_id() is None

    async def test_an_exception_still_restores_the_outer_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        with tenant_scope(TENANT_A):
            with pytest.raises(RuntimeError, match="boom"):
                async with unscoped_session(session_factory):
                    raise RuntimeError("boom")
            assert current_tenant_id() == TENANT_A

    @pytest.mark.no_ambient_tenant
    async def test_current_tenant_id_is_unchanged_after_the_block(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert current_tenant_id() is None
        async with unscoped_session(session_factory):
            pass
        assert current_tenant_id() is None

    async def test_it_reads_rows_from_two_tenants_with_one_of_them_bound(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """What the callers actually rely on, stated in rows rather than in
        contextvars: a sweep or an enumeration reached from inside a bound
        context still sees the whole deployment.

        Today no policy filters anything, so the `set_config` assertion is
        what carries the weight — it is the value the policies will read once
        they land. Both are asserted so this test keeps meaning the same thing
        on either side of that change.
        """
        tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
        tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
        async with session_factory() as session:
            for tenant_id in (tenant_a, tenant_b):
                session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
            await session.flush()
            for tenant_id in (tenant_a, tenant_b):
                session.add(
                    Room(
                        tenant_id=tenant_id,
                        matrix_room_id=f"!{tenant_id}:test",
                        name=tenant_id,
                        description="",
                    )
                )
            await session.commit()

        with tenant_scope(tenant_a):
            async with unscoped_session(session_factory) as session:
                assert await _current_setting(session) is None
                rows = (await session.execute(select(Room.tenant_id))).scalars().all()
        assert {tenant_a, tenant_b} <= set(rows)
