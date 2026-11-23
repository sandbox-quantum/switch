"""What a process's chat streams share, so a busy room does not cost each of
its members' streams a pass of their own at the same instant.

A message in a room wakes the stream of every member who has Switch Console
open (`chat_events` in `gateway/chats.py`), all at once. Each stream then
re-reads what its person may see and reads the room's new rows, and renders
them: about a dozen statements, each in a session of its own. With a few
hundred members that is a few thousand statements for one message, and as many
sessions asking the pool for a connection in the same moment, ahead of
whatever else the process has to do.

Two things here keep that bounded:

- At most `slots` stream passes hold a connection at once in this process. A
  pass over that waits holding nothing, as the agent streams' passes do
  (`EventBuffer.one_session`), so a herd of passes queues behind each other
  instead of taking the pool from requests and from the process's own work.

- The page of a room's rows after a given position, rendered as the Console
  shows them, is read once and handed to every stream that asks for the same
  page soon after. What a person may see is still read by each stream for its
  own person; only the rows, which read the same for every member, are shared.

A page is handed only to a stream that was woken before the page's read
began. A stream is woken once the row that woke it has committed, and every
statement of a read sees what committed before it started, so such a page
holds that row. A stream woken by a row the page may have missed reads the
room itself, and its read is the one shared from then on.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, nullcontext
from dataclasses import dataclass

# How long a page read is handed out after it started. The streams a message
# wakes ask for its page within moments of each other, and the slots stretch
# that to however long the herd waits in line; past this the page is read
# again, which costs only the time saved.
PAGE_KEEP_SECONDS = 2.0
# The most pages kept at once. A page is up to a catch-up page of rendered
# messages; this bounds the memory to a few MB at worst.
MAX_PAGES = 256


def chat_stream_slots_for(pool_size: int, max_overflow: int) -> int:
    """How many chat stream passes may hold a connection at once: a quarter
    of the pool. The agent streams' passes may hold half of it
    (`session_slots_for`), which leaves a quarter for requests and for the
    process's own work however busy both kinds of stream are."""
    return max(1, (pool_size + max_overflow) // 4)


@dataclass(frozen=True)
class Page:
    """A room's rows after a position, as Console stream frames."""

    frames: tuple[bytes, ...]
    # The last row read, shown or not; None when there was none.
    last_seq: int | None
    # Whether the read stopped at its limit, so more rows may follow.
    full: bool


@dataclass
class _Read:
    started: float
    # The page, or None when the read failed or was cancelled with the stream
    # that ran it: a stream waiting on it then reads the room itself.
    page: asyncio.Future[Page | None]


class StreamReads:
    def __init__(
        self,
        slots: int | None,
        *,
        keep_seconds: float = PAGE_KEEP_SECONDS,
        max_pages: int = MAX_PAGES,
    ) -> None:
        self._slots = asyncio.Semaphore(slots) if slots is not None else None
        self._keep_seconds = keep_seconds
        self._max_pages = max_pages
        self._reads: OrderedDict[tuple[str, str, int], _Read] = OrderedDict()

    def slot(self) -> AbstractAsyncContextManager[None]:
        """Held by a stream pass for as long as it holds a connection."""
        return self._slots if self._slots is not None else nullcontext()

    async def page(
        self,
        tenant_id: str,
        room_id: str,
        after_seq: int,
        woken_at: float | None,
        read: Callable[[], Awaitable[Page]],
    ) -> Page:
        """The room's page after `after_seq`, from a read that began after
        `woken_at` when there is one, else from `read`. A stream that was not
        woken by the room (`woken_at` None: a first pass or a recheck) always
        reads it itself, and its read is shared with the streams that follow."""
        key = (tenant_id, room_id, after_seq)
        if woken_at is not None:
            found = self._reads.get(key)
            if (
                found is not None
                and found.started >= woken_at
                and time.monotonic() - found.started <= self._keep_seconds
            ):
                # Shielded: this stream going away must not cancel the read
                # for the others waiting on it.
                shared = await asyncio.shield(found.page)
                if shared is not None:
                    return shared
        entry = _Read(
            started=time.monotonic(),
            page=asyncio.get_running_loop().create_future(),
        )
        self._reads[key] = entry
        self._reads.move_to_end(key)
        while len(self._reads) > self._max_pages:
            self._reads.popitem(last=False)
        try:
            page = await read()
        except BaseException:
            entry.page.set_result(None)
            if self._reads.get(key) is entry:
                del self._reads[key]
            raise
        entry.page.set_result(page)
        return page
