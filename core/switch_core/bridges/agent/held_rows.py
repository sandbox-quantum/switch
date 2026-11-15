"""Rows a process keeps for as long as a signal would tell it they changed.

A row read on every request, and written rarely, can be kept in memory if
every write to it is announced. Triggers announce them (`notify_ddl.py` and its
siblings) on the signal bus, which every process listens to; a process drops
what a signal names. But a signal is only heard while the bus listens: one
sent while the bus was reconnecting reaches nobody. So a row is kept past a
short TTL only while the connection the bus listened on when the row was read
is still the one listening, and a row read while the bus was not listening,
or across a reconnect, lasts the TTL and no longer.

`HeldRows` is that bookkeeping, shared by the caches built on it
(`ControllerAuthCache`, `RoomAccessCache`): the TTL, the hold, and the
generation that keeps a read which straddled an invalidation from being
stored. A reader takes a `ReadTicket` before going to the database and hands
it back with what it read.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING

from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS

if TYPE_CHECKING:
    from switch_core.signals import SignalBus


@dataclass(frozen=True)
class ReadTicket:
    """Taken before a read and handed back with what it read, so the cache
    can tell whether anything it was told while the read was in flight makes
    the read stale."""

    generation: int
    # The signal bus's listening connection when the read began, or None if
    # it was not listening then.
    listening: int | None


@dataclass
class Entry[V]:
    tenant_id: str
    value: V
    expires_at: float
    # The listening connection the entry was read under, while it is the one
    # listening, keeps the entry past `expires_at`. None for a read made while
    # the bus did not listen.
    held_under: int | None


class HeldRows:
    """The TTL, the hold and the generation of a cache of rows.

    A `ttl_seconds` of 0 disables it. The TTL is refused at or above the
    heartbeat TTL: an entry outliving it would outlive a revocation that the
    connections it guards are held to.
    """

    def __init__(self, *, ttl_seconds: float) -> None:
        if ttl_seconds < 0:
            raise ValueError(f"ttl_seconds must not be negative, got {ttl_seconds!r}")
        if ttl_seconds >= HEARTBEAT_TTL_SECONDS:
            raise ValueError(
                f"ttl_seconds must stay below the agent heartbeat TTL of "
                f"{HEARTBEAT_TTL_SECONDS}s, got {ttl_seconds!r}"
            )
        self._ttl = ttl_seconds
        # Bumped by every invalidation. A read that straddled one is not
        # stored.
        self._generation = 0
        self._bus: SignalBus | None = None

    @property
    def enabled(self) -> bool:
        return self._ttl > 0

    def listen_on(self, bus: SignalBus) -> None:
        """Keep entries read while `bus` listens for as long as it does; the
        caller registers the handlers that drop what its signals name."""
        self._bus = bus

    def ticket(self) -> ReadTicket:
        return ReadTicket(generation=self._generation, listening=self._listening())

    def invalidated(self) -> None:
        """Something was dropped: no read in flight may store what it read."""
        self._generation += 1

    def _listening(self) -> int | None:
        bus = self._bus
        if bus is None or not bus.connected.is_set():
            return None
        return bus.listens

    def fresh(self, ticket: ReadTicket) -> bool:
        """Whether what the ticket's read found may be stored: nothing it
        could have read was invalidated while it was in flight."""
        return self.enabled and ticket.generation == self._generation

    def held_under(self, ticket: ReadTicket) -> int | None:
        """The listening connection to keep the read's entries under, if the
        same one listened through the whole read; None keeps them for the TTL
        only."""
        listening = self._listening()
        return listening if ticket.listening == listening else None

    def get[K, V](
        self, entries: OrderedDict[K, Entry[V]], tenant_id: str, key: K
    ) -> V | None:
        entry = entries.get(key)
        if entry is None or entry.tenant_id != tenant_id:
            return None
        if entry.expires_at <= time.monotonic() and (
            entry.held_under is None or entry.held_under != self._listening()
        ):
            del entries[key]
            return None
        entries.move_to_end(key)
        return entry.value

    def put[K, V](
        self,
        entries: OrderedDict[K, Entry[V]],
        bound: int,
        tenant_id: str,
        key: K,
        value: V,
        held_under: int | None,
    ) -> None:
        entries[key] = Entry(
            tenant_id=tenant_id,
            value=value,
            expires_at=time.monotonic() + self._ttl,
            held_under=held_under,
        )
        entries.move_to_end(key)
        while len(entries) > bound:
            entries.popitem(last=False)
