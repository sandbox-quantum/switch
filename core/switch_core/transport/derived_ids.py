"""Ids for rows a client writes on behalf of something that may arrive twice.

A consumer may handle a row twice: an owner that stopped between acting on a
row and recording its progress leaves the row to the next owner. A messaging
platform may deliver one post twice, as Slack sends an event again when its
acknowledgement did not arrive. Every row the client writes meanwhile is given
an id derived from what it is acting on and how many it has written so far,
and `messages.transport_event_id` is unique, so a second run finds the first
one's writes and writes nothing new.

Held in a context variable, so a task started inside the block carries it too
and its writes count as the source's. Only the named client's writes are
derived: another client writing inside the block writes as usual.
"""

from __future__ import annotations

import contextlib
import hashlib
from collections.abc import Iterator
from contextvars import ContextVar
from dataclasses import dataclass, field


def derived_event_id(client_id: str, source_id: str, ordinal: int) -> str:
    """The id of the `ordinal`-th row a client writes on behalf of
    `source_id`: the same every time. Shaped like a fresh event id (`sw_` and
    32 hex digits), so nothing can tell the two apart."""
    digest = hashlib.sha256(
        f"{client_id}\x1f{source_id}\x1f{ordinal}".encode()
    ).hexdigest()
    return f"sw_{digest[:32]}"


@dataclass
class DerivedWrites:
    """What one client is writing on behalf of, while it does."""

    client_id: str
    source_id: str
    written: int = field(default=0)

    def next_event_id(self) -> str:
        event_id = derived_event_id(self.client_id, self.source_id, self.written)
        self.written += 1
        return event_id


_DERIVED: ContextVar[DerivedWrites | None] = ContextVar("derived_writes", default=None)


@contextlib.contextmanager
def writes_derived_from(client_id: str, source_id: str) -> Iterator[None]:
    """Give the rows `client_id` writes inside the block ids derived from
    `source_id`: the row its consumer is handling, or a post a messaging
    platform may deliver again."""
    token = _DERIVED.set(DerivedWrites(client_id=client_id, source_id=source_id))
    try:
        yield
    finally:
        _DERIVED.reset(token)


def derived_writes(client_id: str) -> DerivedWrites | None:
    """What `client_id` is writing on behalf of right now, or None when its
    writes get fresh ids."""
    current = _DERIVED.get()
    if current is None or current.client_id != client_id:
        return None
    return current
