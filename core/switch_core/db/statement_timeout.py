"""The longest one statement may run, for the work that sets a limit.

A context variable rather than a setting on a session, so that every session
opened under it is limited: the request's own, and the ones a service opens
for that request. `db/tenant_session.py` stamps it on each transaction as the
transaction begins, in the same round trip as the tenant, with `is_local` so it
ends with the transaction and never stays behind on a pooled connection.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

_limit: ContextVar[str | None] = ContextVar("statement_timeout", default=None)

# Postgres's code for a statement it cancelled (`query_canceled`). A statement
# timeout is one of its causes; a cancel request from a client is another.
_QUERY_CANCELED = "57014"


def current_statement_timeout() -> str | None:
    """The limit bound here, as a Postgres interval, or None for none."""
    return _limit.get()


@contextmanager
def statement_timeout(limit: str | None) -> Iterator[None]:
    """Bind `limit` (a Postgres interval such as "10s") for the sessions opened
    inside the block; None binds none."""
    token = _limit.set(limit)
    try:
        yield
    finally:
        _limit.reset(token)


def timed_out(exc: BaseException) -> bool:
    """Whether `exc` is, or was caused by, Postgres cancelling a statement
    that ran past its statement timeout."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if getattr(current, "sqlstate", None) == _QUERY_CANCELED and (
            "statement timeout" in str(current)
        ):
            return True
        current = current.__cause__ or getattr(current, "orig", None)
    return False
