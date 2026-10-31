from __future__ import annotations

import asyncio
import logging
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import quote

import httpx
import markdown

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME
from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
    PlatformAdapter,
    RemovalFailed,
)
from switch_core.bridges.collaboration.matrix.chunking import chunk_message
from switch_core.bridges.collaboration.matrix.client import MatrixApiError, MatrixClient
from switch_core.bridges.collaboration.matrix.config import MatrixConnectionConfig
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelRetirement,
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

logger = logging.getLogger(__name__)

_COMMAND_PREFIXES = ("!", "/")
_MEDIA_TYPES = {"m.image", "m.file", "m.audio", "m.video"}
_MATRIX_USER_BARE = re.compile(r"@([A-Za-z0-9._=/+-]+):([A-Za-z0-9.-]+(?::\d+)?)")
_INBOUND_MENTION = re.compile(rf"{_MATRIX_USER_BARE.pattern}|@room\b", re.IGNORECASE)
_MENTION = re.compile(r"(?<![\w@/])@([A-Za-z0-9][A-Za-z0-9._-]*)(?![\w:])")
_SEEN_LIMIT = 5000


class MatrixAdapter(PlatformAdapter):
    display_name = "Matrix"
    docs_slug = "matrix"
    channel_on_delete: ClassVar[ChannelRetirement] = "left"

    keeps_quiet_unless_listening = True
    supports_channel_creation = True
    supports_directory_search = True
    draws_session_activity = True
    separate_attention_slot = True
    supports_activity_reactions = True
    supports_queue_reaction = True
    channel_mention = "@room"
    notifies_only_by_mention = True
    renders_custom_url_schemes = False

    def __init__(self, config: MatrixConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._client = MatrixClient(config)
        self._user_id: str | None = None
        self._bot_localpart = ""
        self._sync_token: str | None = None
        self._sync_task: asyncio.Task[None] | None = None
        self._stopping = False
        self._known_rooms: set[str] = set()
        self._refused_rooms: set[str] = set()
        self._room_names: dict[str, str] = {}
        self._room_types: dict[str, ChannelType] = {}
        self._member_names: dict[str, dict[str, str]] = {}
        self._mention_targets: dict[str, str] = {}
        self._mention_targets_lower: dict[str, str] = {}
        self._reactions: dict[tuple[str, str], dict[str, str]] = {}
        self._seen: OrderedDict[str, None] = OrderedDict()

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

        try:
            self._user_id = await self._client.whoami()
        except MatrixApiError as exc:
            await self._client.close()
            if exc.status == 401 or exc.errcode in (
                "M_UNKNOWN_TOKEN",
                "M_MISSING_TOKEN",
            ):
                raise BridgeCredentialError(
                    f"Matrix refused the bot access token at "
                    f"{self._config.homeserver_url}: {exc.message}"
                ) from exc
            raise BridgeOperationError(
                f"Matrix at {self._config.homeserver_url} returned an error "
                f"checking the bot account: {exc.message}"
            ) from exc
        except httpx.RequestError:
            await self._client.close()
            raise
        self._bot_localpart = self._localpart(self._user_id)

        if not self._listening:
            logger.info(
                "Matrix adapter for %s running quietly: another process holds "
                "this bridge and syncs for it",
                self._user_id,
            )
            return

        self._sync_task = asyncio.create_task(
            self._sync_forever(), name=f"matrix-sync-{self._bot_localpart}"
        )

    async def stop(self) -> None:
        self._stopping = True
        task = self._sync_task
        self._sync_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await self._client.close()

    async def _sync_forever(self) -> None:
        while not self._stopping:
            try:
                body = await self._client.sync(self._sync_token)
                await self._handle_sync(body)
                next_batch = body.get("next_batch")
                if isinstance(next_batch, str) and next_batch:
                    self._sync_token = next_batch
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning(
                    "Matrix sync for %s failed; retrying shortly",
                    self._user_id,
                    exc_info=True,
                )
                await asyncio.sleep(5)

    async def _handle_sync(self, body: dict[str, Any]) -> None:
        rooms = body.get("rooms")
        if not isinstance(rooms, dict):
            return
        failure: Exception | None = None
        invite = rooms.get("invite")
        if isinstance(invite, dict):
            for room_id, room in invite.items():
                if isinstance(room_id, str) and isinstance(room, dict):
                    try:
                        await self._handle_invite(room_id, room)
                    except Exception as exc:
                        logger.warning(
                            "Could not handle the Matrix invitation to %s",
                            room_id,
                            exc_info=True,
                        )
                        failure = failure or exc
        joined = rooms.get("join")
        if isinstance(joined, dict):
            for room_id, room in joined.items():
                if isinstance(room_id, str) and isinstance(room, dict):
                    try:
                        await self._handle_joined(room_id, room)
                    except Exception as exc:
                        logger.warning(
                            "Could not handle Matrix room %s", room_id, exc_info=True
                        )
                        failure = failure or exc
        leave = rooms.get("leave")
        if isinstance(leave, dict):
            for room_id in leave:
                if isinstance(room_id, str):
                    self._forget_room(room_id)
        if failure is not None:
            raise failure

    async def _handle_invite(self, room_id: str, room: dict[str, Any]) -> None:
        events = self._events(room.get("invite_state"))
        encrypted = self._has_encryption(events)
        try:
            await self._client.join(room_id)
        except MatrixApiError as exc:
            logger.warning(
                "Could not join Matrix room %s after being invited: %s",
                room_id,
                exc.message,
            )
            return
        if encrypted:
            await self._refuse_encrypted(room_id, "the invitation was encrypted")
            return
        await self._announce_room(room_id)

    async def _handle_joined(self, room_id: str, room: dict[str, Any]) -> None:
        timeline = self._events(room.get("timeline"))
        state = self._events(room.get("state"))
        encrypted = self._has_encryption(state) or self._has_encryption(timeline)
        if encrypted:
            await self._refuse_encrypted(room_id, "encryption was turned on")
            return

        if room_id not in self._known_rooms:
            await self._announce_room(room_id, state=state)
            if room_id not in self._known_rooms:
                return

        await self._note_room_name(room_id, state)
        for event in timeline:
            event_type = event.get("type")
            if event_type in ("m.room.encryption", "m.room.encrypted"):
                await self._refuse_encrypted(room_id, "encryption was turned on")
                return
            if event_type == "m.room.name":
                await self._note_room_name(room_id, [event])
            elif event_type == "m.room.member":
                await self._handle_member(room_id, event)
            elif event_type == "m.room.message":
                await self._handle_message(room_id, event)

    async def _announce_room(
        self, room_id: str, *, state: list[dict[str, Any]] | None = None
    ) -> None:
        if not state:
            try:
                state = await self._client.room_state(room_id)
            except MatrixApiError as exc:
                logger.warning(
                    "Could not read Matrix room %s: %s", room_id, exc.message
                )
                return
        if self._has_encryption(state):
            await self._refuse_encrypted(room_id, "the room is encrypted")
            return
        try:
            members = await self._client.joined_members(room_id)
        except MatrixApiError as exc:
            logger.warning(
                "Could not read Matrix room %s members: %s", room_id, exc.message
            )
            return
        self._member_names[room_id] = {
            user_id: self._display_name(user_id, info)
            for user_id, info in members.items()
            if isinstance(user_id, str) and isinstance(info, dict)
        }
        name = self._room_name(room_id, state)
        channel_type = self._channel_type(state, len(members))
        self._room_names[room_id] = name
        self._room_types[room_id] = channel_type
        if self._on_app_joined is not None:
            await self._on_app_joined(
                InboundAppJoin(
                    channel_id=room_id,
                    channel_type=channel_type,
                    channel_name=name,
                )
            )
        self._known_rooms.add(room_id)

    async def _refuse_encrypted(self, room_id: str, why: str) -> None:
        already_refused = room_id in self._refused_rooms
        self._refused_rooms.add(room_id)
        self._forget_room(room_id)
        if not already_refused:
            logger.warning("Leaving encrypted Matrix room %s: %s", room_id, why)
            notice = (
                "Switch cannot bridge this room because Matrix end-to-end "
                "encryption is on. Encrypted rooms are not supported. Use an "
                "unencrypted room and invite the bot again."
            )
            try:
                await self._send_text(room_id, notice, None)
            except (MatrixApiError, httpx.HTTPError) as exc:
                logger.warning(
                    "Could not post the encryption notice in Matrix room %s: %s",
                    room_id,
                    exc,
                )
        try:
            await self._client.leave(room_id)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.warning("Could not leave encrypted Matrix room %s: %s", room_id, exc)

    async def _handle_member(self, room_id: str, event: dict[str, Any]) -> None:
        state_key = event.get("state_key")
        content = event.get("content")
        if not isinstance(state_key, str) or not isinstance(content, dict):
            return
        membership = content.get("membership")
        if state_key == self._user_id:
            if membership in ("leave", "ban"):
                self._forget_room(room_id)
            return
        names = self._member_names.setdefault(room_id, {})
        if membership == "join":
            name = self._display_name(state_key, content)
            names[state_key] = name
            if self._on_user_joined is not None:
                await self._on_user_joined(
                    InboundUserJoin(
                        channel_id=room_id,
                        channel_type=await self._channel_type_for(room_id),
                        external_user_id=state_key,
                        external_username=name,
                        channel_name=self._room_names.get(room_id),
                    )
                )
        elif membership in ("leave", "ban"):
            names.pop(state_key, None)

    async def _handle_message(self, room_id: str, event: dict[str, Any]) -> None:
        event_id = event.get("event_id")
        sender = event.get("sender")
        content = event.get("content")
        if not isinstance(event_id, str) or not isinstance(sender, str):
            return
        if sender == self._user_id or not isinstance(content, dict):
            return
        if event_id in self._seen:
            return

        relates = content.get("m.relates_to")
        if isinstance(relates, dict) and relates.get("rel_type") == "m.replace":
            self._remember(event_id)
            return
        if relates is not None and not isinstance(relates, dict):
            relates = None

        body = content.get("body")
        text = body if isinstance(body, str) else ""
        msgtype = content.get("msgtype")
        if msgtype in _MEDIA_TYPES:
            text = ""

        if text:
            parsed = self._parse_command(text.strip())
            if parsed is not None and self._on_command is not None:
                name, args = parsed
                await self._on_command(
                    InboundCommand(
                        channel_id=room_id,
                        channel_type=await self._channel_type_for(room_id),
                        sender_id=sender,
                        sender_name=self._member_name(room_id, sender),
                        command=name,
                        args=self.translate_inbound(args),
                        message_ref=event_id,
                        root_id=self._thread_root(relates),
                        channel_name=self._room_names.get(room_id),
                    )
                )
                self._remember(event_id)
                return

        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        if msgtype in _MEDIA_TYPES:
            await self._collect_attachment(content, attachments, failures)

        if not text and not attachments and not failures:
            self._remember(event_id)
            return
        if self._on_message is None:
            return

        translated = self.translate_inbound(text)
        self_mention = None
        if self._bot_localpart and re.search(
            rf"@{re.escape(self._bot_localpart)}(?::|\b)", text, re.IGNORECASE
        ):
            self_mention = self._bot_localpart
        await self._on_message(
            InboundMessage(
                channel_id=room_id,
                channel_type=await self._channel_type_for(room_id),
                sender_id=sender,
                sender_name=self._member_name(room_id, sender),
                content=translated,
                message_ref=event_id,
                root_id=self._thread_root(relates),
                channel_name=self._room_names.get(room_id),
                attachments=attachments,
                attachment_failures=failures,
                self_mention_token=self_mention,
            )
        )
        self._remember(event_id)

    async def _collect_attachment(
        self,
        content: dict[str, Any],
        attachments: list[Attachment],
        failures: list[AttachmentFailure],
    ) -> None:
        filename = content.get("body")
        filename = filename if isinstance(filename, str) and filename else "attachment"
        if isinstance(content.get("file"), dict):
            failures.append(
                AttachmentFailure(
                    filename=filename,
                    reason="the attachment is encrypted, which Switch does not support",
                )
            )
            return
        url = content.get("url")
        if not isinstance(url, str) or not url.startswith("mxc://"):
            failures.append(
                AttachmentFailure(
                    filename=filename,
                    reason="the homeserver did not include a download URL",
                )
            )
            return
        info = content.get("info")
        info = info if isinstance(info, dict) else {}
        size = info.get("size")
        if isinstance(size, int) and size > self._max_attachment_bytes:
            failures.append(
                AttachmentFailure(
                    filename=filename,
                    reason=(
                        f"the file is {size} bytes, over the bridge's "
                        f"{self._max_attachment_bytes} byte limit"
                    ),
                )
            )
            return
        try:
            data = await self._client.download_media(url)
        except (MatrixApiError, httpx.HTTPError) as exc:
            failures.append(
                AttachmentFailure(
                    filename=filename,
                    reason=f"the file could not be downloaded: {exc}",
                )
            )
            return
        if len(data) > self._max_attachment_bytes:
            failures.append(
                AttachmentFailure(
                    filename=filename,
                    reason=(
                        f"the file is {len(data)} bytes, over the bridge's "
                        f"{self._max_attachment_bytes} byte limit"
                    ),
                )
            )
            return
        mimetype = info.get("mimetype")
        if not isinstance(mimetype, str) or not mimetype:
            mimetype = "application/octet-stream"
        attachments.append(Attachment(filename=filename, mimetype=mimetype, data=data))

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        agent = await self.agent_rendering(sender_name)
        label = self.escape_label_for_body(agent.body_label)
        body = f"**{label}**\n{content}" if content else f"**{label}**"
        return await self._send_text(
            channel_id,
            body,
            thread_root_id,
            room_wide_mention=room_wide_mention,
        )

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        body = self._admin_body(self.translate_outbound(content), drawn)
        return await self._send_text(channel_id, body, thread_root_id)

    async def _send_text(
        self,
        room_id: str,
        body: str,
        thread_root_id: str | None,
        *,
        room_wide_mention: bool = False,
    ) -> str:
        first: str | None = None
        for chunk in chunk_message(body):
            event_id = await self._client.send_event(
                room_id,
                "m.room.message",
                self._message_content(
                    chunk,
                    thread_root_id,
                    room_wide_mention=room_wide_mention and first is None,
                ),
            )
            if first is None:
                first = event_id
        if first is None:
            raise MatrixApiError(500, None, "nothing to send")
        return first

    def _message_content(
        self,
        body: str,
        thread_root_id: str | None,
        *,
        room_wide_mention: bool = False,
    ) -> dict[str, Any]:
        content: dict[str, Any] = {"msgtype": "m.text", "body": body}
        if body:
            content["format"] = "org.matrix.custom.html"
            content["formatted_body"] = markdown.markdown(
                body, extensions=["fenced_code", "tables", "sane_lists"]
            )
        mentioned = sorted(
            {match.group(0) for match in _MATRIX_USER_BARE.finditer(body)}
        )
        if mentioned or room_wide_mention:
            mentions: dict[str, Any] = {}
            if mentioned:
                mentions["user_ids"] = mentioned
            if room_wide_mention:
                mentions["room"] = True
            content["m.mentions"] = mentions
        if thread_root_id is not None:
            content["m.relates_to"] = {
                "rel_type": "m.thread",
                "event_id": thread_root_id,
                "m.in_reply_to": {"event_id": thread_root_id},
            }
        return content

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
        if len(data) > self._max_attachment_bytes:
            note = (
                f"_attachment not relayed: {filename} is {len(data)} bytes, "
                f"over the bridge's {self._max_attachment_bytes} byte limit_"
            )
            body = f"{caption}\n{note}" if caption else note
            return await self.admin_message(channel_id, body, thread_root_id)
        try:
            uri = await self._client.upload_media(data, filename, mimetype)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.warning(
                "Could not upload %s to Matrix room %s: %s", filename, channel_id, exc
            )
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )
        if caption:
            await self.send_message(channel_id, sender_name, caption, thread_root_id)
        if mimetype.startswith("image/"):
            msgtype = "m.image"
        elif mimetype.startswith("audio/"):
            msgtype = "m.audio"
        elif mimetype.startswith("video/"):
            msgtype = "m.video"
        else:
            msgtype = "m.file"
        content: dict[str, Any] = {
            "msgtype": msgtype,
            "body": filename,
            "filename": filename,
            "url": uri,
            "info": {"mimetype": mimetype, "size": len(data)},
        }
        if thread_root_id is not None:
            content["m.relates_to"] = {
                "rel_type": "m.thread",
                "event_id": thread_root_id,
                "m.in_reply_to": {"event_id": thread_root_id},
            }
        try:
            return await self._client.send_event(channel_id, "m.room.message", content)
        except MatrixApiError as exc:
            logger.warning(
                "Could not send %s to Matrix room %s: %s", filename, channel_id, exc
            )
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        chunks = chunk_message(new_content)
        if len(chunks) > 1:
            logger.warning(
                "Matrix edit for %s is too long and was cut to %d characters",
                message_ref,
                len(chunks[0]),
            )
        body = chunks[0]
        content = self._message_content(body, None)
        content["body"] = f"* {body}"
        content["m.new_content"] = self._message_content(body, None)
        content["m.relates_to"] = {
            "rel_type": "m.replace",
            "event_id": message_ref,
        }
        try:
            await self._client.send_event(channel_id, "m.room.message", content)
        except MatrixApiError as exc:
            logger.warning(
                "Could not edit Matrix message %s in %s: %s",
                message_ref,
                channel_id,
                exc.message,
            )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        try:
            await self._client.redact(
                channel_id, message_ref, "Switch deleted this message"
            )
        except MatrixApiError as exc:
            raise RemovalFailed(
                f"Matrix would not redact {message_ref} in {channel_id}: {exc.message}"
            ) from exc

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        if self._user_id is None:
            return
        try:
            await self._client.typing(channel_id, self._user_id, typing=is_typing)
        except (MatrixApiError, httpx.HTTPError) as exc:
            logger.debug("Could not set Matrix typing in %s: %s", channel_id, exc)

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        await self.send_typing(channel_id, agent_name, True)

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
        key = "👀" if mark == "working" else "⏳"
        marks = self._reactions.setdefault((channel_id, message_ref), {})
        if on:
            if mark in marks:
                return
            try:
                ref = await self._client.send_event(
                    channel_id,
                    "m.reaction",
                    {
                        "m.relates_to": {
                            "rel_type": "m.annotation",
                            "event_id": message_ref,
                            "key": key,
                        }
                    },
                )
            except MatrixApiError as exc:
                if exc.status in (400, 403):
                    raise ActivityMarkRefused(
                        f"Matrix refused the {mark} reaction on {message_ref}: "
                        f"{exc.message}"
                    ) from exc
                raise
            marks[mark] = ref
            return
        if mark not in marks:
            return
        ref = marks.pop(mark)
        try:
            await self._client.redact(
                channel_id, ref, "Switch finished with this message"
            )
        except MatrixApiError as exc:
            logger.warning(
                "Could not remove the %s reaction from Matrix message %s: %s",
                mark,
                message_ref,
                exc.message,
            )

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        try:
            return await self._client.create_room(
                name,
                topic,
                public=channel_type == "channel_public",
                invite=[],
                is_direct=channel_type == "direct",
            )
        except MatrixApiError as exc:
            raise BridgeOperationError(
                f"Matrix would not create the room {name!r}: {exc.message}"
            ) from exc

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        if not user_external_id.startswith("@"):
            raise ChannelCreationUnsupported(
                "Matrix direct messages need the person's Matrix user id, "
                "which Switch does not have for this person yet"
            )
        try:
            return await self._client.create_room(
                f"{agent_name} and {user_name}",
                "",
                public=False,
                invite=[user_external_id],
                is_direct=True,
            )
        except MatrixApiError as exc:
            raise BridgeOperationError(
                f"Matrix would not create a direct room with {user_name}: {exc.message}"
            ) from exc

    def rich_fallback_limit(self) -> int:
        return 30000

    async def _channel_type_for(self, room_id: str) -> ChannelType:
        known = self._room_types.get(room_id)
        if known is not None:
            return known
        return await self.get_channel_type(room_id)

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        try:
            state = await self._client.room_state(channel_id)
            members = await self._client.joined_members(channel_id)
        except MatrixApiError as exc:
            raise BridgeOperationError(
                f"Matrix would not describe room {channel_id}: {exc.message}"
            ) from exc
        channel_type = self._channel_type(state, len(members))
        self._room_types[channel_id] = channel_type
        return channel_type

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        failed: list[str] = []
        try:
            joined = await self._client.joined_members(channel_id)
        except MatrixApiError as exc:
            logger.warning(
                "Could not read Matrix room %s before inviting people: %s",
                channel_id,
                exc.message,
            )
            return list(user_external_ids)
        for user_id in user_external_ids:
            if not user_id.startswith("@"):
                failed.append(user_id)
                continue
            if user_id in joined:
                continue
            try:
                await self._client.invite(channel_id, user_id)
            except MatrixApiError as exc:
                logger.warning(
                    "Could not invite %s to Matrix room %s: %s",
                    user_id,
                    channel_id,
                    exc.message,
                )
                failed.append(user_id)
        return failed

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        try:
            results = await self._client.search_users(query)
        except MatrixApiError as exc:
            raise BridgeOperationError(
                f"Matrix would not search its user directory: {exc.message}"
            ) from exc
        users: list[DirectoryUser] = []
        for result in results:
            if not isinstance(result, dict):
                continue
            user_id = result.get("user_id")
            if not isinstance(user_id, str) or not user_id:
                continue
            display = result.get("display_name")
            display_name = (
                display
                if isinstance(display, str) and display
                else self._localpart(user_id)
            )
            users.append(
                DirectoryUser(
                    external_user_id=user_id,
                    username=self._localpart(user_id),
                    display_name=display_name,
                )
            )
        return users

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        try:
            await self._client.leave(external_channel_id)
        except MatrixApiError as exc:
            try:
                members = await self._client.joined_members(external_channel_id)
            except MatrixApiError:
                return RetireOutcome.failed(exc.message)
            if self._user_id not in members:
                return RetireOutcome(outcome="left")
            return RetireOutcome.failed(exc.message)
        return RetireOutcome(outcome="left")

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        return f"https://matrix.to/#/{quote(external_channel_id, safe='')}"

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        try:
            events = await self._client.relations(
                channel_id, root_ref, "m.thread", limit=10
            )
        except (MatrixApiError, httpx.HTTPError):
            return False
        if len(events) >= 10:
            return False
        target_ts: int | None = None
        for event in events:
            if event.get("event_id") == message_ref:
                ts = event.get("origin_server_ts")
                target_ts = ts if isinstance(ts, int) else None
                break
        if target_ts is None:
            return False
        for event in events:
            if event.get("event_id") == message_ref:
                continue
            ts = event.get("origin_server_ts")
            if isinstance(ts, int) and ts < target_ts:
                return False
        return True

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = MatrixConnectionConfig.model_validate(connection_config)
        client = MatrixClient(config)
        try:
            await client.whoami()
        except MatrixApiError as exc:
            if exc.status == 401 or exc.errcode in (
                "M_UNKNOWN_TOKEN",
                "M_MISSING_TOKEN",
            ):
                raise BridgeCredentialError(
                    f"Matrix refused the bot access token at "
                    f"{config.homeserver_url}: {exc.message}. Check the token."
                ) from exc
            raise BridgeOperationError(
                f"Matrix at {config.homeserver_url} returned an error checking "
                f"the bot account: {exc.message}"
            ) from exc
        finally:
            await client.close()

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, MatrixApiError):
            if exc.status == 401 or exc.errcode in (
                "M_UNKNOWN_TOKEN",
                "M_MISSING_TOKEN",
            ):
                return "auth_failed"
            return "platform_error"
        if isinstance(exc, httpx.RequestError):
            return "network"
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        config = MatrixConnectionConfig.model_validate(connection_config)
        return [config.homeserver_url]

    def _render_outbound(self, content: str) -> str:
        if not self._mention_targets:
            return content

        def replace(match: re.Match[str]) -> str:
            name = match.group(1)
            target = self._mention_targets.get(name) or self._mention_targets_lower.get(
                name.lower()
            )
            if target is None:
                return match.group(0)
            return target if target.startswith("@") else f"@{target}"

        return _MENTION.sub(replace, content)

    def defuse_mass_mentions(self, text: str) -> str:
        text = super().defuse_mass_mentions(text)
        return re.sub(r"@(?=room\b)", "@\u200b", text, flags=re.IGNORECASE)

    def translate_inbound(self, raw_message: str) -> str:
        def replace(match: re.Match[str]) -> str:
            token = match.group(0)
            if ":" in token:
                return f"@{token[1:].split(':', 1)[0]}"
            return "@everyone"

        return _INBOUND_MENTION.sub(replace, raw_message)

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        self._mention_targets = dict(targets)
        self._mention_targets_lower = {
            name.lower(): target for name, target in targets.items()
        }

    @staticmethod
    def _events(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, dict):
            return []
        events = value.get("events")
        if not isinstance(events, list):
            return []
        return [event for event in events if isinstance(event, dict)]

    @staticmethod
    def _has_encryption(events: list[dict[str, Any]]) -> bool:
        return any(
            event.get("type") in ("m.room.encryption", "m.room.encrypted")
            for event in events
        )

    @staticmethod
    def _state_content(
        events: list[dict[str, Any]], event_type: str
    ) -> dict[str, Any] | None:
        found: dict[str, Any] | None = None
        for event in events:
            if event.get("type") != event_type:
                continue
            content = event.get("content")
            if isinstance(content, dict):
                found = content
        return found

    def _room_name(self, room_id: str, state: list[dict[str, Any]]) -> str:
        content = self._state_content(state, "m.room.name")
        if content is not None:
            name = content.get("name")
            if isinstance(name, str) and name:
                return name
        names = [
            name
            for user_id, name in self._member_names.get(room_id, {}).items()
            if user_id != self._user_id
        ]
        if names:
            return ", ".join(names[:3])
        return room_id

    @staticmethod
    def _channel_type(state: list[dict[str, Any]], member_count: int) -> ChannelType:
        join_rules = MatrixAdapter._state_content(state, "m.room.join_rules") or {}
        rule = join_rules.get("join_rule")
        if rule == "public":
            return "channel_public"
        if member_count <= 2:
            return "direct"
        if rule in ("invite", "knock", "restricted", "private"):
            return "channel_private"
        return "group"

    async def _note_room_name(self, room_id: str, events: list[dict[str, Any]]) -> None:
        content = self._state_content(events, "m.room.name")
        if content is None:
            return
        name = content.get("name")
        if not isinstance(name, str) or not name:
            return
        old = self._room_names.get(room_id)
        if old is not None and old != name and self._on_channel_named is not None:
            await self._on_channel_named(room_id, old, name)
        self._room_names[room_id] = name

    def _forget_room(self, room_id: str) -> None:
        self._known_rooms.discard(room_id)
        self._room_names.pop(room_id, None)
        self._room_types.pop(room_id, None)
        self._member_names.pop(room_id, None)

    def _member_name(self, room_id: str, user_id: str) -> str:
        name = self._member_names.get(room_id, {}).get(user_id)
        return name or self._localpart(user_id)

    @staticmethod
    def _localpart(user_id: str) -> str:
        return user_id[1:].split(":", 1)[0] if user_id.startswith("@") else user_id

    @staticmethod
    def _display_name(user_id: str, info: dict[str, Any]) -> str:
        name = info.get("displayname")
        if isinstance(name, str) and name:
            return name
        return MatrixAdapter._localpart(user_id)

    @staticmethod
    def _thread_root(relates: dict[str, Any] | None) -> str | None:
        if relates is None:
            return None
        if relates.get("rel_type") == "m.thread":
            root = relates.get("event_id")
            return root if isinstance(root, str) else None
        reply = relates.get("m.in_reply_to")
        if isinstance(reply, dict):
            root = reply.get("event_id")
            return root if isinstance(root, str) else None
        return None

    @staticmethod
    def _parse_command(text: str) -> tuple[str, str] | None:
        if not text or text[0] not in _COMMAND_PREFIXES:
            return None
        parts = text.split(None, 1)
        name = parts[0][1:].split("@", 1)[0]
        if not name:
            return None
        if text[0] == "/" and name not in COMMANDS_BY_NAME:
            name = name.replace("_", "-")
        return name, parts[1].strip() if len(parts) > 1 else ""

    def _remember(self, event_id: str) -> None:
        self._seen[event_id] = None
        while len(self._seen) > _SEEN_LIMIT:
            self._seen.popitem(last=False)
