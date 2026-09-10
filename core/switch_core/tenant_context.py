"""The current request's tenant, held in a context variable.

Shaped like :mod:`switch_core.logging_context`: a module-level `ContextVar`,
a bind that returns a token, and an unbind that resets it — the house pattern
for anything that needs to travel with a request/task without being threaded
through every function signature along the way.

This module only holds the value and the plumbing to bind/read/unbind it. It
does not decide *how* a tenant is resolved (that is `gateway/auth.py` for the
JWT cookie and `bridges/agent/auth.py` for the bearer token) and it does not
decide what happens when nothing is bound — callers do, deliberately:

- `db/tenant_session.py`'s `after_begin` hook treats "nothing bound" as
  "do nothing" — a system session (auth resolution, startup seeding, Alembic)
  has no tenant and must not be given one it invented.
- `db/models.py`'s `require_tenant_id` treats "nothing bound" as an error and
  raises, because a scoped row has to land in *some* tenant and guessing
  which is how a write ends up in a real customer's data. It answered tenant
  zero until row-level security landed; that made the guess unsafe rather
  than merely approximate, since `with check` cannot tell a guess apart from
  a write tenant zero actually intended.

Neither of those answers lives here. A `current_tenant_id()` that quietly
substituted a default would make an unbound context indistinguishable from a
bound one, which is exactly the ambiguity the fail-closed design (see
`docs/old/multi-tenancy-phase1-db.md`) depends on not existing.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token

_current_tenant_id: ContextVar[str | None] = ContextVar(
    "switch_tenant_id", default=None
)


def current_tenant_id() -> str | None:
    """The tenant bound to the current context, or `None` if none is."""
    return _current_tenant_id.get()


def bind_tenant_id(tenant_id: str) -> Token[str | None]:
    """Bind `tenant_id` for the current context, returning a token to unbind with."""
    return _current_tenant_id.set(tenant_id)


def unbind_tenant_id(token: Token[str | None]) -> None:
    _current_tenant_id.reset(token)


def clear_tenant_id() -> Token[str | None]:
    """Unbind whatever tenant is bound, returning a token to restore it with.

    Distinct from never having bound one only in that it can be undone. What
    the reader sees is the same: `current_tenant_id()` is `None` and the
    `after_begin` hook issues no `set_config`.
    """
    return _current_tenant_id.set(None)


@contextmanager
def tenant_scope(tenant_id: str) -> Iterator[None]:
    """Bind `tenant_id` for the duration of the block."""
    token = bind_tenant_id(tenant_id)
    try:
        yield
    finally:
        unbind_tenant_id(token)


@contextmanager
def no_tenant() -> Iterator[None]:
    """Unbind for the duration of the block, whatever was bound going in.

    Two uses, and they are the same idea from both ends:

    - a lookup that must span tenants (which tenant is this room in? which
      rooms is this client a member of?) must not inherit a caller's tenant,
      or it silently narrows to it;
    - a long-lived background task must not inherit the context of whatever
      created it. An `asyncio.Task` snapshots the contextvars of its creator,
      so a bridge restarted from an HTTP request would otherwise run its whole
      life under the requesting user's tenant. Entering this at the top of the
      task body makes the task ambient-free, so every unit of work inside it
      has to bind the tenant of the row it is acting on — and one that forgets
      reads nothing rather than reading the wrong tenant.
    """
    token = clear_tenant_id()
    try:
        yield
    finally:
        unbind_tenant_id(token)
