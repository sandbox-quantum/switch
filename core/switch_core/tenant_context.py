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
- `db/models.py`'s `TenantScoped` default treats "nothing bound" as tenant
  zero, because the background call sites that still write through it have
  not been converted to bind one yet.

Neither of those fallbacks lives here. A `current_tenant_id()` that quietly
substituted a default would make both of those call sites indistinguishable
from a real bind, which is exactly the ambiguity the fail-closed design (see
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


@contextmanager
def tenant_scope(tenant_id: str) -> Iterator[None]:
    """Bind `tenant_id` for the duration of the block."""
    token = bind_tenant_id(tenant_id)
    try:
        yield
    finally:
        unbind_tenant_id(token)
