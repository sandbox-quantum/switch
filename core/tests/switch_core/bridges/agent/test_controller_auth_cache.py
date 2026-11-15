"""The memo of a controller access token's reads, on its own.

The end-to-end properties (a hit reaches no database, a revoke or an unbind
takes effect at once, a TTL of 0 turns it off) are pinned against Postgres in
`tests/switch_core/management/test_controller_auth_cache.py`. These are the
ones that need a hand on the clock or on the ordering.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent import held_rows as module
from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.protocol.controller_presence import (
    DETACH_UNASSIGNED,
    Binding,
    ControllerPresence,
)
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS
from switch_core.db.auth_rows_notify_ddl import (
    AGENT_CHANGED_SIGNAL,
    CONTROLLER_AUTH_CHANGED_SIGNAL,
)
from switch_core.db.models import Agent


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=fake))
    return fake


def _principal(controller_id: str = "c1", tenant_id: str = "t1") -> ControllerPrincipal:
    return ControllerPrincipal(
        controller_id=controller_id, owner_id="owner", tenant_id=tenant_id
    )


def _agent(agent_id: str = "a1") -> Agent:
    return Agent(id=agent_id, name=agent_id, description="")


def test_entries_expire_after_the_ttl(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    cache.put_controller(_principal(), cache.ticket())
    cache.put_agents("t1", [_agent()], cache.ticket())

    clock.now += 4.9
    assert cache.controller("t1", "c1") == _principal()
    assert cache.agent("t1", "a1") is not None
    clock.now += 0.2
    assert cache.controller("t1", "c1") is None
    assert cache.agent("t1", "a1") is None


def test_an_entry_is_keyed_by_its_tenant(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    cache.put_controller(_principal(), cache.ticket())
    cache.put_agents("t1", [_agent()], cache.ticket())

    assert cache.controller("t2", "c1") is None
    assert cache.agent("t2", "a1") is None


def test_a_read_that_straddled_an_invalidation_is_not_stored(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    before_revoke = cache.ticket()
    cache.invalidate_controller("c1")
    cache.put_controller(_principal(), before_revoke)
    assert cache.controller("t1", "c1") is None

    before_unbind = cache.ticket()
    cache.invalidate_agent("a1")
    cache.put_agents("t1", [_agent()], before_unbind)
    assert cache.agent("t1", "a1") is None


def test_invalidation_drops_only_what_it_names(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    for principal in (_principal("c1"), _principal("c2"), _principal("c1", "t2")):
        cache.put_controller(principal, cache.ticket())
    for agent_id in ("a1", "a2"):
        cache.put_agents("t1", [_agent(agent_id)], cache.ticket())

    cache.invalidate_controller("c1")
    cache.invalidate_agent("a1")

    assert cache.controller("t1", "c1") is None
    assert cache.controller("t2", "c1") is None
    assert cache.controller("t1", "c2") is not None
    assert cache.agent("t1", "a1") is None
    assert cache.agent("t1", "a2") is not None


def test_it_holds_no_more_than_its_bound(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=2)
    for agent_id in ("a1", "a2", "a3"):
        cache.put_agents("t1", [_agent(agent_id)], cache.ticket())
    assert cache.agent("t1", "a1") is None
    assert cache.agent("t1", "a3") is not None


def test_agents_have_a_bound_of_their_own(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=1, max_agents=3)
    cache.put_agents("t1", [_agent(a) for a in ("a1", "a2", "a3")], cache.ticket())
    for principal in (_principal("c1"), _principal("c2")):
        cache.put_controller(principal, cache.ticket())

    assert [cache.agent("t1", a) is not None for a in ("a1", "a2", "a3")] == [
        True,
        True,
        True,
    ]
    assert cache.controller("t1", "c1") is None
    assert cache.controller("t1", "c2") is not None


def test_a_ttl_of_zero_stores_nothing(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=0, max_entries=8)
    cache.put_controller(_principal(), cache.ticket())
    cache.put_agents("t1", [_agent()], cache.ticket())
    assert not cache.enabled
    assert cache.controller("t1", "c1") is None
    assert cache.agent("t1", "a1") is None


class _Bus:
    """Just enough of `SignalBus`: whether it listens, on which connection,
    and the handlers registered with it."""

    def __init__(self) -> None:
        self.connected = asyncio.Event()
        self.listens = 0
        self.handlers: dict[str, Callable[[dict[str, Any]], None]] = {}

    def handle(self, kind: str, handler: Callable[[dict[str, Any]], None]) -> None:
        self.handlers[kind] = handler

    def listen(self) -> None:
        self.listens += 1
        self.connected.set()

    def drop(self) -> None:
        self.connected.clear()


def _following(bus: _Bus) -> ControllerAuthCache:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    cache.follow(bus)  # type: ignore[arg-type]
    return cache


def _warm(cache: ControllerAuthCache) -> None:
    cache.put_controller(_principal(), cache.ticket())
    cache.put_agents("t1", [_agent()], cache.ticket())


class TestWhileSignalsListen:
    def test_an_entry_outlives_the_ttl(self, clock: _Clock) -> None:
        bus = _Bus()
        bus.listen()
        cache = _following(bus)
        _warm(cache)

        clock.now += 3600

        assert cache.controller("t1", "c1") == _principal()
        assert cache.agent("t1", "a1") is not None

    def test_the_signals_drop_what_they_name(self, clock: _Clock) -> None:
        bus = _Bus()
        bus.listen()
        cache = _following(bus)
        _warm(cache)
        cache.put_agents("t1", [_agent("a2")], cache.ticket())

        bus.handlers[CONTROLLER_AUTH_CHANGED_SIGNAL](
            {"kind": CONTROLLER_AUTH_CHANGED_SIGNAL, "controller_id": "c1"}
        )
        bus.handlers[AGENT_CHANGED_SIGNAL](
            {"kind": AGENT_CHANGED_SIGNAL, "agent_id": "a1"}
        )

        assert cache.controller("t1", "c1") is None
        assert cache.agent("t1", "a1") is None
        assert cache.agent("t1", "a2") is not None

    def test_an_entry_read_while_the_bus_was_down_lasts_the_ttl(
        self, clock: _Clock
    ) -> None:
        bus = _Bus()
        cache = _following(bus)
        _warm(cache)
        bus.listen()

        clock.now += 5.1

        assert cache.controller("t1", "c1") is None
        assert cache.agent("t1", "a1") is None

    def test_losing_the_connection_ends_the_hold(self, clock: _Clock) -> None:
        """A signal sent while the bus does not listen reaches nobody, so what
        was kept on the strength of signals goes back to lasting the TTL."""
        bus = _Bus()
        bus.listen()
        cache = _following(bus)
        _warm(cache)

        bus.drop()
        clock.now += 5.1
        assert cache.agent("t1", "a1") is None

        _warm(cache)
        bus.listen()
        clock.now += 5.1
        assert cache.controller("t1", "c1") is None

    def test_a_new_connection_does_not_revive_the_old_one_s_entries(
        self, clock: _Clock
    ) -> None:
        bus = _Bus()
        bus.listen()
        cache = _following(bus)
        _warm(cache)

        bus.drop()
        bus.listen()
        clock.now += 5.1

        assert cache.controller("t1", "c1") is None
        assert cache.agent("t1", "a1") is None

    def test_a_read_across_a_reconnect_lasts_the_ttl(self, clock: _Clock) -> None:
        bus = _Bus()
        bus.listen()
        cache = _following(bus)
        ticket = cache.ticket()

        bus.drop()
        bus.listen()
        cache.put_agents("t1", [_agent()], ticket)

        assert cache.agent("t1", "a1") is not None
        clock.now += 5.1
        assert cache.agent("t1", "a1") is None


def test_the_ttl_must_stay_below_the_heartbeat_ttl() -> None:
    with pytest.raises(ValueError, match="heartbeat"):
        ControllerAuthCache(ttl_seconds=HEARTBEAT_TTL_SECONDS, max_entries=8)
    with pytest.raises(ValueError, match="negative"):
        ControllerAuthCache(ttl_seconds=-1, max_entries=8)
    with pytest.raises(ValueError, match="max_entries"):
        ControllerAuthCache(ttl_seconds=1, max_entries=0)
    with pytest.raises(ValueError, match="max_agents"):
        ControllerAuthCache(ttl_seconds=1, max_entries=1, max_agents=0)


def test_presence_keeps_it_in_step_with_bindings_and_revocations(
    clock: _Clock,
) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    presence = ControllerPresence(on_bound=lambda agent_id: None)
    presence.use_auth_cache(cache)
    binding = Binding(
        agent_id="a1",
        controller_id="c1",
        tenant_id="t1",
        controller_name="machine",
        running=True,
    )

    def warm() -> None:
        cache.put_controller(_principal(), cache.ticket())
        cache.put_agents("t1", [_agent()], cache.ticket())

    warm()
    presence.bind(binding)
    assert cache.agent("t1", "a1") is None

    warm()
    presence.bind(
        Binding(
            agent_id="a1",
            controller_id="c2",
            tenant_id="t1",
            controller_name="machine",
            running=True,
        )
    )
    assert cache.agent("t1", "a1") is None

    warm()
    presence.unbind("a1", DETACH_UNASSIGNED)
    assert cache.agent("t1", "a1") is None
    assert cache.controller("t1", "c1") is not None

    warm()
    presence.revoke_controller("c1")
    assert cache.controller("t1", "c1") is None
