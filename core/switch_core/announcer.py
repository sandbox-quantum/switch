"""This process's `NOTIFY`s, sent after the commits they announce, in batches.

A transaction that sends a `NOTIFY` takes a lock that every other notifying
transaction waits on, held until its commit is durable (Postgres takes it in
`PreCommit_Notify`; `pg_locks` shows it as an `object` lock on database 0). One
such commit at a time, for the whole database: on Aurora about 700 a second,
however many connections or vCPUs are added. A trigger that notifies from
inside every message's transaction puts every message through that lock.

So the writers of the busiest tables commit without notifying
(`WRITER_ANNOUNCES` in `db/notify_ddl.py`) and hand their announcements here,
and this sends everything handed to it since its last send in one
transaction, with one transaction in flight. The lock is taken once per
transaction however many notifications it carries, so a process takes it at
most once per round trip whatever its message rate, and the messages
themselves never wait on it.

What this costs and promises:

- **Announced after the commit, never before.** A caller hands over an
  announcement only once its transaction has committed, so a listener never
  hears of a row it cannot read, and a write that rolled back announces
  nothing.
- **Nothing a commit announces is dropped while the database keeps up.** A
  batch that fails is kept, ahead of anything handed over since, and sent
  again. The announcements waiting are bounded either way: past
  `MAX_UNSENT`, whether the database refuses or announcements come faster
  than one transaction at a time can send them, the oldest are dropped and
  logged, and the listeners' re-checks find what they announced.
- **An announcement can still be lost**, which the trigger could not: a
  process that dies between a commit and the send takes it with it. Every
  listener therefore treats an announcement as a hint and re-checks on a
  timer (`AgentEventListener` forgets the heads it was told,
  `PostgresTransport` asks which of its rooms moved), so a lost one costs a
  delay, never a row.
- **Same channels and payloads as the triggers**, so a listener cannot tell
  which sent one, and processes of an older release, which still announce
  through the triggers, deliver to this release's listeners and back.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)

# Postgres refuses a payload of 8000 bytes or more.
MAX_PAYLOAD_BYTES = 7999

# How long a batch that failed to send waits before it is tried again.
RETRY_SECONDS = 2.0

# How many announcements may wait to be sent. Past it the oldest are dropped,
# down to `KEEP_AFTER_DROP` of it, so an overload logs once per drop rather
# than once per announcement.
MAX_UNSENT = 100_000
KEEP_AFTER_DROP = 0.9

# How long stopping waits for what is left to go out.
FLUSH_SECONDS = 5.0

_NOTIFY_MANY = text(
    "SELECT pg_notify(channel, payload) "
    "FROM unnest(CAST(:channels AS text[]), CAST(:payloads AS text[])) "
    "AS announcement(channel, payload)"
)


class Announcer:
    """Sends the `NOTIFY`s handed to it, after their commits, in batches."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self._outbox: list[tuple[str, str]] = []
        self._has_outbox = asyncio.Event()
        # Set while nothing is queued or being sent, so `stop` can wait for
        # the last batch rather than guess.
        self._idle = asyncio.Event()
        self._idle.set()
        self._task: asyncio.Task[None] | None = None

    def announce(self, channel: str, payload: str) -> None:
        """Send `payload` on `channel` with the next batch. Never blocks and
        never raises for the database: the row it announces has committed."""
        if len(payload.encode()) > MAX_PAYLOAD_BYTES:
            raise ValueError(
                f"An announcement on {channel!r} is too large to send "
                f"({len(payload)} bytes)"
            )
        self._outbox.append((channel, payload))
        if len(self._outbox) > MAX_UNSENT:
            self._drop_oldest("announcements came faster than they could be sent")
        self._idle.clear()
        self._has_outbox.set()

    @property
    def unsent(self) -> int:
        return len(self._outbox)

    async def start(self) -> None:
        if self._task is not None:
            raise RuntimeError("Announcer is already started")
        self._task = asyncio.create_task(self._send_forever(), name="announcer")

    async def stop(self) -> None:
        """Send what is left, for up to `FLUSH_SECONDS`, then stop."""
        if self._task is None:
            return
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._idle.wait(), FLUSH_SECONDS)
        if self._outbox:
            logger.error(
                "Stopping with %d announcement(s) unsent; the listeners' "
                "re-checks find what they announced",
                len(self._outbox),
            )
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def _send_forever(self) -> None:
        while True:
            await self._has_outbox.wait()
            self._has_outbox.clear()
            batch, self._outbox = self._outbox, []
            if not batch:
                self._idle.set()
                continue
            # Set once the batch's transaction has committed, which is when
            # Postgres sends it: what fails after that (closing the session)
            # did not stop it going, and keeping it would send it twice.
            committed = False
            try:
                async with self._session_factory() as session:
                    await session.execute(
                        _NOTIFY_MANY,
                        {
                            "channels": [channel for channel, _ in batch],
                            "payloads": [payload for _, payload in batch],
                        },
                    )
                    await session.commit()
                    committed = True
            except asyncio.CancelledError:
                if not committed:
                    self._outbox = batch + self._outbox
                raise
            except Exception:
                if committed:
                    logger.warning(
                        "Sent %d announcement(s), then closing the session failed",
                        len(batch),
                        exc_info=True,
                    )
                else:
                    self._keep(batch)
                    await asyncio.sleep(RETRY_SECONDS)
                    self._has_outbox.set()
                    continue
            if not self._outbox:
                self._idle.set()
            else:
                self._has_outbox.set()

    def _drop_oldest(self, why: str) -> None:
        """Keep the newest announcements, down to `KEEP_AFTER_DROP` of
        `MAX_UNSENT`; the listeners' re-checks find what the others
        announced."""
        dropped = len(self._outbox) - int(MAX_UNSENT * KEEP_AFTER_DROP)
        del self._outbox[:dropped]
        logger.error(
            "Dropped the %d oldest unsent announcement(s) (%s); the listeners' "
            "re-checks find what they announced",
            dropped,
            why,
        )

    def _keep(self, batch: list[tuple[str, str]]) -> None:
        """Put a batch that failed back ahead of anything handed over since,
        so a process still receives one sender's announcements in order."""
        self._outbox = batch + self._outbox
        if len(self._outbox) > MAX_UNSENT:
            self._drop_oldest("the database refused them")
        logger.error(
            "Could not send %d announcement(s); kept and retried in %.0fs",
            len(self._outbox),
            RETRY_SECONDS,
            exc_info=True,
        )
