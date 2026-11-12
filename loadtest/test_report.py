"""Numbers from a run's records. No requests."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from agents import Stats  # noqa: E402
from report import pct, phase_summary  # noqa: E402


def test_p99_is_the_nearest_rank_not_the_maximum():
    ms = [i / 1000 for i in range(1, 101)]  # 1 to 100 ms
    assert pct(ms, 0.99) == 99.0
    assert pct(ms, 0.5) == 50.0 and pct(ms, 1.0) == 100.0
    # 0.07 * 100 is 7.000000000000001 in floating point; still the 7th.
    assert pct(ms, 0.07) == 7.0
    assert pct([], 0.99) is None and pct([0.25], 0.99) == 250.0


def test_a_dropped_controller_socket_is_one_error_however_many_agents_it_carried():
    stats = Stats(phase="steady150@1000")
    stats.event("controller_drop", "c1", why="1011")
    for i in range(20):
        stats.event("detached", f"a{i}", why="1011")
    phase = {
        "name": "steady150@1000",
        "scenario": "steady",
        "seconds": 60.0,
        "agents": 1000,
    }
    s = phase_summary(phase, stats, [], [1000])
    assert s["errors"] == 1 and s["controller_drops"] == 1 and s["detached"] == 20
