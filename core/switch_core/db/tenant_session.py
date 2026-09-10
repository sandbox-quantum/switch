"""Stamps the bound tenant onto every session's transaction, on begin.

This is an SQLAlchemy `after_begin` event hook rather than a call each call
site makes for itself, because a call site is something a future call site
can forget — and the failure mode of forgetting is not "no tenant", it is
"the previous request's tenant". Connections are pooled: a session that never
issues `set_config` simply keeps whatever the connection it borrowed was left
holding, because nothing ever resets it. Two of the four prior-art bugs this
design exists to prevent were exactly that — a session-scoped setting on a
pooled connection outliving the request that set it and leaking into the
next one to borrow that connection. An event hook fires on every session this
process opens, unconditionally, so there is no call site to remember and
nothing to leak: `is_local=true` scopes the setting to the transaction, and it
is released the moment that transaction ends, whether by commit or rollback.

Registered once, globally, on `sqlalchemy.orm.Session` — the class every
`AsyncSession` this codebase creates is built on — via
`register_tenant_session_hook()`, called from
`switch_core.db.engine.create_session_factory`. That is the one place an
`async_sessionmaker` is built, so calling it there is the single seam that
makes it "impossible to open a session that skips setting the tenant" rather
than a convention to remember at each one.

When no tenant is bound (see `switch_core.tenant_context`), the hook does
nothing rather than substituting one — a system session (auth resolution,
Alembic, startup seeding) has no tenant, and the database does not yet reject
that (that lands with `require_tenant_id()` and the row-level-security
policies, in a later change). Until then, a query issued with no tenant set
simply runs unscoped, same as before this hook existed.
"""

from __future__ import annotations

from sqlalchemy import event, text
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session, SessionTransaction

from switch_core.tenant_context import current_tenant_id

_registered = False


def register_tenant_session_hook() -> None:
    """Attach the `after_begin` hook, once per process.

    Idempotent so callers don't have to track whether some earlier
    `create_session_factory` call already registered it.
    """
    global _registered
    if _registered:
        return
    event.listens_for(Session, "after_begin")(_set_tenant_on_begin)
    _registered = True


def _set_tenant_on_begin(
    session: Session, transaction: SessionTransaction, connection: Connection
) -> None:
    tenant_id = current_tenant_id()
    if tenant_id is None:
        return
    connection.execute(
        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
        {"tenant_id": tenant_id},
    )
