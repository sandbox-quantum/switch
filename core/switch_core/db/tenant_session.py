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
`AsyncSession` this codebase creates is built on — as a side effect of
importing this module, not of calling a factory. Importing is the weakest
precondition available: a process that builds its own `async_sessionmaker`
rather than calling `switch_core.db.engine.create_session_factory` still gets
the hook, because `db/engine.py` imports this module and an engine is the one
thing every session needs.

The boundary that gives, stated exactly: **no ORM session in this process can
skip setting the tenant.** Not "no statement can reach the database without
one" — two paths never become a `Session` at all, both deliberately:

- the delivery listener (`messages/notify.py`) reaches past SQLAlchemy to the
  raw asyncpg connection to issue `LISTEN`, so nothing it does passes through
  this hook. It reads no scoped table, which is what makes that acceptable
  rather than a gap.
- Alembic (`migrations/env.py`) runs a migration on a bare `Connection`, and
  is cross-tenant by definition.

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
from sqlalchemy.orm import ORMExecuteState, Session, SessionTransaction

from switch_core.tenant_context import current_tenant_id

_registered = False

# Where the hook records what it actually stamped on the current transaction,
# so the drift check below can compare it against what is bound now.
_STAMPED = "switch_stamped_tenant_id"


class TenantBindingDriftError(RuntimeError):
    """A tenant was bound after this session's transaction had already begun.

    The failure this exists to make loud: `set_config` rides `after_begin`, so
    it is issued once, when the transaction opens. Entering a `tenant_scope`
    *inside* an open transaction rebinds the contextvar and nothing else — the
    connection keeps whatever it was told at begin, which for a session opened
    with nothing bound is nothing at all. Every read and write on it then runs
    under the wrong tenant, or under none.

    That is invisible on a connection Postgres exempts from the policies,
    which is what every environment used before the runtime role, and it is a
    refused write on one it does not. Either way the call site looks correct
    and is not, which is the exact shape this whole design exists to prevent —
    so it raises rather than being left to a code review to notice.

    The fix is never to move the `tenant_scope` earlier by a line or two: it
    is to open the session inside the binding, which is what
    `db/session_scope.tenant_session` does and why it exists.
    """


def register_tenant_session_hook() -> None:
    """Attach the hooks, once per process.

    Called at the bottom of this module, so importing it is enough. Idempotent
    so that an explicit call — a test asserting the registration, say — cannot
    end up with them attached twice and the `set_config` issued twice per
    transaction.
    """
    global _registered
    if _registered:
        return
    event.listens_for(Session, "after_begin")(_set_tenant_on_begin)
    event.listens_for(Session, "after_transaction_end")(_forget_the_stamp)
    event.listens_for(Session, "do_orm_execute")(_refuse_a_binding_that_came_too_late)
    _registered = True


def _set_tenant_on_begin(
    session: Session, transaction: SessionTransaction, connection: Connection
) -> None:
    tenant_id = current_tenant_id()
    # Recorded even when it is None, because "this transaction was stamped
    # with nothing" is exactly what the drift check needs to be able to tell
    # apart from "no transaction has begun yet".
    session.info[_STAMPED] = tenant_id
    if tenant_id is None:
        return
    connection.execute(
        text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
        {"tenant_id": tenant_id},
    )


def _forget_the_stamp(session: Session, transaction: SessionTransaction) -> None:
    """Drop the record when the outermost transaction ends.

    A session outlives its transactions — commit and the next statement opens
    another — and the next one gets its own `after_begin` and so its own
    stamp. Leaving the old one behind would make the first statement after a
    commit compare against a transaction that no longer exists. Only the
    outermost, because a savepoint ending does not end the transaction the
    `set_config` was issued on.
    """
    if transaction.parent is None:
        session.info.pop(_STAMPED, None)


def _refuse_a_binding_that_came_too_late(state: ORMExecuteState) -> None:
    """Raise if what is bound now is not what this transaction was stamped with.

    Fires before every `Session.execute`, which is every statement this
    codebase issues through a session. For the first statement of a
    transaction there is no stamp yet — `after_begin` has not run, since the
    transaction begins as part of executing it — so there is nothing to
    compare and nothing to refuse. From the second onwards the two must agree.
    """
    session = state.session
    if _STAMPED not in session.info:
        return
    stamped = session.info[_STAMPED]
    bound = current_tenant_id()
    if bound == stamped:
        return
    raise TenantBindingDriftError(
        f"this session's transaction was opened with tenant {stamped!r} and "
        f"the tenant bound now is {bound!r}. The `set_config` that makes the "
        "database agree is issued once, when the transaction begins, so "
        "rebinding after that changes nothing the database can see: every "
        "statement from here on runs under the tenant in the first half of "
        "this message. Open the session inside the binding instead — "
        "`db/session_scope.tenant_session(factory, tenant_id)` does exactly "
        "that — or commit this transaction before rebinding."
    )


register_tenant_session_hook()
