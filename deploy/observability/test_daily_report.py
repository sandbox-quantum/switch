"""The morning report's verdict, from the day's numbers."""

from __future__ import annotations

import json

import daily_report as r
import httpx

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


GRAPHS = r.featured_graphs("switch-core")
NO_CHANGE = {graph.key: 0.0 for graph in GRAPHS}


def test_the_graph_of_the_day_explains_the_first_line_to_look_at():
    lines = r.lines_for({**FINE, "pool_ratio": 0.95, "loop_lag_max": 1500})
    graph, reason = r.pick_graph(lines, GRAPHS, NO_CHANGE, day_number=0)
    assert graph.key == "pool"
    assert reason == "it's behind a line above that needs a look"


def test_on_a_good_day_the_graph_that_moved_most_is_featured():
    change = {**NO_CHANGE, "traffic": 0.4, "api": -0.6}
    graph, reason = r.pick_graph(r.lines_for(FINE), GRAPHS, change, day_number=0)
    assert graph.key == "api"
    assert reason == "it moved most against the same day last week (down 60%)"


def test_a_quiet_week_walks_through_every_graph():
    picked = {
        r.pick_graph(r.lines_for(FINE), GRAPHS, NO_CHANGE, day_number=day)[0].key
        for day in range(len(GRAPHS))
    }
    assert picked == {graph.key for graph in GRAPHS}


def test_every_graph_definition_is_valid_json():
    import json

    for graph in GRAPHS:
        assert json.loads(r.graph_def(graph))["requests"]


BY_KEY = {graph.key: graph for graph in GRAPHS}


def test_a_full_pool_is_explained_and_comes_with_a_next_step():
    day = r.Day(peak=133, peak_where="pod zjttv", peak_at="14:05", minutes_over=40)
    text = r.graph_caption(BY_KEY["pool"], "it's behind a line above", day)
    assert "How to read it: Each pod keeps a fixed set" in text
    assert (
        "Today: Peak use was 133% on pod zjttv around 14:05 UTC, above the line for about 40 min."
        in text
    )
    assert "add a pod or raise the pool size" in text


def test_a_quiet_graph_says_there_is_nothing_to_do():
    day = r.Day(peak=900, peak_at="03:00")
    today, advice = r.commentary(BY_KEY["delivery"], day)
    assert today == "The worst was 900 ms around 03:00 UTC."
    assert advice.startswith("Nothing to do")


def test_close_to_the_limit_is_flagged_before_it_fires():
    _, advice = r.commentary(BY_KEY["api"], r.Day(peak=1500))
    assert "over half the 2 s limit" in advice


def test_failing_bridges_name_the_likely_cause():
    day = r.Day(
        peak=20,
        notes={"check": "failing", "top_failure": "mattermost, network (1073 times)"},
    )
    today, advice = r.commentary(BY_KEY["bridges"], day)
    assert today == "The bridges health check failed for most of the day."
    assert advice.startswith(
        "Most failed connections were mattermost, network (1073 times)."
    )


def test_missing_data_is_not_read_as_good_news():
    today, advice = r.commentary(BY_KEY["stalls"], r.Day())
    assert today == "No data in the last 24 hours."
    assert "stopped reporting" in advice


def test_series_names_are_short():
    assert (
        r.series_name(
            "pod_name:switch-switch-core-58f65f47cf-zjttv,service:switch-core"
        )
        == "pod zjttv"
    )
    assert r.series_name("platform:slack,service:switch-core") == "slack"


def test_a_whole_day_over_the_line_says_so():
    today, _ = r.commentary(BY_KEY["pool"], r.Day(peak=133, minutes_over=1435))
    assert today.endswith("above the line for the whole day.")


def test_a_handful_of_errors_is_background():
    notes = {"server_errors": "6", "lost": "0", "top_route": "/gateway/rooms (5)"}
    _, advice = r.commentary(BY_KEY["errors"], r.Day(peak=5, notes=notes))
    assert advice == (
        "Nothing to do: a handful a day is background "
        "(the most came from /gateway/rooms (5))."
    )


def test_a_printed_report_does_not_count_as_posted(monkeypatch):
    """Only a real post may feed the "didn't post" alert, or a job that lost
    its room settings would look healthy."""
    for name in ("SWITCH_URL", "SWITCH_AGENT_ID", "SWITCH_ROOM_ID", "SWITCH_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    assert r.post("text", []) is False


def test_the_posted_mark_is_one_point_tagged_with_the_service():
    sent = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append((request.url.path, request.content))
        return httpx.Response(202, json={"status": "ok"})

    dd = r.Datadog("api", "app", "datadoghq.com")
    dd.http = httpx.Client(
        base_url="https://api.datadoghq.com/api/v1",
        transport=httpx.MockTransport(handler),
    )
    dd.mark_posted("switch-core", 1_800_000_000)

    path, body = sent[0]
    assert path == "/api/v1/series"
    series = json.loads(body)["series"][0]
    assert series["metric"] == "switch.daily_report.posted"
    assert series["points"] == [[1_800_000_000, 1]]
    assert series["tags"] == ["service:switch-core"]
