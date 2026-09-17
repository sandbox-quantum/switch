"""A local stand-in for the telemetry relay, so you can see what Switch sends.

Point a development server at this instead of the real relay and every event
is printed as it arrives, decoded out of OTLP into something readable. Nothing
leaves the machine.

    python scripts/telemetry_listener.py

    # in the server's environment
    TELEMETRY_ENABLED=true
    TELEMETRY_ENDPOINT=http://localhost:4318/v1/logs
    TELEMETRY_SNAPSHOT_INTERVAL_HOURS=0.02   # ~72s, so you see a second pass

Then use Switch — create a room, register an agent, send a message, connect a
bridge — and watch the events appear. Each is printed with its resource
attributes on first sight and its properties every time.

Two flags worth knowing:

``--reject N``   answer with an OTLP partial-success body claiming N records
                 were rejected. A 200 does not mean the relay kept anything,
                 and this is how to check Switch notices: it should log a
                 warning naming the event.
``--fail CODE``  answer with an HTTP error, to check that a refused send is
                 logged and dropped rather than raising into whatever was
                 being done at the time.

This is a development tool, deliberately dependency-free and single-threaded.
It is not the relay and makes no attempt to be: the real one is authenticated
by a client id, fans out to two vendors, and is in another repository.
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

_seen_resources: set[str] = set()
_counts: dict[str, int] = {}


def _value(v: dict[str, Any]) -> Any:
    """One OTLP AnyValue, as the Python value it stands for."""
    for key in ("stringValue", "boolValue", "doubleValue", "intValue"):
        if key in v:
            return v[key]
    return v


def _attributes(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {item["key"]: _value(item["value"]) for item in items}


def _render(payload: dict[str, Any]) -> None:
    for resource_log in payload.get("resourceLogs", []):
        resource = _attributes(resource_log.get("resource", {}).get("attributes", []))
        fingerprint = json.dumps(resource, sort_keys=True)
        if fingerprint not in _seen_resources:
            _seen_resources.add(fingerprint)
            print("\n── deployment ──")
            for key, value in sorted(resource.items()):
                print(f"   {key} = {value}")
            print()

        for scope_log in resource_log.get("scopeLogs", []):
            for record in scope_log.get("logRecords", []):
                attributes = _attributes(record.get("attributes", []))
                name = attributes.pop("event.name", record.get("eventName", "?"))
                _counts[name] = _counts.get(name, 0) + 1

                # The two places the name must appear. Sending only one is
                # accepted with a 200 by the real relay and then silently
                # discarded, so it is worth seeing both here.
                if record.get("eventName") != name:
                    print(f"!! {name}: eventName field is {record.get('eventName')!r}")

                print(f"▸ {name}  (#{_counts[name]})")
                for key, value in sorted(attributes.items()):
                    print(f"    {key:<32} {value!r}")
                print()


class _Handler(BaseHTTPRequestHandler):
    reject = 0
    fail_with = 0

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if self.fail_with:
            self.send_response(self.fail_with)
            self.end_headers()
            print(f"×  refused with HTTP {self.fail_with}")
            return

        try:
            _render(json.loads(body))
        except (ValueError, KeyError, TypeError) as exc:
            print(f"!! could not decode payload: {exc}\n{body[:400]!r}")

        answer = (
            json.dumps({"partialSuccess": {"rejectedLogRecords": str(self.reject)}})
            if self.reject
            else "{}"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(answer)))
        self.end_headers()
        self.wfile.write(answer)

    def log_message(self, fmt: str, *args: Any) -> None:
        """Silence the per-request access line; the events are the output."""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4318)
    parser.add_argument(
        "--reject",
        type=int,
        default=0,
        metavar="N",
        help="claim N records were rejected inside a 200, to check Switch notices",
    )
    parser.add_argument(
        "--fail",
        type=int,
        default=0,
        metavar="CODE",
        help="answer every send with this HTTP status instead of accepting it",
    )
    args = parser.parse_args()

    _Handler.reject = args.reject
    _Handler.fail_with = args.fail

    print(f"Listening on http://localhost:{args.port}/v1/logs")
    print("Point TELEMETRY_ENDPOINT at it and use Switch. Ctrl-C to stop.\n")
    server = HTTPServer(("127.0.0.1", args.port), _Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n── totals ──")
        for name, count in sorted(_counts.items(), key=lambda kv: -kv[1]):
            print(f"   {count:>5}  {name}")


if __name__ == "__main__":
    main()
