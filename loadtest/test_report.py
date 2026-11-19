"""Numbers from a run's records. No requests."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from agents import Stats  # noqa: E402
from report import bulk_verdict, pct, phase_summary  # noqa: E402


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


def _bulk_window(clicks: list[dict], stats: Stats | None = None) -> dict:
    phase = {
        "name": "admin-bulk@200",
        "scenario": "admin-bulk",
        "seconds": 120.0,
        "agents": 200,
        "bulk": clicks,
    }
    return phase_summary(phase, stats or Stats(phase="admin-bulk@200"), [], [200])


def test_an_admin_bulk_window_passes_when_every_click_changed_its_rooms():
    s = _bulk_window(
        [
            {"rooms": 200, "status": 200, "ms": 900.0, "changed": 200, "skipped": 0},
            {"rooms": 26, "status": 200, "ms": 300.0, "changed": 26, "skipped": 0},
        ]
    )
    assert s["bulk"] == {
        "clicks": 2,
        "rooms": 226,
        "changed": 226,
        "failed_clicks": 0,
        "click_ms_max": 900.0,
    }
    assert bulk_verdict(s) == []


def test_an_admin_bulk_window_fails_on_a_failed_click_or_errors_beside_it():
    stats = Stats(phase="admin-bulk@200")
    stats.event("drop", "a1", why="1011")
    s = _bulk_window(
        [{"rooms": 200, "status": 500, "ms": 30000.0, "error": "timeout"}], stats
    )
    assert bulk_verdict(s) == [
        "1 clicks failed",
        "0 of 200 rooms changed",
        "1 errors in the agents' traffic",
    ]
