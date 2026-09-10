"""The two ways background code may open a session, named so the call site
says which one it means.

Everything in a request already gets a tenant for free: `gateway/auth.py` and
`bridges/agent/auth.py` bind one before the endpoint body runs, and the
`after_begin` hook (`db/tenant_session.py`) stamps it on every transaction
that session opens from then on, at any depth, with no call site to remember.

Nothing does that for the roughly 197 places that open a session from the
factory directly with no request behind them — the delivery loop, the
collaboration and server-connector lifecycle services, the startup seeding in
`main.py`, the periodic sweeps. Each needs to say, at the point it opens a
session, which of two things it is doing:

- **`tenant_session`** binds a tenant for the life of one session, the same
  way a request does. This is the answer for a unit of work that acts on one
  row: a message delivery, an inbound bridge event, one bridge's startup, one
  row out of a cross-tenant sweep. Derive the tenant from the row the work is
  actually for — the room, the bridge, the connector — at the point the work
  happens. Never once per long-lived object, and never once per task: see
  `tenant_context.no_tenant` for why.

- **`unscoped_session`** opens a session with **no tenant bound at all**, for
  the duration of the block, whatever the caller had bound going in. It is
  the fail-open hatch inside an otherwise fail-closed design, and it exists
  for two shapes of work:

  - reading every row before fanning out work per row — a sweep, a lifecycle
    enumeration, startup seeding that runs before any tenant exists;
  - a lookup whose whole job is to answer *which* tenant something is in, or
    that is keyed by something globally unique and spans tenants by nature:
    resolving a room from its transport id, or a client's rooms from its id.
    Inheriting a caller's tenant here is not a smaller answer, it is a wrong
    one.

  The unbinding is the point, and it is why this is not a synonym for calling
  the factory. A helper that merely *named* the intent while inheriting
  whatever was ambient would have the hook stamp the caller's tenant onto the
  transaction, and the cross-tenant read the call site asked for would
  silently be a single-tenant one. Its callers are pinned to an explicit
  allowlist by `tests/switch_core/db/test_unscoped_session_allowlist.py`,
  which fails on a new one and says what to do about it. Reach for
  `tenant_session` first.

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

from switch_core.tenant_context import bind_tenant_id, no_tenant, unbind_tenant_id


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

    Unbinds for the duration of the block and restores the caller's binding on
    the way out, so a query issued here reads across every tenant *whether or
    not* the caller had one bound. That is the whole contract: a call site
    that says "unscoped" and then quietly ran scoped, because it was reached
    from a request or from inside a `tenant_scope`, would be the worst
    available outcome — an allowlist certifying a cross-tenant read that never
    happened.
    """
    with no_tenant():
        async with session_factory() as session:
            yield session
