"""A STUB of Switch Core for the controller gate. It is not Core.

It serves the routes a cloud machine's controller calls, in the wire
shapes of Core's own fixtures (core/tests/switch_core/fixtures/agent_controllers
and hosted_machines), and nothing else: no database, no Matrix, no rooms. What
is real is the sealing: provider logins are sealed with Core's
switch_core.providers.sealing, against KMS (moto here), exactly as Core seals
them for an ec2 controller.

HTTPS on :443 (the machine's apiEndpoint, https://switch-gate.test):

  controller management   POST /v1/management/controllers/{id}/token
                          GET  .../assignment            (ETag / If-None-Match)
                          GET  .../provider-credentials/{provider}
                          PUT  .../status
                          GET  .../operations?state=pending
                          POST .../control/{relay_id}, .../control/push
  controller stream       POST /v1/controllers/{id}/connection, .../connection/beat
                          GET  /v1/controllers/{id}/events   (SSE)
  relayed agent calls     GET  /version, /health; anything else is logged and
                          answered with a 404 error envelope

Plain HTTP on 127.0.0.1:8090, for the gate's checks only:

  GET  /state             what the stub has seen
  POST /frame             push one frame on the controller stream
  POST /control           relay a control message to an agent and wait for its reply
  POST /seal              seal a login (optionally for another controller, or sealed for
                          one and labelled as another's)
  POST /assignment        replace the assignment and announce it
"""

from __future__ import annotations

import asyncio
import json
import queue
import re
import secrets
import ssl
import sys
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

from switch_core.providers.sealing import (
    KmsSettings,
    login_context,
    login_plaintext,
    revoked_envelope,
    seal,
)

CONFIG_PATH = "/etc/cc-gate/stub.json"
HEARTBEAT_INTERVAL_S = 5.0
REPORT_WITHIN_S = 5
KEEPALIVE_S = 5.0

config: dict[str, Any] = json.load(open(CONFIG_PATH))
CONTROLLER_ID: str = config["controller_id"]
lock = threading.Condition()


class State:
    def __init__(self) -> None:
        self.tokens: set[str] = set()
        self.token_requests: list[dict[str, Any]] = []
        self.assignment: dict[str, Any] = config["assignment"]
        self.envelopes: dict[str, dict[str, Any]] = {}
        self.status_reports: list[dict[str, Any]] = []
        self.status_count = 0
        self.connection_id: str | None = None
        self.generation = 0
        self.streams: dict[int, queue.Queue[tuple[str, Any] | None]] = {}
        self.stream_opens = 0
        self.beats = 0
        self.relays: dict[str, dict[str, Any] | None] = {}
        self.pushes: list[dict[str, Any]] = []
        self.relayed: list[dict[str, Any]] = []
        self.unknown: list[str] = []


state = State()


def log(message: str) -> None:
    print(f"stub-core: {message}", file=sys.stderr, flush=True)


def broadcast(event: str, data: Any) -> int:
    with lock:
        targets = list(state.streams.values())
    for target in targets:
        target.put((event, data))
    return len(targets)


def error_body(
    code: str, message: str, retryable: bool = False, retry_after_s: float | None = None
) -> dict[str, Any]:
    body: dict[str, Any] = {"code": code, "message": message, "retryable": retryable}
    if retry_after_s is not None:
        body["retry_after_s"] = retry_after_s
    return {"error": body}


def kms_settings() -> KmsSettings:
    return KmsSettings(key_arn=config["key_arn"], region=config["region"])


def seal_login(body: dict[str, Any]) -> dict[str, Any]:
    provider = body.get("provider", "claude")
    revision = int(body["revision"])
    if body.get("revoked"):
        context = login_context(
            config["tenant"], config["owner"], CONTROLLER_ID, provider
        )
        return revoked_envelope(provider, revision, context)
    context = body.get("context") or login_context(
        config["tenant"],
        config["owner"],
        body.get("controller_id", CONTROLLER_ID),
        provider,
    )
    envelope = asyncio.run(
        seal(
            kms_settings(),
            provider=provider,
            revision=revision,
            context=context,
            plaintext=login_plaintext(
                provider, body.get("kind", "api-key"), body["credential"], revision
            ),
        )
    )
    if body.get("relabel_controller_id"):
        envelope["context"] = login_context(
            config["tenant"], config["owner"], body["relabel_controller_id"], provider
        )
    return envelope


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    admin = False

    def log_message(self, format: str, *args: object) -> None:
        pass

    # ── plumbing ──────────────────────────────────────────────────────────

    def body(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        return json.loads(raw)

    def send_json(
        self, status: int, value: Any, headers: dict[str, str] | None = None
    ) -> None:
        data = b"" if value is None else json.dumps(value).encode()
        self.send_response(status)
        if value is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for name, item in (headers or {}).items():
            self.send_header(name, item)
        self.end_headers()
        if data:
            self.wfile.write(data)

    def authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        token = header.removeprefix("Bearer ")
        with lock:
            ok = token in state.tokens
        if not ok:
            self.send_json(401, error_body("unauthorized", "Unknown access token."))
        return ok

    def do_GET(self) -> None:
        self.route("GET")

    def do_POST(self) -> None:
        self.route("POST")

    def do_PUT(self) -> None:
        self.route("PUT")

    def route(self, method: str) -> None:
        try:
            if self.admin:
                self.admin_route(method)
            else:
                self.public_route(method)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:  # one bad request must not stop the stub
            log(f"{method} {self.path} failed: {error!r}")
            try:
                self.send_json(500, error_body("internal", repr(error), True))
            except OSError:
                pass

    # ── public (what the machine calls) ──────────────────────────────────

    def public_route(self, method: str) -> None:
        url = urlsplit(self.path)
        path = url.path
        management = f"/v1/management/controllers/{CONTROLLER_ID}"
        stream = f"/v1/controllers/{CONTROLLER_ID}"

        if method == "POST" and path == f"{management}/token":
            return self.token()
        if path.startswith(management + "/"):
            if not self.authorized():
                return
            rest = path[len(management) :]
            if method == "GET" and rest == "/assignment":
                return self.assignment()
            match = re.fullmatch(r"/provider-credentials/([a-z]+)", rest)
            if method == "GET" and match:
                return self.provider_credential(match.group(1))
            if method == "PUT" and rest == "/status":
                return self.status()
            if method == "GET" and rest == "/operations":
                return self.send_json(200, {"operations": []})
            if method == "POST" and rest == "/control/push":
                body = self.body()
                with lock:
                    state.pushes.append(body)
                    del state.pushes[:-200]
                return self.send_json(200, {"unsubscribe": False})
            match = re.fullmatch(r"/control/([^/]+)", rest)
            if method == "POST" and match:
                return self.control_reply(match.group(1))
        if path.startswith(stream + "/"):
            if not self.authorized():
                return
            rest = path[len(stream) :]
            if method == "POST" and rest == "/connection":
                return self.open_connection()
            if method == "POST" and rest == "/connection/beat":
                return self.beat()
            if method == "GET" and rest == "/events":
                return self.events(parse_qs(url.query))
        return self.relayed(method, path)

    def token(self) -> None:
        body = self.body() or {}
        instance = self.headers.get("X-Switch-Host-Instance-Id")
        boot = self.headers.get("X-Switch-Host-Boot-Id")
        with lock:
            state.token_requests.append(
                {
                    "instance_id": instance,
                    "boot_id": boot,
                    "protocol": self.headers.get("Switch-Controller-Protocol"),
                    "at": time.time(),
                }
            )
        if body.get("credential") != config["credential"]:
            return self.send_json(
                401,
                error_body(
                    "invalid_credential", "The controller credential is not valid."
                ),
            )
        if instance != config["instance_id"] or not boot:
            return self.send_json(
                409,
                error_body(
                    "instance_mismatch", "This instance is not the machine's.", True, 2
                ),
            )
        token = "swct_gate_" + secrets.token_urlsafe(24)
        with lock:
            state.tokens.add(token)
        expires = datetime.now(UTC) + timedelta(hours=1)
        self.send_json(
            200,
            {
                "access_token": token,
                "expires_at": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
        )

    def assignment(self) -> None:
        with lock:
            assignment = json.loads(json.dumps(state.assignment))
        etag = f'"gate-{assignment["revision"]}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_json(200, assignment, {"ETag": etag})

    def provider_credential(self, provider: str) -> None:
        with lock:
            envelope = state.envelopes.get(provider)
        if envelope is None:
            return self.send_json(
                404,
                error_body(
                    "provider_credential_not_found", f"No sealed {provider} login."
                ),
            )
        self.send_json(200, envelope)

    def status(self) -> None:
        report = self.body()
        with lock:
            state.status_count += 1
            state.status_reports.append(report)
            del state.status_reports[:-20]
            revision = state.assignment["revision"]
        self.send_json(
            200, {"assignment_revision": revision, "report_within_s": REPORT_WITHIN_S}
        )

    def control_reply(self, relay_id: str) -> None:
        reply = self.body()
        with lock:
            if relay_id not in state.relays:
                self.send_json(404, error_body("unknown_relay", "No such relay."))
                return
            state.relays[relay_id] = reply
            lock.notify_all()
        self.send_json(204, None)

    def open_connection(self) -> None:
        self.body()
        with lock:
            state.connection_id = str(uuid.uuid4())
            state.generation += 1
            for old in state.streams.values():
                old.put(None)
            agents = [agent["agent_id"] for agent in state.assignment["agents"]]
            response = {
                "connection_id": state.connection_id,
                "generation": state.generation,
                "heartbeat_interval_s": HEARTBEAT_INTERVAL_S,
                "agents": agents,
            }
        self.send_json(200, response)

    def beat(self) -> None:
        body = self.body() or {}
        with lock:
            if (
                body.get("connection_id") != state.connection_id
                or body.get("generation") != state.generation
            ):
                self.send_json(
                    404, error_body("unknown_connection", "No such connection.")
                )
                return
            state.beats += 1
            agents = [agent["agent_id"] for agent in state.assignment["agents"]]
        self.send_json(200, {"agents": agents})

    def events(self, query: dict[str, list[str]]) -> None:
        connection_id = (query.get("connection_id") or [""])[0]
        generation = int((query.get("generation") or ["-1"])[0])
        with lock:
            if connection_id != state.connection_id or generation != state.generation:
                self.send_json(
                    404, error_body("unknown_connection", "No such connection.")
                )
                return
            frames: queue.Queue[tuple[str, Any] | None] = queue.Queue()
            previous = state.streams.pop(generation, None)
            if previous is not None:
                previous.put(None)
            state.streams[generation] = frames
            state.stream_opens += 1
            first = {
                "controller_id": CONTROLLER_ID,
                "assignment_revision": state.assignment["revision"],
                "report_within_s": REPORT_WITHIN_S,
                "connection_id": state.connection_id,
                "generation": state.generation,
                "heartbeat_interval_s": HEARTBEAT_INTERVAL_S,
            }
            agents = [agent["agent_id"] for agent in state.assignment["agents"]]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def write(event: str, data: Any) -> None:
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        try:
            write("connection_state", first)
            for agent_id in agents:
                write(
                    "agent.attached", {"agent_id": agent_id, "from_seq": 0, "rooms": []}
                )
            while True:
                try:
                    item = frames.get(timeout=KEEPALIVE_S)
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                if item is None:
                    return
                write(*item)
        finally:
            with lock:
                if state.streams.get(generation) is frames:
                    del state.streams[generation]

    def relayed(self, method: str, path: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        with lock:
            state.relayed.append(
                {
                    "method": method,
                    "path": path,
                    "agent": self.headers.get("X-Switch-Agent-Id"),
                    "authorized": self.headers.get("Authorization", "").removeprefix(
                        "Bearer "
                    )
                    in state.tokens,
                }
            )
            del state.relayed[:-200]
        if method == "GET" and path == "/version":
            return self.send_json(200, {"version": "gate-stub", "protocol": 1})
        if method == "GET" and path == "/health":
            return self.send_json(200, {"status": "ok"})
        self.send_json(
            404,
            error_body(
                "not_in_stub", f"The gate's stub Core does not serve {method} {path}."
            ),
        )

    # ── admin (the gate's checks) ─────────────────────────────────────────

    def admin_route(self, method: str) -> None:
        path = urlsplit(self.path).path
        if method == "GET" and path == "/state":
            with lock:
                body = {
                    "token_requests": state.token_requests[-20:],
                    "token_count": len(state.token_requests),
                    "assignment": state.assignment,
                    "envelopes": {
                        name: env.get("revision")
                        for name, env in state.envelopes.items()
                    },
                    "status_count": state.status_count,
                    "status_reports": state.status_reports[-5:],
                    "connection_id": state.connection_id,
                    "generation": state.generation,
                    "streams": len(state.streams),
                    "stream_opens": state.stream_opens,
                    "beats": state.beats,
                    "pushes": len(state.pushes),
                    "relayed": state.relayed[-50:],
                }
            return self.send_json(200, body)
        body = self.body() or {}
        if method == "POST" and path == "/frame":
            return self.send_json(
                200, {"streams": broadcast(body["event"], body["data"])}
            )
        if method == "POST" and path == "/control":
            relay_id = str(uuid.uuid4())
            timeout = float(body.get("timeout_s", 30))
            with lock:
                state.relays[relay_id] = None
            sent = broadcast(
                "agent.control",
                {
                    "relay_id": relay_id,
                    "agent_id": body["agent_id"],
                    "message": body["message"],
                    "deadline_ms": int((time.time() + timeout) * 1000),
                },
            )
            deadline = time.time() + timeout
            with lock:
                while state.relays[relay_id] is None and time.time() < deadline:
                    lock.wait(timeout=max(0.0, deadline - time.time()))
                reply = state.relays.pop(relay_id)
            if reply is None:
                return self.send_json(
                    504, {"relay_id": relay_id, "streams": sent, "error": "no reply"}
                )
            return self.send_json(200, {"relay_id": relay_id, "reply": reply})
        if method == "POST" and path == "/seal":
            envelope = seal_login(body)
            if body.get("store", True):
                with lock:
                    state.envelopes[envelope["provider"]] = envelope
            notified = 0
            if body.get("notify"):
                notified = broadcast(
                    "provider.credential_changed",
                    {
                        "provider": envelope["provider"],
                        "revision": envelope["revision"],
                    },
                )
            return self.send_json(200, {"envelope": envelope, "notified": notified})
        if method == "POST" and path == "/assignment":
            with lock:
                state.assignment = body["assignment"]
                revision = state.assignment["revision"]
            notified = broadcast("assignment.changed", {"revision": revision})
            return self.send_json(200, {"notified": notified})
        self.send_json(404, {"error": "unknown admin route"})


class AdminHandler(Handler):
    admin = True


class Server(ThreadingHTTPServer):
    daemon_threads = True


def main() -> None:
    public = Server(("0.0.0.0", 443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(config["tls_cert"], config["tls_key"])
    public.socket = context.wrap_socket(public.socket, server_side=True)
    admin = Server(("127.0.0.1", 8090), AdminHandler)
    threading.Thread(target=admin.serve_forever, daemon=True).start()
    log(
        "serving https://switch-gate.test (stub Core) and the admin API on 127.0.0.1:8090"
    )
    public.serve_forever()


if __name__ == "__main__":
    main()
