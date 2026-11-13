# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx", "matplotlib"]
# ///
"""The morning report: one post that says whether switch-core was fine over the
last day, with the graphs that show it.

    uv run deploy/observability/daily_report.py

It reads the same metrics as the Signal board and the monitors, from Datadog,
and posts into a Switch room as an agent in that room. The first line is the
verdict, so on a good day there is nothing else to read.

Each report also carries one graph of the day, with two sentences on what it
measures and why it matters, so the team learns the signals one at a time.
The graph is the one behind the first line that needs a look; on a good day,
the one that moved most against the same day last week; on a quiet day, the
next one in turn.

The alerts cover what needs someone now; this covers what can wait for the
morning: a pool that came close to full, latency creeping up, agents still on
the old connection, events dropped for agents that were away.

Environment:
  DD_API_KEY, DD_APP_KEY   read access to metrics, and to logs for why bridges fail
  DD_SITE                  default datadoghq.com
  SERVICE                  the switch-core service to report on, default switch-core
  SWITCH_URL, SWITCH_AGENT_ID, SWITCH_ROOM_ID, SWITCH_TOKEN
                           the room and the agent posting into it; without
                           them the report is only printed
  DASHBOARD_URL            optional, the Signal board's link for the last line

After a post it sends one point on switch.daily_report.posted, which the
"morning report didn't post" alert watches.
"""

from __future__ import annotations

import io
import itertools
import os
import sys
import textwrap
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx
import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402
from matplotlib.ticker import StrMethodFormatter  # noqa: E402

DAY = 24 * 3600

GOOD, LOOK, BAD = "🟢", "🟡", "🔴"


@dataclass(frozen=True)
class Line:
    state: str
    text: str
    graph: str = field(default="", compare=False)


def check(value: float | None, *, look: float, bad: float) -> str:
    """A value at or over `bad` is red, at or over `look` yellow, otherwise
    green. No value means nothing was reported, which is itself worth a look."""
    if value is None:
        return LOOK
    if value >= bad:
        return BAD
    if value >= look:
        return LOOK
    return GOOD


def _ms(value: float | None) -> str:
    if value is None:
        return "no data"
    return f"{value / 1000:.1f} s" if value >= 1000 else f"{value:.0f} ms"


def _n(value: float | None) -> str:
    return "no data" if value is None else f"{value:.0f}"


def lines_for(m: dict[str, float | None]) -> list[Line]:
    """The report's lines from the day's numbers, in the Signal board's order.
    Thresholds sit below the monitors', which already posted anything worse."""
    pool = m["pool_ratio"]
    lines = [
        Line(
            BAD if not m["agents_now"] else GOOD,
            f"Agent connections now: {_n(m['agents_now'])}",
            graph="agents",
        ),
        Line(
            GOOD if m["bridges_min"] == 1 else BAD,
            "Messaging apps: all bridges running"
            if m["bridges_min"] == 1
            else "Messaging apps: a bridge was down at some point",
            graph="bridges",
        ),
        Line(
            check(m["api_p95_max"], look=1000, bad=2000),
            f"API: worst p95 {_ms(m['api_p95_max'])}",
            graph="api",
        ),
        Line(
            check(m["delivery_p95_max"], look=3000, bad=10000),
            f"Messages: worst delivery p95 {_ms(m['delivery_p95_max'])}",
            graph="delivery",
        ),
        Line(
            LOOK
            if (m["server_errors"] or 0) >= 20
            or m["send_failures"]
            or m["delivery_failures"]
            else GOOD,
            f"Errors: {_n(m['server_errors'])} server errors, "
            f"{_n(m['send_failures'])} failed sends, "
            f"{_n(m['delivery_failures'])} failed deliveries",
            graph="errors",
        ),
        Line(
            check(pool, look=0.9, bad=1.0),
            "Database: peak pool use " + ("no data" if pool is None else f"{pool:.0%}"),
            graph="pool",
        ),
        Line(
            check(m["loop_lag_max"], look=500, bad=1000),
            f"Server: worst event-loop lag {_ms(m['loop_lag_max'])}",
            graph="stalls",
        ),
    ]
    if m["old_connection"]:
        lines.append(
            Line(LOOK, f"Agents on the old connection: {_n(m['old_connection'])}")
        )
    if m["events_dropped"]:
        lines.append(
            Line(
                GOOD,
                f"Events dropped for agents that were away: {_n(m['events_dropped'])}",
            )
        )
    return lines


@dataclass(frozen=True)
class Graph:
    """One graph the report can feature, and how to teach it to the team."""

    key: str
    title: str
    queries: tuple[str, ...]
    # The alert's limit, drawn as a dashed red line; None when there is none.
    limit: float | None
    how_to_read: str
    what_matters: str
    # Grouped by pod or app where it helps, so the comment can say which one.
    detail: str
    unit: str = "ms"
    # What the y axis measures, written on it.
    axis: str = ""
    # A name for each query's line when the query isn't split by pod or app.
    labels: tuple[str, ...] = ()


@dataclass(frozen=True)
class Day:
    """What one graph did over the report's 24 hours."""

    peak: float | None = None
    peak_where: str = ""
    peak_at: str = ""
    mean: float | None = None
    last_week: float | None = None
    minutes_over: int = 0
    # Extra findings some graphs need: the top error route, why bridges fail.
    notes: dict[str, str] = field(default_factory=dict)

    @property
    def change(self) -> float | None:
        if self.mean is None or not self.last_week:
            return None
        return (self.mean - self.last_week) / self.last_week


def featured_graphs(service: str) -> list[Graph]:
    s = f"service:{service}"
    streams = "!route:/gateway/chats/events,!route:/gateway/chats/activity/events"
    pool = (
        f"100 * max:switch.db.pool.in_use{{{s}}} by {{pod_name}}"
        f" / max:switch.db.pool.size{{{s}}} by {{pod_name}}"
    )
    return [
        Graph(
            "delivery",
            "Time for a message to reach everyone in the room (p95, ms)",
            (f"p95:switch.messages.delivery_lag{{{s}}}",),
            10_000,
            "Each point is p95: line up every message from that minute by how "
            "long it took to reach the people and agents in the room, and p95 "
            "is the one 95 in from the fast end. So only the slowest 5 in 100 "
            "took longer than the line.",
            "Stretches above the dashed red line at 10 s. A single spike is one "
            "bad minute; the alert needs 15 minutes above it.",
            f"p95:switch.messages.delivery_lag{{{s}}}",
            axis="Time to reach the room, ms (p95)",
            labels=("All pods",),
        ),
        Graph(
            "api",
            "API response time (p95, ms)",
            (f"p95:switch.http.request.duration{{{s},{streams}}}",),
            2_000,
            "Each point is how long the slowest 5 in 100 requests to the server "
            "took that minute. The two live streams are left out: they stay "
            "open for about 10 s on purpose.",
            "Time above the dashed red line at 2 s. Everything the Console and "
            "the agents do goes through the API, so this is how fast Switch "
            "feels to them.",
            f"p95:switch.http.request.duration{{{s},{streams}}}",
            axis="Response time, ms (p95)",
            labels=("All pods",),
        ),
        Graph(
            "agents",
            "Agent connections, all pods together",
            (f"sum:switch.agents.connected{{{s}}}",),
            None,
            "How many agent connections the server holds. One agent can hold "
            "several, one per room it serves, so it counts connections, not "
            "agents.",
            "Cliffs: a sudden drop that stays down means agents were cut off. "
            "Short spikes are agents reconnecting after a deploy.",
            f"sum:switch.agents.connected{{{s}}} by {{pod_name}}",
            unit="",
            axis="Agent connections",
            labels=("All pods",),
        ),
        Graph(
            "pool",
            "Database pool in use, per pod (% of its size)",
            (pool,),
            100,
            "Each pod keeps a fixed set of database connections, its pool. One "
            "line per pod shows how many were busy, as a share of the set.",
            "The dashed red line is 100%: every connection busy. Above it, "
            "requests queue for a connection and everything slows down at "
            "once. That's what happened from 30 Oct to 2 Nov.",
            pool,
            unit="%",
            axis="Connections in use, % of the pool",
        ),
        Graph(
            "stalls",
            "Server stalls: longest time each pod was too busy (ms)",
            (f"max:switch.runtime.event_loop_lag{{{s}}} by {{pod_name}}",),
            1_000,
            "switch-core does one thing at a time on each pod. This is the "
            "longest each pod made new work wait, minute by minute.",
            "Spikes towards the dashed red line at 1 s. During a stall every "
            "message on that pod waits, so stalls show up as late messages.",
            f"max:switch.runtime.event_loop_lag{{{s}}} by {{pod_name}}",
            axis="Longest wait in the minute, ms",
        ),
        Graph(
            "errors",
            "Server errors and lost messages, per hour",
            (
                f"sum:switch.http.requests{{{s},status_class:5xx}}.as_count()"
                ".rollup(sum, 3600)",
                f"sum:switch.messages.send_failures{{{s}}}.as_count()"
                ".rollup(sum, 3600)",
            ),
            None,
            "Bars per hour: requests the server failed to answer (5xx), and "
            "messages it failed to save.",
            "Clusters of bars, and any lost message at all. A few scattered "
            "errors a day are background; a lost message never is.",
            f"sum:switch.http.requests{{{s},status_class:5xx}} by {{route}}.as_count()",
            unit="",
            axis="Count in the hour",
            labels=("Server errors (5xx)", "Messages not saved"),
        ),
        Graph(
            "traffic",
            "Requests per second, against the same time last week",
            (f"sum:switch.http.requests{{{s}}}.as_rate()",),
            None,
            "The solid line is today, the dashed one the same hours a week "
            "earlier, so the daily rhythm cancels out.",
            "A gap opening between the two lines. Traffic isn't good or bad by "
            "itself, but it explains the rest: errors with a traffic spike are "
            "load, without one they're a bug.",
            f"sum:switch.http.requests{{{s}}}.as_rate()",
            unit=" requests/s",
            axis="Requests per second",
            labels=("Today",),
        ),
        Graph(
            "bridges",
            "Messaging-app bridges running, by app",
            (f"sum:switch.bridges.running{{{s}}} by {{platform}}",),
            None,
            "One line per messaging app: how many bridges to it are running, "
            "over both pods.",
            "A line falling to zero. When a bridge stops, the people in that "
            "app's rooms stop hearing from the agents.",
            f"sum:switch.bridges.running{{{s}}} by {{platform}}",
            unit="",
            axis="Bridges running",
        ),
    ]


def pick_graph(
    lines: list[Line],
    graphs: list[Graph],
    change: dict[str, float | None],
    day_number: int,
) -> tuple[Graph, str]:
    """The graph of the day, and why it was picked.

    The graph behind the first line that needs a look wins, since that's what
    the reader will ask about. Otherwise the one that moved most against the
    same day last week, if it moved by a quarter or more. Otherwise the next
    one in turn, so a quiet week still walks the team through every signal.
    """
    by_key = {graph.key: graph for graph in graphs}
    for line in lines:
        if line.state != GOOD and line.graph in by_key:
            return by_key[line.graph], "it's behind a line above that needs a look"
    moved = [(abs(c), k) for k, c in change.items() if c is not None and k in by_key]
    if moved:
        size, key = max(moved)
        if size >= 0.25:
            direction = "up" if (change[key] or 0) > 0 else "down"
            return by_key[key], (
                f"it moved most against the same day last week ({direction} {size:.0%})"
            )
    return graphs[day_number % len(graphs)], (
        "nothing stood out today, so it's this one's turn"
    )


def _v(value: float | None, unit: str) -> str:
    if value is None:
        return "no data"
    if unit == "ms":
        return _ms(value)
    if unit == "%":
        return f"{value:.0f}%"
    return f"{value:,.0f}{unit}" if value >= 10 else f"{value:.1f}{unit}"


def _limit(value: float, unit: str) -> str:
    return f"{value / 1000:g} s" if unit == "ms" and value >= 1000 else _v(value, unit)


def _for(minutes: int) -> str:
    if minutes >= 23 * 60:
        return "the whole day"
    if minutes >= 90:
        return f"about {minutes / 60:.0f} h"
    return f"about {minutes} min"


def _where(day: Day) -> str:
    where = f" on {day.peak_where}" if day.peak_where else ""
    at = f" around {day.peak_at} UTC" if day.peak_at else ""
    return where + at


def commentary(graph: Graph, day: Day) -> tuple[str, str]:
    """What the graph says about the last 24 hours, and what to do about it.

    The first part reads the numbers back in plain words; the second is a
    diagnosis and a next step when something is off, or says there's nothing
    to do. The advice points at the detail board's charts by name.
    """
    peak = _v(day.peak, graph.unit)
    if day.peak is None:
        return (
            "No data in the last 24 hours.",
            "No data usually means switch-core stopped reporting, not that all "
            "is well: check that the pods are up and that the 'has stopped "
            "reporting' alert hasn't fired.",
        )
    over = f", above the line for {_for(day.minutes_over)}" if day.minutes_over else ""

    if graph.key in ("delivery", "api", "stalls"):
        limit = graph.limit or 0
        today = f"The worst was {peak}{_where(day)}{over}."
        if day.minutes_over:
            advice = {
                "delivery": "Late messages usually come from a stalled pod or a "
                "full database pool. On the detail board, check 'Server stalls' "
                "and 'Database strain' for the same time. If neither moved, "
                "check how long Slack and Discord took to answer: the delay may "
                "be on their side.",
                "api": "The detail board's 'Five slowest API routes' names the "
                "route. If every route slowed together, the cause is shared: "
                "look at 'Database query time' and 'Server stalls' for the same "
                "time.",
                "stalls": "A stall means one piece of work held the pod. Check "
                "that pod's CPU on the detail board; if it was near 100%, the "
                "pod ran out of room and another pod would help. If CPU was "
                "low, the pod was waiting on something slow, usually the "
                "database.",
            }[graph.key]
        elif day.peak >= limit / 2:
            advice = (
                f"Nothing fired, but {peak} is over half the {_limit(limit, graph.unit)} "
                "limit. Not a problem yet; worth a glance if it happens again "
                "tomorrow."
            )
        else:
            advice = f"Nothing to do: well under the {_limit(limit, graph.unit)} line."
        return today, advice

    if graph.key == "pool":
        today = f"Peak use was {peak}{_where(day)}{over}."
        if day.minutes_over:
            advice = (
                "Requests queued for a database connection, so everything on "
                "that pod slowed down at once. On the detail board, 'Database "
                "query time' shows whether a slow query held connections, and "
                "'Database strain' how long requests waited. If both pods "
                "filled up, it's load: add a pod or raise the pool size."
            )
        elif day.peak >= 70:
            advice = (
                "Getting close to full. If it stays this high, it's time to "
                "plan another pod before it tips over."
            )
        else:
            advice = "Nothing to do: plenty of room left."
        return today, advice

    if graph.key in ("agents", "traffic"):
        change = day.change
        compared = (
            f", against about {_v(day.last_week, graph.unit)} on the same day last week "
            f"({'up' if change > 0 else 'down'} {abs(change):.0%})"
            if change is not None
            else ""
        )
        today = f"On average {_v(day.mean, graph.unit)}{compared}."
        if graph.key == "agents" and change is not None and change <= -0.3:
            advice = (
                "Fewer agent connections than last week. If 'Agents that went "
                "silent' on the detail board spiked at the same time, they were "
                "cut off (network or a stalled pod); if not, people are simply "
                "running fewer agents."
            )
        elif graph.key == "traffic" and change is not None and abs(change) >= 0.5:
            advice = (
                "A big change in traffic. Fine on its own; if errors or latency "
                "moved too, the two are likely connected."
            )
        else:
            advice = "Nothing to do: in line with last week."
        return today, advice

    if graph.key == "errors":
        total = day.notes.get("server_errors", _v(day.mean, ""))
        lost = day.notes.get("lost", "0")
        today = f"{total} server errors and {lost} lost messages in 24 hours."
        if lost != "0":
            advice = (
                "Messages were lost: someone sent something nobody received. "
                "That's worth a look today. The switch-core logs for the same "
                "time say which room and why."
            )
        elif float(total) >= 20 and day.notes.get("top_route"):
            advice = (
                f"More than the usual background. Most came from "
                f"{day.notes['top_route']}: start there; 'Routes returning "
                "server errors' on the detail board has the rest."
            )
        else:
            top = day.notes.get("top_route")
            advice = "Nothing to do: a handful a day is background" + (
                f" (the most came from {top})." if top else "."
            )
        return today, advice

    # bridges
    if day.notes.get("check") == "failing":
        today = "The bridges health check failed for most of the day."
        reason = day.notes.get("top_failure")
        advice = (f"Most failed connections were {reason}. " if reason else "") + (
            "A 'network' failure means the app's server didn't answer; if that "
            "bridge isn't used any more, deactivating it clears the check. "
            "'Why connecting to a messaging app failed' on the detail board "
            "has the full list."
        )
    else:
        today = (
            f"{peak} bridges running at the busiest point, and the health check passed."
        )
        advice = "Nothing to do."
    return today, advice


def graph_caption(graph: Graph, reason: str, day: Day) -> str:
    today, advice = commentary(graph, day)
    return "\n".join(
        [
            f"📊 Graph of the day: {graph.title}",
            f"Picked because {reason}.",
            "",
            f"How to read it: {graph.how_to_read}",
            f"What to look for: {graph.what_matters}",
            "",
            f"Today: {today}",
            f"What it means: {advice}",
        ]
    )


def report_text(lines: list[Line], service: str, dashboard_url: str = "") -> str:
    to_look = [line for line in lines if line.state != GOOD]
    if not to_look:
        head = f"{service}, last 24 h: all good."
    elif any(line.state == BAD for line in to_look):
        head = f"{service}, last 24 h: {len(to_look)} to look at, some of it bad."
    else:
        head = f"{service}, last 24 h: {len(to_look)} to look at."
    body = [head, *(f"{line.state} {line.text}" for line in lines)]
    if dashboard_url:
        body.append(dashboard_url)
    return "\n".join(body)


class Datadog:
    def __init__(self, api_key: str, app_key: str, site: str) -> None:
        self.http = httpx.Client(
            base_url=f"https://api.{site}/api/v1",
            headers={"DD-API-KEY": api_key, "DD-APPLICATION-KEY": app_key},
            timeout=60,
        )

    def mark_posted(self, service: str, at: int) -> None:
        """One point on `switch.daily_report.posted`, so the "the morning
        report didn't post" alert can tell a quiet day from a broken job."""
        response = self.http.post(
            "/series",
            json={
                "series": [
                    {
                        "metric": "switch.daily_report.posted",
                        "type": "gauge",
                        "points": [[at, 1]],
                        "tags": [f"service:{service}"],
                    }
                ]
            },
        )
        response.raise_for_status()

    def points(self, query: str, start: int, end: int) -> list[float]:
        response = self.http.get(
            "/query", params={"from": start, "to": end, "query": query}
        )
        response.raise_for_status()
        return [
            value
            for series in response.json().get("series", [])
            for _, value in series.get("pointlist", [])
            if value is not None
        ]

    def series(
        self, query: str, start: int, end: int
    ) -> dict[str, list[tuple[float, float]]]:
        """Points per series, keyed by a short name for what the series is
        split by (a pod, an app, a route); "" when it isn't split."""
        response = self.http.get(
            "/query", params={"from": start, "to": end, "query": query}
        )
        response.raise_for_status()
        out: dict[str, list[tuple[float, float]]] = {}
        for series in response.json().get("series", []):
            name = series_name(series.get("scope", ""))
            out[name] = [
                (ts / 1000, value)
                for ts, value in series.get("pointlist", [])
                if value is not None
            ]
        return out

    def top_log_group(
        self, search: str, facets: tuple[str, ...], start: int, end: int
    ) -> tuple[str, int] | None:
        """The most common combination of facets among matching logs, and how
        many there were. None when there are none or logs can't be read."""
        body = {
            "compute": [{"aggregation": "count"}],
            "filter": {
                "query": search,
                "from": str(start * 1000),
                "to": str(end * 1000),
            },
            "group_by": [
                {
                    "facet": f,
                    "limit": 1,
                    "sort": {"aggregation": "count", "order": "desc"},
                }
                for f in facets
            ],
        }
        response = self.http.post(
            str(self.http.base_url).replace("/v1", "/v2") + "/logs/analytics/aggregate",
            json=body,
        )
        response.raise_for_status()
        buckets = response.json().get("data", {}).get("buckets", [])
        if not buckets:
            return None
        top = buckets[0]
        return ", ".join(str(v) for v in top.get("by", {}).values()), int(
            top.get("computes", {}).get("c0", 0)
        )


def measure(dd: Datadog, service: str, start: int, end: int) -> dict[str, float | None]:
    s = f"service:{service}"

    def agg(query: str, how) -> float | None:
        values = dd.points(query, start, end)
        return how(values) if values else None

    last = lambda xs: xs[-1]  # noqa: E731
    in_use = dd.points(f"max:switch.db.pool.in_use{{{s}}}", start, end)
    size = dd.points(f"max:switch.db.pool.size{{{s}}}", start, end)
    return {
        "agents_now": agg(f"sum:switch.agents.connected{{{s}}}", last),
        "bridges_min": agg(f"min:switch.health.check{{{s},check:bridges}}", min),
        "api_p95_max": agg(
            f"p95:switch.http.request.duration{{{s},"
            "!route:/gateway/chats/events,!route:/gateway/chats/activity/events}",
            max,
        ),
        "delivery_p95_max": agg(f"p95:switch.messages.delivery_lag{{{s}}}", max),
        "server_errors": agg(
            f"sum:switch.http.requests{{{s},status_class:5xx}}.as_count()", sum
        )
        or 0,
        "send_failures": agg(
            f"sum:switch.messages.send_failures{{{s}}}.as_count()", sum
        )
        or 0,
        "delivery_failures": agg(
            f"sum:switch.messages.delivery_failures{{{s}}}.as_count()", sum
        )
        or 0,
        "pool_ratio": max(in_use) / max(size) if in_use and size else None,
        "loop_lag_max": agg(f"max:switch.runtime.event_loop_lag{{{s}}}", max),
        "old_connection": agg(f"sum:switch.agents.connected{{{s},transport:sse}}", max)
        or 0,
        "events_dropped": agg(f"sum:switch.agent.events_dropped{{{s}}}.as_count()", sum)
        or 0,
    }


@dataclass(frozen=True)
class Drawn:
    """One line (or set of bars) on the graph of the day."""

    label: str
    points: list[tuple[float, float]]
    # Last week's line, drawn dashed and grey behind today's.
    last_week: bool = False


def graph_lines(dd: Datadog, graph: Graph, start: int, end: int) -> list[Drawn]:
    """What the graph of the day draws: one line per pod or app when the query
    is split, the query's own name when it isn't, and for traffic the same
    hours a week earlier, moved onto today's axis."""
    drawn = []
    for i, query in enumerate(graph.queries):
        # Oldest first, so pods that run side by side get neighbouring colours.
        split = dd.series(query, start, end)
        for name, points in sorted(split.items(), key=lambda kv: kv[1][:1]):
            label = name or (graph.labels[i] if i < len(graph.labels) else "")
            drawn.append(Drawn(label, points))
    if graph.key == "traffic":
        week = 7 * DAY
        before = dd.series(graph.queries[0], start - week, end - week)
        for points in before.values():
            moved = [(t + week, v) for t, v in points]
            drawn.append(Drawn("Same hours last week", moved, last_week=True))
    return drawn


# Line colours in a fixed order, picked to stay apart for colour-blind
# readers (Okabe and Ito). Red is left out: it marks the alert's limit. A day
# with deploys has more pods than colours; they repeat, and since only two or
# three pods run at once, the ones that share a colour don't overlap.
COLOURS = ("#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#000000")
LIMIT_COLOUR = "#C62828"
LAST_WEEK_COLOUR = "#9AA3AD"


def caption(graph: Graph) -> str:
    """The figure's caption: how to read the graph, and the limit when it has
    one, so the image reads on its own when it is forwarded without the post."""
    text = f"Figure 1. {graph.how_to_read}"
    if graph.limit is not None:
        text += f" Dashed red: the alert's limit, {_limit(graph.limit, graph.unit)}."
    return text


def draw(
    graph: Graph, drawn: list[Drawn], service: str, start: int, end: int
) -> Figure:
    """The graph of the day, with a title, the time span, labelled axes, a
    legend and a caption. Raises ValueError when there is nothing to draw."""
    if not any(d.points for d in drawn):
        raise ValueError("no data to draw")
    fig, ax = plt.subplots(figsize=(11.5, 6), dpi=150)
    top = 0.0
    shown = [d for d in drawn if d.points]
    bars = graph.key == "errors"
    width = 3600 / DAY / (len(shown) + 1)
    colour = itertools.cycle(COLOURS)
    for i, d in enumerate(shown):
        x = [datetime.fromtimestamp(t, UTC) for t, _ in d.points]
        y = [v for _, v in d.points]
        top = max(top, *y)
        if d.last_week:
            ax.plot(
                x,
                y,
                color=LAST_WEEK_COLOUR,
                linestyle="--",
                lw=1.5,
                label=d.label,
                zorder=1,
            )
        elif bars:
            at = [mdates.date2num(t) + (i - (len(shown) - 1) / 2) * width for t in x]
            ax.bar(
                at,
                y,
                width=width,
                color=next(colour),
                label=d.label,
                zorder=2,
            )
        else:
            ax.plot(x, y, color=next(colour), lw=1.8, label=d.label, zorder=2)
    if graph.limit is not None:
        ax.axhline(
            graph.limit,
            color=LIMIT_COLOUR,
            linestyle="--",
            lw=1.5,
            label=f"Alert limit ({_limit(graph.limit, graph.unit)})",
            zorder=3,
        )
        top = max(top, graph.limit)
    ax.set_ylim(0, top * 1.12 or 1)
    ax.set_xlim(datetime.fromtimestamp(start, UTC), datetime.fromtimestamp(end, UTC))
    ax.xaxis.set_major_locator(mdates.HourLocator(interval=3, tz=UTC))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M", tz=UTC))
    ax.set_xlabel("Time (UTC)")
    ax.set_ylabel(graph.axis)
    ax.yaxis.set_major_formatter(StrMethodFormatter("{x:,.0f}"))
    ax.grid(axis="y", color="#E3E8EF", lw=0.8)
    ax.spines[["top", "right"]].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color("#9AA3AD")
    ax.tick_params(colors="#5D6B7A")
    if any(d.label for d in shown) or graph.limit is not None:
        ax.legend(
            loc="upper left",
            bbox_to_anchor=(1.01, 1),
            frameon=False,
            fontsize=9,
        )
    span = (
        f"{service}, {datetime.fromtimestamp(start, UTC):%d %b %H:%M} to "
        f"{datetime.fromtimestamp(end, UTC):%d %b %H:%M} UTC"
    )
    fig.text(0.05, 0.955, graph.title, fontsize=14, fontweight="bold")
    fig.text(0.05, 0.915, span, fontsize=10, color="#5D6B7A")
    fig.text(
        0.05,
        0.03,
        textwrap.fill(caption(graph), 140),
        fontsize=9,
        color="#5D6B7A",
        va="bottom",
    )
    fig.subplots_adjust(left=0.07, right=0.8, top=0.87, bottom=0.2)
    return fig


def figure(
    graph: Graph, drawn: list[Drawn], service: str, start: int, end: int
) -> bytes:
    """The graph of the day (`draw`) as a PNG."""
    fig = draw(graph, drawn, service, start, end)
    out = io.BytesIO()
    fig.savefig(out, format="png", facecolor="white")
    plt.close(fig)
    return out.getvalue()


def series_name(scope: str) -> str:
    """'pod_name:switch-switch-core-58f65f47cf-zjttv,service:switch-core'
    becomes 'pod zjttv'; other splits keep their value."""
    for tag in scope.split(","):
        key, _, value = tag.partition(":")
        if key == "pod_name":
            return f"pod {value.rsplit('-', 1)[-1]}"
        if key in ("platform", "route", "check"):
            return value
    return ""


def mean_of(dd: Datadog, query: str, start: int, end: int) -> float | None:
    values = dd.points(query, start, end)
    return sum(values) / len(values) if values else None


def read_day(dd: Datadog, graph: Graph, service: str, start: int, end: int) -> Day:
    """What the graph did over the day: its peak and where, time over the
    limit, and its mean against the same 24 hours a week earlier."""
    split = dd.series(graph.detail, start, end)
    points = [(v, t, name) for name, pts in split.items() for t, v in pts]
    if not points:
        return Day()
    peak, at, where = max(points)
    minutes_over = 0
    if graph.limit is not None:
        for pts in split.values():
            over = sum(b[0] - a[0] for a, b in zip(pts, pts[1:]) if a[1] > graph.limit)
            minutes_over = max(minutes_over, round(over / 60))
    week = 7 * DAY
    notes: dict[str, str] = {}
    s = f"service:{service}"
    if graph.key == "errors":
        totals = {name: sum(v for _, v in pts) for name, pts in split.items()}
        notes["server_errors"] = f"{sum(totals.values()):.0f}"
        if totals:
            route, count = max(totals.items(), key=lambda kv: kv[1])
            if count:
                notes["top_route"] = f"{route} ({count:.0f})"
        lost = sum(
            sum(dd.points(f"sum:switch.messages.{m}{{{s}}}.as_count()", start, end))
            for m in ("send_failures", "delivery_failures")
        )
        notes["lost"] = f"{lost:.0f}"
    if graph.key == "bridges":
        checks = dd.points(f"min:switch.health.check{{{s},check:bridges}}", start, end)
        if checks and sum(1 for v in checks if v < 1) > len(checks) / 2:
            notes["check"] = "failing"
            try:
                top = dd.top_log_group(
                    f"{s} @event.name:switch_core.bridge_connected @outcome:failure",
                    ("@bridge_platform", "@failure_reason"),
                    start,
                    end,
                )
            except httpx.HTTPError:
                top = None
            if top:
                notes["top_failure"] = f"{top[0]} ({top[1]} times)"
    return Day(
        peak=peak,
        peak_where=where if len(split) > 1 else "",
        peak_at=time.strftime("%H:%M", time.gmtime(at)),
        mean=mean_of(dd, graph.queries[0], start, end),
        last_week=mean_of(dd, graph.queries[0], start - week, end - week),
        minutes_over=minutes_over,
        notes=notes,
    )


def post(text: str, images: list[tuple[str, bytes]]) -> bool:
    url = os.environ.get("SWITCH_URL", "")
    agent = os.environ.get("SWITCH_AGENT_ID", "")
    room = os.environ.get("SWITCH_ROOM_ID", "")
    token = os.environ.get("SWITCH_TOKEN", "")
    if not (url and agent and room and token):
        print("no Switch room set; report only printed", flush=True)
        return False
    headers = {"Authorization": f"Bearer {token}"}
    base = f"{url.rstrip('/')}/agents/{agent}"
    if images:
        response = httpx.post(
            f"{base}/rooms/{room}/media",
            headers=headers,
            data={"caption": text},
            files=[("files", (name, png, "image/png")) for name, png in images],
            timeout=120,
        )
    else:
        response = httpx.post(
            f"{base}/message",
            headers=headers,
            json={"room_id": room, "content": text},
            timeout=30,
        )
    response.raise_for_status()
    return True


def main() -> int:
    service = os.environ.get("SERVICE", "switch-core")
    dd = Datadog(
        os.environ["DD_API_KEY"],
        os.environ["DD_APP_KEY"],
        os.environ.get("DD_SITE", "datadoghq.com"),
    )
    end = int(time.time())
    start = end - DAY
    lines = lines_for(measure(dd, service, start, end))
    text = report_text(lines, service, os.environ.get("DASHBOARD_URL", ""))
    graphs = featured_graphs(service)
    week = 7 * DAY
    change: dict[str, float | None] = {}
    for g in graphs:
        now = mean_of(dd, g.queries[0], start, end)
        before = mean_of(dd, g.queries[0], start - week, end - week)
        change[g.key] = (now - before) / before if now is not None and before else None
    graph, reason = pick_graph(lines, graphs, change, end // DAY)
    day = read_day(dd, graph, service, start, end)
    text = f"{text}\n\n{graph_caption(graph, reason, day)}"
    print(text, flush=True)
    images = []
    try:
        lines_drawn = graph_lines(dd, graph, start, end)
        images.append(("graph.png", figure(graph, lines_drawn, service, start, end)))
    except (httpx.HTTPError, ValueError) as error:
        # The verdict matters more than the picture: post without it.
        print(f"graph {graph.title!r} skipped: {error}", file=sys.stderr, flush=True)
    if post(text, images):
        dd.mark_posted(service, int(time.time()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
