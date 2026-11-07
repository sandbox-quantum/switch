"""`tenant_session` (`db/session_scope.py`): how background code opens a
session with no request behind it.

It is sugar over `tenant_context.bind_tenant_id` plus opening a session, so
what these tests pin is the composition — bound inside the block, released on
the way out, even on an exception — rather than the binding mechanics
themselves, which `test_tenant_session_hook.py` already covers.

There was a second helper here, `unscoped_session`, with its own class of
tests asserting that a session opened through it had no tenant set whatever
the caller had bound. Both are gone. That contract was only ever meaningful
against a connection Postgres exempts from the policies; under the restricted
runtime role an unbound session reads nothing rather than everything, so
"unscoped" stopped being a hatch and became a failure. What replaced it is
`db/tenant_lookup.py`, tested in `test_tenant_lookup.py`, and who may reach it
is pinned in `test_tenant_exemption_allowlist.py`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.session_scope import shared_tenant_session, tenant_session
from switch_core.tenant_context import current_tenant_id, tenant_scope
from tests.session_counting import CountingSessionFactory

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


class TestSharedTenantSession:
    async def test_a_session_opened_inside_the_block_is_the_shared_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        counting: Any = CountingSessionFactory(session_factory)
        async with shared_tenant_session(counting, TENANT_A) as shared:
            async with tenant_session(counting, TENANT_A) as first:
                assert await _current_setting(first) == TENANT_A
            async with tenant_session(counting, TENANT_A) as second:
                assert await _current_setting(second) == TENANT_A
        assert first is shared
        assert second is shared
        assert counting.opened == 1

    async def test_another_tenant_opens_its_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with shared_tenant_session(session_factory, TENANT_A) as shared:
            assert await _current_setting(shared) == TENANT_A
            async with tenant_session(session_factory, TENANT_B) as other:
                assert other is not shared
                assert await _current_setting(other) == TENANT_B
            assert await _current_setting(shared) == TENANT_A

    async def test_another_task_opens_its_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A task started inside the block inherits its context, but two tasks
        must never use one `AsyncSession` at once."""

        async def opened() -> AsyncSession:
            async with tenant_session(session_factory, TENANT_A) as session:
                await _current_setting(session)
                return session

        async with shared_tenant_session(session_factory, TENANT_A) as shared:
            assert await asyncio.create_task(opened()) is not shared

    async def test_nothing_is_lent_once_the_block_exits(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with shared_tenant_session(session_factory, TENANT_A) as shared:
            pass
        async with tenant_session(session_factory, TENANT_A) as after:
            assert after is not shared

    async def test_an_inner_block_leaves_the_session_open(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with shared_tenant_session(session_factory, TENANT_A) as shared:
            async with tenant_session(session_factory, TENANT_A) as inner:
                await _current_setting(inner)
            assert await _current_setting(shared) == TENANT_A

    async def test_a_commit_inside_the_block_keeps_the_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A commit ends the transaction, and `set_config` is local to it; the
        next transaction is stamped again by `after_begin`."""
        async with shared_tenant_session(session_factory, TENANT_A):
            async with tenant_session(session_factory, TENANT_A) as session:
                assert await _current_setting(session) == TENANT_A
                await session.commit()
            async with tenant_session(session_factory, TENANT_A) as session:
                assert await _current_setting(session) == TENANT_A

    @pytest.mark.no_ambient_tenant
    async def test_the_tenant_is_unbound_once_the_block_exits(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        with pytest.raises(RuntimeError, match="boom"):
            async with shared_tenant_session(session_factory, TENANT_A):
                async with tenant_session(session_factory, TENANT_A):
                    raise RuntimeError("boom")
        assert current_tenant_id() is None
        async with tenant_session(session_factory, TENANT_A) as session:
            assert await _current_setting(session) == TENANT_A

    async def test_a_block_inside_another_for_the_same_tenant_raises(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with shared_tenant_session(session_factory, TENANT_A):
            with pytest.raises(RuntimeError, match="already open"):
                async with shared_tenant_session(session_factory, TENANT_A):
                    pass

    async def test_a_block_left_by_closing_its_generator_lends_nothing_after(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Yielding inside a block is forbidden, but if a generator does and is
        then closed, later sessions in the same task are not handed the closed
        one."""

        async def holds() -> Any:
            async with shared_tenant_session(session_factory, TENANT_A) as session:
                yield session

        frames = holds()
        shared = await anext(frames)
        await frames.aclose()

        async with tenant_session(session_factory, TENANT_A) as after:
            assert after is not shared
