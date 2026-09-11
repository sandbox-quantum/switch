"""Regression coverage for CHOO-2698: `conftest.session_factory` binds
tenant zero and restores it in a `finally`, and pytest-asyncio can finalise a
fixture's async generator by having the garbage collector close a suspended,
dropped one rather than resuming it. That `finally` then runs in whatever
context the collector happens to be in, not the one the token was created in.

`Token.reset` refuses to cross contexts, so a raw `bind_tenant_id` /
`unbind_tenant_id` pair here raises `ValueError` instead of tearing down —
exactly the shape that made this the fourth instance of the pattern. The
fixture is pinned to `tenant_context.tenant_scope` instead, whose own guard
(`_held`) is covered by
`test_tenant_context.TestFinalisationInAnotherContext`; this test is not
about that mechanism, it is about the fixture actually using it, which
nothing else would notice if undone.
"""

from __future__ import annotations

import asyncio
import contextvars
from collections.abc import AsyncGenerator
from typing import Any

from tests.conftest import session_factory as _session_factory_fixture

# The bare async generator function pytest_asyncio.fixture wraps, so it can
# be driven directly instead of through pytest's fixture machinery. Fetched
# via getattr rather than `.__wrapped__` directly since the fixture wrapper's
# declared type doesn't carry that attribute.
_session_factory: Any = getattr(_session_factory_fixture, "__wrapped__")


class _NoMarkerRequest:
    """Stands in for `pytest.FixtureRequest` with no markers on the node --
    enough for the fixture's `no_ambient_tenant` check to take the ambient
    tenant-scope branch."""

    class _Node:
        def get_closest_marker(self, name: str) -> None:
            return None

    node = _Node()


async def test_survives_being_finalised_from_another_context(
    postgres_url: str,
) -> None:
    agen: AsyncGenerator[Any, None] = _session_factory(postgres_url, _NoMarkerRequest())
    loop = asyncio.get_running_loop()
    # Advance to the fixture's `yield` inside its own, isolated context -- the
    # same isolation a pytest-asyncio task gives it going in.
    drive_ctx = contextvars.copy_context()
    await loop.create_task(agen.asend(None), context=drive_ctx)
    try:
        # Finalise it the way the collector does to a dropped, suspended
        # async generator: close it from whatever context is current here,
        # which is deliberately not `drive_ctx`.
        await agen.aclose()
    except ValueError as exc:
        raise AssertionError(
            "session_factory's tenant bind was restored in a context other "
            "than the one that created it -- it must route through "
            "tenant_scope rather than a raw bind_tenant_id/unbind_tenant_id "
            "pair"
        ) from exc
