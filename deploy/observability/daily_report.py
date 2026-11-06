# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""The morning report: one post that says whether switch-core was fine over the
last day, with the graphs that show it.

    uv run deploy/observability/daily_report.py

It reads the same metrics as the Signal board and the monitors, from Datadog,
and posts into a Switch room as an agent in that room, with three graph images.
The first line is the verdict, so on a good day there is nothing else to read.

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
from dataclasses import dataclass

import httpx

DAY = 24 * 3600

GOOD, LOOK, BAD = "🟢", "🟡", "🔴"


@dataclass(frozen=True)
class Line:
    state: str
    text: str


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
            f"Agents connected now: {_n(m['agents_now'])}",
        ),
        Line(
            GOOD if m["bridges_min"] == 1 else BAD,
            "Messaging apps: all bridges running"
            if m["bridges_min"] == 1
            else "Messaging apps: a bridge was down at some point",
        ),
        Line(
            check(m["api_p95_max"], look=1000, bad=2000),
            f"API: worst p95 {_ms(m['api_p95_max'])}",
        ),
        Line(
            check(m["delivery_p95_max"], look=3000, bad=10000),
            f"Messages: worst delivery p95 {_ms(m['delivery_p95_max'])}",
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
        ),
        Line(
            check(pool, look=0.9, bad=1.0),
            "Database: peak pool use " + ("no data" if pool is None else f"{pool:.0%}"),
        ),
        Line(
            check(m["loop_lag_max"], look=500, bad=1000),
            f"Server: worst event-loop lag {_ms(m['loop_lag_max'])}",
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
        "api_p95_max": agg(f"p95:switch.http.request.duration{{{s}}}", max),
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


def graphs(service: str) -> list[tuple[str, str]]:
    """The three graphs posted with the report, as Datadog graph definitions:
    grey lines, the alert's limit as a dashed red marker."""
    s = f"service:{service}"

    def graph(queries: list[str], marker: str | None) -> str:
        requests = ",".join(
            f'{{"q":"{q}","type":"line","style":{{"palette":"grey"}}}}' for q in queries
        )
        markers = (
            f',"markers":[{{"value":"y = {marker}","type":"error dashed"}}]'
            if marker
            else ""
        )
        return f'{{"viz":"timeseries","requests":[{requests}]{markers}}}'

    return [
        (
            "Database connections in use, per pod (pool size 30)",
            graph([f"max:switch.db.pool.in_use{{{s}}} by {{pod_name}}"], "30"),
        ),
        (
            "p95 ms: API requests and message delivery",
            graph(
                [
                    f"p95:switch.http.request.duration{{{s}}}",
                    f"p95:switch.messages.delivery_lag{{{s}}}",
                ],
                "2000",
            ),
        ),
        ("Agents connected", graph([f"sum:switch.agents.connected{{{s}}}"], None)),
    ]


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
    text = report_text(
        lines_for(measure(dd, service, start, end)),
        service,
        os.environ.get("DASHBOARD_URL", ""),
    )
    print(text, flush=True)
    images = []
    for index, (title, graph_def) in enumerate(graphs(service), 1):
        try:
            images.append((f"{index}.png", dd.snapshot(graph_def, title, start, end)))
        except (httpx.HTTPError, TimeoutError) as error:
            # The verdict matters more than the pictures: post without this one.
            print(f"graph {title!r} skipped: {error}", file=sys.stderr, flush=True)
    post(text, images)
    return 0


if __name__ == "__main__":
    sys.exit(main())
