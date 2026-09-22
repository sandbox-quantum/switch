#!/usr/bin/env python3
"""A local stand-in for an OTLP collector, so you can see what Switch reports.

Point a deployment at it and read what arrives:

    python scripts/otlp_sink.py &
    OTLP_ENDPOINT=http://localhost:4318 \
    DEPLOYMENT_ID=$(uuidgen) \
    OTLP_EXPORT_INTERVAL_SECONDS=5 \
    OTLP_LOGS_ENABLED=true \
    just run

It answers `/v1/metrics` and `/v1/logs` like a real collector and prints a
summary of every payload. Nothing is stored or forwarded, so "is it reporting?"
is answerable on a laptop without a Datadog account.

`--raw` prints the full JSON instead, for checking the wire format by eye.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def _attributes(entries: list[dict[str, Any]]) -> dict[str, Any]:
    flat: dict[str, Any] = {}
    for entry in entries:
        value = entry.get("value", {})
        flat[entry["key"]] = next(iter(value.values()), None)
    return flat


def _summarise_metrics(payload: dict[str, Any]) -> list[str]:
    lines = []
    for resource in payload.get("resourceMetrics", []):
        attributes = _attributes(resource.get("resource", {}).get("attributes", []))
        lines.append(
            f"  resource: service={attributes.get('service.name')} "
            f"version={attributes.get('service.version')} "
            f"env={attributes.get('deployment.environment')} "
            f"deployment={attributes.get('flint.client_id')}"
        )
        for scope in resource.get("scopeMetrics", []):
            for metric in scope.get("metrics", []):
                name = metric["name"]
                if "sum" in metric:
                    for point in metric["sum"]["dataPoints"]:
                        lines.append(
                            f"    {name} +{point['asDouble']:g}"
                            f"{_render(point.get('attributes', []))}"
                        )
                elif "gauge" in metric:
                    for point in metric["gauge"]["dataPoints"]:
                        lines.append(
                            f"    {name} = {point['asDouble']:g}"
                            f"{_render(point.get('attributes', []))}"
                        )
                elif "histogram" in metric:
                    for point in metric["histogram"]["dataPoints"]:
                        count = int(point["count"])
                        mean = (point["sum"] / count) if count else 0.0
                        lines.append(
                            f"    {name} n={count} mean={mean:.1f}ms"
                            f"{_render(point.get('attributes', []))}"
                        )
    return lines


def _render(attributes: list[dict[str, Any]]) -> str:
    flat = _attributes(attributes)
    if not flat:
        return ""
    return "  {" + ", ".join(f"{k}={v}" for k, v in sorted(flat.items())) + "}"


def _summarise_events(records: list[dict[str, Any]]) -> list[str]:
    """Product events: the name, then every property.

    Nothing is truncated. The point of watching these is to check exactly what
    a deployment would report, and a property elided as "… and 6 more" is
    precisely the one that might not belong on the wire.
    """
    lines = []
    for record in records:
        attributes = _attributes(record.get("attributes", []))
        name = attributes.pop("event.name", record.get("eventName", "?"))
        if record.get("eventName") != name:
            # Both places must carry it: the relay filters on the attribute and
            # the exporter reads the field. One without the other is accepted
            # with a 200 and then silently dropped.
            lines.append(f"  !! {name}: eventName field is {record.get('eventName')!r}")
        lines.append(f"  ▸ {name}")
        for key in sorted(attributes):
            lines.append(f"      {key:<34} {attributes[key]!r}")
    return lines


def _summarise_logs(payload: dict[str, Any]) -> list[str]:
    lines = []
    for resource in payload.get("resourceLogs", []):
        for scope in resource.get("scopeLogs", []):
            records = scope.get("logRecords", [])
            # A product event is a log record carrying an event name, and it
            # wants the opposite treatment from a log line: every property
            # matters and there is one record per request, where a log batch
            # is many records of which the first few are representative.
            if records and "eventName" in records[0]:
                lines.extend(_summarise_events(records))
                continue
            levels = Counter(record.get("severityText", "?") for record in records)
            lines.append(
                f"  {len(records)} record(s): "
                + ", ".join(f"{level} {count}" for level, count in levels.most_common())
            )
            for record in records[:3]:
                attributes = _attributes(record.get("attributes", []))
                context = {
                    key: attributes[key]
                    for key in ("tenant_id", "request_id", "agent_id", "user_id")
                    if key in attributes
                }
                body = record.get("body", {}).get("stringValue", "")
                lines.append(
                    f"    [{record.get('severityText')}] {body[:90]}"
                    + (f"  {context}" if context else "")
                )
            if len(records) > 3:
                lines.append(f"    … and {len(records) - 3} more")
    return lines


class Handler(BaseHTTPRequestHandler):
    raw = False
    reject = 0
    fail_with = 0
    # Keep-alive, like a real collector. The default is HTTP/1.0, where closing
    # the connection delimits the response — which curl accepts and a pooling
    # client reports as "server disconnected without sending a response".
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's spelling
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        # Answer first: a slow collector is indistinguishable from a broken one.
        if self.fail_with:
            self.send_response(self.fail_with)
            self.send_header("Content-Length", "0")
            self.end_headers()
            print(
                f"[{datetime.now(UTC):%H:%M:%S}] refused with {self.fail_with}",
                flush=True,
            )
            return

        # A 200 does not mean a collector kept anything: OTLP reports partial
        # success in the body. `--reject` is how to check the sender notices.
        reply = (
            json.dumps(
                {"partialSuccess": {"rejectedLogRecords": str(self.reject)}}
            ).encode()
            if self.reject
            else b'{"partialSuccess":{}}'
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

        stamp = datetime.now(UTC).strftime("%H:%M:%S")
        try:
            payload = json.loads(body)
        except ValueError:
            print(
                f"[{stamp}] {self.path}: {len(body)} bytes that are not JSON",
                flush=True,
            )
            return

        if self.raw:
            print(f"[{stamp}] {self.path}\n{json.dumps(payload, indent=2)}", flush=True)
            return

        if self.path.endswith("/metrics"):
            lines = _summarise_metrics(payload)
        elif self.path.endswith("/logs"):
            lines = _summarise_logs(payload)
        else:
            lines = [f"  (unrecognised signal, {len(body)} bytes)"]
        print(f"[{stamp}] POST {self.path}")
        print("\n".join(lines) or "  (empty)", flush=True)

    def log_message(self, *args: object) -> None:
        """Silence the per-request access log; the summaries are the output."""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4318)
    parser.add_argument(
        "--raw", action="store_true", help="print the full JSON payload"
    )
    parser.add_argument(
        "--reject",
        type=int,
        default=0,
        metavar="N",
        help="claim N records were rejected inside a 200, to check the sender notices",
    )
    parser.add_argument(
        "--fail",
        type=int,
        default=0,
        metavar="CODE",
        help="answer every request with this HTTP status instead of accepting it",
    )
    args = parser.parse_args()

    Handler.raw = args.raw
    Handler.reject = args.reject
    Handler.fail_with = args.fail
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        # Usually a sink from a previous run. A traceback would send the reader
        # into this file rather than the command that fixes it.
        raise SystemExit(
            f"Cannot listen on port {args.port}: {error}\n"
            f"Something is already there — most likely an earlier sink. "
            f"Find it with `lsof -nP -iTCP:{args.port} -sTCP:LISTEN`, stop it "
            f"with `pkill -f otlp_sink.py`, or pass --port."
        ) from error

    print(
        f"OTLP sink listening on http://localhost:{args.port}\n"
        f"Point a deployment at it with OTLP_ENDPOINT=http://localhost:{args.port}\n",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)


if __name__ == "__main__":
    main()
