"""Count the pooled connections a request holds, at the pool itself.

A request that holds one connection while it waits for a second from the same
pool can starve it: under load every connection ends up held by a request
waiting for one more, and they all time out together. The ways a request ends
up doing that are many (a service that opens its own session, a lookup helper,
a dependency that reads and never commits), so counting sessions at any one of
them misses the rest. This counts where they all meet, the pool's `checkout`
and `checkin` events, and attributes each connection to the request that
borrowed it.

A request is a `CheckoutScope`, entered with `PoolCheckouts.scope()` or, for an
app under test, `PoolCheckouts.wrap(app)`. The scope lives in a context
variable, which SQLAlchemy carries into the greenlet a checkout runs in, and
which tasks the request starts inherit, so their connections count as the
request's too. A checkin is matched back to its checkout by connection record
rather than by context, because a connection can be returned from somewhere
else, a session closed by the dependency's teardown for one.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine


@dataclass
class CheckoutScope:
    """One request's connections: how many it holds now, and the most at once."""

    label: str
    held: int = 0
    peak: int = 0


_current: ContextVar[CheckoutScope | None] = ContextVar(
    "pool_checkout_scope", default=None
)


class PoolCheckouts:
    def __init__(self, engine: AsyncEngine) -> None:
        self._pool = engine.sync_engine.pool
        self._owners: dict[int, CheckoutScope] = {}
        self.scopes: list[CheckoutScope] = []
        event.listen(self._pool, "checkout", self._on_checkout)
        event.listen(self._pool, "checkin", self._on_checkin)

    def close(self) -> None:
        event.remove(self._pool, "checkout", self._on_checkout)
        event.remove(self._pool, "checkin", self._on_checkin)

    def _on_checkout(self, _dbapi: Any, record: Any, _proxy: Any) -> None:
        scope = _current.get()
        if scope is None:
            return
        scope.held += 1
        scope.peak = max(scope.peak, scope.held)
        self._owners[id(record)] = scope

    def _on_checkin(self, _dbapi: Any, record: Any) -> None:
        scope = self._owners.pop(id(record), None)
        if scope is not None:
            scope.held -= 1

    @contextmanager
    def scope(self, label: str) -> Iterator[CheckoutScope]:
        scope = CheckoutScope(label)
        self.scopes.append(scope)
        token = _current.set(scope)
        try:
            yield scope
        finally:
            _current.reset(token)

    def held_now(self) -> int:
        """Connections the current scope holds at this moment; 0 outside one.

        For a fake standing in for a platform, Matrix or bcrypt to record when
        it is called: the answer there should always be 0.
        """
        scope = _current.get()
        return 0 if scope is None else scope.held

    def wrap(self, app: Any) -> Any:
        """`app`, with every HTTP request in a scope of its own."""

        async def asgi(scope: dict[str, Any], receive: Any, send: Any) -> None:
            if scope["type"] != "http":
                await app(scope, receive, send)
                return
            with self.scope(f"{scope['method']} {scope['path']}"):
                await app(scope, receive, send)

        return asgi

    def over(self, limit: int = 1) -> list[CheckoutScope]:
        """Every scope that held more than `limit` connections at once."""
        return [s for s in self.scopes if s.peak > limit]
