"""Lark's open platform: the API Switch calls and the socket events arrive on.

`LarkApi` signs every call with the app's tenant access token, fetched with
the App ID and App Secret and kept until shortly before it expires. Losing it
costs one fetch, so it lives in memory on every process that calls the API.

`LarkSocket` holds the long connection: it asks for an address, answers
Lark's ping interval, puts a split event back together, and hands each event
or card press to the adapter, which acknowledges it once it is handled. Lark
pushes an event that is not acknowledged again, so an event is handled at
least once, and the adapter drops a second delivery by the message's own id.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import websockets

from switch_core.bridges.collaboration.lark.protocol import (
    CONTROL,
    DATA,
    Frame,
    FrameError,
    acknowledge,
    decode,
    encode,
    ping,
)

logger = logging.getLogger(__name__)

HOSTS = {"lark": "https://open.larksuite.com", "feishu": "https://open.feishu.cn"}

# Refetch the tenant token this long before Lark says it expires.
_TOKEN_MARGIN = 300.0
# Lark's codes for a tenant token it no longer takes.
_TOKEN_REFUSED = frozenset({99991661, 99991663, 99991668})
_RECONNECT_FIRST = 1.0
_RECONNECT_MOST = 60.0
_CREDENTIALS_RETRY = 300.0
# A split event whose parts do not all arrive is given up after this.
_PARTS_WITHIN = 60.0
_TIMEOUT = httpx.Timeout(20.0, connect=10.0)

ACK = json.dumps({"code": 200}).encode()


class LarkApiError(Exception):
    """Lark refused a call; `code` and `message` are Lark's own."""

    def __init__(self, code: int, message: str, *, status: int) -> None:
        super().__init__(f"{message} (Lark code {code})")
        self.code = code
        self.message = message
        self.status = status


class LarkCredentialsRefused(Exception):
    """Lark does not take the App ID and App Secret."""


class LarkDisconnected(Exception):
    """The long connection closed or could not be opened."""


class LarkTooLarge(Exception):
    """A file is bigger than Switch takes."""


class LarkApi:
    def __init__(
        self,
        *,
        host: str,
        app_id: str,
        app_secret: str,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.host = host
        self._app_id = app_id
        self._app_secret = app_secret
        self._http = http or httpx.AsyncClient(timeout=_TIMEOUT)
        self._owns_http = http is None
        self._token: str | None = None
        self._token_until = 0.0
        self._token_lock = asyncio.Lock()

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def tenant_token(self, *, fresh: bool = False) -> str:
        async with self._token_lock:
            if not fresh and self._token and time.monotonic() < self._token_until:
                return self._token
            response = await self._http.post(
                f"{self.host}/open-apis/auth/v3/tenant_access_token/internal",
                json={"app_id": self._app_id, "app_secret": self._app_secret},
            )
            body = _json(response)
            code = int(body.get("code", -1))
            if code != 0:
                if code in (10003, 10014) or response.status_code in (400, 401, 403):
                    raise LarkCredentialsRefused(
                        str(body.get("msg") or "Lark refused the App ID and App Secret")
                    )
                raise LarkApiError(
                    code, str(body.get("msg") or ""), status=response.status_code
                )
            self._token = str(body["tenant_access_token"])
            self._token_until = (
                time.monotonic() + float(body.get("expire", 7200)) - _TOKEN_MARGIN
            )
            return self._token

    async def call(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """`data` of Lark's answer; a refusal raises `LarkApiError`. A token
        Lark no longer takes is fetched again once."""
        for attempt in range(2):
            token = await self.tenant_token(fresh=attempt == 1)
            response = await self._http.request(
                method,
                f"{self.host}/open-apis{path}",
                json=json_body,
                params=params,
                files=files,
                data=data,
                headers={"Authorization": f"Bearer {token}"},
            )
            body = _json(response)
            code = int(body.get("code", -1))
            if code == 0:
                # Most answers are under `data`; a few (the bot's own) are not.
                answer = body.get("data")
                if isinstance(answer, dict):
                    return answer
                return {k: v for k, v in body.items() if k not in ("code", "msg")}
            if code in _TOKEN_REFUSED and attempt == 0:
                continue
            raise LarkApiError(
                code,
                str(body.get("msg") or f"HTTP {response.status_code}"),
                status=response.status_code,
            )
        raise AssertionError("unreachable")

    async def download(self, path: str, *, params: dict[str, str], limit: int) -> bytes:
        """A message's file, refused once it passes `limit` bytes."""
        token = await self.tenant_token()
        async with self._http.stream(
            "GET",
            f"{self.host}/open-apis{path}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        ) as response:
            if response.status_code != 200:
                body = _json(
                    httpx.Response(response.status_code, content=await response.aread())
                )
                raise LarkApiError(
                    int(body.get("code", -1)),
                    str(body.get("msg") or f"HTTP {response.status_code}"),
                    status=response.status_code,
                )
            size = int(response.headers.get("content-length") or 0)
            if size > limit:
                raise LarkTooLarge(f"{size} bytes")
            out = bytearray()
            async for chunk in response.aiter_bytes():
                out += chunk
                if len(out) > limit:
                    raise LarkTooLarge(f"over {limit} bytes")
            return bytes(out)

    async def socket_address(self) -> tuple[str, float]:
        """Where to open the long connection, and how often to ping it."""
        response = await self._http.post(
            f"{self.host}/callback/ws/endpoint",
            json={"AppID": self._app_id, "AppSecret": self._app_secret},
            headers={"locale": "en"},
        )
        body = _json(response)
        code = int(body.get("code", -1))
        if code != 0:
            message = str(body.get("msg") or f"HTTP {response.status_code}")
            if response.status_code in (401, 403) or code in (514, 1000040343):
                raise LarkCredentialsRefused(message)
            raise LarkDisconnected(f"Lark gave no socket address: {message} ({code})")
        data = body.get("data") or {}
        interval = float((data.get("ClientConfig") or {}).get("PingInterval") or 120)
        return str(data["URL"]), interval


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {"code": -1, "msg": f"HTTP {response.status_code}"}
    return body if isinstance(body, dict) else {"code": -1, "msg": "not an object"}


# What the adapter does with one pushed event or press: `kind` is the frame's
# type (`event` or `card`), `body` the JSON Lark sent. It returns the payload
# to acknowledge with.
Handler = Callable[[str, dict[str, Any]], Awaitable[bytes]]


class LarkSocket:
    def __init__(self, api: LarkApi, handler: Handler, *, name: str) -> None:
        self._api = api
        self._handler = handler
        self._name = name
        self._parts: dict[str, tuple[float, dict[int, bytes]]] = {}
        self.connected = asyncio.Event()

    async def run(self, stopping: asyncio.Event) -> None:
        """Hold the connection until `stopping`, reopening it when it drops.
        App credentials Lark refuses are retried slowly, and said."""
        delay = _RECONNECT_FIRST
        while not stopping.is_set():
            try:
                await self._session(stopping)
                delay = _RECONNECT_FIRST
            except LarkCredentialsRefused as error:
                logger.error(
                    "Lark bridge %s: Lark refused the app's credentials (%s). "
                    "Retrying in %.0fs",
                    self._name,
                    error,
                    _CREDENTIALS_RETRY,
                )
                delay = _CREDENTIALS_RETRY
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.warning(
                    "Lark bridge %s lost its connection: %s. Reconnecting in %.0fs",
                    self._name,
                    error or type(error).__name__,
                    delay,
                )
                delay = min(delay * 2, _RECONNECT_MOST)
            self.connected.clear()
            if stopping.is_set():
                return
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    stopping.wait(), timeout=delay * random.uniform(0.5, 1.0)
                )

    async def _session(self, stopping: asyncio.Event) -> None:
        url, interval = await self._api.socket_address()
        service = _service_id(url)
        # Lark answers its own ping frames, not WebSocket pings.
        async with websockets.connect(url, ping_interval=None, max_size=None) as socket:
            self.connected.set()
            logger.info("Lark bridge %s connected", self._name)
            state = {"interval": interval}

            async def pinger() -> None:
                while True:
                    await socket.send(encode(ping(service)))
                    await asyncio.sleep(state["interval"])

            beat = asyncio.create_task(pinger(), name=f"lark-ping-{self._name}")
            closer = asyncio.create_task(stopping.wait())
            try:
                while not stopping.is_set():
                    receive = asyncio.ensure_future(socket.recv())
                    done, _ = await asyncio.wait(
                        {receive, closer, beat}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if beat in done:
                        beat.result()
                    if receive not in done:
                        receive.cancel()
                        return
                    raw = receive.result()
                    if isinstance(raw, str):
                        continue
                    try:
                        frame = decode(raw)
                    except FrameError as error:
                        logger.warning(
                            "Lark bridge %s skipped a frame it could not read: %s",
                            self._name,
                            error,
                        )
                        continue
                    if frame.method == CONTROL:
                        self._on_control(frame, state)
                        continue
                    if frame.method == DATA:
                        answer = await self._on_data(frame)
                        if answer is not None:
                            await socket.send(encode(acknowledge(frame, answer)))
            except websockets.ConnectionClosed as error:
                raise LarkDisconnected(f"the socket closed ({error.code})") from error
            finally:
                for task in (beat, closer):
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task

    def _on_control(self, frame: Frame, state: dict[str, float]) -> None:
        if frame.header("type") != "pong" or not frame.payload:
            return
        with contextlib.suppress(ValueError, TypeError):
            config = json.loads(frame.payload)
            if config.get("PingInterval"):
                state["interval"] = float(config["PingInterval"])

    async def _on_data(self, frame: Frame) -> bytes | None:
        """The acknowledgement for a data frame once its event is whole and
        handled; None while parts are still to come."""
        kind = frame.header("type") or ""
        message_id = frame.header("message_id") or ""
        total = int(frame.header("sum") or "1")
        seq = int(frame.header("seq") or "0")
        payload = frame.payload or b""
        if total > 1:
            now = time.monotonic()
            for stale, (since, _) in list(self._parts.items()):
                if now - since > _PARTS_WITHIN:
                    self._parts.pop(stale, None)
            _, parts = self._parts.setdefault(message_id, (now, {}))
            parts[seq] = payload
            if len(parts) < total:
                return None
            self._parts.pop(message_id, None)
            payload = b"".join(parts[index] for index in range(total))
        try:
            body = json.loads(payload)
        except ValueError:
            logger.warning("Lark bridge %s got an event that is not JSON", self._name)
            return ACK
        if not isinstance(body, dict):
            return ACK
        return await self._handler(kind, body)


def _service_id(url: str) -> int:
    query = httpx.URL(url).params
    try:
        return int(query.get("service_id") or 0)
    except ValueError:
        return 0
