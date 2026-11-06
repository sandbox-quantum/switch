"""The morning report's verdict, from the day's numbers."""

from __future__ import annotations

import daily_report as r

FINE = {
    "agents_now": 9,
    "bridges_min": 1,
    "api_p95_max": 300,
    "delivery_p95_max": 800,
    "server_errors": 3,
    "send_failures": 0,
    "delivery_failures": 0,
    "pool_ratio": 0.3,
    "loop_lag_max": 120,
    "old_connection": 0,
    "events_dropped": 0,
}


def test_a_good_day_is_one_line_to_read():
    text = r.report_text(r.lines_for(FINE), "switch-core")
    assert text.splitlines()[0] == "switch-core, last 24 h: all good."
    assert r.BAD not in text and r.LOOK not in text


def test_a_full_pool_and_a_down_bridge_are_called_out():
    day = {**FINE, "pool_ratio": 1.33, "bridges_min": 0}
    text = r.report_text(r.lines_for(day), "switch-core")
    assert (
        text.splitlines()[0] == "switch-core, last 24 h: 2 to look at, some of it bad."
    )
    assert "🔴 Database: peak pool use 133%" in text
    assert "🔴 Messaging apps: a bridge was down at some point" in text


def test_old_connections_and_missing_data_ask_for_a_look():
    day = {**FINE, "old_connection": 4, "api_p95_max": None}
    lines = r.lines_for(day)
    assert r.Line(r.LOOK, "Agents on the old connection: 4") in lines
    assert r.Line(r.LOOK, "API: worst p95 no data") in lines


def test_lost_messages_are_never_good():
    day = {**FINE, "send_failures": 1}
    assert any(
        line.state == r.LOOK and line.text.startswith("Errors:")
        for line in r.lines_for(day)
    )
