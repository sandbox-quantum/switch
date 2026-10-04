"""The memo of a controller access token's reads, on its own.

The end-to-end properties (a hit reaches no database, a revoke or an unbind
takes effect at once, a TTL of 0 turns it off) are pinned against Postgres in
`tests/switch_core/management/test_controller_auth_cache.py`. These are the
ones that need a hand on the clock or on the ordering.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.bridges.agent import controller_auth_cache as module
from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.protocol.controller_presence import (
    DETACH_UNASSIGNED,
    Binding,
    ControllerPresence,
)
from switch_core.bridges.agent.protocol.liveness import HEARTBEAT_TTL_SECONDS
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
    cache.put_controller(_principal(), cache.generation)
    cache.put_agent("t1", _agent(), cache.generation)

    clock.now += 4.9
    assert cache.controller("t1", "c1") == _principal()
    assert cache.agent("t1", "a1") is not None
    clock.now += 0.2
    assert cache.controller("t1", "c1") is None
    assert cache.agent("t1", "a1") is None


def test_an_entry_is_keyed_by_its_tenant(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    cache.put_controller(_principal(), cache.generation)
    cache.put_agent("t1", _agent(), cache.generation)

    assert cache.controller("t2", "c1") is None
    assert cache.agent("t2", "a1") is None


def test_a_read_that_straddled_an_invalidation_is_not_stored(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    before_revoke = cache.generation
    cache.invalidate_controller("c1")
    cache.put_controller(_principal(), before_revoke)
    assert cache.controller("t1", "c1") is None

    before_unbind = cache.generation
    cache.invalidate_agent("a1")
    cache.put_agent("t1", _agent(), before_unbind)
    assert cache.agent("t1", "a1") is None


def test_invalidation_drops_only_what_it_names(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    for principal in (_principal("c1"), _principal("c2"), _principal("c1", "t2")):
        cache.put_controller(principal, cache.generation)
    for agent_id in ("a1", "a2"):
        cache.put_agent("t1", _agent(agent_id), cache.generation)

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
        cache.put_agent("t1", _agent(agent_id), cache.generation)
    assert cache.agent("t1", "a1") is None
    assert cache.agent("t1", "a3") is not None


def test_a_ttl_of_zero_stores_nothing(clock: _Clock) -> None:
    cache = ControllerAuthCache(ttl_seconds=0, max_entries=8)
    cache.put_controller(_principal(), cache.generation)
    cache.put_agent("t1", _agent(), cache.generation)
    assert not cache.enabled
    assert cache.controller("t1", "c1") is None
    assert cache.agent("t1", "a1") is None


def test_the_ttl_must_stay_below_the_heartbeat_ttl() -> None:
    with pytest.raises(ValueError, match="heartbeat"):
        ControllerAuthCache(ttl_seconds=HEARTBEAT_TTL_SECONDS, max_entries=8)
    with pytest.raises(ValueError, match="negative"):
        ControllerAuthCache(ttl_seconds=-1, max_entries=8)
    with pytest.raises(ValueError, match="max_entries"):
        ControllerAuthCache(ttl_seconds=1, max_entries=0)


def test_presence_keeps_it_in_step_with_bindings_and_revocations(
    clock: _Clock,
) -> None:
    cache = ControllerAuthCache(ttl_seconds=5, max_entries=8)
    presence = ControllerPresence(
        on_bound=lambda agent_id: None, on_worker_dropped=lambda worker: None
    )
    presence.use_auth_cache(cache)
    binding = Binding(
        agent_id="a1",
        controller_id="c1",
        tenant_id="t1",
        controller_name="machine",
        running=True,
    )

    def warm() -> None:
        cache.put_controller(_principal(), cache.generation)
        cache.put_agent("t1", _agent(), cache.generation)

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
