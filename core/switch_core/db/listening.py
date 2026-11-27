"""Holding a `LISTEN` connection open, and getting it back once it is lost.

Every listener in the process (`messages/notify.py`, `signals.py`, the agent
event and session-activity listeners) holds one connection for its whole life
and treats a lost one the same way: what was sent while it was gone reached
nobody, so it reconnects and re-reads. Two rules for that live here, because
each listener getting them wrong on its own is how they went wrong.

**A connection that ends is noticed when it ends.** A server that closes the
connection (a failover, a restart, an administrator ending the backend) tells
the driver at once, and asyncpg calls its termination listeners. Waiting for
the next heartbeat instead left a listener believing it listened for up to a
heartbeat after it had stopped: notifications were lost all that time, and a
cache held only while its listener listens (`bridges/agent/held_rows.py`) was
kept past its TTL under a connection that no longer existed. The heartbeat is
still needed, for the connection that ends without a word (a half-open socket).

**The backoff starts again once a connection is made.** It grows only over
failed attempts in a row. A count that never went back to zero left a process
whose connection had been lost a few times over its life waiting the cap
before every reconnect, deaf all the while.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from typing import Any


class ListeningConnectionLost(ConnectionError):
    """The server closed a held listening connection."""


class ReconnectBackoff:
    """How long to wait before the next attempt to connect: doubling from
    `base` up to `cap` over attempts that failed in a row, and back to `base`
    after one that connected."""

    def __init__(self, *, base: float, cap: float) -> None:
        self._base = base
        self._cap = cap
        self._failures = 0

    def connected(self) -> None:
        self._failures = 0

    def next_delay(self) -> float:
        self._failures += 1
        return min(self._base * 2.0 ** (self._failures - 1), self._cap)


async def hold_open(
    driver: Any,
    *,
    heartbeat_seconds: float,
    heartbeat_timeout_seconds: float,
    running: Callable[[], bool],
    after_beat: Callable[[], None] | None,
) -> None:
    """Keep a listening connection until it is lost, which raises, or until
    `running` says to stop, which returns.

    Raises `ListeningConnectionLost` as soon as the server closes the
    connection, and whatever the heartbeat raises when it fails or times out.
    `after_beat` runs after each heartbeat that succeeded."""
    ended = asyncio.Event()

    def on_end(_connection: Any) -> None:
        ended.set()

    driver.add_termination_listener(on_end)
    try:
        while running():
            # Checked before waiting as well as after: a connection that ended
            # before the listener was added (during a resync, say) fires
            # nothing, and would otherwise wait out a whole heartbeat.
            _raise_if_ended(driver, ended)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(ended.wait(), heartbeat_seconds)
            _raise_if_ended(driver, ended)
            await driver.execute("SELECT 1", timeout=heartbeat_timeout_seconds)
            if after_beat is not None:
                after_beat()
    finally:
        driver.remove_termination_listener(on_end)


def _raise_if_ended(driver: Any, ended: asyncio.Event) -> None:
    if ended.is_set() or driver.is_closed():
        raise ListeningConnectionLost("the server closed the listening connection")
