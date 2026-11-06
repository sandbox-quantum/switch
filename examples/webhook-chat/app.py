"""Run with the core environment; see docs/messaging-platforms/webhook.md.

The receiver's SQLite transaction stores both event receipts and message parts.
Restarting the example therefore does not redisplay a signed retry.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, Field

BODY_LIMIT = 6 * 1024 * 1024
basic = HTTPBasic()


class Send(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    channel_id: str = Field(default="demo", min_length=1, max_length=256)
    thread_id: str | None = Field(default=None, max_length=256)
    # Retrying a failed request must reuse the browser's message_id.
    message_id: str = Field(min_length=1, max_length=256)


def create_app(
    *,
    database: str,
    signing_secret: str,
    inbound_token: str,
    switch_url: str,
    ui_password: str,
) -> FastAPI:
    if min(len(signing_secret), len(inbound_token), len(ui_password)) < 32:
        raise ValueError(
            "Configure three independent random secrets of at least 32 characters"
        )
    if len({signing_secret, inbound_token, ui_password}) != 3:
        raise ValueError("Use different secrets for signing, inbound and UI access")
    parts = urlsplit(switch_url)
    if (
        not parts.hostname
        or parts.username
        or parts.password
        or parts.fragment
        or parts.query
        or (
            parts.scheme != "https"
            and not (
                parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")
            )
        )
    ):
        raise ValueError(
            "SWITCH_WEBHOOK_URL must be HTTPS (loopback HTTP is allowed for development)"
        )
    app = FastAPI()

    @contextmanager
    def connection():
        with sqlite3.connect(database, timeout=2) as db:
            yield db

    with connection() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS parts (
                channel TEXT, message TEXT, part INTEGER, payload TEXT,
                PRIMARY KEY (channel, message, part)
            );
        """)

    def authenticate(credentials: HTTPBasicCredentials = Depends(basic)):
        valid_user = hmac.compare_digest(credentials.username.encode(), b"demo")
        valid_password = hmac.compare_digest(
            credentials.password.encode(), ui_password.encode()
        )
        if not (valid_user and valid_password):
            raise HTTPException(
                401, "Sign in as demo", headers={"WWW-Authenticate": "Basic"}
            )

    @app.post("/events")
    async def receive(request: Request):
        timestamp = request.headers.get("x-switch-timestamp", "")
        if (
            not timestamp.isascii()
            or not timestamp.isdecimal()
            or len(timestamp) > 12
            or abs(time.time() - int(timestamp)) > 300
        ):
            raise HTTPException(401, "Invalid or expired timestamp")
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > BODY_LIMIT:
                raise HTTPException(413, "Payload exceeds 6 MiB")
            body.extend(chunk)
        digest = (
            "sha256="
            + hmac.new(
                signing_secret.encode(),
                timestamp.encode() + b"." + bytes(body),
                hashlib.sha256,
            ).hexdigest()
        )
        if not hmac.compare_digest(
            digest.encode(),
            request.headers.get("x-switch-signature", "").encode(),
        ):
            raise HTTPException(401, "Invalid signature")
        try:
            event = json.loads(body)
            if type(event["version"]) is not int or event["version"] != 1:
                raise ValueError
            event_id = event["event_id"]
            if not isinstance(event_id, str) or not 1 <= len(event_id) <= 256:
                raise ValueError
            kind = event["type"]
            if kind == "connection.check":
                challenge = event["challenge"]
                if not isinstance(challenge, str) or not 1 <= len(challenge) <= 256:
                    raise ValueError
                proof = hmac.new(
                    signing_secret.encode(),
                    b"switch-webhook-check-v1." + challenge.encode(),
                    hashlib.sha256,
                ).hexdigest()
                return PlainTextResponse(proof)
            if kind not in (
                "message.created",
                "message.updated",
                "message.deleted",
                "activity",
            ):
                raise ValueError
            channel, message = event["channel_id"], event["message_id"]
            if not isinstance(channel, str) or not isinstance(message, str):
                raise ValueError
            part = event.get("part", 1)
            if type(part) is not int or part < 1:
                raise ValueError
        except (ValueError, TypeError, KeyError):
            raise HTTPException(400, "Invalid version-one event") from None
        if kind == "activity":
            # Ephemeral state expires; it must not consume durable storage.
            return {"ok": True}
        with connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute(
                "SELECT 1 FROM receipts WHERE id = ?", (event_id,)
            ).fetchone():
                return {"ok": True, "duplicate": True}
            if kind == "message.deleted":
                db.execute(
                    "DELETE FROM parts WHERE channel = ? AND message = ?",
                    (channel, message),
                )
            else:
                if kind == "message.updated":
                    previous = db.execute(
                        "SELECT payload FROM parts WHERE channel = ? AND message = ? LIMIT 1",
                        (channel, message),
                    ).fetchone()
                    if previous:
                        original = json.loads(previous[0])
                        event.setdefault(
                            "sender_name", original.get("sender_name", "Switch")
                        )
                        event.setdefault("thread_id", original.get("thread_id"))
                    db.execute(
                        "DELETE FROM parts WHERE channel = ? AND message = ?",
                        (channel, message),
                    )
                db.execute(
                    "INSERT OR REPLACE INTO parts VALUES (?, ?, ?, ?)",
                    (channel, message, part, json.dumps(event)),
                )
            db.execute("INSERT INTO receipts VALUES (?)", (event_id,))
        return {"ok": True}

    @app.post("/send", dependencies=[Depends(authenticate)])
    async def send(message: Send):
        envelope = {
            "version": 1,
            "type": "message.created",
            "event_id": message.message_id,
            "message_id": message.message_id,
            "channel_id": message.channel_id,
            "sender_id": "demo-user",
            "sender_name": "Demo user",
            "text": message.text,
            "thread_id": message.thread_id or None,
        }
        try:
            async with httpx.AsyncClient(timeout=35, follow_redirects=False) as client:
                response = await client.post(
                    switch_url,
                    json=envelope,
                    headers={"authorization": "Bearer " + inbound_token},
                )
        except httpx.HTTPError:
            raise HTTPException(
                503, "Switch unavailable; retry with the same message_id"
            ) from None
        if response.status_code != 200:
            raise HTTPException(
                response.status_code, "Switch refused the event; see its status code"
            )
        return {"ok": True, "message_id": message.message_id}

    @app.get("/state", dependencies=[Depends(authenticate)])
    async def state():
        with connection() as db:
            rows = db.execute("SELECT payload FROM parts ORDER BY rowid").fetchall()
        groups = {}
        for (payload,) in rows:
            event = json.loads(payload)
            groups.setdefault((event["channel_id"], event["message_id"]), []).append(
                event
            )
        messages = []
        for (channel, message), chunks in groups.items():
            chunks.sort(key=lambda e: e["part"])
            if len(chunks) != chunks[0]["parts"]:
                continue  # Render Markdown only after every part arrives.
            messages.append(
                {
                    "channel_id": channel,
                    "message_id": message,
                    "sender_name": chunks[0].get("sender_name", "Switch"),
                    "thread_id": chunks[0].get("thread_id"),
                    "text": "".join(e.get("text", "") for e in chunks),
                    "files": [
                        f["filename"] for e in chunks for f in e.get("attachments", [])
                    ],
                }
            )
        return messages

    @app.get("/", response_class=HTMLResponse, dependencies=[Depends(authenticate)])
    async def index():
        return """<!doctype html><meta charset="utf-8"><title>Switch webhook chat</title>
<h1>Switch webhook chat</h1><p>Sign in as demo. Type !invite-agent NAME, then @NAME hello.</p>
<form id="chat"><input id="channel" value="demo" aria-label="Channel">
<input id="thread" placeholder="Thread root message ID (optional)" aria-label="Thread">
<textarea id="text" required aria-label="Message"></textarea><button>Send / retry</button></form>
<p id="status"></p><pre id="messages"></pre><script>
let pending;
document.getElementById('chat').onsubmit = async e => {
 e.preventDefault();
 const input = {channel_id: document.getElementById('channel').value,
  thread_id: document.getElementById('thread').value || null,
  text: document.getElementById('text').value};
 if (!pending || JSON.stringify(pending.input) !== JSON.stringify(input))
  pending = {input, id: crypto.randomUUID()};
 const response = await fetch('/send', {method:'POST', headers:{'Content-Type':'application/json'},
  body:JSON.stringify({...pending.input, message_id:pending.id})});
 document.getElementById('status').textContent = response.ok ?
  'Sent: ' + pending.id : 'HTTP ' + response.status + '; retry with the same text';
 if (response.ok) pending = null;
};
async function refresh() {
 const response = await fetch('/state');
 if(response.ok) document.getElementById('messages').textContent =
  JSON.stringify(await response.json(), null, 2);
}
setInterval(refresh, 1500); refresh();
</script>"""

    return app


if __name__ == "__main__":
    import uvicorn

    app = create_app(
        database=os.environ.get(
            "WEBHOOK_DEMO_DB", str(Path(__file__).with_name("chat.sqlite3"))
        ),
        signing_secret=os.environ["WEBHOOK_SIGNING_SECRET"],
        inbound_token=os.environ["WEBHOOK_INBOUND_TOKEN"],
        switch_url=os.environ["SWITCH_WEBHOOK_URL"],
        ui_password=os.environ["WEBHOOK_DEMO_PASSWORD"],
    )
    uvicorn.run(app, host="127.0.0.1", port=8787)
