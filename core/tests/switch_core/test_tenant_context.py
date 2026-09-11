"""switch_core.tenant_context: the contextvar itself, independent of anything
that reads or writes it for a real request."""

from __future__ import annotations

import asyncio
import contextvars
from collections.abc import Coroutine, Generator
from typing import Any

import pytest

from switch_core.logging_context import bind_log_context, unbind_log_context
from switch_core.tenant_context import (
    bind_tenant_id,
    clear_tenant_id,
    current_tenant_id,
    no_tenant,
    tenant_scope,
    unbind_tenant_id,
)


class _Suspend:
    """An await that suspends once, so a coroutine can be left mid-scope with
    no event loop in sight."""

    def __await__(self) -> Generator[None, None, None]:
        yield


class TestBindAndUnbind:
    def test_nothing_bound_reads_as_none(self) -> None:
        assert current_tenant_id() is None

    def test_bind_is_visible_until_unbound(self) -> None:
        token = bind_tenant_id("tenant-a")
        try:
            assert current_tenant_id() == "tenant-a"
        finally:
            unbind_tenant_id(token)
        assert current_tenant_id() is None

    def test_unbinding_restores_the_enclosing_value_not_none(self) -> None:
        outer = bind_tenant_id("outer")
        try:
            inner = bind_tenant_id("inner")
            try:
                assert current_tenant_id() == "inner"
            finally:
                unbind_tenant_id(inner)
            assert current_tenant_id() == "outer"
        finally:
            unbind_tenant_id(outer)


class TestTenantScope:
    def test_binds_for_the_block_and_releases_after(self) -> None:
        with tenant_scope("tenant-a"):
            assert current_tenant_id() == "tenant-a"
        assert current_tenant_id() is None

    def test_releases_even_if_the_block_raises(self) -> None:
        try:
            with tenant_scope("tenant-a"):
                raise ValueError("boom")
        except ValueError:
            pass
        assert current_tenant_id() is None


class TestNoTenant:
    """The unbind side. It is what makes "nothing is ambient" enforceable
    rather than aspirational: a long-lived task enters it before doing
    anything, so a unit of work inside that forgets to bind reads nothing
    instead of reading whoever created the task."""

    def test_it_unbinds_for_the_block_and_restores_after(self) -> None:
        with tenant_scope("tenant-a"):
            with no_tenant():
                assert current_tenant_id() is None
            assert current_tenant_id() == "tenant-a"

    def test_it_is_a_no_op_when_nothing_was_bound(self) -> None:
        with no_tenant():
            assert current_tenant_id() is None
        assert current_tenant_id() is None

    def test_it_restores_even_if_the_block_raises(self) -> None:
        with tenant_scope("tenant-a"):
            try:
                with no_tenant():
                    raise ValueError("boom")
            except ValueError:
                pass
            assert current_tenant_id() == "tenant-a"

    def test_a_binding_inside_it_still_works_and_still_releases(self) -> None:
        """The shape every converted task takes: unbind for the lifetime,
        bind per unit of work, and be back to nothing between them."""
        with tenant_scope("creator"):
            with no_tenant():
                with tenant_scope("the-row-s-tenant"):
                    assert current_tenant_id() == "the-row-s-tenant"
                assert current_tenant_id() is None
            assert current_tenant_id() == "creator"

    async def test_a_task_created_inside_it_inherits_nothing(self) -> None:
        """Why it is entered at the top of a task body rather than around the
        `create_task` call: what a task snapshots is its creator's context, so
        the unbinding has to be inside the task to cover anything the task
        itself spawns."""
        seen: list[str | None] = []

        async def _child() -> None:
            seen.append(current_tenant_id())

        with tenant_scope("creator"):
            with no_tenant():
                await asyncio.create_task(_child())

        assert seen == [None]

    def test_clear_tenant_id_returns_a_token_that_restores(self) -> None:
        with tenant_scope("tenant-a"):
            token = clear_tenant_id()
            assert current_tenant_id() is None
            unbind_tenant_id(token)
            assert current_tenant_id() == "tenant-a"


class TestFinalisationInAnotherContext:
    """A dropped coroutine is closed by the garbage collector, and the
    collector runs the frame's `finally` in whatever context it is in rather
    than the task's. A scope that reset its token there would either raise
    (`Token.reset` refuses to cross contexts) or, worse, write its tenant into
    a context that never asked for one."""

    @staticmethod
    def _drive_then_finalise_elsewhere(coro: Coroutine[Any, Any, None]) -> None:
        """Enter the scope inside its own context, then close from this one."""
        contextvars.copy_context().run(coro.send, None)
        coro.close()

    def test_no_tenant_survives_being_closed_from_another_context(self) -> None:
        async def body() -> None:
            with no_tenant():
                await _Suspend()

        with tenant_scope("caller"):
            self._drive_then_finalise_elsewhere(body())
            assert current_tenant_id() == "caller"

    def test_tenant_scope_survives_being_closed_from_another_context(self) -> None:
        async def body() -> None:
            with tenant_scope("the-task-s-tenant"):
                await _Suspend()

        self._drive_then_finalise_elsewhere(body())
        assert current_tenant_id() is None, (
            "finalising a dropped coroutine leaked its tenant into the "
            "collector's context"
        )

    @pytest.mark.xfail(
        strict=True,
        reason=(
            "tenant_scope alone does not cover this shape yet. "
            "gateway/auth.py and bridges/agent/auth.py bind a log context "
            "with the raw bind_log_context/unbind_log_context pair inside "
            "the tenant scope; unbind_log_context has the same unguarded "
            "Token.reset and raises first on finalisation, turning the "
            "GeneratorExit into a ValueError before tenant_scope's own "
            "guard ever sees one — so it resets its own token from the "
            "wrong context too, and the crash this ticket set out to close "
            "still reaches both call sites. Closing it needs "
            "logging_context.unbind_log_context to get the same guard "
            "tenant_context._held gives bind_tenant_id/unbind_tenant_id, "
            "tracked separately. Delete this test (or flip the assertion) "
            "once that lands."
        ),
    )
    def test_the_request_auth_shape_survives_too(self) -> None:
        """The shape `gateway/auth.py` and `bridges/agent/auth.py` bind: a
        tenant scope wrapping a log context, torn down together when the
        request that opened them is dropped rather than resumed."""

        async def body() -> None:
            with tenant_scope("the-request-s-tenant"):
                log_token = bind_log_context(tenant_id="the-request-s-tenant")
                try:
                    await _Suspend()
                finally:
                    unbind_log_context(log_token)

        self._drive_then_finalise_elsewhere(body())
        assert current_tenant_id() is None
