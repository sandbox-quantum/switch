#!/usr/bin/env python3
"""A local stand-in for an OTLP collector, so you can see what Switch reports.

Point a deployment at it and read what arrives:

    python scripts/otlp_sink.py &
    OTLP_ENDPOINT=http://localhost:4318 \
    DEPLOYMENT_ID=$(uuidgen) \
    OTLP_EXPORT_INTERVAL_SECONDS=5 \
    OTLP_LOGS_ENABLED=true \
    just run

It answers `/v1/metrics` and `/v1/logs` the way a real collector does and
prints a readable summary of every payload. Nothing is stored and nothing is
forwarded — this exists so that "is it reporting?" is a question you can
answer on a laptop, without a Datadog account and without sending a
deployment's data anywhere.

`--raw` prints the full JSON instead of the summary, for checking the wire
format by eye.
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


def _summarise_logs(payload: dict[str, Any]) -> list[str]:
    lines = []
    for resource in payload.get("resourceLogs", []):
        for scope in resource.get("scopeLogs", []):
            records = scope.get("logRecords", [])
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
    # Keep-alive, like a real collector. The default here is HTTP/1.0, where
    # the response is delimited by closing the connection — which curl accepts
    # and a pooling client such as httpx reports as "server disconnected
    # without sending a response".
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's spelling
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        # Answer first: a collector that is slow to reply is indistinguishable
        # from one that is broken, and the point here is to not be the problem.
        reply = b'{"partialSuccess":{}}'
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
    args = parser.parse_args()

    Handler.raw = args.raw
    print(
        f"OTLP sink listening on http://localhost:{args.port}\n"
        f"Point a deployment at it with OTLP_ENDPOINT=http://localhost:{args.port}\n",
        flush=True,
    )
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
