"""The bot's realtime session: the WebSocket Rocket.Chat delivers events on.

Rocket.Chat's realtime API speaks DDP. Its method calls are deprecated in
favour of REST, so this uses only what is still supported: the `login` that
every subscription needs first, the subscriptions themselves, and ping/pong.
Everything the bridge *does* goes over REST; this only listens.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import ssl
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit

import websockets
from websockets.asyncio.client import ClientConnection

logger = logging.getLogger(__name__)

# Every message the bot can see, in every room it is in, on one subscription.
MY_MESSAGES = "__my_messages__"

_HANDSHAKE_TIMEOUT_SECONDS = 15.0
_FIRST_RETRY_SECONDS = 1.0
_LAST_RETRY_SECONDS = 60.0

# An event as it is queued: the stream, the event name and its arguments. None
# on the queue marks the session having just (re)subscribed, so what happened
# while it was not listening is to be read back now.
_Event = tuple[str, str, list[Any]]


class RealtimeLoginRefused(Exception):
    """The server would not log the token in, so no subscription can start."""


class RealtimeSession:
    """Keep one DDP session open, logged in and subscribed, until stopped.

    Events are handed over one at a time, in the order they arrived, from a
    queue of their own: the socket keeps answering pings while a handler is
    busy downloading a file, and a slow handler never reorders a room.
    """

    def __init__(
        self,
        *,
        url: str,
        user_id: str,
        token: str,
        ssl_context: ssl.SSLContext | None,
        resolve: Callable[[str, int], Awaitable[list[str]]],
        on_event: Callable[[str, str, list[Any]], Awaitable[None]],
        on_subscribed: Callable[[], Awaitable[None]],
    ) -> None:
        self._url = url
        self._user_id = user_id
        self._token = token
        self._ssl = ssl_context
        self._resolve = resolve
        self._on_event = on_event
        self._on_subscribed = on_subscribed
        self._queue: asyncio.Queue[_Event | None] = asyncio.Queue()
        self._tasks: list[asyncio.Task[None]] = []

    def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._connect_forever(), name="rocketchat-socket"),
            asyncio.create_task(self._deliver_forever(), name="rocketchat-events"),
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []

    async def _connect_forever(self) -> None:
        delay = _FIRST_RETRY_SECONDS
        while True:
            try:
                socket = await self._connect()
                async with socket:
                    await self._open(socket)
                    delay = _FIRST_RETRY_SECONDS
                    await self._read(socket)
                logger.warning("Rocket.Chat closed the realtime connection")
            except asyncio.CancelledError:
                raise
            except RealtimeLoginRefused as refused:
                logger.error(
                    "Rocket.Chat refused to log the bot in on the realtime "
                    "connection, so no messages reach Switch: %s. Check the "
                    "bridge's bot user id and personal access token.",
                    refused,
                )
                delay = _LAST_RETRY_SECONDS
            except Exception as error:
                logger.warning("Rocket.Chat realtime connection failed: %r", error)
            wait = delay * random.uniform(0.5, 1.0)
            logger.info("Reconnecting to Rocket.Chat in %.1fs", wait)
            await asyncio.sleep(wait)
            delay = min(delay * 2, _LAST_RETRY_SECONDS)

    async def _connect(self) -> ClientConnection:
        """Open the socket on an address `resolve` allowed, resolved just now.

        Connecting to the checked address rather than the name means the name
        cannot resolve somewhere else between the check and the connection.
        TLS and the `Host` header still carry the name from the URL.
        """
        parts = urlsplit(self._url)
        secure = parts.scheme == "wss"
        port = parts.port or (443 if secure else 80)
        addresses = await self._resolve(parts.hostname or "", port)
        return await websockets.connect(
            self._url,
            host=addresses[0],
            port=port,
            ssl=self._ssl if secure else None,
            # Through a proxy, the address checked would be the proxy's.
            proxy=None,
            open_timeout=_HANDSHAKE_TIMEOUT_SECONDS,
            max_size=None,
        )

    async def _open(self, socket: ClientConnection) -> None:
        """Connect, log in and subscribe; return once every subscription is ready."""
        await _send(socket, {"msg": "connect", "version": "1", "support": ["1"]})
        await _expect(socket, lambda m: m.get("msg") == "connected")
        await _send(
            socket,
            {
                "msg": "method",
                "method": "login",
                "id": "login",
                "params": [{"resume": self._token}],
            },
        )
        result = await _expect(
            socket, lambda m: m.get("msg") == "result" and m.get("id") == "login"
        )
        if "error" in result:
            error = result["error"]
            reason = error.get("reason") or error.get("message") or error
            raise RealtimeLoginRefused(str(reason))
        subscriptions = {
            "messages": ("stream-room-messages", MY_MESSAGES),
            "rooms": ("stream-notify-user", f"{self._user_id}/subscriptions-changed"),
        }
        for sub_id, (stream, event) in subscriptions.items():
            await _send(
                socket,
                {"msg": "sub", "id": sub_id, "name": stream, "params": [event, False]},
            )
        pending = set(subscriptions)
        while pending:
            reply = await _expect(socket, lambda m: m.get("msg") in ("ready", "nosub"))
            if reply["msg"] == "nosub":
                raise RuntimeError(
                    f"Rocket.Chat refused the {reply.get('id')} subscription: "
                    f"{reply.get('error')}"
                )
            pending -= set(reply.get("subs", []))
        logger.info("Rocket.Chat realtime connection subscribed")
        self._queue.put_nowait(None)

    async def _read(self, socket: ClientConnection) -> None:
        async for raw in socket:
            message = _parse(raw)
            if message is None:
                continue
            kind = message.get("msg")
            if kind == "ping":
                await _send(socket, {"msg": "pong", **_echo_id(message)})
            elif kind == "changed":
                fields = message.get("fields") or {}
                args = fields.get("args")
                if isinstance(args, list):
                    self._queue.put_nowait(
                        (
                            str(message.get("collection", "")),
                            str(fields.get("eventName", "")),
                            args,
                        )
                    )

    async def _deliver_forever(self) -> None:
        while True:
            item = await self._queue.get()
            try:
                if item is None:
                    await self._on_subscribed()
                else:
                    await self._on_event(*item)
            except asyncio.CancelledError:
                raise
            except Exception:
                # One bad event must not stop the ones behind it.
                logger.exception("Failed to handle a Rocket.Chat realtime event")


async def _send(socket: ClientConnection, message: dict[str, Any]) -> None:
    await socket.send(json.dumps(message))


async def _expect(
    socket: ClientConnection, wanted: Callable[[dict[str, Any]], bool]
) -> dict[str, Any]:
    """The next message `wanted` accepts, answering pings while waiting."""
    async with asyncio.timeout(_HANDSHAKE_TIMEOUT_SECONDS):
        while True:
            message = _parse(await socket.recv())
            if message is None:
                continue
            if message.get("msg") == "ping":
                await _send(socket, {"msg": "pong", **_echo_id(message)})
            elif wanted(message):
                return message


def _parse(raw: str | bytes) -> dict[str, Any] | None:
    try:
        message = json.loads(raw)
    except ValueError:
        logger.warning("Ignoring a Rocket.Chat realtime frame that is not JSON")
        return None
    return message if isinstance(message, dict) else None


def _echo_id(ping: dict[str, Any]) -> dict[str, Any]:
    return {"id": ping["id"]} if "id" in ping else {}
