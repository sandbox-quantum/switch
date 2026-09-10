"""`tenant_session` and `unscoped_session` (`db/session_scope.py`): the two
named ways background code may open a session with no request behind it.

`tenant_session` is sugar over `tenant_context.bind_tenant_id` plus opening a
session, so what these tests pin is the composition — bound inside the block,
released on the way out, even on an exception — rather than the binding
mechanics themselves, which `test_tenant_session_hook.py` already covers.
`unscoped_session` does nothing at all beyond calling the factory; it is
tested here for what it does *not* do — bind anything — and its callers are
pinned separately, in `test_unscoped_session_allowlist.py`.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

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

    async def test_the_tenant_is_unbound_once_the_block_exits(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert current_tenant_id() is None
        async with tenant_session(session_factory, TENANT_A):
            pass
        assert current_tenant_id() is None

    async def test_an_exception_still_unbinds(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        with pytest.raises(RuntimeError, match="boom"):
            async with tenant_session(session_factory, TENANT_A):
                raise RuntimeError("boom")
        assert current_tenant_id() is None

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

    async def test_it_neither_binds_nor_clears_an_outer_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """It is not a "no tenant" guarantee, only a "no new binding" one —
        the docstring is explicit that this is not force-unscoped. A caller
        already inside a bound context keeps seeing that context's tenant."""
        with tenant_scope(TENANT_A):
            async with unscoped_session(session_factory) as session:
                assert current_tenant_id() == TENANT_A
                assert await _current_setting(session) == TENANT_A
        assert current_tenant_id() is None

    async def test_current_tenant_id_is_unchanged_after_the_block(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert current_tenant_id() is None
        async with unscoped_session(session_factory):
            pass
        assert current_tenant_id() is None
