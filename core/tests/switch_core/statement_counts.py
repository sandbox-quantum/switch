"""Count the SQL statements a request runs, at the engine itself.

A route that reads one row per room, per agent or per owner holds its
connection for a round trip per row, so the time it holds the connection grows
with the data and, under load, with every wait between those round trips. The
guard against that is a count that does not grow: the same route over one row
and over many runs the same number of statements.

Counted at the engine's `before_cursor_execute` event, which every statement
reaches whichever store or helper issued it. A request is a `StatementScope`,
entered with `StatementCounts.scope()` or, for an app under test,
`StatementCounts.wrap(app)`; the scope lives in a context variable, which
SQLAlchemy carries into the greenlet a statement runs in, the same way
`pool_checkouts.py` attributes connections.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine


@dataclass
class StatementScope:
    """One request's statements, in the order they ran."""

    label: str
    statements: list[str] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.statements)


_current: ContextVar[StatementScope | None] = ContextVar(
    "statement_count_scope", default=None
)


class StatementCounts:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine.sync_engine
        self.scopes: list[StatementScope] = []
        event.listen(self._engine, "before_cursor_execute", self._on_execute)

    def close(self) -> None:
        event.remove(self._engine, "before_cursor_execute", self._on_execute)

    def _on_execute(
        self,
        _conn: Any,
        _cursor: Any,
        statement: str,
        _parameters: Any,
        _context: Any,
        _executemany: bool,
    ) -> None:
        scope = _current.get()
        if scope is not None:
            scope.statements.append(statement)

    @contextmanager
    def scope(self, label: str) -> Iterator[StatementScope]:
        scope = StatementScope(label)
        self.scopes.append(scope)
        token = _current.set(scope)
        try:
            yield scope
        finally:
            _current.reset(token)

    def wrap(self, app: Any) -> Any:
        """`app`, with every HTTP request in a scope of its own."""

        async def asgi(scope: dict[str, Any], receive: Any, send: Any) -> None:
            if scope["type"] != "http":
                await app(scope, receive, send)
                return
            with self.scope(f"{scope['method']} {scope['path']}"):
                await app(scope, receive, send)

        return asgi

    def last(self, label: str) -> StatementScope:
        """The most recent request counted under `label`."""
        for scope in reversed(self.scopes):
            if scope.label == label:
                return scope
        raise AssertionError(f"no request {label!r} was counted")
