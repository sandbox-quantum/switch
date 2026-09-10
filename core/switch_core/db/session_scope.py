"""How background code opens a session: bound to a tenant, and nothing else.

Everything in a request already gets a tenant for free: `gateway/auth.py` and
`bridges/agent/auth.py` bind one before the endpoint body runs, and the
`after_begin` hook (`db/tenant_session.py`) stamps it on every transaction
that session opens from then on, at any depth, with no call site to remember.

`tenant_session` is that, for the 157 places that open a session from the
factory with no request behind them — the delivery loop, the collaboration and
server-connector lifecycle services, the startup seeding in `main.py`, the
periodic sweeps. It binds a tenant for the life of one session, and the tenant
is derived from the row the work is acting on: a message delivery binds the
room's, an inbound bridge event binds the room's or the bridge's, one row out
of a sweep binds its own. Never once per long-lived object, and never once per
task — see `tenant_context.no_tenant` for the four ways that went wrong.

**There was a second helper here, `unscoped_session`, and it is gone.** It
opened a session with no tenant bound, for work that was legitimately
cross-tenant: a boot enumeration, a sweep, a lookup whose job was to answer
*which* tenant something was in. It read across every tenant, exactly as
documented — but only because every environment connected to Postgres as the
tables' owner, which Postgres exempts from their policies. Under the
restricted runtime role an unscoped session is not a hatch at all: unscoped is
precisely the state `require_tenant_id()` raises on, so every one of its
seventeen call sites — the ones that went through this helper by name, which
is not the same count as the exemption's full inventory; see
`db/tenant_lookup.py` for the other two — either died at boot or silently
read nothing. The whole model was inverted, and `db/tenant_lookup.py` is what
replaced it: eight `SECURITY DEFINER` functions that answer *which tenant*
and never return a row, so a cross-tenant question is asked in one place with
a fixed shape, and the work it fans out into is scoped like everything else.

What is left is the one helper. Two things still open a session with nothing
bound, and neither is cross-tenant:

- `db/tenant_lookup.py` itself, which touches only its own exempt functions;
- the reads of `users` and `oidc_identities` in `gateway/auth.py` and
  `main.py`. Those tables carry no tenant and no policy — a person is not a
  tenant member — so an unbound session is the honest way to read them and
  there is nothing for a tenant to narrow.

`tests/switch_core/db/test_tenant_exemption_allowlist.py` pins both surfaces:
who may reach the exemption, and which modules may open a session straight
from the factory at all.

The binding is a contextvar (`tenant_context.py`), and the `after_begin` hook
is what turns it into `set_config` on the transaction. Opening a session does
no I/O by itself — the hook only fires once a transaction begins, on that
session's first query.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.tenant_context import tenant_scope


@asynccontextmanager
async def tenant_session(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str
) -> AsyncIterator[AsyncSession]:
    """Open a session bound to `tenant_id` for the life of the `async with` block.

    Binds before the session is constructed and unbinds on the way out, so a
    long-lived caller (a bridge's own task, say) cannot leak this tenant into
    whatever it does next even if the block raises.

    Before the session is constructed matters more than it reads. The
    `set_config` rides `after_begin`, so a `tenant_scope` entered *inside* an
    already-open transaction changes nothing about that transaction — the
    startup bootstrap seeding did exactly that and wrote a `tenant_members`
    row on a connection that had never been told which tenant it was for.
    """
    with tenant_scope(tenant_id):
        async with session_factory() as session:
            yield session
