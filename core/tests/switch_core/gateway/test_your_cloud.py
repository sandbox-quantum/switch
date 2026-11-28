"""Your cloud's figures, read from the workspace controller's last report: room
to work and sessions awake. A figure the report doesn't carry, or one out of
bounds, reads as null rather than as a wrong number."""

from __future__ import annotations

from switch_core.gateway.hosted_machines import your_cloud

GIB = 1024**3


def test_every_figure_from_a_full_report() -> None:
    status = {
        "machine": {
            "mem_total_bytes": 8 * GIB,
            "mem_free_bytes": 2 * GIB,
            "sessions_running": 3,
            "sessions_max": 15,
            # What a box made before the daily call cap went still reports.
            "gateway_calls_today": 40,
            "gateway_capped": False,
            "gateway_daily_cap": 200,
        }
    }
    assert your_cloud(status) == {
        "room": {"used_bytes": 6 * GIB, "total_bytes": 8 * GIB},
        "awake": {"running": 3, "max": 15},
    }


def test_nothing_without_a_report() -> None:
    empty = {"room": None, "awake": None}
    assert your_cloud(None) == empty
    assert your_cloud({}) == empty
    assert your_cloud({"machine": "not a dict"}) == empty


def test_figures_out_of_bounds_or_of_the_wrong_type_read_as_null() -> None:
    for machine in (
        {"mem_total_bytes": 0, "mem_free_bytes": 0},
        {"mem_total_bytes": "8", "mem_free_bytes": 1},
        {"sessions_running": True, "sessions_max": 15},
        {"sessions_running": 3, "sessions_max": 5000},
    ):
        figures = your_cloud({"machine": machine})
        assert figures == {"room": None, "awake": None}, machine


def test_free_above_total_never_reads_as_negative() -> None:
    status = {"machine": {"mem_total_bytes": GIB, "mem_free_bytes": 2 * GIB}}
    assert your_cloud(status)["room"] == {"used_bytes": 0, "total_bytes": GIB}
