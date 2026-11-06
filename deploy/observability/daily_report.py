# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
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
  DD_API_KEY, DD_APP_KEY   read access to the metrics and graph snapshots
  DD_SITE                  default datadoghq.com
  SERVICE                  the switch-core service to report on, default switch-core
  SWITCH_URL, SWITCH_AGENT_ID, SWITCH_ROOM_ID, SWITCH_TOKEN
                           the room and the agent posting into it; without
                           them the report is only printed
  DASHBOARD_URL            optional, the Signal board's link for the last line
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass, field

import httpx

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
    """One graph the report can feature, and how to explain it to the team."""

    key: str
    title: str
    queries: tuple[str, ...]
    marker: str | None
    what: str
    why: str
    # The query whose daily mean is compared with last week's.
    trend: str


def featured_graphs(service: str) -> list[Graph]:
    s = f"service:{service}"
    api = (
        f"p95:switch.http.request.duration{{{s},"
        "!route:/gateway/chats/events,!route:/gateway/chats/activity/events}"
    )
    pool = (
        f"100 * max:switch.db.pool.in_use{{{s}}} by {{pod_name}}"
        f" / max:switch.db.pool.size{{{s}}} by {{pod_name}}"
    )
    return [
        Graph(
            "delivery",
            "Time for a message to reach everyone in the room (p95, ms)",
            (f"p95:switch.messages.delivery_lag{{{s}}}",),
            "10000",
            "How long the slowest 5 in 100 messages took to reach every person "
            "and agent in the room.",
            "It's what using Switch feels like; the average hides the slow "
            "messages people complain about. The alert line is at 10 s.",
            f"p95:switch.messages.delivery_lag{{{s}}}",
        ),
        Graph(
            "api",
            "API response time (p95, ms)",
            (api,),
            "2000",
            "How long the slowest 5 in 100 requests to the server took, leaving "
            "out the live streams that stay open on purpose.",
            "A slow API is a slow Console and slow agents. The alert line is at 2 s.",
            api,
        ),
        Graph(
            "agents",
            "Agent connections, both pods together",
            (f"sum:switch.agents.connected{{{s}}}",),
            None,
            "How many agent connections the server holds; one agent can hold "
            "one per room it serves.",
            "Agents are half of Switch: if they can't connect, rooms go quiet "
            "even when everything else is fine.",
            f"sum:switch.agents.connected{{{s}}}",
        ),
        Graph(
            "pool",
            "Database pool in use, per pod (% of its size)",
            (pool,),
            "100",
            "How many of each pod's database connections were busy.",
            "At 100% requests queue for a connection, and everything slows "
            "down at once. That's what happened from 30 Oct to 2 Nov.",
            f"max:switch.db.pool.in_use{{{s}}}",
        ),
        Graph(
            "stalls",
            "Server stalls: event-loop lag, worst (ms)",
            (f"max:switch.runtime.event_loop_lag{{{s}}} by {{pod_name}}",),
            "1000",
            "The longest time each pod was too busy to pick up new work.",
            "switch-core does one thing at a time per pod, so a stall delays "
            "every message on that pod. The alert line is at 1 s.",
            f"max:switch.runtime.event_loop_lag{{{s}}}",
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
            "Requests the server failed to answer, and messages it failed to save.",
            "A lost message is the worst thing a messaging system can do; "
            "these should stay near zero.",
            f"sum:switch.http.requests{{{s},status_class:5xx}}.as_count()",
        ),
        Graph(
            "traffic",
            "Requests per second, against the same time last week",
            (f"sum:switch.http.requests{{{s}}}.as_rate()",),
            None,
            "How busy the server was.",
            "Traffic gives every other graph its context: errors with a "
            "traffic spike are load, without one they're a bug.",
            f"sum:switch.http.requests{{{s}}}.as_rate()",
        ),
        Graph(
            "bridges",
            "Messaging-app bridges running, by app",
            (f"sum:switch.bridges.running{{{s}}} by {{platform}}",),
            None,
            "How many bridges to Slack, Discord and the others were running.",
            "When a bridge stops, the people in that app's rooms stop hearing "
            "from the agents.",
            f"sum:switch.bridges.running{{{s}}}",
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
            return by_key[line.graph], "it's behind a line above"
    moved = [(abs(c), k) for k, c in change.items() if c is not None and k in by_key]
    if moved:
        size, key = max(moved)
        if size >= 0.25:
            direction = "up" if (change[key] or 0) > 0 else "down"
            return by_key[
                key
            ], f"it moved most since last week ({direction} {size:.0%})"
    return graphs[day_number % len(graphs)], "it's this one's turn"


def graph_caption(graph: Graph, reason: str) -> str:
    return (
        f"Graph of the day: {graph.title}, because {reason}.\n"
        f"What it shows: {graph.what}\nWhy it matters: {graph.why}"
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

    def snapshot(self, graph_def: str, title: str, start: int, end: int) -> bytes:
        """A PNG of one graph. Datadog renders it after answering, so the
        image is fetched until it is ready."""
        response = self.http.get(
            "/graph/snapshot",
            params={"graph_def": graph_def, "title": title, "start": start, "end": end},
        )
        response.raise_for_status()
        url = response.json()["snapshot_url"]
        for _ in range(20):
            image = httpx.get(url, timeout=30)
            if image.status_code == 200 and image.headers.get(
                "content-type", ""
            ).startswith("image/"):
                return image.content
            time.sleep(3)
        raise TimeoutError(f"snapshot {title!r} never rendered")


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


def graph_def(graph: Graph) -> str:
    """A Datadog graph definition: grey lines, the alert's limit as a dashed
    red marker, and last week as a second line for traffic."""
    requests = [
        f'{{"q":"{q}","type":"line","style":{{"palette":"grey"}}}}'
        for q in graph.queries
    ]
    if graph.key == "traffic":
        requests.append(
            f'{{"q":"week_before({graph.queries[0]})","type":"line",'
            '"style":{"palette":"grey","type":"dashed"}}'
        )
    markers = (
        f',"markers":[{{"value":"y = {graph.marker}","type":"error dashed"}}]'
        if graph.marker
        else ""
    )
    return f'{{"viz":"timeseries","requests":[{",".join(requests)}]{markers}}}'


def change_since_last_week(
    dd: Datadog, graphs: list[Graph], start: int, end: int
) -> dict[str, float | None]:
    """Each graph's daily mean against the same 24 hours a week earlier."""

    def mean(query: str, a: int, b: int) -> float | None:
        values = dd.points(query, a, b)
        return sum(values) / len(values) if values else None

    week = 7 * DAY
    out: dict[str, float | None] = {}
    for graph in graphs:
        now, before = (
            mean(graph.trend, start, end),
            mean(graph.trend, start - week, end - week),
        )
        out[graph.key] = (now - before) / before if now is not None and before else None
    return out


def post(text: str, images: list[tuple[str, bytes]]) -> None:
    url = os.environ.get("SWITCH_URL", "")
    agent = os.environ.get("SWITCH_AGENT_ID", "")
    room = os.environ.get("SWITCH_ROOM_ID", "")
    token = os.environ.get("SWITCH_TOKEN", "")
    if not (url and agent and room and token):
        print("no Switch room set; report only printed", flush=True)
        return
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
    graph, reason = pick_graph(
        lines, graphs, change_since_last_week(dd, graphs, start, end), end // DAY
    )
    text = f"{text}\n\n{graph_caption(graph, reason)}"
    print(text, flush=True)
    images = []
    try:
        images.append(
            ("graph.png", dd.snapshot(graph_def(graph), graph.title, start, end))
        )
    except (httpx.HTTPError, TimeoutError) as error:
        # The verdict matters more than the picture: post without it.
        print(f"graph {graph.title!r} skipped: {error}", file=sys.stderr, flush=True)
    post(text, images)
    return 0


if __name__ == "__main__":
    sys.exit(main())
