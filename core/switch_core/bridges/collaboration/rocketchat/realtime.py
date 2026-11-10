"""Rocket.Chat's realtime API: the one connection events arrive on.

A DDP session over a WebSocket. It stays connected for as long as `run` does,
reconnecting with a growing delay, and says when each connection is ready so
the adapter can read back whatever was said while there was none.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import ssl
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import websockets
from websockets.asyncio.client import ClientConnection
from websockets.exceptions import WebSocketException

from switch_core.outbound import OutboundPolicy

logger = logging.getLogger(__name__)

_CALL_TIMEOUT_SECONDS = 15.0
_FIRST_RETRY_SECONDS = 1.0
_LAST_RETRY_SECONDS = 60.0
# A DDP frame is a message and its metadata, so this only has to be above the
# server's own `Message_MaxAllowedSize` by a margin no setting reaches.
_MAX_FRAME_BYTES = 8 * 1024 * 1024

#: A stream event: (stream, event name, arguments).
EventHandler = Callable[[str, str, list[Any]], None]


class RealtimeError(Exception):
    """A call on the realtime connection failed, or there is no connection."""


class RealtimeRefused(RealtimeError):
    """The server answered a call with an error."""


class RealtimeLoginRefused(RealtimeError):
    """The server refused the token this connection logged in with."""


def websocket_url(server_url: str) -> str:
    parts = urlsplit(server_url)
    scheme = "wss" if parts.scheme == "https" else "ws"
    path = parts.path.rstrip("/") + "/websocket"
    return urlunsplit((scheme, parts.netloc, path, "", ""))


class RocketChatRealtime:
    def __init__(
        self,
        *,
        url: str,
        token: str,
        policy: OutboundPolicy,
        verify_tls: bool,
        subscriptions: list[tuple[str, str]],
        on_event: EventHandler,
        on_ready: Callable[[], None],
        on_login_refused: Callable[[], None],
    ) -> None:
        self._url = websocket_url(url)
        self._token = token
        self._policy = policy
        self._verify_tls = verify_tls
        self._subscriptions = subscriptions
        self._on_event = on_event
        self._on_ready = on_ready
        self._on_login_refused = on_login_refused
        self._socket: ClientConnection | None = None
        self._last_id = 0
        self._waiting: dict[str, asyncio.Future[Any]] = {}
        self._session_opened: asyncio.Future[None] | None = None
        self._opened = False

    @property
    def connected(self) -> bool:
        return self._socket is not None

    async def call(self, method: str, params: list[Any]) -> Any:
        """Call a method on the live connection and return its result."""
        return await self._exchange({"msg": "method", "method": method}, params)

    async def run(self) -> None:
        """Stay connected until cancelled."""
        delay = _FIRST_RETRY_SECONDS
        while True:
            self._opened = False
            try:
                await self._connection()
            except RealtimeLoginRefused:
                logger.error(
                    "Rocket.Chat refused the realtime login at %s, so no messages "
                    "will arrive until the bot's personal access token is replaced",
                    self._url,
                )
                self._on_login_refused()
                delay = _LAST_RETRY_SECONDS
            except (
                OSError,
                TimeoutError,
                ValueError,
                RealtimeError,
                WebSocketException,
            ) as exc:
                logger.warning(
                    "Rocket.Chat realtime connection to %s dropped: %s",
                    self._url,
                    exc,
                )
            if self._opened:
                delay = _FIRST_RETRY_SECONDS
            await asyncio.sleep(delay * random.uniform(0.8, 1.2))
            delay = min(delay * 2, _LAST_RETRY_SECONDS)

    async def _connection(self) -> None:
        """One connection, from opening it to losing it."""
        parts = urlsplit(self._url)
        secure = parts.scheme == "wss"
        host = parts.hostname or ""
        port = parts.port or (443 if secure else 80)
        # Connect to an address the policy checked, so a name that resolves
        # differently a moment later cannot move the socket somewhere else.
        addresses = await self._policy.resolve(host, port)
        options: dict[str, Any] = {}
        if secure:
            options["ssl"] = self._tls_context()
            options["server_hostname"] = host
        socket = await self._dial(addresses, port, options)
        async with socket:
            reader = asyncio.create_task(self._read(socket))
            try:
                await self._open_session(socket, reader)
                self._opened = True
                self._on_ready()
                await reader
            finally:
                reader.cancel()
                await asyncio.gather(reader, return_exceptions=True)
                self._socket = None
                self._fail_waiting("The realtime connection closed.")

    async def _dial(
        self, addresses: list[str], port: int, options: dict[str, Any]
    ) -> ClientConnection:
        """Each checked address in turn, as the REST client tries them."""
        failure: OSError | None = None
        for address in addresses:
            try:
                return await websockets.connect(
                    self._url,
                    host=address,
                    port=port,
                    proxy=None,
                    max_size=_MAX_FRAME_BYTES,
                    **options,
                )
            except OSError as exc:
                failure = exc
        raise failure or RealtimeError("The server's name resolved to no address.")

    async def _open_session(
        self, socket: ClientConnection, reader: asyncio.Task[None]
    ) -> None:
        """Log in and subscribe. Raises if the connection ends before that."""
        loop = asyncio.get_running_loop()
        self._session_opened = loop.create_future()
        await socket.send(
            json.dumps({"msg": "connect", "version": "1", "support": ["1"]})
        )
        await self._before_reader_ends(reader, self._session_opened)
        self._socket = socket
        try:
            await self._before_reader_ends(
                reader,
                self.call("login", [{"resume": self._token}]),
            )
        except RealtimeRefused as exc:
            raise RealtimeLoginRefused(str(exc)) from exc
        for stream, event in self._subscriptions:
            await self._before_reader_ends(
                reader,
                self._exchange(
                    {"msg": "sub", "name": stream},
                    [event, {"useCollection": False, "args": []}],
                ),
            )

    async def _before_reader_ends(
        self, reader: asyncio.Task[None], step: Awaitable[Any]
    ) -> Any:
        waiting = asyncio.ensure_future(step)
        try:
            done, _ = await asyncio.wait(
                {waiting, reader},
                timeout=_CALL_TIMEOUT_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if waiting in done:
                return waiting.result()
            if reader in done:
                reader.result()
                raise RealtimeError(
                    "The server closed the connection while opening it."
                )
            raise RealtimeError(
                "The server did not answer while opening the connection."
            )
        finally:
            waiting.cancel()
            await asyncio.gather(waiting, return_exceptions=True)

    async def _exchange(self, frame: dict[str, Any], params: list[Any]) -> Any:
        socket = self._socket
        if socket is None:
            raise RealtimeError("There is no realtime connection.")
        self._last_id += 1
        frame_id = str(self._last_id)
        answer: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._waiting[frame_id] = answer
        try:
            await socket.send(json.dumps({**frame, "id": frame_id, "params": params}))
            async with asyncio.timeout(_CALL_TIMEOUT_SECONDS):
                return await answer
        except WebSocketException as exc:
            raise RealtimeError(f"The realtime connection closed: {exc}") from exc
        except TimeoutError as exc:
            raise RealtimeError(f"No answer to {frame}.") from exc
        finally:
            self._waiting.pop(frame_id, None)

    async def _read(self, socket: ClientConnection) -> None:
        async for raw in socket:
            try:
                frame = json.loads(raw)
            except ValueError:
                logger.warning("Ignoring a realtime frame that is not JSON")
                continue
            if isinstance(frame, dict):
                await self._receive(socket, frame)

    async def _receive(self, socket: ClientConnection, frame: dict[str, Any]) -> None:
        kind = frame.get("msg")
        if kind == "ping":
            await socket.send(json.dumps({"msg": "pong"}))
        elif kind == "connected":
            if self._session_opened is not None and not self._session_opened.done():
                self._session_opened.set_result(None)
        elif kind == "result":
            self._settle(str(frame.get("id")), frame.get("result"), frame.get("error"))
        elif kind == "ready":
            for frame_id in frame.get("subs", []):
                self._settle(str(frame_id), None, None)
        elif kind == "nosub":
            self._settle(
                str(frame.get("id")), None, frame.get("error") or "subscription ended"
            )
        elif kind == "changed":
            fields = frame.get("fields") or {}
            try:
                self._on_event(
                    str(frame.get("collection")),
                    str(fields.get("eventName")),
                    list(fields.get("args") or []),
                )
            except Exception:
                # Broad because one event the server shaped unexpectedly must
                # not end the connection every other event arrives on.
                logger.exception("Could not take a Rocket.Chat realtime event")

    def _settle(self, frame_id: str, result: Any, error: Any) -> None:
        answer = self._waiting.get(frame_id)
        if answer is None or answer.done():
            return
        if error:
            answer.set_exception(RealtimeRefused(_error_text(error)))
        else:
            answer.set_result(result)

    def _fail_waiting(self, reason: str) -> None:
        for answer in self._waiting.values():
            if not answer.done():
                answer.set_exception(RealtimeError(reason))

    def _tls_context(self) -> ssl.SSLContext:
        context = ssl.create_default_context()
        if not self._verify_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        return context


def _error_text(error: Any) -> str:
    if isinstance(error, dict):
        return str(error.get("reason") or error.get("message") or error)
    return str(error)
