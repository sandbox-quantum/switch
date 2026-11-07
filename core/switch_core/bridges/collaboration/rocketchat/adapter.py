"""Rocket.Chat, through one bot user on the operator's own server.

Messages arrive over Rocket.Chat's realtime API (a WebSocket speaking DDP) and
everything Switch does goes out over the REST API. The bot signs in with a
personal access token, so there is no password to store and no session to
refresh.

Every agent posts through that one bot account, under its own name and avatar
(`alias` and `avatar` on `chat.postMessage`). That is a cosmetic override
Rocket.Chat draws on each post, not an account per agent: the agent has no
user to mention, add to a channel or find in the directory, and people reach
it by typing `@agent-name`, which Switch reads from the text.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import ssl
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, ClassVar
from urllib.parse import quote, urlsplit

import httpx
import websockets
from pydantic import field_validator
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    AgentIdentity,
    PlatformAdapter,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    DirectoryUser,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)

#: Rocket.Chat refuses a message longer than `Message_MaxAllowedSize`, 5000
#: characters unless the operator raised it. Posts are cut below that.
MAX_MESSAGE = 4000

_REQUEST_TIMEOUT_SECONDS = 30.0
_RATE_LIMIT_RETRIES = 3
_RATE_LIMIT_MAX_WAIT_SECONDS = 30.0
#: The server pings about every 25 seconds. A socket that says nothing for
#: this long is dead, whatever the operating system thinks.
_SILENCE_LIMIT_SECONDS = 90.0
_RECONNECT_FIRST_SECONDS = 1.0
_RECONNECT_MAX_SECONDS = 30.0
_SEEN_MESSAGES = 5000
_FILE_DOWNLOAD_LIMIT = "the file is larger than the {limit} MB Switch relays"

_REACTIONS: dict[str, str] = {
    "working": ":hourglass_flowing_sand:",
    "queued": ":eyes:",
}

_ROOM_TYPES: dict[str, ChannelType] = {
    "c": "channel_public",
    "p": "channel_private",
    "d": "direct",
}


class RocketChatConnectionConfig(BridgeConnectionConfig):
    url: str
    #: The bot user's id, shown beside the token when it is created under
    #: My Account > Personal Access Tokens.
    user_id: str
    #: A personal access token of the bot user. Created with "Ignore Two Factor
    #: Authentication" ticked, because a bot cannot answer a second factor.
    auth_token: str
    #: The address people open Rocket.Chat at, when it differs from `url` (which
    #: is where Switch connects, possibly an internal address). Used for links.
    public_url: str | None = None
    #: Username of a person to add to every channel this bridge creates. A room
    #: an agent creates names no users, and a private channel the bot alone
    #: belongs to can be read by nobody.
    default_member: str | None = None
    #: Verify the server's TLS certificate. Turn off only for a self-signed
    #: certificate on a server you trust.
    verify_tls: bool = True

    @field_validator("url", "public_url")
    @classmethod
    def _names_a_server(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parts = urlsplit(value.strip())
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
            raise ValueError("must be an http(s) URL naming the server")
        try:
            parts.port
        except ValueError as exc:
            raise ValueError(f"has an invalid port: {exc}") from exc
        return value.strip().rstrip("/")


def _http_client(config: RocketChatConnectionConfig) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=config.url,
        headers={"X-User-Id": config.user_id, "X-Auth-Token": config.auth_token},
        verify=config.verify_tls,
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )


def _socket_url(config: RocketChatConnectionConfig) -> str:
    parts = urlsplit(config.url)
    scheme = "wss" if parts.scheme.lower() == "https" else "ws"
    return f"{scheme}://{parts.netloc}{parts.path.rstrip('/')}/websocket"


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _refusal(response: httpx.Response, body: dict[str, Any]) -> str:
    text = body.get("error") or body.get("message") or body.get("reason")
    return str(text) if text else f"HTTP {response.status_code}"


def _wait_for(response: httpx.Response) -> float:
    retry_after = response.headers.get("Retry-After")
    if retry_after and retry_after.isdigit():
        return min(float(retry_after), _RATE_LIMIT_MAX_WAIT_SECONDS)
    reset = response.headers.get("X-RateLimit-Reset")
    if reset and reset.isdigit():
        return min(
            max(int(reset) / 1000 - time.time(), 1.0), _RATE_LIMIT_MAX_WAIT_SECONDS
        )
    return 2.0


def _millis(value: Any) -> int | None:
    """A Rocket.Chat timestamp as epoch milliseconds: `{"$date": ms}` over the
    realtime API, an ISO string over REST."""
    if isinstance(value, dict):
        value = value.get("$date")
    if isinstance(value, int | float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(
                datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
            )
        except ValueError:
            return None
    return None


def _iso(millis: int) -> str:
    stamp = datetime.fromtimestamp(millis / 1000, UTC)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def split_message(text: str, limit: int = MAX_MESSAGE) -> list[str]:
    """Cut `text` into posts of at most `limit` characters, on line breaks where
    there are any. A code fence open at a cut is closed there and reopened at
    the start of the next post, so neither half renders as prose."""
    if len(text) <= limit:
        return [text]
    pieces: list[str] = []
    current: list[str] = []
    size = 0
    fence: str | None = None

    def flush() -> None:
        nonlocal current, size
        body = "\n".join(current)
        if fence:
            body += "\n```"
        pieces.append(body)
        current = [fence] if fence else []
        size = len(fence) + 1 if fence else 0

    for line in text.split("\n"):
        while len(line) + 4 > limit:
            room = max(limit - size - 4, 1)
            current.append(line[:room])
            line = line[room:]
            flush()
        if size + len(line) + 5 > limit and current:
            flush()
        current.append(line)
        size += len(line) + 1
        if line.lstrip().startswith("```"):
            fence = None if fence else line.strip()
    if any(part.strip() for part in current):
        pieces.append("\n".join(current))
    return pieces


class RocketChatAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Rocket.Chat"
    docs_slug: ClassVar[str | None] = None
    #: A quiet bridge opens no socket. Rocket.Chat sends every message to every
    #: socket the bot has open, so one in each process would hand each process
    #: every message.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    #: One bot account serves every agent, so the platform has one reaction
    #: between them.
    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True
    activity_reactions_per_agent: ClassVar[bool] = False
    channel_mention: ClassVar[str | None] = "@all"

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask the server who the token belongs to, as `start` will."""
        config = RocketChatConnectionConfig.model_validate(connection_config)
        async with _http_client(config) as client:
            try:
                response = await client.get("/api/v1/me")
            except httpx.HTTPError as exc:
                raise BridgeCredentialError(
                    f"Could not reach Rocket.Chat at {config.url} to check the "
                    f"credentials: {exc}"
                ) from exc
        body = _json_object(response)
        if response.status_code in (401, 403):
            raise BridgeCredentialError(
                f"Rocket.Chat refused the user id and token ({_refusal(response, body)}). "
                "Check user_id and auth_token, and that the token was created "
                "with two-factor authentication ignored."
            )
        if response.status_code >= 400 or body.get("success") is False:
            raise BridgeCredentialError(
                f"Rocket.Chat at {config.url} answered {_refusal(response, body)} "
                "when asked who the token belongs to."
            )
        if body.get("_id") != config.user_id:
            raise BridgeCredentialError(
                "Rocket.Chat accepted the token but it belongs to a different "
                "user than user_id. Copy both from the same Personal Access "
                "Token dialog."
            )

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.TimeoutException | httpx.TransportError):
            return "network"
        if isinstance(exc, httpx.HTTPStatusError):
            return "platform_error"
        if isinstance(exc, InvalidStatus):
            return (
                "auth_failed"
                if exc.response.status_code in (401, 403)
                else "platform_error"
            )
        if isinstance(exc, ConnectionClosed | OSError | TimeoutError):
            return "network"
        if isinstance(exc, WebSocketException):
            return "platform_error"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        parts = urlsplit(str(connection_config["url"]).strip())
        host = (parts.hostname or "").lower()
        default = {"http": 80, "https": 443}.get(parts.scheme.lower())
        if parts.port is not None and parts.port != default:
            host = f"{host}:{parts.port}"
        path = parts.path.rstrip("/")
        return f"Rocket.Chat user {connection_config['user_id']} on {host}{path}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [str(connection_config["url"]).strip()]

    def __init__(self, *, config: RocketChatConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._client: httpx.AsyncClient | None = None
        self._bot_id = config.user_id
        self._socket_task: asyncio.Task[None] | None = None
        self._handlers: set[asyncio.Task[None]] = set()
        self._seen: OrderedDict[str, None] = OrderedDict()
        self._rooms: dict[str, dict[str, Any]] = {}
        self._last_seen_ms: int | None = None
        self._connections = 0
        self.socket_failure: str | None = None

    # Lifecycle
    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        self._client = _http_client(self.config)
        me = await self._api("GET", "/api/v1/me")
        self._bot_id = str(me.get("_id") or self.config.user_id)
        if self._listening:
            self._socket_task = asyncio.create_task(self._run_socket())

    async def stop(self) -> None:
        task, self._socket_task = self._socket_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        for handler in list(self._handlers):
            handler.cancel()
        self._handlers.clear()
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    # REST
    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            raise BridgeOperationError("The Rocket.Chat bridge is not running.")
        return self._client

    async def _api(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """One REST call, returning the JSON body.

        Raises `BridgeCredentialError` when the token is refused and
        `BridgeOperationError`, with Rocket.Chat's own wording, for any other
        refusal. A rate limit is waited out a few times before it is one.
        """
        client = self._http()
        for attempt in range(_RATE_LIMIT_RETRIES + 1):
            response = await client.request(
                method, path, json=json, params=params, data=data, files=files
            )
            if response.status_code != 429 or attempt == _RATE_LIMIT_RETRIES:
                break
            await asyncio.sleep(_wait_for(response))
        body = _json_object(response)
        if response.status_code == 401:
            raise BridgeCredentialError(
                f"Rocket.Chat refused the bot's token ({_refusal(response, body)})."
            )
        if response.status_code >= 400 or body.get("success") is False:
            raise BridgeOperationError(
                f"Rocket.Chat refused {method} {path}: {_refusal(response, body)}"
            )
        return body

    async def _room(self, room_id: str) -> dict[str, Any]:
        cached = self._rooms.get(room_id)
        if cached is not None:
            return cached
        body = await self._api("GET", "/api/v1/rooms.info", params={"roomId": room_id})
        room = body.get("room")
        if not isinstance(room, dict):
            raise BridgeOperationError(f"Rocket.Chat has no room {room_id!r}.")
        self._rooms[room_id] = room
        return room

    @staticmethod
    def _channel_type(room: dict[str, Any]) -> ChannelType:
        return _ROOM_TYPES.get(str(room.get("t")), "group")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return self._channel_type(await self._room(channel_id))

    # Inbound: the realtime socket
    async def _run_socket(self) -> None:
        delay = _RECONNECT_FIRST_SECONDS
        while True:
            try:
                await self._socket_session()
                delay = _RECONNECT_FIRST_SECONDS
            except asyncio.CancelledError:
                raise
            except BridgeCredentialError as exc:
                self.socket_failure = str(exc)
                logger.error(
                    "Rocket.Chat refused the bot's sign-in on the realtime "
                    "socket, so nothing posted there reaches Switch until the "
                    "token is fixed: %s",
                    exc,
                )
                return
            except Exception as exc:
                self.socket_failure = f"{type(exc).__name__}: {exc}"
                logger.warning(
                    "Rocket.Chat realtime socket dropped (%s); reconnecting in %.0fs",
                    self.socket_failure,
                    delay,
                )
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RECONNECT_MAX_SECONDS)

    async def _socket_session(self) -> None:
        context: ssl.SSLContext | None = None
        if _socket_url(self.config).startswith("wss://") and not self.config.verify_tls:
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        async with websockets.connect(
            _socket_url(self.config), ssl=context, ping_interval=None, max_size=None
        ) as socket:
            await self._send(
                socket, {"msg": "connect", "version": "1", "support": ["1"]}
            )
            await self._expect(socket, lambda f: f.get("msg") == "connected")
            await self._send(
                socket,
                {
                    "msg": "method",
                    "method": "login",
                    "id": "login",
                    "params": [{"resume": self.config.auth_token}],
                },
            )
            result = await self._expect(
                socket, lambda f: f.get("msg") == "result" and f.get("id") == "login"
            )
            if "error" in result:
                raise BridgeCredentialError(
                    f"Rocket.Chat refused the token on the realtime socket: "
                    f"{result['error'].get('reason') or result['error'].get('message')}"
                )
            await self._send(
                socket,
                {
                    "msg": "sub",
                    "id": "messages",
                    "name": "stream-room-messages",
                    "params": ["__my_messages__", False],
                },
            )
            await self._send(
                socket,
                {
                    "msg": "sub",
                    "id": "rooms",
                    "name": "stream-notify-user",
                    "params": [f"{self._bot_id}/rooms-changed", False],
                },
            )
            self.socket_failure = None
            self._connections += 1
            if self._connections > 1 and self._last_seen_ms is not None:
                await self._recover(self._last_seen_ms)
            while True:
                raw = await asyncio.wait_for(socket.recv(), _SILENCE_LIMIT_SECONDS)
                await self._on_frame(socket, raw)

    @staticmethod
    async def _send(socket: Any, frame: dict[str, Any]) -> None:
        await socket.send(json.dumps(frame))

    async def _expect(
        self, socket: Any, matches: Callable[[dict[str, Any]], bool]
    ) -> dict:
        while True:
            raw = await asyncio.wait_for(socket.recv(), _REQUEST_TIMEOUT_SECONDS)
            frame = self._frame(raw)
            if frame.get("msg") == "ping":
                await self._send(socket, {"msg": "pong"})
            elif matches(frame):
                return frame

    @staticmethod
    def _frame(raw: str | bytes) -> dict[str, Any]:
        try:
            frame = json.loads(raw)
        except ValueError:
            return {}
        return frame if isinstance(frame, dict) else {}

    async def _on_frame(self, socket: Any, raw: str | bytes) -> None:
        frame = self._frame(raw)
        kind = frame.get("msg")
        if kind == "ping":
            await self._send(socket, {"msg": "pong"})
            return
        if kind == "nosub":
            raise WebSocketException(
                f"Rocket.Chat refused subscription {frame.get('id')}: {frame.get('error')}"
            )
        if kind != "changed":
            return
        fields = frame.get("fields") or {}
        args = fields.get("args") or []
        if frame.get("collection") == "stream-room-messages" and args:
            self._spawn(self._handle_message(args[0]))
        elif frame.get("collection") == "stream-notify-user" and len(args) >= 2:
            if str(fields.get("eventName", "")).endswith("/rooms-changed"):
                self._spawn(self._handle_room_change(args[0], args[1]))

    def _spawn(self, work: Awaitable[None]) -> None:
        task = asyncio.ensure_future(self._guarded(work))
        self._handlers.add(task)
        task.add_done_callback(self._handlers.discard)

    @staticmethod
    async def _guarded(work: Awaitable[None]) -> None:
        # One bad event must not take the socket down with it.
        try:
            await work
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Failed to handle a Rocket.Chat event")

    async def _recover(self, since_ms: int) -> None:
        """Replay what was said while the socket was down.

        Only covers a socket that dropped inside this process: the point it
        resumes from is memory, so a restart starts from now.
        """
        subscriptions = await self._api("GET", "/api/v1/subscriptions.get")
        missed: list[dict[str, Any]] = []
        for subscription in subscriptions.get("update", []):
            rid = subscription.get("rid")
            if not rid:
                continue
            synced = await self._api(
                "GET",
                "/api/v1/chat.syncMessages",
                params={"roomId": rid, "lastUpdate": _iso(since_ms)},
            )
            missed.extend((synced.get("result") or {}).get("updated", []))
        missed.sort(key=lambda m: _millis(m.get("ts")) or 0)
        for message in missed:
            await self._handle_message(message)

    async def _handle_room_change(self, action: str, room: dict[str, Any]) -> None:
        room_id = room.get("_id")
        if action != "inserted" or not room_id or self._on_app_joined is None:
            return
        self._rooms[room_id] = room
        await self._on_app_joined(
            InboundAppJoin(
                channel_id=room_id,
                channel_type=self._channel_type(room),
                channel_name=room.get("fname") or room.get("name"),
            )
        )

    async def _handle_message(self, message: dict[str, Any]) -> None:
        message_id = message.get("_id")
        rid = message.get("rid")
        sender = message.get("u") or {}
        if not message_id or not rid or not sender.get("_id"):
            return
        stamp = _millis(message.get("ts"))
        if stamp is not None and (
            self._last_seen_ms is None or stamp > self._last_seen_ms
        ):
            self._last_seen_ms = stamp
        if sender["_id"] == self._bot_id:
            return
        if message_id in self._seen:
            return
        self._seen[message_id] = None
        if len(self._seen) > _SEEN_MESSAGES:
            self._seen.popitem(last=False)
        try:
            await self._deliver(message, message_id, rid, sender)
        except BaseException:
            # Not delivered, so a replay after a reconnect must try it again.
            self._seen.pop(message_id, None)
            raise

    async def _deliver(
        self, message: dict[str, Any], message_id: str, rid: str, sender: dict[str, Any]
    ) -> None:
        if message.get("editedAt"):
            # An edit is the same message again. Switch has no inbound edit.
            return
        room = await self._room(rid)
        channel_type = self._channel_type(room)
        channel_name = room.get("fname") or room.get("name")
        username = str(sender.get("username") or sender["_id"])
        system_type = message.get("t")
        if system_type:
            if system_type == "uj" and self._on_user_joined is not None:
                await self._on_user_joined(
                    InboundUserJoin(
                        channel_id=rid,
                        channel_type=channel_type,
                        external_user_id=str(sender["_id"]),
                        external_username=username,
                        channel_name=channel_name,
                    )
                )
            return
        text = str(message.get("msg") or "")
        root_id = message.get("tmid") or None
        stripped = text.strip()
        if stripped.startswith("!") and self._on_command is not None:
            command, _, args = stripped.partition(" ")
            await self._on_command(
                InboundCommand(
                    channel_id=rid,
                    channel_type=channel_type,
                    sender_id=str(sender["_id"]),
                    sender_name=username,
                    command=command.lstrip("!"),
                    args=args.strip(),
                    message_ref=message_id,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return
        if self._on_message is None:
            return
        attachments, failures = await self._fetch_files(message)
        if not stripped and not attachments and not failures:
            return
        await self._on_message(
            InboundMessage(
                channel_id=rid,
                channel_type=channel_type,
                sender_id=str(sender["_id"]),
                sender_name=username,
                content=self.translate_inbound(text),
                message_ref=message_id,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=failures,
                sender_is_app=bool(message.get("bot")),
            )
        )

    async def _fetch_files(
        self, message: dict[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        files = message.get("files") or (
            [message["file"]] if message.get("file") else []
        )
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for file in files:
            name = str(file.get("name") or file.get("_id") or "file")
            size = file.get("size")
            limit = self._max_attachment_bytes
            if isinstance(size, int) and size > limit:
                failures.append(
                    AttachmentFailure(
                        filename=name,
                        reason=_FILE_DOWNLOAD_LIMIT.format(
                            limit=limit // (1024 * 1024)
                        ),
                    )
                )
                continue
            try:
                response = await self._http().get(
                    f"/file-upload/{quote(str(file['_id']))}/{quote(name)}"
                )
                response.raise_for_status()
            except (httpx.HTTPError, KeyError) as exc:
                failures.append(
                    AttachmentFailure(filename=name, reason=f"download failed: {exc}")
                )
                continue
            if len(response.content) > limit:
                failures.append(
                    AttachmentFailure(
                        filename=name,
                        reason=_FILE_DOWNLOAD_LIMIT.format(
                            limit=limit // (1024 * 1024)
                        ),
                    )
                )
                continue
            attachments.append(
                Attachment(
                    filename=name,
                    mimetype=str(file.get("type") or "application/octet-stream"),
                    data=response.content,
                )
            )
        return attachments, failures

    # Outbound
    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        rendering = await self.agent_rendering(sender_name)
        first: str | None = None
        for piece in split_message(content):
            payload: dict[str, Any] = {
                "roomId": channel_id,
                "text": piece,
                "alias": rendering.field_label,
            }
            if rendering.icon_url:
                payload["avatar"] = rendering.icon_url
            if thread_root_id:
                payload["tmid"] = thread_root_id
            body = await self._api("POST", "/api/v1/chat.postMessage", json=payload)
            if first is None:
                first = (body.get("message") or {}).get("_id")
        return first

    async def send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        # An upload cannot carry an alias, so the agent is named in the caption.
        rendering = await self.agent_rendering(sender_name)
        text = f"**{rendering.body_label}**" + (f"\n{caption}" if caption else "")
        form: dict[str, Any] = {"msg": text}
        if thread_root_id:
            form["tmid"] = thread_root_id
        body = await self._api(
            "POST",
            f"/api/v1/rooms.upload/{quote(channel_id)}",
            data=form,
            files={"file": (filename, data, mimetype)},
        )
        return (body.get("message") or {}).get("_id")

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._api(
            "POST",
            "/api/v1/chat.update",
            json={"roomId": channel_id, "msgId": message_ref, "text": new_content},
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._api(
            "POST",
            "/api/v1/chat.delete",
            json={"roomId": channel_id, "msgId": message_ref},
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Typing is only offered as a realtime method call, the surface
        # Rocket.Chat is retiring; the activity reaction shows the agent works.
        return None

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        mark: ActivityMark,
        on: bool,
        force: bool = False,
    ) -> None:
        await self._api(
            "POST",
            "/api/v1/chat.react",
            json={
                "messageId": message_ref,
                "emoji": _REACTIONS[mark],
                "shouldReact": on,
            },
        )

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    # Channels and people
    @staticmethod
    def _channel_name(name: str) -> str:
        cleaned = "".join(
            ch if ch.isalnum() or ch in "-_." else "-" for ch in name.lower().strip()
        )
        return cleaned.strip("-_.") or "switch-room"

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        private = channel_type in ("channel_private", "group")
        members = [self.config.default_member] if self.config.default_member else []
        body = await self._api(
            "POST",
            "/api/v1/groups.create" if private else "/api/v1/channels.create",
            json={"name": self._channel_name(name), "members": members},
        )
        room = body.get("group" if private else "channel") or {}
        room_id = room.get("_id")
        if not room_id:
            raise BridgeOperationError(
                "Rocket.Chat created the channel but did not return its id."
            )
        self._rooms[room_id] = room
        if topic:
            await self._api(
                "POST",
                "/api/v1/groups.setTopic" if private else "/api/v1/channels.setTopic",
                json={"roomId": room_id, "topic": topic},
            )
        return str(room_id)

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Every agent speaks through the bot, which is in the channel already.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        room = await self._room(channel_id)
        path = (
            "/api/v1/groups.invite"
            if room.get("t") == "p"
            else "/api/v1/channels.invite"
        )
        failed: list[str] = []
        for name, external_id in zip(user_names, user_external_ids, strict=True):
            who = {"userId": external_id} if external_id else {"username": name}
            try:
                await self._api("POST", path, json={"roomId": channel_id, **who})
            except BridgeOperationError as exc:
                logger.warning("Could not add %s to Rocket.Chat room: %s", name, exc)
                failed.append(external_id or name)
        return failed

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        body = await self._api(
            "GET",
            "/api/v1/directory",
            params={"text": query, "type": "users", "workspace": "local", "count": 25},
        )
        found: list[DirectoryUser] = []
        for user in body.get("result", []):
            username = user.get("username")
            if not user.get("_id") or not username:
                continue
            emails = user.get("emails") or []
            found.append(
                DirectoryUser(
                    external_user_id=str(user["_id"]),
                    username=str(username),
                    display_name=str(user.get("name") or username),
                    email=(emails[0].get("address") if emails else None),
                )
            )
        return found

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        base = self._public_base()
        if base is None:
            return None
        room = await self._room(external_channel_id)
        name = room.get("name")
        kind = {"c": "channel", "p": "group"}.get(str(room.get("t")))
        if not name or kind is None:
            return None
        return f"{base}/{kind}/{quote(str(name))}"

    async def home_deeplink(self) -> str | None:
        return self._public_base()

    def _public_base(self) -> str | None:
        base = self.config.public_url or self.config.url
        return base if base.startswith("https://") else None
