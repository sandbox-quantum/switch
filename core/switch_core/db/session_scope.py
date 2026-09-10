"""The two ways background code may open a session, named so the call site
says which one it means.

Everything in a request already gets a tenant for free: `gateway/auth.py` and
`bridges/agent/auth.py` bind one before the endpoint body runs, and the
`after_begin` hook (`db/tenant_session.py`) stamps it on every transaction
that session opens from then on, at any depth, with no call site to remember.

Nothing does that for the roughly 206 places that open a session from the
factory directly with no request behind them — the delivery loop, the
collaboration and server-connector lifecycle services, the startup seeding in
`main.py`, the periodic sweeps. Each needs to say, at the point it opens a
session, which of two things it is doing:

- **`tenant_session`** binds a tenant for the life of one session, the same
  way a request does. This is the answer for a unit of work that acts for one
  room, one bridge, or one connector — a message delivery, an inbound bridge
  event, a bridge's own startup, one row out of a cross-tenant sweep. Bind at
  the natural unit of work: derive the tenant from whatever the work is
  actually for (the room, the bridge, the connector row), not once per
  long-lived object and reused, since a client or a bridge is not guaranteed
  to act for only one tenant over its life.

- **`unscoped_session`** opens a session with no tenant bound at all — the
  fail-open hatch inside an otherwise fail-closed design. It exists for work
  that is legitimately cross-tenant: reading every row before fanning out
  work per row (a sweep, a lifecycle enumeration), and startup seeding that
  runs before any tenant can be said to exist. Nothing today stops a query on
  a session it opens from reading across every tenant there is — that is
  exactly what "unscoped" means — so its callers are pinned to an explicit
  allowlist by
  `tests/switch_core/db/test_unscoped_session_allowlist.py`, which fails on a
  new one and says what to do about it. Reach for `tenant_session` first;
  reach for this only when the work really cannot be attributed to one
  tenant.

Both are thin: the tenant binding is a contextvar (`tenant_context.py`), and
the `after_begin` hook is what actually turns it into `set_config` on the
transaction. Opening a session through either helper does no I/O by itself,
same as calling the factory directly — the hook only fires once a transaction
begins, on that session's first query.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.tenant_context import bind_tenant_id, unbind_tenant_id


@asynccontextmanager
async def tenant_session(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> AsyncIterator[AsyncSession]:
    """Open a session bound to `tenant_id` for the life of the `async with` block.

    Binds before the session is constructed and unbinds in a `finally`, so a
    long-lived caller (a bridge's own task, say) cannot leak this tenant into
    whatever it does next even if the block raises.
    """
    token = bind_tenant_id(tenant_id)
    try:
        async with session_factory() as session:
            yield session
    finally:
        unbind_tenant_id(token)


@asynccontextmanager
async def unscoped_session(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    """Open a session with no tenant bound — the fail-open hatch.

    Behaves exactly like calling `session_factory()` directly today, because
    that is what it is: no binding, no unbinding, nothing hidden. The point of
    naming it is not to change what it does but to make every place that does
    it say so, so the allowlist in
    `tests/switch_core/db/test_unscoped_session_allowlist.py` has something to
    pin.
    """
    async with session_factory() as session:
        yield session
