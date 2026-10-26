"""Determinism and shape of the planned workload. No server needed:

uv run --project core pytest loadtest/test_workload.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from kube import Refused, guard_target  # noqa: E402
from workload import (  # noqa: E402
    build_membership,
    build_schedule,
    fingerprint,
    payload,
)


def _schedule(seed: int, scenario: str = "steady", **kw):
    rooms = build_membership(seed, 40, 20, 4)
    args = dict(
        seed=seed,
        scenario=scenario,
        step=40,
        duration=60,
        rooms=rooms,
        active=40,
        rate=5,
    )
    args.update(kw)
    return build_schedule(**args)


def test_same_seed_same_workload():
    assert build_membership(7, 40, 20, 4) == build_membership(7, 40, 20, 4)
    for sc in ("steady", "burst"):
        assert _schedule(7, sc) == _schedule(7, sc)
        assert fingerprint(_schedule(7, sc)) == fingerprint(_schedule(7, sc))


def test_different_seed_different_workload():
    assert build_membership(7, 40, 20, 4) != build_membership(8, 40, 20, 4)
    assert fingerprint(_schedule(7)) != fingerprint(_schedule(8))


def test_every_agent_has_a_room_and_rooms_are_full():
    rooms = build_membership(3, 40, 20, 4)
    assert all(len(r) == 4 and len(set(r)) == 4 for r in rooms)
    assert {a for r in rooms for a in r} == set(range(40))


def test_messages_go_to_connected_members_only():
    rooms = build_membership(3, 100, 50, 4)
    sch = build_schedule(
        seed=3, scenario="steady", step=30, duration=60, rooms=rooms, active=30, rate=10
    )
    assert sch
    for s in sch:
        assert s.sender < 30 and s.sender in rooms[s.room]
        assert sum(1 for a in rooms[s.room] if a < 30) >= 2


def test_burst_adds_spikes_and_idle_sends_nothing():
    steady, burst = (
        _schedule(1, "steady"),
        _schedule(1, "burst", burst_every=20, burst_size=50),
    )
    assert len(burst) >= len(steady) + 3 * 50 - 5
    assert _schedule(1, "idle") == []


def test_hot_room_spikes_land_in_one_room():
    sch = _schedule(1, "burst", rate=0, burst_every=20, burst_size=30, hot_room=True)
    assert len({s.room for s in sch}) == 1


def test_payload_sizes_and_token():
    sch = _schedule(5, payload_min=40, payload_max=2000)
    assert all(40 <= s.size <= 2000 for s in sch)
    text = payload("run.steady.40.3", 300)
    assert text.startswith("lt:run.steady.40.3: ") and len(text) == 300


@pytest.mark.parametrize(
    "ns,url",
    [
        ("switch", ""),
        ("switch-prod", ""),
        ("switch-staging", "https://switch-api.tail21382.ts.net"),
        ("switch-staging", "https://switch-gateway.tail21382.ts.net"),
        ("switch-staging", "https://switch-prod-api.example.com"),
    ],
)
def test_refuses_pilot_and_prod(ns, url):
    with pytest.raises(Refused):
        guard_target(ns, url)


def test_allows_staging_and_dev_abel():
    guard_target("switch-staging", "https://switch-staging-api.tail21382.ts.net")
    guard_target("switch-dev-abel", "https://switch-dev-abel-gateway.tail21382.ts.net")
