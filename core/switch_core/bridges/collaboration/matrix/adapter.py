from __future__ import annotations

import asyncio
import contextlib
import hashlib
import html
import logging
import re
from collections.abc import Awaitable, Callable, Mapping
from pathlib import PurePath
from typing import Any, ClassVar, cast
from urllib.parse import quote, urlsplit

import httpx
from markdown import markdown
from pydantic import Field, field_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.matrix.client import MatrixApiError, MatrixClient
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
    RetireOutcome,
)
from switch_core.outbound import guarded_async_client

logger = logging.getLogger(__name__)

_COMMAND = re.compile(r"^!([a-z][a-z0-9_-]*)(?:\s+(.*))?$", re.DOTALL)
_HTML_TAG = re.compile(r"<[^>]+>")
_SYNC_RETRY_MAX_SECONDS = 30.0
_MESSAGE_TYPES = {"m.text", "m.notice", "m.emote"}
_MEDIA_TYPES = {"m.file", "m.image", "m.audio", "m.video"}


class MatrixConnectionConfig(BridgeConnectionConfig):
    homeserver_url: str = Field(
        title="Homeserver URL",
        description="Bare HTTPS origin of the external Matrix homeserver.",
    )
    access_token: str = Field(
        title="Bot access token",
        description="Access token for the dedicated Matrix bot account.",
        min_length=1,
    )
    sync_token: SkipJsonSchema[str | None] = None

    @field_validator("homeserver_url")
    @classmethod
    def _valid_homeserver(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("homeserver_url must be an http or https origin")
        if parsed.username or parsed.password:
            raise ValueError("homeserver_url must not contain credentials")
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError(
                "homeserver_url must be a bare origin with no path or query"
            )
        return value


class MatrixAdapter(PlatformAdapter):
    """External Matrix rooms through the standard Client-Server API."""

    display_name: ClassVar[str] = "Matrix"
    docs_slug: ClassVar[str | None] = "matrix"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    renders_custom_url_schemes: ClassVar[bool] = False
    channel_on_delete = "left"

    def __init__(self, *, config: MatrixConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client: MatrixClient | None = None
        self._http: httpx.AsyncClient | None = None
        self._sync_task: asyncio.Task[None] | None = None
        self._user_id = ""
        self._sync_token = config.sync_token
        self._persist_state: Callable[[dict[str, object]], Awaitable[None]] | None = (
            None
        )
        self._room_names: dict[str, str] = {}
        self._room_types: dict[str, ChannelType] = {}
        self._member_names: dict[str, str] = {}
        self._known_rooms: set[str] = set()
        self._known_members: set[tuple[str, str]] = set()
        self._encrypted_rooms: set[str] = set()

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [MatrixConnectionConfig.model_validate(connection_config).homeserver_url]

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        config = MatrixConnectionConfig.model_validate(connection_config)
        digest = hashlib.sha256(config.access_token.encode()).hexdigest()[:16]
        return f"matrix-access-token:{digest}"

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = MatrixConnectionConfig.model_validate(connection_config)
        client = MatrixClient(
            homeserver_url=config.homeserver_url, access_token=config.access_token
        )
        try:
            whoami = await client.whoami()
            if not whoami.get("user_id"):
                raise BridgeCredentialError(
                    "Matrix returned no user id for this token."
                )
        except MatrixApiError as exc:
            raise BridgeCredentialError(
                f"Matrix rejected the bot token: {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise BridgeCredentialError(
                "Could not reach the Matrix homeserver. Check its URL and network policy."
            ) from exc
        finally:
            await client.close()

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, MatrixApiError):
            if exc.errcode in {"M_UNKNOWN_TOKEN", "M_MISSING_TOKEN", "M_FORBIDDEN"}:
                return "auth_failed"
            return "platform_error"
        if isinstance(exc, httpx.HTTPError):
            return "network"
        return None

    def set_state_persister(
        self, persist: Callable[[dict[str, object]], Awaitable[None]]
    ) -> None:
        self._persist_state = persist

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
        self._http = guarded_async_client(
            self.outbound_policy,
            headers={"Authorization": f"Bearer {self._config.access_token}"},
            timeout=httpx.Timeout(30, read=None),
        )
        self._client = MatrixClient(
            homeserver_url=self._config.homeserver_url,
            access_token=self._config.access_token,
            http=self._http,
        )
        whoami = await self._client.whoami()
        self._user_id = str(whoami["user_id"])
        if not self._listening:
            logger.info(
                "Matrix bridge is quiet on this process; the lease holder runs /sync"
            )
            return
        if self._sync_token is None:
            initial = await self._client.sync(since=None, timeout_ms=0)
            await self._apply_sync(initial, dispatch_timeline=False)
            await self._advance_cursor(initial)
        self._sync_task = asyncio.create_task(
            self._sync_forever(), name="external-matrix-sync"
        )

    async def stop(self) -> None:
        task, self._sync_task = self._sync_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        client, self._client = self._client, None
        if client is not None:
            await client.close()
        http, self._http = self._http, None
        if http is not None:
            await http.aclose()

    async def _sync_forever(self) -> None:
        delay = 1.0
        while True:
            try:
                response = await self._require_client().sync(
                    since=self._sync_token, timeout_ms=30_000
                )
                await self._apply_sync(response, dispatch_timeline=True)
                await self._advance_cursor(response)
                delay = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "External Matrix sync failed; retrying in %.0f seconds", delay
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, _SYNC_RETRY_MAX_SECONDS)

    async def _advance_cursor(self, response: Mapping[str, Any]) -> None:
        token = response.get("next_batch")
        if not isinstance(token, str) or not token:
            raise BridgeOperationError("Matrix /sync returned no next_batch token")
        if token == self._sync_token:
            return
        self._sync_token = token
        if self._persist_state is not None:
            await self._persist_state({"sync_token": token})

    async def _apply_sync(
        self, response: Mapping[str, Any], *, dispatch_timeline: bool
    ) -> None:
        rooms = response.get("rooms")
        if not isinstance(rooms, dict):
            return
        invites = rooms.get("invite")
        if isinstance(invites, dict):
            for room_id in invites:
                try:
                    await self._require_client().join(str(room_id))
                except MatrixApiError:
                    logger.exception("Could not join invited Matrix room %s", room_id)
        joined = rooms.get("join")
        if not isinstance(joined, dict):
            return
        for room_id, room in joined.items():
            if isinstance(room, dict):
                await self._apply_room_sync(
                    str(room_id), room, dispatch_timeline=dispatch_timeline
                )

    async def _apply_room_sync(
        self, room_id: str, room: Mapping[str, Any], *, dispatch_timeline: bool
    ) -> None:
        state = room.get("state")
        state_events = state.get("events", []) if isinstance(state, dict) else []
        timeline = room.get("timeline")
        timeline_events = (
            timeline.get("events", []) if isinstance(timeline, dict) else []
        )
        if not isinstance(state_events, list):
            state_events = []
        if not isinstance(timeline_events, list):
            timeline_events = []
        for event in [*state_events, *timeline_events]:
            if isinstance(event, dict):
                self._learn_state(room_id, event)
        if room_id not in self._known_rooms:
            self._known_rooms.add(room_id)
            await self._learn_room_type(room_id)
            if self._on_app_joined is not None:
                await self._on_app_joined(
                    InboundAppJoin(
                        channel_id=room_id,
                        channel_type=self._room_types.get(room_id, "group"),
                        channel_name=self._room_names.get(room_id),
                    )
                )
        if not dispatch_timeline:
            return
        for event in timeline_events:
            if isinstance(event, dict):
                await self._handle_event(room_id, event)

    def _learn_state(self, room_id: str, event: Mapping[str, Any]) -> None:
        event_type = event.get("type")
        content = event.get("content")
        if not isinstance(content, dict):
            return
        if event_type == "m.room.name" and content.get("name"):
            self._room_names[room_id] = str(content["name"])
        elif event_type == "m.room.encryption":
            self._encrypted_rooms.add(room_id)
        elif event_type == "m.room.member":
            user_id = event.get("state_key")
            if isinstance(user_id, str) and content.get("displayname"):
                self._member_names[user_id] = str(content["displayname"])

    async def _learn_room_type(self, room_id: str) -> None:
        try:
            members = await self._require_client().joined_members(room_id)
        except MatrixApiError:
            logger.warning("Could not determine Matrix room type for %s", room_id)
            self._room_types[room_id] = "group"
            return
        joined = members.get("joined")
        self._room_types[room_id] = (
            "direct" if isinstance(joined, dict) and len(joined) == 2 else "group"
        )

    async def _handle_event(self, room_id: str, event: Mapping[str, Any]) -> None:
        event_type = event.get("type")
        sender = str(event.get("sender") or "")
        if not sender or sender == self._user_id:
            return
        if event_type == "m.room.encrypted":
            self._encrypted_rooms.add(room_id)
            logger.warning(
                "Ignoring encrypted event in external Matrix room %s; E2EE is unsupported",
                room_id,
            )
            return
        if event_type == "m.room.member":
            await self._handle_member(room_id, event)
            return
        if event_type != "m.room.message":
            return
        content = event.get("content")
        if not isinstance(content, dict):
            return
        relates = content.get("m.relates_to")
        if isinstance(relates, dict) and relates.get("rel_type") == "m.replace":
            logger.info(
                "Ignoring inbound Matrix edit %s: collaboration ingress has no edit port",
                event.get("event_id"),
            )
            return
        event_id = event.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            return
        msgtype = str(content.get("msgtype") or "")
        body = str(content.get("body") or "")
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        if msgtype in _MEDIA_TYPES:
            attachment, failure = await self._download_attachment(content)
            if attachment is not None:
                attachments.append(attachment)
            if failure is not None:
                failures.append(failure)
        elif msgtype not in _MESSAGE_TYPES:
            return
        root_id: str | None = None
        if isinstance(relates, dict) and relates.get("rel_type") == "m.thread":
            root = relates.get("event_id")
            root_id = str(root) if root else None
        sender_name = self._member_names.get(sender, sender)
        command = _COMMAND.match(body.strip())
        channel_type = self._room_types.get(room_id, "group")
        if command and self._on_command is not None:
            await self._on_command(
                InboundCommand(
                    channel_id=room_id,
                    channel_type=channel_type,
                    sender_id=sender,
                    sender_name=sender_name,
                    command=command.group(1),
                    args=command.group(2) or "",
                    message_ref=event_id,
                    root_id=root_id,
                    channel_name=self._room_names.get(room_id),
                )
            )
            return
        if self._on_message is None or not (body or attachments or failures):
            return
        await self._on_message(
            InboundMessage(
                channel_id=room_id,
                channel_type=channel_type,
                sender_id=sender,
                sender_name=sender_name,
                content=self.translate_inbound(body),
                message_ref=event_id,
                root_id=root_id,
                channel_name=self._room_names.get(room_id),
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    async def _handle_member(self, room_id: str, event: Mapping[str, Any]) -> None:
        content = event.get("content")
        user_id = event.get("state_key")
        if not isinstance(content, dict) or not isinstance(user_id, str):
            return
        if content.get("membership") != "join" or user_id == self._user_id:
            return
        key = (room_id, user_id)
        if key in self._known_members:
            return
        self._known_members.add(key)
        name = str(content.get("displayname") or user_id)
        self._member_names[user_id] = name
        if self._on_user_joined is not None:
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=room_id,
                    channel_type=self._room_types.get(room_id, "group"),
                    external_user_id=user_id,
                    external_username=name,
                    channel_name=self._room_names.get(room_id),
                )
            )

    async def _download_attachment(
        self, content: Mapping[str, Any]
    ) -> tuple[Attachment | None, AttachmentFailure | None]:
        filename = PurePath(
            str(content.get("filename") or content.get("body") or "file")
        ).name
        info = content.get("info")
        size = int(info.get("size") or 0) if isinstance(info, dict) else 0
        if size > self._max_attachment_bytes:
            return None, AttachmentFailure(
                filename=filename,
                reason=f"file is larger than {self._max_attachment_bytes} bytes",
            )
        uri = content.get("url")
        if not isinstance(uri, str):
            return None, AttachmentFailure(
                filename=filename, reason="missing Matrix media URI"
            )
        try:
            data = await self._require_client().download(uri)
            if len(data) > self._max_attachment_bytes:
                raise ValueError("download exceeded the configured media limit")
        except (MatrixApiError, httpx.HTTPError, ValueError) as exc:
            return None, AttachmentFailure(filename=filename, reason=str(exc))
        mimetype = (
            str(info.get("mimetype") or "application/octet-stream")
            if isinstance(info, dict)
            else "application/octet-stream"
        )
        return Attachment(filename=filename, mimetype=mimetype, data=data), None

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        self._refuse_encrypted(channel_id)
        return await self._require_client().send_message(
            channel_id,
            self._text_content(sender_name, content, thread_root_id=thread_root_id),
        )

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
        self._refuse_encrypted(channel_id)
        if len(data) > self._max_attachment_bytes:
            raise BridgeOperationError(
                f"{filename} is larger than the {self._max_attachment_bytes}-byte limit"
            )
        uri = await self._require_client().upload(
            data, filename=filename, mimetype=mimetype
        )
        msgtype = self._matrix_media_type(mimetype)
        content: dict[str, Any] = {
            "msgtype": msgtype,
            "body": f"{sender_name}: {caption or filename}",
            "filename": filename,
            "url": uri,
            "info": {"mimetype": mimetype, "size": len(data)},
        }
        if thread_root_id:
            content["m.relates_to"] = self._thread_relation(thread_root_id)
        return await self._require_client().send_message(channel_id, content)

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        self._refuse_encrypted(channel_id)
        plain = self._plain(new_content)
        replacement = {
            "msgtype": "m.text",
            "body": plain,
            "format": "org.matrix.custom.html",
            "formatted_body": new_content,
        }
        await self._require_client().send_message(
            channel_id,
            {
                **replacement,
                "body": f"* {plain}",
                "formatted_body": f"* {new_content}",
                "m.new_content": replacement,
                "m.relates_to": {"rel_type": "m.replace", "event_id": message_ref},
            },
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._require_client().redact(channel_id, message_ref)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        if not self._user_id or channel_id in self._encrypted_rooms:
            return
        await self._require_client().typing(channel_id, self._user_id, typing=is_typing)

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        room_id = await self._require_client().create_room(
            name=name, topic=topic, public=channel_type == "channel_public"
        )
        self._room_names[room_id] = name
        self._room_types[room_id] = channel_type
        return room_id

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        if channel_id not in self._room_types:
            await self._learn_room_type(channel_id)
        return self._room_types[channel_id]

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        failed: list[str] = []
        for user_id in user_external_ids:
            try:
                await self._require_client().invite(channel_id, user_id)
            except MatrixApiError:
                logger.warning("Could not invite %s to %s", user_id, channel_id)
                failed.append(user_id)
        return failed

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        try:
            await self._require_client().leave(external_channel_id)
        except MatrixApiError as exc:
            return RetireOutcome.failed(str(exc))
        return RetireOutcome(outcome="left")

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        users = await self._require_client().search_users(query)
        return [
            DirectoryUser(
                external_user_id=str(user["user_id"]),
                username=str(user["user_id"]),
                display_name=str(user.get("display_name") or user["user_id"]),
            )
            for user in users
            if user.get("user_id")
        ]

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        return f"https://matrix.to/#/{quote(external_channel_id, safe='')}"

    async def home_deeplink(self) -> str | None:
        return self._config.homeserver_url

    async def attention(self) -> str | None:
        if not self._encrypted_rooms:
            return None
        return (
            f"{len(self._encrypted_rooms)} Matrix room(s) use end-to-end encryption. "
            "This connection refuses encrypted traffic; invite the bot to an "
            "unencrypted room instead."
        )

    def _render_outbound(self, content: str) -> str:
        return cast(str, markdown(content, extensions=[]))

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    def _require_client(self) -> MatrixClient:
        if self._client is None:
            raise RuntimeError("Matrix adapter is not started")
        return self._client

    def _refuse_encrypted(self, room_id: str) -> None:
        if room_id in self._encrypted_rooms:
            raise BridgeOperationError(
                "This Matrix room is end-to-end encrypted. The external Matrix "
                "adapter does not store device keys and will not send plaintext into it."
            )

    @staticmethod
    def _plain(rendered: str) -> str:
        return html.unescape(_HTML_TAG.sub("", rendered)).strip()

    @classmethod
    def _text_content(
        cls, sender_name: str, rendered: str, *, thread_root_id: str | None
    ) -> dict[str, Any]:
        content: dict[str, Any] = {
            "msgtype": "m.text",
            "body": f"{sender_name}: {cls._plain(rendered)}",
            "format": "org.matrix.custom.html",
            "formatted_body": f"<strong>{html.escape(sender_name)}</strong>: {rendered}",
        }
        if thread_root_id:
            content["m.relates_to"] = cls._thread_relation(thread_root_id)
        return content

    @staticmethod
    def _thread_relation(root: str) -> dict[str, Any]:
        return {
            "rel_type": "m.thread",
            "event_id": root,
            "is_falling_back": True,
            "m.in_reply_to": {"event_id": root},
        }

    @staticmethod
    def _matrix_media_type(mimetype: str) -> str:
        if mimetype.startswith("image/"):
            return "m.image"
        if mimetype.startswith("audio/"):
            return "m.audio"
        if mimetype.startswith("video/"):
            return "m.video"
        return "m.file"
