"""Rocket.Chat collaboration bridge adapter.

A bot user on the operator's own Rocket.Chat server. Outbound messages go
through the REST API; inbound messages arrive on the realtime (DDP)
WebSocket the bot subscribes to, one subscription per room it is in.
Channels and private groups are bridged; 1:1 direct messages are not.
Threads are Rocket.Chat's own: a reply in Switch is a threaded message
on Rocket.Chat.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import mimetypes
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar, override
from urllib.parse import urljoin, urlparse

import httpx
from pydantic import Field, field_validator
from websockets.asyncio.client import connect as ws_connect

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
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)

logger = logging.getLogger(__name__)


class RocketChatRpcError(RuntimeError):
    """The Rocket.Chat REST API answered with a failure payload."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


class RocketChatConnectionConfig(BridgeConnectionConfig):
    """Configuration for a Rocket.Chat bridge connection."""

    server_url: str = Field(
        description="The Rocket.Chat server base URL (e.g. https://chat.example.com)"
    )
    username: str = Field(description="The bot user's username on that server")
    password: str = Field(description="The bot user's password")

    @field_validator("server_url")
    @classmethod
    def _validate_server_url(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if not v:
            raise ValueError("server_url is required")
        parsed = urlparse(v)
        if parsed.scheme not in ("http", "https"):
            raise ValueError("server_url must use http or https scheme")
        if not parsed.netloc:
            raise ValueError("server_url must have a valid hostname")
        if parsed.path not in ("", "/"):
            raise ValueError("server_url must be the server root, with no path")
        return v

    @field_validator("username")
    @classmethod
    def _validate_username(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("username is required")
        if " " in v:
            raise ValueError("username must not contain whitespace")
        return v


class RocketChatAdapter(PlatformAdapter):
    """Rocket.Chat bridge: REST for sends, realtime WebSocket for receives."""

    display_name: ClassVar[str] = "Rocket.Chat"
    docs_slug: ClassVar[str | None] = "rocketchat"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    channel_on_delete = "archived"
    draws_session_activity: ClassVar[bool] = True
    supports_channel_creation: ClassVar[bool] = True
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    notifies_only_by_mention: ClassVar[bool] = False
    every_message_notifies_members: ClassVar[bool] = True
    separate_attention_slot: ClassVar[bool] = True
    redraws_for_elapsed_time: ClassVar[bool] = False
    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = False
    activity_reactions_per_agent: ClassVar[bool] = False
    recovers_uncertain_posts: ClassVar[bool] = False
    carries_publication_marker: ClassVar[bool] = False
    discloses_unconfirmed_posts: ClassVar[bool] = False
    removes_answered_cards: ClassVar[bool] = False
    channel_mention: ClassVar[str | None] = None

    def __init__(
        self,
        *,
        config: RocketChatConnectionConfig,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__()
        self._config = config
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._auth_token: str | None = None
        self._bot_user_id: str | None = None
        self._bot_username: str | None = None
        self._seen_messages: OrderedDict[str, None] = OrderedDict()
        self._subscribed_rooms: set[str] = set()
        self._room_types: dict[str, ChannelType] = {}
        self._ddp_task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._max_ddp_backoff = 30.0

    # -- Failure classification and registration hooks --------------------

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.ConnectError | httpx.TimeoutException):
            return "network"
        if isinstance(exc, httpx.HTTPStatusError):
            if exc.response.status_code in (401, 403):
                return "auth_failed"
            if exc.response.status_code == 404:
                return "config_invalid"
            return "platform_error"
        if isinstance(exc, RocketChatRpcError | json.JSONDecodeError):
            return "platform_error"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        config = RocketChatConnectionConfig.model_validate(connection_config)
        return f"Rocket.Chat server {config.server_url}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        config = RocketChatConnectionConfig.model_validate(connection_config)
        return [config.server_url]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = RocketChatConnectionConfig.model_validate(connection_config)
        await cls._login(config, None)

    @classmethod
    async def _login(
        cls,
        config: RocketChatConnectionConfig,
        transport: httpx.AsyncBaseTransport | None,
    ) -> dict[str, Any]:
        url = config.server_url.rstrip("/") + "/api/v1/login"
        try:
            async with httpx.AsyncClient(
                transport=transport, timeout=15.0, trust_env=False
            ) as client:
                resp = await client.post(
                    url,
                    json={"username": config.username, "password": config.password},
                )
        except httpx.ConnectError as e:
            raise BridgeCredentialError(
                f"Could not reach the Rocket.Chat server at {config.server_url}: {e}"
            ) from e
        except httpx.TimeoutException as e:
            raise BridgeCredentialError(
                f"Timed out connecting to the Rocket.Chat server at "
                f"{config.server_url}: {e}"
            ) from e
        if resp.status_code in (401, 403):
            raise BridgeCredentialError(
                f"The Rocket.Chat server at {config.server_url} rejected the "
                f"credentials (HTTP {resp.status_code}). Check the bot user's "
                "username and password."
            )
        if resp.status_code != 200:
            raise BridgeCredentialError(
                f"The Rocket.Chat server at {config.server_url} answered "
                f"HTTP {resp.status_code} on login"
            )
        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError) as e:
            raise BridgeCredentialError(
                f"The Rocket.Chat server at {config.server_url} answered login "
                f"with an unparseable response: {e}"
            ) from e
        if not isinstance(data, dict) or not data.get("data", {}).get("authToken"):
            raise BridgeCredentialError(
                f"The Rocket.Chat server at {config.server_url} did not return "
                "an auth token on login"
            )
        result = data["data"]
        return result if isinstance(result, dict) else {}

    # -- Lifecycle --------------------------------------------------------

    @override
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

        if not self._listening:
            logger.info("Rocket.Chat adapter started in quiet mode (no WebSocket)")
            return

        await self._ensure_auth()
        self._stop_event.clear()
        self._ddp_task = asyncio.create_task(self._ddp_loop())
        logger.info("Rocket.Chat adapter started with realtime WebSocket")

    @override
    async def stop(self) -> None:
        self._stop_event.set()
        if self._ddp_task is not None:
            self._ddp_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._ddp_task
            self._ddp_task = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -- REST transport ---------------------------------------------------

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            transport = self._transport
            if transport is None:
                transport = httpx.AsyncHTTPTransport(verify=True, trust_env=False)
            self._client = httpx.AsyncClient(
                transport=transport,
                timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0),
                follow_redirects=False,
            )
        return self._client

    async def _ensure_auth(self) -> None:
        if self._auth_token:
            return
        result = await self._login(self._config, self._transport)
        self._auth_token = str(result["authToken"])
        self._bot_user_id = str(result.get("userId") or "")
        me = result.get("me")
        if isinstance(me, dict) and me.get("username"):
            self._bot_username = str(me["username"])

    async def _rest(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        await self._ensure_auth()
        client = await self._get_client()
        headers = {
            "X-User-Id": self._bot_user_id or "",
            "X-Auth-Token": self._auth_token or "",
        }
        resp = await client.request(
            method,
            self._config.server_url.rstrip("/") + path,
            headers=headers,
            json=json_body,
            params=params,
            timeout=30.0,
        )
        try:
            data = resp.json()
        except (ValueError, httpx.DecodingError):
            resp.raise_for_status()
            raise RocketChatRpcError(
                f"{method} {path} returned an unparseable response"
            )
        if isinstance(data, dict) and data.get("success") is False:
            error = data.get("error") or data.get("message") or "unknown error"
            raise RocketChatRpcError(f"{method} {path} failed: {error}")
        resp.raise_for_status()
        return data

    # -- Inbound: DDP realtime WebSocket ----------------------------------

    def _ws_url(self) -> str:
        parsed = urlparse(self._config.server_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return f"{scheme}://{parsed.netloc}/websocket"

    async def _ddp_loop(self) -> None:
        backoff = 1.0
        while not self._stop_event.is_set():
            try:
                await self._ensure_auth()
                async with ws_connect(self._ws_url()) as ws:
                    await ws.send(
                        json.dumps(
                            {
                                "msg": "connect",
                                "version": "1",
                                "support": ["1", "pre2", "default"],
                            }
                        )
                    )
                    await ws.send(
                        json.dumps(
                            {
                                "msg": "method",
                                "method": "login",
                                "params": [{"resume": self._auth_token}],
                                "id": str(uuid.uuid4()),
                            }
                        )
                    )
                    backoff = 1.0
                    self._subscribed_rooms = set()
                    await self._subscribe_rooms(ws)
                    async for raw in ws:
                        if self._stop_event.is_set():
                            return
                        try:
                            payload = json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("Invalid JSON in DDP frame: %s", raw[:100])
                            continue
                        await self._handle_ddp_message(ws, payload)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Rocket.Chat realtime connection failed")
            if self._stop_event.is_set():
                break
            self._auth_token = None
            logger.info(
                "Rocket.Chat realtime disconnected, reconnecting in %.1fs", backoff
            )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, self._max_ddp_backoff)

    async def _handle_ddp_message(self, ws: Any, payload: dict[str, Any]) -> None:
        msg = payload.get("msg")
        if msg == "ping":
            await ws.send(json.dumps({"msg": "pong"}))
            return
        if msg == "error":
            logger.warning("Rocket.Chat DDP error: %s", payload)
            return
        if msg != "changed" or payload.get("collection") != "stream-room-messages":
            return
        fields = payload.get("fields") or {}
        args = fields.get("args") or []
        if not args or not isinstance(args[0], dict):
            return
        room_id = fields.get("eventName") or args[0].get("rid")
        room_type = args[1] if len(args) > 1 else None
        await self._process_stream_message(args[0], room_type, room_id)

    async def _discover_room_ids(self) -> list[str]:
        data = await self._rest("GET", "/api/v1/rooms.get")
        rooms: Any = []
        if isinstance(data, dict):
            rooms = data.get("update") or data.get("rooms") or []
        elif isinstance(data, list):
            rooms = data
        room_ids = []
        for room in rooms if isinstance(rooms, list) else []:
            if not isinstance(room, dict):
                continue
            rid = room.get("_id") or room.get("rid")
            room_type = room.get("t")
            if rid and room_type in ("c", "p"):
                room_ids.append(str(rid))
                self._room_types[str(rid)] = (
                    "channel_public" if room_type == "c" else "channel_private"
                )
        return room_ids

    async def _subscribe_rooms(self, ws: Any) -> None:
        try:
            room_ids = await self._discover_room_ids()
        except Exception:
            logger.exception("Rocket.Chat room discovery failed")
            return
        if not room_ids:
            logger.warning("Rocket.Chat bot is in no channels or groups yet")
        for rid in room_ids:
            if rid in self._subscribed_rooms:
                continue
            await ws.send(
                json.dumps(
                    {
                        "msg": "sub",
                        "name": "stream-room-messages",
                        "id": f"room-{rid}",
                        "params": [rid, False],
                    }
                )
            )
            self._subscribed_rooms.add(rid)

    async def _process_stream_message(
        self, message: dict[str, Any], room_type: Any, room_id: Any
    ) -> None:
        resolved_room_id = str(room_id or message.get("rid") or "")
        if room_type == "d" or self._room_types.get(resolved_room_id) == "direct":
            return
        if room_type not in ("c", "p") and resolved_room_id not in self._room_types:
            logger.debug(
                "Rocket.Chat message for unknown room %s; assuming private",
                resolved_room_id,
            )
        if message.get("t"):
            return
        user = message.get("u") or {}
        author_id = str(user.get("_id") or "")
        if self._bot_user_id and author_id == self._bot_user_id:
            return
        message_id = str(message.get("_id") or "")
        if not message_id:
            return
        if message_id in self._seen_messages:
            return
        self._seen_messages[message_id] = None
        if len(self._seen_messages) > 1000:
            self._seen_messages.popitem(last=False)

        channel_id = resolved_room_id
        content = message.get("msg") or ""
        sender_name = str(user.get("name") or user.get("username") or author_id)
        channel_type: ChannelType = self._room_types.get(channel_id) or (
            "channel_public" if room_type == "c" else "channel_private"
        )
        root_id = str(message["tmid"]) if message.get("tmid") else None

        if content.strip().startswith("!"):
            if self._on_command is None:
                return
            parts = content.strip().split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=author_id,
                    sender_name=sender_name,
                    command=parts[0][1:],
                    args=parts[1] if len(parts) > 1 else "",
                    message_ref=message_id,
                    root_id=root_id,
                )
            )
            return

        self_mention_token: str | None = None
        for mention in message.get("mentions") or []:
            if isinstance(mention, dict) and str(mention.get("_id") or "") == (
                self._bot_user_id or ""
            ):
                self_mention_token = self._bot_username
                break

        attachments: list[Attachment] = []
        attachment_failures: list[AttachmentFailure] = []
        for att in message.get("attachments") or []:
            if not isinstance(att, dict):
                continue
            url = att.get("attachmentUrl")
            if not url:
                continue
            filename = att.get("title") or url.rsplit("/", 1)[-1] or "attachment"
            try:
                data_bytes = await self._download_attachment(str(url))
                attachments.append(
                    Attachment(
                        filename=str(filename),
                        mimetype=(
                            mimetypes.guess_type(str(filename))[0]
                            or "application/octet-stream"
                        ),
                        data=data_bytes,
                    )
                )
            except Exception as e:
                logger.warning("Failed to fetch attachment %s: %s", att.get("title"), e)
                attachment_failures.append(
                    AttachmentFailure(
                        filename=str(filename), reason=f"failed to download: {e}"
                    )
                )

        if not content and not attachments and not attachment_failures:
            return
        if self._on_message is None:
            return
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=author_id,
                sender_name=sender_name,
                content=content,
                message_ref=message_id,
                root_id=root_id,
                attachments=attachments,
                attachment_failures=attachment_failures,
                self_mention_token=self_mention_token,
                sender_is_app=False,
            )
        )

    async def _download_attachment(self, url: str) -> bytes:
        full_url = urljoin(self._config.server_url.rstrip("/") + "/", url.lstrip("/"))
        await self._ensure_auth()
        client = await self._get_client()
        headers = {
            "X-User-Id": self._bot_user_id or "",
            "X-Auth-Token": self._auth_token or "",
        }
        async with client.stream("GET", full_url, headers=headers) as resp:
            resp.raise_for_status()
            declared = resp.headers.get("content-length")
            if declared and int(declared) > self._max_attachment_bytes:
                raise ValueError(
                    f"attachment exceeds maximum size of "
                    f"{self._max_attachment_bytes} bytes"
                )
            chunks = []
            total = 0
            async for chunk in resp.aiter_bytes():
                total += len(chunk)
                if total > self._max_attachment_bytes:
                    raise ValueError(
                        f"attachment exceeds maximum size of "
                        f"{self._max_attachment_bytes} bytes"
                    )
                chunks.append(chunk)
            return b"".join(chunks)

    # -- Outbound ----------------------------------------------------------

    def _format_attributed(self, content: str, label: str) -> str:
        label = self.escape_label_for_body(label)
        if "\n" in content:
            return f"{label}:\n{content}"
        return f"{label}: {content}"

    def _chunk_message(self, text: str, limit: int = 8000) -> list[str]:
        if len(text) <= limit:
            return [text]
        chunks = []
        remaining = text
        while remaining:
            cut = remaining.rfind("\n\n", 0, limit)
            if cut == -1:
                cut = remaining.rfind("\n", 0, limit)
            if cut == -1:
                cut = remaining.rfind(" ", 0, limit)
            if cut == -1:
                cut = limit
            chunks.append(remaining[: cut + 1])
            remaining = remaining[cut + 1 :]
        return chunks

    def _render_outbound(self, content: str) -> str:
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    @override
    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        try:
            body = self._format_attributed(content, sender_name)
            first_ref: str | None = None
            for index, chunk in enumerate(self._chunk_message(body)):
                payload: dict[str, Any] = {
                    "roomId": channel_id,
                    "text": self._render_outbound(chunk),
                }
                if thread_root_id and index == 0:
                    payload["tmid"] = thread_root_id
                data = await self._rest(
                    "POST", "/api/v1/chat.postMessage", json_body=payload
                )
                message = data.get("message") if isinstance(data, dict) else None
                message_id = message.get("_id") if isinstance(message, dict) else None
                if not message_id:
                    logger.error(
                        "Rocket.Chat send response missing message id: %s", data
                    )
                    return None
                if first_ref is None:
                    first_ref = str(message_id)
            return first_ref
        except RocketChatRpcError as e:
            logger.error("Rocket.Chat send failed: %s", e)
            return None
        except Exception:
            logger.exception("Unexpected error sending Rocket.Chat message")
            return None

    @override
    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        try:
            await self._rest(
                "POST",
                "/api/v1/chat.update",
                json_body={
                    "roomId": channel_id,
                    "msgId": message_ref,
                    "text": self._render_outbound(new_content),
                },
            )
        except RocketChatRpcError as e:
            logger.error("Rocket.Chat edit failed: %s", e)
            raise BridgeOperationError(f"Failed to edit message: {e}") from e

    @override
    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._rest(
                "POST",
                "/api/v1/chat.delete",
                json_body={"roomId": channel_id, "msgId": message_ref},
            )
        except RocketChatRpcError as e:
            logger.error("Rocket.Chat delete failed: %s", e)
            raise BridgeOperationError(f"Failed to delete message: {e}") from e

    @override
    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        logger.debug("Rocket.Chat has no typing indicator to send")

    @override
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
        if mark != "working":
            return
        try:
            await self._rest(
                "POST",
                "/api/v1/chat.react",
                json_body={"messageId": message_ref, "reaction": "eyes"},
            )
        except RocketChatRpcError as e:
            logger.warning("Rocket.Chat activity reaction failed: %s", e)

    @override
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
        try:
            await self._ensure_auth()
            client = await self._get_client()
            headers = {
                "X-User-Id": self._bot_user_id or "",
                "X-Auth-Token": self._auth_token or "",
            }
            content_meta = json.dumps({"filename": filename, "contentType": mimetype})
            resp = await client.post(
                self._config.server_url.rstrip("/")
                + f"/api/v1/rooms.media/{channel_id}",
                headers=headers,
                files={"file": (filename, data, mimetype)},
                data={"content": content_meta},
                timeout=60.0,
            )
            payload = (
                resp.json()
                if resp.headers.get("content-type", "").startswith("application/json")
                else {}
            )
            if isinstance(payload, dict) and payload.get("success") is False:
                error = payload.get("error") or "unknown error"
                raise RocketChatRpcError(f"rooms.media failed: {error}")
            resp.raise_for_status()
            file_obj = payload.get("file") if isinstance(payload, dict) else None
            file_id = file_obj.get("_id") if isinstance(file_obj, dict) else None
            if not file_id:
                logger.error("Rocket.Chat upload response missing file id: %s", payload)
                return None
            confirm_body: dict[str, Any] = {"description": caption or ""}
            if thread_root_id:
                confirm_body["tmid"] = thread_root_id
            confirmed = await self._rest(
                "POST",
                f"/api/v1/rooms.mediaConfirm/{channel_id}/{file_id}",
                json_body=confirm_body,
            )
            message = confirmed.get("message") if isinstance(confirmed, dict) else None
            if isinstance(message, dict) and message.get("_id"):
                return str(message["_id"])
            if isinstance(confirmed, dict) and confirmed.get("_id"):
                return str(confirmed["_id"])
            logger.error(
                "Rocket.Chat confirm response missing message id: %s", confirmed
            )
            return None
        except RocketChatRpcError as e:
            logger.error("Rocket.Chat send attachment failed: %s", e)
            return None
        except Exception:
            logger.exception("Unexpected error sending Rocket.Chat attachment")
            return None

    @override
    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        try:
            data = await self._rest(
                "POST",
                "/api/v1/channels.create",
                json_body={"name": name, "readOnly": False},
            )
        except RocketChatRpcError as e:
            raise BridgeOperationError(f"Failed to create channel: {e}") from e
        channel = data.get("channel") if isinstance(data, dict) else None
        channel_id = channel.get("_id") if isinstance(channel, dict) else None
        if not channel_id:
            raise BridgeOperationError(
                "Rocket.Chat create channel returned no channel id"
            )
        return str(channel_id)

    @override
    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        try:
            await self._rest(
                "POST",
                "/api/v1/channels.archive",
                json_body={"roomId": external_channel_id},
            )
            return RetireOutcome(outcome="archived")
        except RocketChatRpcError as e:
            logger.warning(
                "Rocket.Chat archive failed for %s: %s", external_channel_id, e
            )
            return RetireOutcome.failed(str(e))

    @override
    async def get_channel_type(self, channel_id: str) -> ChannelType:
        try:
            data = await self._rest(
                "GET", "/api/v1/rooms.info", params={"roomId": channel_id}
            )
        except RocketChatRpcError as e:
            raise BridgeOperationError(f"Failed to read channel type: {e}") from e
        room = data.get("room") if isinstance(data, dict) else None
        room_type = room.get("t") if isinstance(room, dict) else None
        if room_type == "c":
            return "channel_public"
        if room_type == "p":
            return "channel_private"
        if room_type == "d":
            return "direct"
        raise BridgeOperationError(f"Unknown Rocket.Chat room type: {room_type!r}")

    @override
    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        channel_type = await self.get_channel_type(channel_id)
        path = (
            "/api/v1/groups.invite"
            if channel_type == "channel_private"
            else "/api/v1/channels.invite"
        )
        failed: list[str] = []
        for user_id in user_external_ids:
            try:
                await self._rest(
                    "POST", path, json_body={"roomId": channel_id, "userId": user_id}
                )
            except RocketChatRpcError as e:
                logger.warning("Rocket.Chat invite of %s failed: %s", user_id, e)
                failed.append(user_id)
        return failed

    @override
    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    @override
    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    @override
    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    @override
    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    @override
    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        try:
            data = await self._rest(
                "GET", "/api/v1/rooms.info", params={"roomId": external_channel_id}
            )
        except RocketChatRpcError:
            return None
        room = data.get("room") if isinstance(data, dict) else None
        name = room.get("name") if isinstance(room, dict) else None
        if not name:
            return None
        return f"{self._config.server_url.rstrip('/')}/channel/{name}"

    @override
    async def home_deeplink(self) -> str | None:
        return self._config.server_url
