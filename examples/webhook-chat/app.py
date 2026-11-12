"""Local webhook v1 demo. Run with the Core uv environment; no model API is used."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import tempfile
import time
import uuid
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import ValidationError

from switch_core.bridges.collaboration.webhook.protocol import Incoming, Outgoing

LIMIT = 8 * 1024 * 1024
DB_PATH = Path(
    os.environ.get(
        "WEBHOOK_CHAT_DB",
        str(Path(tempfile.gettempdir()) / "switch-webhook-chat.sqlite3"),
    )
)
ADMIN_TOKEN = os.environ.get("WEBHOOK_CHAT_ADMIN_TOKEN") or secrets.token_urlsafe(32)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    os.chmod(DB_PATH, 0o600)
    db.row_factory = sqlite3.Row
    db.executescript("""
        CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, data TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
    """)
    try:
        with db:
            yield db
    finally:
        db.close()


def settings(db: sqlite3.Connection) -> dict[str, str]:
    return {row["name"]: row["value"] for row in db.execute("SELECT * FROM settings")}


def require_admin(request: Request) -> None:
    if not hmac.compare_digest(
        request.headers.get("authorization", "").encode(),
        f"Bearer {ADMIN_TOKEN}".encode(),
    ):
        raise HTTPException(401, "Enter the demo admin token printed by the server")


async def body(request: Request) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > LIMIT:
            raise HTTPException(413, "Request exceeds 8 MiB")
    return bytes(data)


def queue(db: sqlite3.Connection, event: dict[str, Any]) -> None:
    encoded = json.dumps(event)
    db.execute(
        "INSERT INTO outbox VALUES (?, ?, 'pending', NULL)",
        (event["event_id"], encoded),
    )
    if event["type"] == "message":
        display = {
            "message_id": event["message_id"],
            "sender_name": "You",
            "text": event["text"],
            "thread_id": event["thread_id"],
            "attachments": event["attachments"],
            "type": "message.create",
        }
        db.execute(
            "INSERT INTO messages VALUES (?, ?)",
            (event["message_id"], json.dumps(display)),
        )


async def flush_once(client: httpx.AsyncClient) -> None:
    with connect() as db:
        config = settings(db)
        rows = list(
            db.execute(
                "SELECT id, data FROM outbox WHERE state = 'pending' ORDER BY rowid LIMIT 20"
            )
        )
    if not config.get("inbound_url"):
        return
    for row in rows:
        try:
            response = await client.post(
                config["inbound_url"],
                content=row["data"],
                headers={
                    "authorization": f"Bearer {config['inbound_token']}",
                    "content-type": "application/json",
                },
            )
            code = response.status_code
            state = (
                "delivered"
                if code == 200
                else "failed"
                if 400 <= code < 500 and code not in (408, 429)
                else "pending"
            )
            error = None if state == "delivered" else f"Switch returned HTTP {code}"
        except httpx.TransportError:
            state, error = "pending", "Switch is unreachable; retrying"
        with connect() as db:
            db.execute(
                "UPDATE outbox SET state = ?, error = ? WHERE id = ?",
                (state, error, row["id"]),
            )
        if state == "pending":
            break


@asynccontextmanager
async def lifespan(app: FastAPI):
    with connect():
        pass
    print(f"Webhook demo admin token (keep private): {ADMIN_TOKEN}", flush=True)

    async def worker():
        async with httpx.AsyncClient(
            timeout=30, follow_redirects=False, trust_env=False
        ) as client:
            while True:
                await flush_once(client)
                await asyncio.sleep(1)

    task = asyncio.create_task(worker())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(lifespan=lifespan)


@app.get("/", response_class=HTMLResponse)
async def home():
    return FileResponse(
        Path(__file__).with_name("index.html"), headers={"cache-control": "no-store"}
    )


@app.post("/configure")
async def configure(request: Request):
    require_admin(request)
    data = json.loads(await body(request))
    config = {
        name: str(data.get(name, ""))
        for name in ("inbound_url", "inbound_token", "signing_secret")
    }
    url = urlsplit(config["inbound_url"])
    if url.scheme != "https" and not (
        url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise HTTPException(400, "Use HTTPS, or loopback HTTP for development")
    if not url.hostname or url.username or url.password or url.query or url.fragment:
        raise HTTPException(400, "Invalid Switch webhook URL")
    if any(len(config[name]) < 32 for name in ("inbound_token", "signing_secret")):
        raise HTTPException(400, "Both secrets must be at least 32 characters")
    with connect() as db:
        previous = settings(db)
        if previous and previous != config:
            raise HTTPException(
                409, "Use a new WEBHOOK_CHAT_DB when connecting a different bridge"
            )
        db.executemany("INSERT OR REPLACE INTO settings VALUES (?, ?)", config.items())
        if not previous:
            event_id = uuid.uuid4().hex
            queue(
                db,
                {
                    "version": 1,
                    "event_id": event_id,
                    "type": "channel.join",
                    "channel_id": "demo-chat",
                    "channel_name": "Webhook demo",
                    "channel_type": "channel_private",
                    "sender": {"id": "demo-user", "name": "demo-user", "kind": "human"},
                    "message_id": event_id,
                    "thread_id": None,
                    "text": "",
                    "attachments": [],
                },
            )
    return {"configured": True}


@app.post("/receive")
async def receive(request: Request):
    raw = await body(request)
    with connect() as db:
        config = settings(db)
    if config:
        timestamp = request.headers.get("x-switch-timestamp", "")
        try:
            if abs(time.time() - int(timestamp)) > 300:
                raise ValueError
        except ValueError:
            raise HTTPException(401, "Expired signature") from None
        expected = (
            "sha256="
            + hmac.new(
                config["signing_secret"].encode(),
                timestamp.encode() + b"." + raw,
                hashlib.sha256,
            ).hexdigest()
        )
        if not hmac.compare_digest(
            expected.encode(), request.headers.get("x-switch-signature", "").encode()
        ):
            raise HTTPException(401, "Bad signature")
    try:
        event = Outgoing.model_validate_json(raw).model_dump()
    except (ValueError, KeyError, TypeError, ValidationError):
        raise HTTPException(400, "Invalid webhook v1 event") from None
    ack = {"version": 1, "event_id": event["event_id"]}
    # The pre-connect probe has no credentials or message content and changes no state.
    if event.get("type") == "connection.check":
        return ack
    if not config:
        raise HTTPException(503, "Finish configuring the demo before sending messages")
    kind = event.get("type")
    if kind not in {
        "publication.lookup",
        "message.create",
        "message.update",
        "message.delete",
        "typing",
        "activity",
        "request",
    }:
        raise HTTPException(400, "Unknown event type")
    message_id = event.get("message_id")
    if not isinstance(message_id, str) or not message_id:
        raise HTTPException(400, "A message id is required")
    with connect() as db:
        if kind == "publication.lookup":
            ack["found"] = (
                db.execute(
                    "SELECT 1 FROM messages WHERE id = ?", (message_id,)
                ).fetchone()
                is not None
            )
            return ack
        digest = hashlib.sha256(raw).hexdigest()
        prior = db.execute(
            "SELECT digest FROM receipts WHERE id = ?", (event["event_id"],)
        ).fetchone()
        if prior:
            if prior[0] != digest:
                raise HTTPException(
                    409, "An event id cannot be reused with a different body"
                )
            return ack
        db.execute("INSERT INTO receipts VALUES (?, ?)", (event["event_id"], digest))
        if kind == "typing":
            return ack
        if kind == "message.delete":
            for row in list(db.execute("SELECT id, data FROM messages")):
                current = json.loads(row["data"])
                if row["id"] == message_id or current.get("group_id") == message_id:
                    db.execute("DELETE FROM messages WHERE id = ?", (row["id"],))
        elif kind == "message.update":
            prior = db.execute(
                "SELECT data FROM messages WHERE id = ?", (message_id,)
            ).fetchone()
            if prior is None:
                raise HTTPException(404, "Message not found")
            current = json.loads(prior[0])
            current["text"] = event["text"]
            db.execute(
                "UPDATE messages SET data = ? WHERE id = ?",
                (json.dumps(current), message_id),
            )
            for row in list(
                db.execute("SELECT id, data FROM messages WHERE id != ?", (message_id,))
            ):
                if json.loads(row["data"]).get("group_id") == message_id:
                    db.execute("DELETE FROM messages WHERE id = ?", (row["id"],))
        else:
            db.execute(
                "INSERT OR IGNORE INTO messages VALUES (?, ?)",
                (message_id, json.dumps(event)),
            )
    return ack


@app.post("/send")
async def send(request: Request):
    require_admin(request)
    data = json.loads(await body(request))
    text = str(data.get("text", ""))
    files = data.get("attachments", [])
    if len(text) > 32000 or not isinstance(files, list) or len(files) > 5:
        raise HTTPException(
            400, "At most 32000 characters and five files are supported"
        )
    try:
        if (
            sum(
                len(base64.b64decode(file["data_base64"], validate=True))
                for file in files
            )
            > 5 * 1024 * 1024
        ):
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, "Invalid attachment or more than 5 MiB") from None
    if not text.strip() and not files:
        raise HTTPException(400, "Enter a message or attach a file")
    event_id = uuid.uuid4().hex
    event = {
        "version": 1,
        "event_id": event_id,
        "type": "message",
        "channel_id": "demo-chat",
        "channel_type": "channel_private",
        "sender": {"id": "demo-user", "name": "demo-user", "kind": "human"},
        "message_id": event_id,
        "thread_id": data.get("thread_id") or None,
        "text": text,
        "attachments": files,
    }
    try:
        event = Incoming.model_validate(event).model_dump()
    except ValidationError:
        raise HTTPException(400, "Invalid message, thread, or attachment") from None
    with connect() as db:
        if not settings(db):
            raise HTTPException(409, "Configure the demo first")
        queue(db, event)
    return {"queued": event_id}


@app.get("/messages")
async def messages(request: Request):
    require_admin(request)
    with connect() as db:
        rows = [
            json.loads(row[0])
            for row in db.execute("SELECT data FROM messages ORDER BY rowid")
        ]
        outbox = [
            dict(row)
            for row in db.execute("SELECT id, state, error FROM outbox ORDER BY rowid")
        ]
        configured = bool(settings(db))
    return {"messages": rows, "outbox": outbox, "configured": configured}


@app.get("/file/{message_id}/{index}")
async def download(message_id: str, index: int, request: Request):
    require_admin(request)
    with connect() as db:
        row = db.execute(
            "SELECT data FROM messages WHERE id = ?", (message_id,)
        ).fetchone()
    files = json.loads(row[0]).get("attachments", []) if row else []
    if not 0 <= index < len(files):
        raise HTTPException(404)
    # Serve as a download, never as active HTML from this app's own origin.
    data = base64.b64decode(files[index]["data_base64"], validate=True)
    return Response(
        data,
        media_type="application/octet-stream",
        headers={"content-disposition": "attachment"},
    )
