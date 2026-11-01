from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS
from switch_core.db.auth_rows_notify_ddl import (
    AGENT_CHANGED_SIGNAL,
    CONTROLLER_AUTH_CHANGED_SIGNAL,
)
from switch_core.db.models import Agent

if TYPE_CHECKING:
    from switch_core.bridges.agent.auth import ControllerPrincipal
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
class _Entry[V]:
    tenant_id: str
    value: V
    expires_at: float
    # The listening connection the entry was read under, while it is the one
    # listening, keeps the entry past `expires_at`. None for a read made while
    # the bus did not listen.
    held_under: int | None


class ControllerAuthCache:
    """A memo of the two reads a controller access token costs.

    A controller token is a signed JWT, so verifying it needs no database. But
    every request it authenticates also re-reads its controller row, to refuse
    a revoked controller while its token is unexpired, and a request acting as
    one of its agents reads that agent's row too. A controller relays every
    call its agents' sessions make, so those reads are most of what it costs
    the connection pool.

    Kept apart from :class:`ApiKeyCache`, which maps one bearer token to one
    agent: a controller token stands for many agents, and its authorization is
    the binding Core holds in memory (``ControllerPresence``), which is checked
    on every request and never cached here.

    How long an entry is kept:

    - **Until a signal says it changed, while one could.** A cache that
      follows the signal bus (``follow``) keeps an entry read while the bus
      listened for as long as that same connection listens. Triggers on
      ``agents`` and ``agent_controllers`` send ``agent.changed`` and
      ``controller.auth_changed`` (``db/auth_rows_notify_ddl.py``), and every
      process drops the entry it names. A controller's requests are spread
      over every process, so each process sees one controller or agent only
      every so often, and an entry kept for seconds was gone by the next
      request for it.
    - **Otherwise for ``ttl_seconds``.** An entry read while the bus did not
      listen, or kept past the connection it was read under, lasts the TTL: a
      signal sent between two connections reached neither.

    What it deliberately does not do:

    - **Cache a refusal.** Only a controller that authenticated and an agent
      that was found are stored, so a revoked controller or a missing agent
      always reaches the database.
    - **Outlive a revocation or a binding change.** ``ControllerPresence``
      calls ``invalidate_controller`` when a controller is revoked and
      ``invalidate_agent`` when an agent is bound, moved, unbound or deleted,
      and the signals above reach every process. A read that was in flight
      when an entry was invalidated does not store what it read.

    A ``ttl_seconds`` of 0 disables it. The TTL is refused at or above the
    heartbeat TTL, for the reason :class:`ApiKeyCache` gives.
    """

    def __init__(
        self, *, ttl_seconds: float, max_entries: int, max_agents: int | None = None
    ) -> None:
        if ttl_seconds < 0:
            raise ValueError(f"ttl_seconds must not be negative, got {ttl_seconds!r}")
        if ttl_seconds >= HEARTBEAT_TTL_SECONDS:
            raise ValueError(
                f"ttl_seconds must stay below the agent heartbeat TTL of "
                f"{HEARTBEAT_TTL_SECONDS}s, got {ttl_seconds!r}"
            )
        if max_entries < 1:
            raise ValueError(f"max_entries must be at least 1, got {max_entries!r}")
        if max_agents is not None and max_agents < 1:
            raise ValueError(f"max_agents must be at least 1, got {max_agents!r}")
        self._ttl = ttl_seconds
        self._max_controllers = max_entries
        self._max_agents = max_agents if max_agents is not None else max_entries
        # Keyed by id alone: controller and agent ids are unique across
        # tenants, so a signal naming one finds its entry without a scan.
        self._controllers: OrderedDict[str, _Entry[ControllerPrincipal]] = OrderedDict()
        self._agents: OrderedDict[str, _Entry[Agent]] = OrderedDict()
        # Bumped by every invalidation. A reader takes a ticket before going
        # to the database and hands it back with what it read; a read that
        # straddled an invalidation is not stored.
        self._generation = 0
        self._bus: SignalBus | None = None

    def follow(self, bus: SignalBus) -> None:
        """Keep entries while `bus` listens, and drop the ones its signals
        name."""
        self._bus = bus
        bus.handle(AGENT_CHANGED_SIGNAL, self._on_agent_changed)
        bus.handle(CONTROLLER_AUTH_CHANGED_SIGNAL, self._on_controller_changed)

    @property
    def enabled(self) -> bool:
        return self._ttl > 0

    def ticket(self) -> ReadTicket:
        return ReadTicket(generation=self._generation, listening=self._listening())

    def controller(
        self, tenant_id: str, controller_id: str
    ) -> ControllerPrincipal | None:
        return self._get(self._controllers, tenant_id, controller_id)

    def put_controller(
        self, principal: ControllerPrincipal, ticket: ReadTicket
    ) -> None:
        if not self._fresh(ticket):
            return
        self._put(
            self._controllers,
            self._max_controllers,
            principal.tenant_id,
            principal.controller_id,
            principal,
            self._held_under(ticket),
        )

    def agent(self, tenant_id: str, agent_id: str) -> Agent | None:
        return self._get(self._agents, tenant_id, agent_id)

    def put_agents(
        self, tenant_id: str, agents: Iterable[Agent], ticket: ReadTicket
    ) -> None:
        if not self._fresh(ticket):
            return
        held_under = self._held_under(ticket)
        for agent in agents:
            self._put(
                self._agents, self._max_agents, tenant_id, agent.id, agent, held_under
            )

    def invalidate_controller(self, controller_id: str) -> None:
        self._generation += 1
        self._controllers.pop(controller_id, None)

    def invalidate_agent(self, agent_id: str) -> None:
        self._generation += 1
        self._agents.pop(agent_id, None)

    def clear(self) -> None:
        self._generation += 1
        self._controllers.clear()
        self._agents.clear()

    def _on_agent_changed(self, signal: dict[str, Any]) -> None:
        self.invalidate_agent(signal["agent_id"])

    def _on_controller_changed(self, signal: dict[str, Any]) -> None:
        self.invalidate_controller(signal["controller_id"])

    def _listening(self) -> int | None:
        bus = self._bus
        if bus is None or not bus.connected.is_set():
            return None
        return bus.listens

    def _fresh(self, ticket: ReadTicket) -> bool:
        """Whether what the ticket's read found may be stored: nothing it
        could have read was invalidated while it was in flight."""
        return self.enabled and ticket.generation == self._generation

    def _held_under(self, ticket: ReadTicket) -> int | None:
        """The listening connection to keep the read's entries under, if the
        same one listened through the whole read; None keeps them for the TTL
        only."""
        listening = self._listening()
        return listening if ticket.listening == listening else None

    def _get[V](
        self, entries: OrderedDict[str, _Entry[V]], tenant_id: str, key: str
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

    def _put[V](
        self,
        entries: OrderedDict[str, _Entry[V]],
        bound: int,
        tenant_id: str,
        key: str,
        value: V,
        held_under: int | None,
    ) -> None:
        entries[key] = _Entry(
            tenant_id=tenant_id,
            value=value,
            expires_at=time.monotonic() + self._ttl,
            held_under=held_under,
        )
        entries.move_to_end(key)
        while len(entries) > bound:
            entries.popitem(last=False)
