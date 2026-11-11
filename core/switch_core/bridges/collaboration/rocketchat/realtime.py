"""Rocket.Chat's realtime API: DDP over a WebSocket, for what arrives.

Sending goes through REST (`client.py`). This holds one connection open, logs
in with the personal access token, subscribes to the bot's own message stream
and subscription changes, and hands each event to the adapter one at a time,
reconnecting for as long as it runs.

Events are queued rather than handled on the reader, because the server closes
a connection that stops answering its pings, and handling one event can take as
long as downloading a file.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)

_MY_MESSAGES = "__my_messages__"

# How long the server has to answer the handshake, and how long a connection may
# stay silent. The server pings every 30 seconds or so.
_HANDSHAKE_SECONDS = 15.0
_SILENCE_SECONDS = 75.0

_BACKOFF_FIRST_SECONDS = 1.0
_BACKOFF_MOST_SECONDS = 60.0

# Enough for any burst a person can make; past it the reader stops taking
# frames, and the socket's own flow control holds the server back.
_QUEUE_SIZE = 1000


class RealtimeLoginRefused(Exception):
    """The server turned the token down on the realtime connection."""


@dataclass(frozen=True)
class RoomMessage:
    """A message created or changed in a room the bot is in."""

    message: dict[str, Any]
    room_type: str | None
    room_name: str | None


@dataclass(frozen=True)
class SubscriptionAdded:
    """The bot was added to a room."""

    subscription: dict[str, Any]


RealtimeEvent = RoomMessage | SubscriptionAdded


def websocket_url(server_url: str) -> str:
    """The realtime address of a server, from its web address."""
    parts = urlsplit(server_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    path = f"{parts.path.rstrip('/')}/websocket"
    return urlunsplit((scheme, parts.netloc, path, "", ""))


def parse_event(frame: dict[str, Any], *, bot_id: str) -> RealtimeEvent | None:
    """The event in one DDP `changed` frame, or None if it is not one we want."""
    if frame.get("msg") != "changed":
        return None
    fields = frame.get("fields")
    if not isinstance(fields, dict):
        return None
    args = fields.get("args")
    if not isinstance(args, list) or not args:
        return None
    collection = frame.get("collection")
    if collection == "stream-room-messages":
        if not isinstance(args[0], dict):
            return None
        room = args[1] if len(args) > 1 and isinstance(args[1], dict) else {}
        return RoomMessage(args[0], room.get("roomType"), room.get("roomName"))
    if (
        collection == "stream-notify-user"
        and fields.get("eventName") == f"{bot_id}/subscriptions-changed"
        and args[0] == "inserted"
        and len(args) > 1
        and isinstance(args[1], dict)
    ):
        return SubscriptionAdded(args[1])
    return None


class RealtimeConnection:
    """One bot's connection to a server's realtime API, kept open until stopped.

    `on_connected` runs after each successful subscribe, the first time and
    every time after a drop, so whatever was missed while the connection was
    down can be read back. It runs ahead of the events queued behind it.
    """

    def __init__(
        self,
        *,
        url: str,
        token: str,
        bot_id: str,
        on_event: Callable[[RealtimeEvent], Awaitable[None]],
        on_connected: Callable[[], Awaitable[None]],
        dial: Callable[[str], Awaitable[ClientConnection]],
    ) -> None:
        self._url = url
        self._token = token
        self._bot_id = bot_id
        self._on_event = on_event
        self._on_connected = on_connected
        self._dial = dial
        self._queue: asyncio.Queue[RealtimeEvent | Callable[[], Awaitable[None]]] = (
            asyncio.Queue(_QUEUE_SIZE)
        )
        self._tasks: list[asyncio.Task[None]] = []
        self._ready = asyncio.Event()
        self._failure: Exception | None = None

    async def start(self) -> None:
        """Connect, and return once subscribed.

        A refused token is raised here, where the operator sees it. A server
        that cannot be reached is not: the connection keeps trying."""
        self._tasks = [
            asyncio.create_task(self._run(), name="rocketchat-realtime"),
            asyncio.create_task(self._drain(), name="rocketchat-events"),
        ]
        await self._ready.wait()
        if self._failure is not None:
            await self.stop()
            raise self._failure

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []

    async def _run(self) -> None:
        delay = _BACKOFF_FIRST_SECONDS
        while True:
            try:
                socket = await self._dial(self._url)
                try:
                    await self._handshake(socket)
                    await self._queue.put(self._on_connected)
                    self._ready.set()
                    delay = _BACKOFF_FIRST_SECONDS
                    await self._read(socket)
                finally:
                    await socket.close()
            except RealtimeLoginRefused as exc:
                logger.error("Rocket.Chat refused the realtime login: %s", exc)
                self._failure = exc
                self._ready.set()
                return
            except (OSError, ConnectionClosed, TimeoutError) as exc:
                logger.warning(
                    "Rocket.Chat realtime connection dropped (%s); trying again in "
                    "%.0fs",
                    exc,
                    delay,
                )
            except Exception as exc:
                # Nothing a retry can mend on a first connection, such as an
                # address the outbound policy refuses, so it goes to whoever
                # started this. Later on, nobody is waiting to be told.
                if not self._ready.is_set():
                    self._failure = exc
                    self._ready.set()
                    return
                logger.exception("Rocket.Chat realtime connection failed")
            # Waiting for the server to come back is what a first connection
            # does as well, so `start` is released rather than held up by it.
            self._ready.set()
            await asyncio.sleep(delay * random.uniform(0.5, 1.0))
            delay = min(delay * 2, _BACKOFF_MOST_SECONDS)

    async def _handshake(self, socket: ClientConnection) -> None:
        await _send(socket, {"msg": "connect", "version": "1", "support": ["1"]})
        await self._expect(socket, lambda frame: frame.get("msg") == "connected")

        login = secrets.token_hex(8)
        await _send(
            socket,
            {
                "msg": "method",
                "method": "login",
                "id": login,
                "params": [{"resume": self._token}],
            },
        )
        answer = await self._expect(
            socket,
            lambda frame: frame.get("msg") == "result" and frame.get("id") == login,
        )
        if answer.get("error"):
            error = answer["error"]
            reason = error.get("reason") if isinstance(error, dict) else error
            raise RealtimeLoginRefused(str(reason))

        subscriptions = (
            ("stream-room-messages", _MY_MESSAGES),
            ("stream-notify-user", f"{self._bot_id}/subscriptions-changed"),
        )
        waiting: set[str] = set()
        for name, event in subscriptions:
            ident = secrets.token_hex(8)
            waiting.add(ident)
            await _send(
                socket,
                {
                    "msg": "sub",
                    "id": ident,
                    "name": name,
                    "params": [event, {"useCollection": False, "args": []}],
                },
            )
        while waiting:
            frame = await self._expect(
                socket, lambda f: f.get("msg") in {"ready", "nosub"}
            )
            if frame.get("msg") == "nosub":
                raise ConnectionError(f"the server refused a subscription: {frame}")
            waiting -= set(frame.get("subs") or [])

    async def _expect(
        self, socket: ClientConnection, wanted: Callable[[dict[str, Any]], bool]
    ) -> dict[str, Any]:
        """Read until `wanted` matches, answering pings on the way."""
        async with asyncio.timeout(_HANDSHAKE_SECONDS):
            while True:
                frame = await _receive(socket)
                if frame is None:
                    continue
                if frame.get("msg") == "ping":
                    await _send(socket, {"msg": "pong"})
                elif wanted(frame):
                    return frame

    async def _read(self, socket: ClientConnection) -> None:
        while True:
            async with asyncio.timeout(_SILENCE_SECONDS):
                frame = await _receive(socket)
            if frame is None:
                continue
            if frame.get("msg") == "ping":
                await _send(socket, {"msg": "pong"})
                continue
            event = parse_event(frame, bot_id=self._bot_id)
            if event is not None:
                await self._queue.put(event)

    async def _drain(self) -> None:
        while True:
            item = await self._queue.get()
            try:
                if isinstance(item, RoomMessage | SubscriptionAdded):
                    await self._on_event(item)
                else:
                    await item()
            except Exception:
                logger.exception("Could not handle a Rocket.Chat realtime event")


async def _send(socket: ClientConnection, frame: dict[str, Any]) -> None:
    await socket.send(json.dumps(frame))


async def _receive(socket: ClientConnection) -> dict[str, Any] | None:
    raw = await socket.recv()
    try:
        frame = json.loads(raw)
    except ValueError:
        logger.warning("Rocket.Chat sent a realtime frame that is not JSON")
        return None
    return frame if isinstance(frame, dict) else None
