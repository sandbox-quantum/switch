"""A tiny web chat wired to Switch through the `webhook` messaging platform.

Standard library only. It does both halves of the round trip:

* `POST /switch` receives Switch's signed events (messages, edits, deletes,
  typing, turn activity, approval cards), verifies `X-Switch-Signature-256`
  and keeps them in memory for the page to poll.
* `POST /api/send` and `POST /api/interact` carry what people do in the page
  (a message, a reply, a `!command`, a file, a button press) to the
  connection's inbound webhook address with the bearer token.

State is in memory, so it is lost on restart. Run `python3 server.py`; see
docs/messaging-platforms/webhook.md for the environment it needs.
"""

import hashlib
import hmac
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SIGNING_SECRET = os.environ["SWITCH_SIGNING_SECRET"]
INBOUND_URL = os.environ["SWITCH_INBOUND_URL"]
INBOUND_TOKEN = os.environ["SWITCH_INBOUND_TOKEN"]
PORT = int(os.environ.get("PORT", "9000"))

# Matches the adapter's tolerance for signed requests.
TOLERANCE_SECONDS = 300
TYPING_SECONDS = 8

PAGE = (Path(__file__).parent / "index.html").read_bytes()

lock = threading.Lock()
items: list[dict] = []  # messages and cards, in arrival order
typing: dict[tuple[str, str], float] = {}


def expected_signature(timestamp: str, body: bytes) -> str:
    digest = hmac.new(
        SIGNING_SECRET.encode(), timestamp.encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    return f"sha256={digest}"


def authentic(headers, body: bytes) -> bool:
    timestamp = headers.get("X-Switch-Timestamp", "")
    given = headers.get("X-Switch-Signature-256", "")
    if not timestamp.isdecimal() or abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
        return False
    return hmac.compare_digest(given, expected_signature(timestamp, body))


def find(message_id: str) -> dict | None:
    return next((item for item in items if item["id"] == message_id), None)


def apply_event(event: str, data: dict) -> None:
    """Fold one Switch event into the in-memory chat."""
    if event == "message.created":
        items.append(
            {
                "id": data["message_id"],
                "kind": "message",
                "channel_id": data["channel_id"],
                "thread_root_id": data["thread_root_id"],
                "sender": data["sender_display_name"],
                "sender_type": data["sender_type"],
                "content": data["content"],
                "attachments": data["attachments"],
                "edited": False,
            }
        )
        typing.pop((data["channel_id"], data["sender_name"]), None)
    elif event == "message.updated":
        item = find(data["message_id"])
        if item:
            item["content"], item["edited"] = data["content"], True
    elif event == "message.deleted":
        items[:] = [item for item in items if item["id"] != data["message_id"]]
    elif event == "typing.updated":
        key = (data["channel_id"], data["sender_name"])
        if data["is_typing"]:
            typing[key] = time.time() + TYPING_SECONDS
        else:
            typing.pop(key, None)
    elif event in {"activity.updated", "request.opened", "request.updated"}:
        card = {
            **data,
            "id": data["message_id"],
            "kind": "activity" if event == "activity.updated" else "request",
            "sender": data["sender_display_name"],
        }
        existing = find(card["id"])
        if existing:
            existing.update(card)
        else:
            items.append(card)


def send_to_switch(event: dict) -> None:
    body = json.dumps({"schema_version": 1, "event_id": uuid.uuid4().hex, **event})
    request = urllib.request.Request(
        INBOUND_URL,
        data=body.encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {INBOUND_TOKEN}",
        },
    )
    urllib.request.urlopen(request, timeout=10).close()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: bytes, content_type: str = "application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length", "0")))

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/":
            self.reply(200, PAGE, "text/html; charset=utf-8")
        elif url.path == "/api/state":
            channel = parse_qs(url.query).get("channel", ["general"])[0]
            now = time.time()
            with lock:
                shown = [i for i in items if i["channel_id"] == channel]
                who = [n for (c, n), until in typing.items() if c == channel and until > now]
            self.reply(200, json.dumps({"items": shown, "typing": who}).encode())
        else:
            self.reply(404, b"{}")

    def do_POST(self):
        body = self.read_body()
        if self.path == "/switch":
            if not authentic(self.headers, body):
                return self.reply(401, b'{"error":"bad signature"}')
            envelope = json.loads(body)
            with lock:
                apply_event(envelope["event"], envelope["data"])
            return self.reply(200, b"{}")
        if self.path in {"/api/send", "/api/interact", "/api/join"}:
            request = json.loads(body)
            try:
                if self.path == "/api/send":
                    self.send(request)
                elif self.path == "/api/join":
                    send_to_switch({"type": "channel.joined", **request})
                else:
                    send_to_switch({"type": "interaction", **request})
            except urllib.error.URLError as error:
                return self.reply(502, json.dumps({"error": str(error)}).encode())
            return self.reply(200, b"{}")
        self.reply(404, b"{}")

    def send(self, request: dict) -> None:
        message_id = uuid.uuid4().hex
        event = {"type": "message", "message_id": message_id, **request}
        send_to_switch(event)
        if not request["text"].lstrip().startswith("!"):
            with lock:
                items.append(
                    {
                        "id": message_id,
                        "kind": "message",
                        "channel_id": request["channel_id"],
                        "thread_root_id": request.get("thread_root_id"),
                        "sender": request["sender_name"],
                        "sender_type": "user",
                        "content": request["text"],
                        "attachments": request.get("attachments", []),
                        "edited": False,
                    }
                )


if __name__ == "__main__":
    print(f"webhook-chat on http://localhost:{PORT}  (Switch posts to /switch)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
