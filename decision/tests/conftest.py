import io
import json
import logging
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from fastapi.testclient import TestClient

from switch_decision import app as app_module
from switch_decision.config import Settings
from switch_decision.logging_setup import LogSettings, build_handler
from tests.helpers import logprobs, settings_for

PROCESS_ID = "decision-pod-0-1234abcd"


@pytest.fixture
def make_client(monkeypatch):
    def make(settings: Settings | None = None, handler=None) -> TestClient:
        monkeypatch.setattr(app_module, "settings", settings or settings_for())
        tc = TestClient(app_module.app)
        tc.__enter__()
        transport = httpx.MockTransport(
            handler or (lambda r: httpx.Response(200, json=logprobs("A")))
        )
        monkeypatch.setattr(
            app_module, "client", httpx.AsyncClient(transport=transport)
        )
        return tc

    return make


@dataclass
class JsonLog:
    stream: io.StringIO

    def lines(self) -> list[dict]:
        return [json.loads(line) for line in self.stream.getvalue().splitlines()]

    def text(self) -> str:
        return self.stream.getvalue()


@pytest.fixture
def json_log() -> Iterator[JsonLog]:
    """What the service's JSON handler writes, at DEBUG, for the test's span."""
    stream = io.StringIO()
    handler = build_handler(
        LogSettings(
            log_format="json",
            log_level="DEBUG",
            service_name="switch-decision",
            environment="test",
            pod_name=None,
        ),
        "0.1.0",
        PROCESS_ID,
    )
    handler.setStream(stream)
    root = logging.getLogger()
    level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        yield JsonLog(stream)
    finally:
        root.removeHandler(handler)
        root.setLevel(level)


@dataclass
class Collector:
    """A local OTLP/HTTP collector: records what is posted to /v1/logs."""

    url: str
    mode: str = "ok"
    posts: list[dict] = field(default_factory=list)
    headers: list[dict] = field(default_factory=list)
    release: threading.Event = field(default_factory=threading.Event)

    def records(self) -> list[dict]:
        return [
            record
            for post in self.posts
            for resource_logs in post["resourceLogs"]
            for scope_logs in resource_logs["scopeLogs"]
            for record in scope_logs["logRecords"]
        ]


@pytest.fixture
def collector() -> Iterator[Collector]:
    state: dict[str, Collector] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["Content-Length"]))
            c = state["collector"]
            if c.mode == "hang":
                c.release.wait(10)
                return
            if c.mode == "fail":
                self.send_response(503)
                self.end_headers()
                return
            c.posts.append(json.loads(body))
            c.headers.append(dict(self.headers))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"partialSuccess": {}}')

        def log_message(self, format, *args) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    state["collector"] = Collector(url=f"http://127.0.0.1:{server.server_port}")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state["collector"]
    finally:
        state["collector"].release.set()
        server.shutdown()
        server.server_close()
