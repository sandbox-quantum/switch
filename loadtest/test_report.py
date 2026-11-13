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


def test_the_busiest_pod_and_console_re_reads_are_counted_per_window():
    stats = Stats(phase="idle@60")
    stats.console_refresh("idle@60", 0.5, 61, 0)
    stats.console_refresh("idle@60", 2.5, 61, 3)
    samples = [
        {"kind": "db", "phase": "idle@60", "app_total": 50, "app_active": 30,
         "app_idle_tx": 10, "db_total": 60, "lock_waits": 0, "app_busy_client_max": 12},
        {"kind": "db", "phase": "idle@60", "app_total": 80, "app_active": 40,
         "app_idle_tx": 30, "db_total": 90, "lock_waits": 0, "app_busy_client_max": 40},
    ]  # fmt: skip
    phase = {
        "name": "idle@60",
        "scenario": "idle",
        "seconds": 60.0,
        "agents": 60,
        "pool_ceiling": 40,
    }
    s = phase_summary(phase, stats, samples, [60])
    assert (s["pool_busy_pod_max"], s["pool_ceiling"], s["pool_full"]) == (40, 40, True)
    assert s["console_refreshes"] == 2 and s["console_requests"] == 122
    assert s["console_refresh_ms_p99"] == 2500.0 and s["console_errors"] == 3
    assert s["errors"] == 3


def test_a_pool_within_a_tenth_of_its_ceiling_is_full_and_one_with_none_known_is_not():
    stats = Stats(phase="idle@60")
    base = {"name": "idle@60", "scenario": "idle", "seconds": 60.0, "agents": 60}

    def full(busy: int, ceiling: int | None) -> bool:
        sample = {"kind": "db", "phase": "idle@60", "app_total": 10, "app_active": 5,
                  "app_idle_tx": 1, "db_total": 12, "lock_waits": 0,
                  "app_busy_client_max": busy}  # fmt: skip
        phase = {**base, "pool_ceiling": ceiling} if ceiling else base
        return phase_summary(phase, stats, [sample], [60])["pool_full"]

    assert full(36, 40) and full(39, 40)
    assert not full(35, 40)
    assert not full(39, None)
