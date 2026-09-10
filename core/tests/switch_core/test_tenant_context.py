"""switch_core.tenant_context: the contextvar itself, independent of anything
that reads or writes it for a real request."""

from __future__ import annotations

from switch_core.tenant_context import (
    bind_tenant_id,
    current_tenant_id,
    tenant_scope,
    unbind_tenant_id,
)


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
