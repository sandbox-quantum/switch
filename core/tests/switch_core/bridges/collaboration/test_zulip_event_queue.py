"""The Zulip event queue, driven over a real socket.

The other Zulip tests fake the transport, which proves the requests are shaped
right but never exercises the loop that keeps the connection alive: registration,
long polling, the expiry of an idle queue and the reconnect after it. That loop
is where a restart either drops a message or repeats one, so it gets a real HTTP
server rather than a mock — a thread on 127.0.0.1 speaking Zulip's API, and the
adapter's own client talking to it.
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from switch_core.bridges.collaboration.zulip.adapter import (
    ZulipAdapter,
    ZulipConnectionConfig,
)

EMAIL = "switch-bot@acme.zulipchat.com"
API_KEY = "key"

#: A message from somebody in the room, in a topic that is a Switch thread.
FIRST = {
    "id": 1,
    "type": "stream",
    "stream_id": 12,
    "subject": "Plan",
    "sender_id": 7,
    "sender_full_name": "Ada Lovelace",
    "sender_email": "ada@acme.zulipchat.com",
    "content": "first in the topic",
    "attachments": [],
}

#: The bridge's own post, which Zulip delivers back like anybody else's.
OWN_POST = {
    "id": 2,
    "type": "stream",
    "stream_id": 12,
    "subject": "Plan",
    "sender_id": 9,
    "sender_full_name": "Switch",
    "sender_email": EMAIL,
    "content": "the bot talking to itself",
    "attachments": [],
}

SECOND = {
    "id": 3,
    "type": "stream",
    "stream_id": 12,
    "subject": "Plan",
    "sender_id": 7,
    "sender_full_name": "Ada Lovelace",
    "sender_email": "ada@acme.zulipchat.com",
    "content": "after the reconnect",
    "attachments": [],
}


class FakeZulip:
    """Just enough of one organization: register, poll, and the queue expiring."""

    def __init__(self) -> None:
        self.registers = 0
        self.polls: list[tuple[str, int]] = []
        self.authorization: str | None = None
        self.lock = threading.Lock()
        self._polls_for_queue: dict[str, int] = {}
        self._q1_delivered = False
        self._q2_delivered = False
        self.served = 0

    def register(self) -> dict[str, Any]:
        with self.lock:
            self.registers += 1
            queue = f"q{self.registers}"
            self._polls_for_queue[queue] = 0
            return {
                "result": "success",
                "msg": "",
                "queue_id": queue,
                "last_event_id": 0,
                "subscriptions": [
                    {"stream_id": 12, "name": "research", "invite_only": False}
                ],
            }

    def poll(self, queue: str, last_event_id: int) -> tuple[int, dict[str, Any]]:
        with self.lock:
            self.polls.append((queue, last_event_id))
            self._polls_for_queue[queue] = self._polls_for_queue.get(queue, 0) + 1
            seen = self._polls_for_queue[queue]

        if queue == "q1" and seen == 1:
            return 200, {
                "result": "success",
                "msg": "",
                "events": [{"id": 1, "type": "message", "message": FIRST}],
            }
        if queue == "q1":
            # What Zulip does to a queue nobody has polled for ten minutes.
            return 400, {
                "result": "error",
                "msg": "Bad event queue ID: q1",
                "code": "BAD_EVENT_QUEUE_ID",
            }
        if queue == "q2" and seen == 1:
            return 200, {
                "result": "success",
                "msg": "",
                "events": [
                    {"id": 2, "type": "message", "message": OWN_POST},
                    {"id": 3, "type": "message", "message": SECOND},
                ],
            }
        # An idle organization holds the request for its long-poll window; a
        # short pause here keeps the test fast without spinning a core.
        time.sleep(0.05)
        return 200, {"result": "success", "msg": "", "events": []}


class Handler(BaseHTTPRequestHandler):
    server_version = "FakeZulip/1.0"

    def log_message(self, *args: object) -> None:  # keep pytest output clean
        return

    @property
    def state(self) -> FakeZulip:
        return self.server.state  # type: ignore[attr-defined]

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _remember_auth(self) -> None:
        if self.state.authorization is None:
            self.state.authorization = self.headers.get("Authorization")

    def do_POST(self) -> None:
        self._remember_auth()
        path = urlsplit(self.path).path
        # Drained on every POST: the connection is reused, and an unread body
        # would be parsed as the start of the next request.
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if path == "/api/v1/register":
            form = parse_qs(body.decode())
            assert json.loads(form["apply_markdown"][0]) is False
            assert json.loads(form["event_types"][0]) == ["message", "heartbeat"]
            self._json(200, self.state.register())
            return
        if path == "/api/v1/messages":
            form = parse_qs(body.decode())
            assert form["type"] == ["stream"]
            self._json(200, {"result": "success", "msg": "", "id": 500})
            return
        self._json(404, {"result": "error", "msg": "no such endpoint", "code": "BAD"})

    def do_GET(self) -> None:
        self._remember_auth()
        parsed = urlsplit(self.path)
        if parsed.path == "/api/v1/users/me":
            self._json(200, {"result": "success", "msg": "", "user_id": 9})
            return
        if parsed.path == "/api/v1/events":
            query = parse_qs(parsed.query)
            status, payload = self.state.poll(
                query.get("queue_id", [""])[0],
                int(query.get("last_event_id", ["-1"])[0]),
            )
            self._json(status, payload)
            return
        self._json(404, {"result": "error", "msg": "no such endpoint", "code": "BAD"})


@pytest.fixture
def fake_zulip() -> Any:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.state = FakeZulip()  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


async def test_the_queue_survives_an_expiry_and_delivers_each_message_once(
    fake_zulip: ThreadingHTTPServer,
) -> None:
    port = fake_zulip.server_address[1]
    adapter = ZulipAdapter(
        config=ZulipConnectionConfig(
            url=f"http://127.0.0.1:{port}", email=EMAIL, api_key=API_KEY
        )
    )
    received: list[Any] = []
    delivered = asyncio.Event()

    async def on_message(message: Any) -> None:
        received.append(message)
        if len(received) >= 2:
            delivered.set()

    async def on_command(command: Any) -> None:
        return None

    async def on_join(event: Any) -> None:
        return None

    try:
        await adapter.start(on_message, on_command, on_join, on_join, on_join)
        await asyncio.wait_for(delivered.wait(), timeout=15)
    finally:
        await adapter.stop()

    state: FakeZulip = fake_zulip.state  # type: ignore[attr-defined]

    # One message before the queue expired, one after it was reopened — and the
    # bridge's own post in between never reached the room.
    assert [m.content for m in received] == [
        "first in the topic",
        "after the reconnect",
    ]
    assert [m.message_ref for m in received] == ["1", "3"]
    assert all(m.channel_id == "12" for m in received)
    assert all(m.root_id == "Plan" for m in received)

    # The queue was opened twice, and the second poll of the first one carried
    # the id of the event already handled — so nothing is replayed.
    assert state.registers == 2
    assert state.polls[1] == ("q1", 1)
    assert any(queue == "q2" for queue, _ in state.polls)

    # Credentials travel as basic auth over the bot's own address, not the
    # person's, and the first call is the queue registration.
    expected = "Basic " + base64.b64encode(f"{EMAIL}:{API_KEY}".encode()).decode()
    assert state.authorization == expected
