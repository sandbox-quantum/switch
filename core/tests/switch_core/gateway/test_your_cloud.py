"""Your cloud's figures, read from the workspace
controller's last report: room to work, sessions awake, and AI calls today
against the cap. A figure the report doesn't carry, or one out of bounds,
reads as null rather than as a wrong number."""

from __future__ import annotations

from datetime import UTC, datetime

from switch_core.gateway.hosted_machines import next_utc_midnight, your_cloud

NOW = datetime(2026, 10, 29, 13, 45, tzinfo=UTC)
GIB = 1024**3


def test_every_figure_from_a_full_report() -> None:
    status = {
        "machine": {
            "mem_total_bytes": 8 * GIB,
            "mem_free_bytes": 2 * GIB,
            "sessions_running": 3,
            "sessions_max": 15,
            "gateway_calls_today": 40,
            "gateway_capped": False,
            "gateway_daily_cap": 200,
        }
    }
    assert your_cloud(status, NOW) == {
        "room": {"used_bytes": 6 * GIB, "total_bytes": 8 * GIB},
        "awake": {"running": 3, "max": 15},
        "ai_calls_today": {
            "used": 40,
            "cap": 200,
            "capped": False,
            "resets_at": "2026-10-30T00:00:00+00:00",
        },
    }


def test_nothing_without_a_report() -> None:
    empty = {"room": None, "awake": None, "ai_calls_today": None}
    assert your_cloud(None, NOW) == empty
    assert your_cloud({}, NOW) == empty
    assert your_cloud({"machine": "not a dict"}, NOW) == empty


def test_no_ai_calls_without_a_cap() -> None:
    status = {"machine": {"gateway_calls_today": 40}}
    assert your_cloud(status, NOW)["ai_calls_today"] is None


def test_at_the_cap_reads_as_capped() -> None:
    for machine in (
        {"gateway_calls_today": 200, "gateway_daily_cap": 200},
        {"gateway_calls_today": 10, "gateway_daily_cap": 200, "gateway_capped": True},
    ):
        assert your_cloud({"machine": machine}, NOW)["ai_calls_today"]["capped"] is True


def test_figures_out_of_bounds_or_of_the_wrong_type_read_as_null() -> None:
    for machine in (
        {"mem_total_bytes": 0, "mem_free_bytes": 0},
        {"mem_total_bytes": "8", "mem_free_bytes": 1},
        {"sessions_running": True, "sessions_max": 15},
        {"sessions_running": 3, "sessions_max": 5000},
        {"gateway_calls_today": -1, "gateway_daily_cap": 200},
        {"gateway_calls_today": 1, "gateway_daily_cap": 0},
    ):
        figures = your_cloud({"machine": machine}, NOW)
        assert figures == {"room": None, "awake": None, "ai_calls_today": None}, machine


def test_free_above_total_never_reads_as_negative() -> None:
    status = {"machine": {"mem_total_bytes": GIB, "mem_free_bytes": 2 * GIB}}
    assert your_cloud(status, NOW)["room"] == {"used_bytes": 0, "total_bytes": GIB}


def test_the_count_resets_at_the_next_utc_midnight() -> None:
    assert next_utc_midnight(NOW) == datetime(2026, 10, 30, tzinfo=UTC)
    just_before = datetime(2026, 10, 29, 23, 59, 59, tzinfo=UTC)
    assert next_utc_midnight(just_before) == datetime(2026, 10, 30, tzinfo=UTC)
    at_midnight = datetime(2026, 10, 30, tzinfo=UTC)
    assert next_utc_midnight(at_midnight) == datetime(2026, 10, 31, tzinfo=UTC)
