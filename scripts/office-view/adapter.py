"""Mirror one Switch room into a local Claude-Office.

Signs in to the gateway as a Switch user who is a member of the room, follows
the room's agent activity (``/chats/activity/events``) and messages
(``/chats/events``), and posts the matching events to the office's
``POST /event`` on loopback. Read-only against Switch, apart from ``--join``,
which adds the signed-in user to a room they manage (the same thing Switch
Console's "Join" does).

    uv run --with httpx scripts/office-view/adapter.py \\
        --gateway http://localhost:8000 --email you@example.com --room office-demo

The password comes from ``$OFFICE_VIEW_PASSWORD``. Stop it with Ctrl-C: every
desk it opened clocks out.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mapping import Mapper, OfficeEvent  # noqa: E402

DEFAULT_TOKEN_FILE = (
    Path.home() / ".cache/switch-office-view/home/.agent-office/auth-token"
)
BACKOFF = (1, 2, 5, 10, 20)


class Refused(Exception):
    """A reason to stop that the operator has to act on."""


def log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", file=sys.stderr, flush=True)


async def sse(client: httpx.AsyncClient, path: str) -> AsyncIterator[tuple[str, Any]]:
    """(event, data) pairs from one server-sent-events stream, until it ends."""
    async with client.stream(
        "GET", path, timeout=httpx.Timeout(10, read=90)
    ) as response:
        if response.status_code != 200:
            raise httpx.HTTPStatusError(
                f"{path} answered {response.status_code}",
                request=response.request,
                response=response,
            )
        event, data = "message", []
        async for line in response.aiter_lines():
            if line == "":
                if data:
                    yield event, json.loads("\n".join(data))
                event, data = "message", []
            elif line.startswith(":"):
                continue
            elif line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())


class Office:
    def __init__(self, url: str, token: str, record: Path | None):
        self.client = httpx.AsyncClient(
            base_url=url, timeout=5, headers={"Authorization": f"Bearer {token}"}
        )
        self.record = record.open("a") if record else None

    async def check(self) -> None:
        try:
            config = (await self.client.get("/config")).json()
        except httpx.HTTPError as e:
            raise Refused(
                f"the office at {self.client.base_url} does not answer ({e}); start it with office.sh start"
            ) from e
        if config.get("version") != "1.3.0":
            raise Refused(
                f"the office at {self.client.base_url} is version {config.get('version')}, office-view supports only 1.3.0"
            )

    async def send(self, events: list[OfficeEvent]) -> None:
        for event in events:
            try:
                r = await self.client.post("/event", json=event)
                if r.status_code != 200:
                    log(
                        f"office refused {event['type']}: {r.status_code} {r.text[:200]}"
                    )
                    continue
            except httpx.HTTPError as e:
                log(f"office unreachable, dropped {event['type']}: {e}")
                continue
            if self.record:
                self.record.write(
                    json.dumps({"at": int(time.time() * 1000), **event}) + "\n"
                )
                self.record.flush()
            log(
                f"-> {event['type']:<18} {event.get('sessionId', '')} {event.get('text') or event.get('status') or event.get('summary') or ''}"[
                    :160
                ]
            )


class Room:
    """The gateway side: sign-in, the room, its snapshot and its streams."""

    def __init__(self, gateway: str, email: str, password: str):
        self.client = httpx.AsyncClient(
            base_url=gateway.rstrip("/") + "/gateway", timeout=30
        )
        self.email, self.password = email, password

    async def sign_in(self) -> dict[str, Any]:
        r = await self.client.post(
            "/auth/login", json={"email": self.email, "password": self.password}
        )
        if r.status_code != 200:
            raise Refused(
                f"signing in to {self.client.base_url} as {self.email} failed: {r.status_code} {r.text[:200]}"
            )
        self.client.headers["Cookie"] = f"switch_auth={r.cookies.get('switch_auth')}"
        return (await self.client.get("/auth/me")).raise_for_status().json()

    async def chats(self) -> list[dict[str, Any]]:
        data = (await self.client.get("/chats")).raise_for_status().json()
        return data.get("chats", data)

    async def find(self, wanted: str, me: dict[str, Any], join: bool) -> dict[str, Any]:
        for chat in await self.chats():
            if wanted in (chat["roomId"], chat["name"]):
                return chat
        rooms = (await self.client.get("/rooms")).raise_for_status().json()
        rooms = rooms if isinstance(rooms, list) else rooms.get("rooms", [])
        match = next((r for r in rooms if wanted in (r["id"], r["name"])), None)
        if match is None:
            raise Refused(
                f"room {wanted!r} does not exist, or {self.email} cannot see it"
            )
        if not join:
            raise Refused(
                f"{self.email} cannot read room {match['name']!r}: they are not a member of it (pass --join if they manage it)"
            )
        r = await self.client.post(
            f"/chats/{match['id']}/members", json={"user_id": me["id"]}
        )
        if r.status_code != 200:
            raise Refused(
                f"{self.email} cannot read room {match['name']!r} and could not join it: {r.status_code} {r.text[:200]}"
            )
        log(f"joined room {match['name']!r} as {self.email}")
        for chat in await self.chats():
            if chat["roomId"] == match["id"]:
                return chat
        raise Refused(
            f"joined room {match['name']!r} but it is still not among {self.email}'s chats"
        )

    async def snapshot(
        self, room_id: str
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        activity = (
            (await self.client.get(f"/chats/{room_id}/activity"))
            .raise_for_status()
            .json()
        )
        messages = (
            (await self.client.get(f"/chats/{room_id}/messages"))
            .raise_for_status()
            .json()
        )
        return activity["items"], activity["approvals"], messages["messages"]


def agent_names(chat: dict[str, Any]) -> dict[str, str]:
    return {a["id"]: a.get("displayName") or a["name"] for a in chat.get("agents", [])}


async def follow(
    name: str,
    open_stream: Callable[[], AsyncIterator[tuple[str, Any]]],
    on_frame: Callable[[str, Any], Awaitable[None]],
) -> None:
    """Keep one stream open for good: reconnect with backoff, and announce each
    (re)connection as a ``ready`` frame so the caller can catch up."""
    attempt = 0
    while True:
        try:
            async for event, data in open_stream():
                if event == "ready":
                    attempt = 0
                    log(f"{name}: connected")
                await on_frame(event, data)
            log(f"{name}: the stream ended")
        except (httpx.HTTPError, json.JSONDecodeError) as e:
            log(f"{name}: {type(e).__name__}: {e}")
        delay = BACKOFF[min(attempt, len(BACKOFF) - 1)]
        attempt += 1
        log(f"{name}: reconnecting in {delay}s")
        await asyncio.sleep(delay)


async def run(args: argparse.Namespace) -> None:
    password = os.environ.get("OFFICE_VIEW_PASSWORD")
    if not password:
        raise Refused("set OFFICE_VIEW_PASSWORD to the Switch user's password")
    token_file = Path(args.office_token_file).expanduser()
    if not token_file.is_file():
        raise Refused(
            f"no office token at {token_file}; start the office with office.sh start"
        )
    office = Office(
        args.office,
        token_file.read_text().strip(),
        Path(args.record) if args.record else None,
    )
    await office.check()

    room = Room(args.gateway, args.email, password)
    me = await room.sign_in()
    chat = await room.find(args.room, me, args.join)
    room_id = chat["roomId"]
    mapper = Mapper(room_id, agent_names(chat))
    mapper.baseline(*await room.snapshot(room_id))
    log(
        f"following room {chat['name']!r} ({room_id}) with agents {', '.join(mapper.agents.values()) or 'none yet'}"
    )
    await office.send(mapper.open_desks())

    lock = asyncio.Lock()

    async def catch_up() -> None:
        for c in await room.chats():
            if c["roomId"] == room_id:
                mapper.agents.update(agent_names(c))
                break
        else:
            raise Refused(f"{args.email} can no longer read room {chat['name']!r}")
        items, approvals, messages = await room.snapshot(room_id)
        out: list[OfficeEvent] = []
        for item in sorted(items, key=lambda i: i.get("updatedAt", "")):
            out += mapper.activity(item)
        for req in approvals:
            out += mapper.approval(req)
        for msg in sorted(messages, key=lambda m: m.get("seq", 0)):
            out += mapper.message(msg)
        await office.send(out)

    async def on_activity(event: str, data: Any) -> None:
        async with lock:
            if event in ("ready", "resync"):
                await catch_up()
            elif event == "activity":
                await office.send(mapper.activity(data))
            elif event == "approval":
                await office.send(mapper.approval(data))

    async def on_chat(event: str, data: Any) -> None:
        async with lock:
            if event == "message":
                await office.send(mapper.message(data))
            elif event == "chat.removed" and data.get("roomId") == room_id:
                raise Refused(
                    f"room {chat['name']!r} was removed from {args.email}'s chats"
                )

    tasks = [
        asyncio.create_task(
            follow(
                "activity",
                lambda: sse(room.client, "/chats/activity/events"),
                on_activity,
            )
        ),
        asyncio.create_task(
            follow("messages", lambda: sse(room.client, "/chats/events"), on_chat)
        ),
    ]
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    done, _ = await asyncio.wait(
        [*tasks, asyncio.create_task(stop.wait())], return_when=asyncio.FIRST_COMPLETED
    )
    for task in tasks:
        task.cancel()
    log("stopping: everyone clocks out")
    await office.send(mapper.close_desks())
    for task in done:
        if task in tasks and task.exception():
            raise task.exception()


def main() -> None:
    p = argparse.ArgumentParser(
        description="Mirror one Switch room into a local Claude-Office."
    )
    p.add_argument(
        "--gateway", required=True, help="Switch server URL, e.g. http://localhost:8000"
    )
    p.add_argument(
        "--email",
        required=True,
        help="the Switch user to sign in as (password in $OFFICE_VIEW_PASSWORD)",
    )
    p.add_argument("--room", required=True, help="room id or name")
    p.add_argument(
        "--join",
        action="store_true",
        help="join the room first if the user manages it but is not in it",
    )
    p.add_argument(
        "--office", default="http://127.0.0.1:3334", help="the office server"
    )
    p.add_argument("--office-token-file", default=str(DEFAULT_TOKEN_FILE))
    p.add_argument(
        "--record",
        help="append every office event sent, with its time, to this JSONL file",
    )
    try:
        asyncio.run(run(p.parse_args()))
    except Refused as e:
        sys.exit(f"office-view: {e}")


if __name__ == "__main__":
    main()
