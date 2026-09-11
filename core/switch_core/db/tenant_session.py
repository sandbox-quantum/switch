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
Alembic, startup seeding) has no tenant, and there is none to stamp. What
happens next to a query issued on it is no longer this module's to decide:
`require_tenant_id()` and the row-level-security policy on every scoped table
(`db/rls_ddl.py`) now raise the moment such a session touches one, so a
session with nothing bound may only read what carries no policy at all —
`users`, `oidc_identities`, and the tenant lookups' own exempt functions in
`db/tenant_lookup.py`. This hook's job is unchanged either way: it stamps
whatever is bound, including nothing. Whether nothing bound then reads
quietly or is refused loudly is the policies' call, not this hook's, and it
used to be the former.

**One read never reaches the database, and so reaches neither the policy nor
the drift check.** `Session.get` matches a primary key against the objects the
session has already loaded, and on a hit returns one with no statement, no
flush and no transaction. Every other guarantee here is downstream of a round
trip: the policy is the server's, and `do_orm_execute`/`before_flush` fire on
statements and units of work. An identity-map hit is none of those, so a
session reused across two tenants can be handed the first tenant's row back
while the second is bound. `TenantCheckedSession` below closes it, on the row
rather than on the transaction — the object in hand carries its own
`tenant_id`, which is a more direct answer than any stamp — and
`db/engine.create_session_factory` is what puts it under every session in the
process. It fires only when the `get` issued no statement at all; one that
went to the database was filtered on the way, and second-guessing it would
apply the policy's semantics to the owner connection, which nothing else here
does.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import event, text
from sqlalchemy.engine import Connection
from sqlalchemy.orm import ORMExecuteState, Session, SessionTransaction

from switch_core.tenant_context import current_tenant_id

_registered = False

# Where the hook records what it actually stamped on the current transaction,
# so the drift check below can compare it against what is bound now.
_STAMPED = "switch_stamped_tenant_id"

# Set on the session whenever a statement goes out through the ORM, and read
# by `TenantCheckedSession.get` to tell "this answer came from the database"
# from "this answer came out of the identity map". Only the second needs the
# row check: a read that reached Postgres was filtered by the policy on the
# way, or would have been on a connection the policy applies to.
_ISSUED_A_STATEMENT = "switch_issued_a_statement"


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
    event.listens_for(Session, "do_orm_execute")(_note_that_a_statement_was_issued)
    # `do_orm_execute` does not cover a flush: the INSERTs and UPDATEs the unit
    # of work emits go to the connection directly rather than through
    # `Session.execute`, so a late binding followed only by `session.add(...)`
    # and `commit()` would slip past the check above. That is the shape a
    # *write* under a drifted binding actually takes, which makes it the case
    # that matters most: the column default reads the late tenant while the
    # transaction still carries the early one, so the row claims one tenant
    # and the policy compares another.
    event.listens_for(Session, "before_flush")(_refuse_a_flush_that_drifted)
    _registered = True


def _set_tenant_on_begin(
    session: Session, transaction: SessionTransaction, connection: Connection
) -> None:
    if transaction.nested:
        # A savepoint, not a transaction. `after_begin` fires for one, but the
        # setting it would issue belongs to the enclosing transaction: an
        # `is_local` `set_config` inside a savepoint survives `RELEASE` and
        # reverts on `ROLLBACK TO`, so re-stamping here would leave the record
        # holding the savepoint's tenant while the connection had gone back to
        # the outer one. Measured on 16, not assumed. The enclosing
        # transaction already carries the right value; a savepoint has nothing
        # to add and no business overwriting it.
        return
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
    codebase issues through a session other than a flush. For the first
    statement of a transaction there is no stamp yet — `after_begin` has not
    run, since the transaction begins as part of executing it — so there is
    nothing to compare and nothing to refuse. From the second onwards the two
    must agree.
    """
    _refuse_drift(state.session)


def _note_that_a_statement_was_issued(state: ORMExecuteState) -> None:
    """Record that this session went to the database, for `get` to read back."""
    state.session.info[_ISSUED_A_STATEMENT] = True


def _refuse_a_flush_that_drifted(
    session: Session, flush_context: object, instances: object
) -> None:
    """The same check, on the path `do_orm_execute` does not see."""
    _refuse_drift(session)


def _refuse_drift(session: Session) -> None:
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


class CrossTenantIdentityMapError(RuntimeError):
    """`Session.get` answered with a row belonging to a different tenant.

    Not the same failure as `TenantBindingDriftError`, and not caught by it.
    Every check above is reached by *going to the database* — `do_orm_execute`
    fires on a statement, `before_flush` on a unit of work — and both of those
    are also where the policy would refuse a cross-tenant read even if the
    check did not. `Session.get` answered from the identity map does neither.
    It matches the primary key against objects the session has already loaded
    and returns one, with no statement, no flush, no transaction and so no
    policy: the two mechanisms that make this design work are both downstream
    of a round trip that never happens.

    So this is the one read in the process that a rebinding can quietly walk
    past, and it gets a check of its own — on the row rather than on the
    transaction, since the object in hand carries the answer directly.
    """


def _tenant_of(instance: object) -> str | None:
    """The tenant `instance` belongs to, or None if its table carries none.

    The same two cases `db/rls_ddl._tenant_column` derives the policy from, and
    deliberately so: a check that disagreed with the policy about which column
    identifies the tenant would refuse rows the database allows, or allow rows
    it refuses. `tenants` is compared on `id`, because a tenant *is* the
    boundary rather than belonging to one; everything else on `tenant_id`.
    """
    if getattr(type(instance), "__tablename__", None) == "tenants":
        identifier = getattr(instance, "id", None)
        return None if identifier is None else str(identifier)
    tenant_id = getattr(instance, "tenant_id", None)
    return None if tenant_id is None else str(tenant_id)


def _refuse_a_row_from_another_tenant(instance: object) -> None:
    """Raise when `instance` belongs to a tenant other than the bound one.

    Compares the row against what is bound now rather than against what the
    transaction was stamped with, because the failure being caught here does
    not need a transaction to exist: a session that has committed still holds
    its objects (`expire_on_commit=False`), so a `get` after the commit finds
    them with no stamp to compare against at all.

    Deliberately silent when nothing is bound. A read with no tenant bound is
    a read the policies refuse, so an identity-map hit in that state is
    equally suspect — but there is no tenant to say the row is *not* in, and
    the honest boundary here is a comparison rather than a guess. What is left
    uncovered is written down in `docs/old/multi-tenancy-phase1-db.md` rather
    than half-checked.
    """
    tenant_id = _tenant_of(instance)
    if tenant_id is None:
        # A global table (`users`, `oidc_identities`, `feature_flags`) carries
        # no tenant, so there is nothing to compare and nothing to refuse.
        return
    bound = current_tenant_id()
    if bound is None or bound == tenant_id:
        return
    raise CrossTenantIdentityMapError(
        f"Session.get answered with a {type(instance).__name__} in tenant "
        f"{tenant_id!r} while tenant {bound!r} is bound. The row was already "
        "in this session's identity map, so it came back without a statement "
        "and without the row-level-security policy that would have refused "
        "it. The session is being reused across two tenants, which is what "
        "`db/session_scope.tenant_session(factory, tenant_id)` exists to "
        "prevent: open a session inside the binding and let it end with it, "
        "rather than rebinding around a session that outlives the tenant it "
        "was opened for."
    )


class TenantCheckedSession(Session):
    """`Session`, with the tenant checks extended to the one path they missed.

    Used through `db/engine.create_session_factory`'s `sync_session_class`, so
    every session this process opens is one of these — including the async
    ones, since `AsyncSession.get` delegates to the sync session underneath.

    Subclassing rather than adding another event listener, because there is no
    event to listen to: SQLAlchemy fires `do_orm_execute` when `get` has to
    issue a statement and not when it answers from the identity map, which is
    exactly the case that needs checking.

    **The row check runs only when `get` issued no statement**, and that
    restriction is the whole of its correctness. A `get` that reached the
    database was filtered by the policy on the way — or would have been, on a
    connection the policy applies to — so the row it returns is the bound
    tenant's by construction and there is nothing to check. Applying the check
    to those as well would impose the policy's semantics on the *owner*
    connection, which this design deliberately does not do anywhere else: the
    unit suite and every fan-out rely on an owner connection reading across
    tenants (see the "filters what it reads back" note in
    `db/tenant_lookup.py`), and a test arranging a second tenant's fixture rows
    would start failing for a reason that has nothing to do with a leak.

    Worth knowing about the hole this closes: SQLAlchemy's identity map holds
    **weak** references, so an object is only reachable through it while
    something else still holds a strong one. That makes the exposure narrower
    than it first looks and, more importantly, makes it *intermittent* —
    whether the leak happens depends on whether a local variable happens to
    still be in scope. Intermittent is worse than reliable for something nobody
    would think to test, which is the argument for checking rather than
    reasoning about how reachable it is.
    """

    def get(self, *args: Any, **kwargs: Any) -> Any:
        _refuse_drift(self)
        self.info[_ISSUED_A_STATEMENT] = False
        instance = super().get(*args, **kwargs)
        if instance is not None and not self.info[_ISSUED_A_STATEMENT]:
            _refuse_a_row_from_another_tenant(instance)
        return instance

    def get_one(self, *args: Any, **kwargs: Any) -> Any:
        _refuse_drift(self)
        self.info[_ISSUED_A_STATEMENT] = False
        instance = super().get_one(*args, **kwargs)
        if not self.info[_ISSUED_A_STATEMENT]:
            _refuse_a_row_from_another_tenant(instance)
        return instance


register_tenant_session_hook()
