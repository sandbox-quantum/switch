from __future__ import annotations

import time
from collections import OrderedDict
from typing import TYPE_CHECKING

from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS
from switch_core.db.models import Agent

if TYPE_CHECKING:
    from switch_core.bridges.agent.auth import ControllerPrincipal


class ControllerAuthCache:
    """A short-lived memo of the two reads a controller access token costs.

    A controller token is a signed JWT, so verifying it needs no database. But
    every request it authenticates also re-reads its controller row, to refuse
    a revoked controller while its token is unexpired, and a request acting as
    one of its agents reads that agent's row too. A controller beats every two
    seconds and relays every call its agents' sessions make, so those reads are
    most of what it costs the connection pool.

    Kept apart from :class:`ApiKeyCache`, which maps one bearer token to one
    agent: a controller token stands for many agents, and its authorization is
    the binding Core holds in memory (``ControllerPresence``), which is checked
    on every request and never cached here.

    What it deliberately does not do:

    - **Outlive a credential.** Each controller is stored with the credential
      it authenticated under, and a token exchanged for any other one misses,
      so a token minted before the credential was replaced always reaches
      the database and is refused there.
    - **Cache a refusal.** Only a controller that authenticated and an agent
      that was found are stored, so a revoked controller or a missing agent
      always reaches the database.
    - **Outlive a revocation or a binding change.** ``ControllerPresence``
      calls ``invalidate_controller`` when a controller is revoked and
      ``invalidate_agent`` when an agent is bound, moved, unbound or deleted;
      expiry is the backstop, not the mechanism. A read that was in flight
      when an entry was invalidated does not store what it read.

    A ``ttl_seconds`` of 0 disables it. The TTL is refused at or above the
    heartbeat TTL, for the reason :class:`ApiKeyCache` gives.
    """

    def __init__(self, *, ttl_seconds: float, max_entries: int) -> None:
        if ttl_seconds < 0:
            raise ValueError(f"ttl_seconds must not be negative, got {ttl_seconds!r}")
        if ttl_seconds >= HEARTBEAT_TTL_SECONDS:
            raise ValueError(
                f"ttl_seconds must stay below the agent heartbeat TTL of "
                f"{HEARTBEAT_TTL_SECONDS}s, got {ttl_seconds!r}"
            )
        if max_entries < 1:
            raise ValueError(f"max_entries must be at least 1, got {max_entries!r}")
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._controllers: OrderedDict[
            tuple[str, str], tuple[float, tuple[str, ControllerPrincipal]]
        ] = OrderedDict()
        self._agents: OrderedDict[tuple[str, str], tuple[float, Agent]] = OrderedDict()
        # Bumped by every invalidation. A reader takes it before going to the
        # database and hands it back with what it read; a read that straddled
        # an invalidation is not stored.
        self._generation = 0

    @property
    def enabled(self) -> bool:
        return self._ttl > 0

    @property
    def generation(self) -> int:
        return self._generation

    def controller(
        self, tenant_id: str, controller_id: str, credential_id: str
    ) -> ControllerPrincipal | None:
        entry = _get(self._controllers, (tenant_id, controller_id))
        if entry is None or entry[0] != credential_id:
            return None
        return entry[1]

    def put_controller(
        self, principal: ControllerPrincipal, credential_id: str, generation: int
    ) -> None:
        if not self.enabled or generation != self._generation:
            return
        self._put(
            self._controllers,
            (principal.tenant_id, principal.controller_id),
            (credential_id, principal),
        )

    def agent(self, tenant_id: str, agent_id: str) -> Agent | None:
        return _get(self._agents, (tenant_id, agent_id))

    def put_agent(self, tenant_id: str, agent: Agent, generation: int) -> None:
        if not self.enabled or generation != self._generation:
            return
        self._put(self._agents, (tenant_id, agent.id), agent)

    def invalidate_controller(self, controller_id: str) -> None:
        self._generation += 1
        for key in [k for k in self._controllers if k[1] == controller_id]:
            del self._controllers[key]

    def invalidate_agent(self, agent_id: str) -> None:
        self._generation += 1
        for key in [k for k in self._agents if k[1] == agent_id]:
            del self._agents[key]

    def clear(self) -> None:
        self._generation += 1
        self._controllers.clear()
        self._agents.clear()

    def _put[V](
        self,
        entries: OrderedDict[tuple[str, str], tuple[float, V]],
        key: tuple[str, str],
        value: V,
    ) -> None:
        entries[key] = (time.monotonic() + self._ttl, value)
        entries.move_to_end(key)
        while len(entries) > self._max_entries:
            entries.popitem(last=False)


def _get[V](
    entries: OrderedDict[tuple[str, str], tuple[float, V]], key: tuple[str, str]
) -> V | None:
    entry = entries.get(key)
    if entry is None:
        return None
    expires_at, value = entry
    if expires_at <= time.monotonic():
        del entries[key]
        return None
    entries.move_to_end(key)
    return value
