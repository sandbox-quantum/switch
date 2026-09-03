"""Matrix implementation of `MessageTransport`.

This is the only module in Switch that may import matrix-nio. Everything
Matrix-shaped lives here: content dicts, `m.relates_to` threading, mxc URIs,
pagination tokens and the sync loop.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import Any

import markdown
from nio import (
    AsyncClient,
    DownloadError,
    InviteMemberEvent,
    JoinedRoomsError,
    LoginError,
    ProfileSetDisplayNameError,
    ReactionEvent,
    RoomGetEventError,
    RoomMemberEvent,
    RoomMessageMedia,
    RoomMessagesError,
    RoomMessageText,
    RoomSendError,
    RoomTypingError,
    SyncError,
    SyncResponse,
    UnknownEvent,
    UploadError,
)

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.transport.port import TransportHandlers
from switch_core.transport.types import (
    DownloadResult,
    HistoryPage,
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
    MessageFormat,
    NotConnectedError,
    RoomRef,
    SendResult,
    TransportError,
    UploadResult,
)

logger = logging.getLogger(__name__)

SYNC_TIMEOUT_MS = 30000


@dataclass(frozen=True)
class _RoomIdOnly:
    """Stands in for a room object when only the id is known.

    History and single-event fetches return events without the room they came
    from, but the converters only ever read the id.
    """

    room_id: str


def _content(event: Any) -> dict[str, object]:
    source = getattr(event, "source", None) or {}
    content = source.get("content") or {}
    return dict(content)


def _thread_root_of(content: dict[str, object], event_id: str) -> str | None:
    """The thread this event belongs to, or None when it is top level.

    Matrix threads are flat: an event either relates to a root or is one.
    """
    relates = content.get("m.relates_to") or {}
    if isinstance(relates, dict) and relates.get("rel_type") == "m.thread":
        root = relates.get("event_id")
        return str(root) if root else None
    return None


def to_room_ref(room: Any) -> RoomRef:
    return RoomRef(room_id=room.room_id)


def to_inbound_message(room: Any, event: Any) -> InboundMessage:
    content = _content(event)
    return InboundMessage(
        room_id=room.room_id,
        event_id=event.event_id,
        sender=event.sender,
        timestamp=event.server_timestamp,
        content=content,
        body=getattr(event, "body", "") or "",
        sender_name=content.get("sender_name"),  # type: ignore[arg-type]
        formatted_body=getattr(event, "formatted_body", None),
        msgtype=str(content.get("msgtype") or "m.text"),
        thread_root_id=_thread_root_of(content, event.event_id),
    )


def to_inbound_media(room: Any, event: Any) -> InboundMedia:
    content = _content(event)
    info = content.get("info") or {}
    if not isinstance(info, dict):
        info = {}
    return InboundMedia(
        room_id=room.room_id,
        event_id=event.event_id,
        sender=event.sender,
        timestamp=event.server_timestamp,
        content=content,
        body=getattr(event, "body", "") or "",
        sender_name=content.get("sender_name"),  # type: ignore[arg-type]
        uri=str(getattr(event, "url", "") or ""),
        filename=content.get("filename") or getattr(event, "body", None),  # type: ignore[arg-type]
        mimetype=info.get("mimetype"),
        size=info.get("size"),
        msgtype=str(content.get("msgtype") or "m.file"),
        thread_root_id=_thread_root_of(content, event.event_id),
        group=content.get(ATTACHMENT_GROUP_KEY),  # type: ignore[arg-type]
    )


def to_inbound_membership(room: Any, event: Any) -> InboundMembership:
    content = _content(event)
    return InboundMembership(
        room_id=room.room_id,
        event_id=getattr(event, "event_id", ""),
        sender=getattr(event, "sender", ""),
        timestamp=getattr(event, "server_timestamp", 0),
        content=content,
        state_key=getattr(event, "state_key", ""),
        membership=getattr(event, "membership", ""),
        prev_membership=getattr(event, "prev_membership", None),
        display_name=content.get("displayname"),  # type: ignore[arg-type]
    )


def to_inbound_custom(room: Any, event: Any) -> InboundCustomEvent:
    content = _content(event)
    return InboundCustomEvent(
        room_id=room.room_id,
        event_id=event.event_id,
        sender=event.sender,
        timestamp=getattr(event, "server_timestamp", 0),
        content=content,
        event_type=event.type,
        thread_root_id=_thread_root_of(content, event.event_id),
    )


def to_inbound(room: Any, event: Any) -> InboundEvent:
    """Convert a timeline event to the DTO matching its kind."""
    if isinstance(event, RoomMessageMedia):
        return to_inbound_media(room, event)
    if isinstance(event, RoomMessageText):
        return to_inbound_message(room, event)
    if isinstance(event, RoomMemberEvent):
        return to_inbound_membership(room, event)
    if isinstance(event, UnknownEvent):
        return to_inbound_custom(room, event)
    return to_inbound_event(room, event)


def to_inbound_event(room: Any, event: Any) -> InboundEvent:
    return InboundEvent(
        room_id=room.room_id,
        event_id=getattr(event, "event_id", ""),
        sender=getattr(event, "sender", ""),
        timestamp=getattr(event, "server_timestamp", 0),
        content=_content(event),
    )


def _thread_relation(thread_root_id: str) -> dict[str, object]:
    """A pure `m.thread` relation, with no `m.in_reply_to` fallback.

    The root id must already be an actual thread root; mid-thread ids are
    normalised upstream.
    """
    return {"rel_type": "m.thread", "event_id": thread_root_id}


class MatrixTransport:
    """Carries Switch messages over a Matrix homeserver."""

    def __init__(
        self,
        *,
        server_url: str,
        user_id: str,
        password: str,
        device_id: str | None = None,
        access_token: str | None = None,
        client: AsyncClient | None = None,
    ) -> None:
        self.server_url = server_url
        self.user_id = user_id
        self.password = password
        self.device_id = device_id
        self.access_token = access_token
        self._client: AsyncClient | None = client
        self._handlers = TransportHandlers()

    # ── Session ───────────────────────────────────────────────────────────────

    @property
    def raw_client(self) -> AsyncClient:
        """The underlying nio client.

        An escape hatch for call sites not yet expressed on the port. New code
        must use the port; this exists so the migration can proceed in steps.
        """
        if self._client is None:
            raise NotConnectedError(
                f"Transport for {self.user_id} is not connected — call connect() first"
            )
        return self._client

    @property
    def session_state(self) -> dict[str, str | None]:
        return {"access_token": self.access_token, "device_id": self.device_id}

    async def connect(self) -> None:
        if self._client is None:
            self._client = AsyncClient(self.server_url, self.user_id)

        if self.access_token and self.device_id:
            self._client.access_token = self.access_token
            self._client.device_id = self.device_id
            logger.info("Transport %s restored session from stored token", self.user_id)
            return

        if not self.password:
            raise TransportError(f"No credentials available for {self.user_id}")

        resp = await self._client.login(self.password)
        if isinstance(resp, LoginError):
            raise TransportError(f"Login failed for {self.user_id}: {resp.message}")
        self.device_id = resp.device_id
        self.access_token = self._client.access_token
        logger.info("Transport %s authenticated via password", self.user_id)

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()

    async def relogin(self) -> None:
        """Re-authenticate an existing connection after a session failure."""
        if not self.password:
            return
        resp = await self.raw_client.login(self.password)
        if isinstance(resp, LoginError):
            raise TransportError(f"Re-login failed for {self.user_id}: {resp.message}")
        self.device_id = resp.device_id
        self.access_token = self.raw_client.access_token

    def register_handlers(self, handlers: TransportHandlers) -> None:
        self._handlers = handlers
        client = self.raw_client

        def bind(handler: Any, convert: Any, kind: Any) -> None:
            if handler is None:
                return

            async def _cb(room: Any, event: Any) -> None:
                await handler(to_room_ref(room), convert(room, event))

            client.add_event_callback(_cb, kind)

        bind(handlers.on_message, to_inbound_message, RoomMessageText)
        # RoomMessageMedia is the base of RoomMessageImage / RoomMessageFile, so
        # one callback covers every media msgtype.
        bind(handlers.on_media, to_inbound_media, RoomMessageMedia)
        bind(handlers.on_reaction, to_inbound_event, ReactionEvent)
        bind(handlers.on_member_event, to_inbound_membership, RoomMemberEvent)
        bind(handlers.on_custom_event, to_inbound_custom, UnknownEvent)
        bind(handlers.on_invite, to_inbound_membership, InviteMemberEvent)

        if handlers.on_sync is not None:
            on_sync = handlers.on_sync

            async def _sync_cb(response: SyncResponse) -> None:
                await on_sync(response.next_batch)

            client.add_response_callback(_sync_cb, SyncResponse)  # type: ignore[arg-type]

        if handlers.on_sync_error is not None:
            on_sync_error = handlers.on_sync_error

            async def _sync_error_cb(response: SyncError) -> None:
                await on_sync_error(response.message)

            client.add_response_callback(_sync_error_cb, SyncError)  # type: ignore[arg-type]

    async def receive_forever(self, *, since: str | None) -> None:
        await self.raw_client.sync_forever(timeout=SYNC_TIMEOUT_MS, since=since)

    # ── Outbound ──────────────────────────────────────────────────────────────

    async def send_message(
        self,
        room_id: str,
        body: str,
        *,
        sender_name: str,
        format: MessageFormat = "text",
        mentions: list[str] | None = None,
        thread_root_id: str | None = None,
        extra_content: dict[str, object] | None = None,
    ) -> SendResult:
        content: dict[str, object] = {
            "msgtype": "m.text",
            "body": body,
            "sender_name": sender_name,
        }
        # Caller-supplied content fields (e.g. a `com.switch.*` marker) are
        # merged in. They ride on the plain m.room.message — the body still
        # renders normally; the extra keys are metadata other clients can read.
        if extra_content:
            content.update(extra_content)

        if format == "markdown":
            html = markdown.markdown(body)
            if mentions:
                for user_id in mentions:
                    local = user_id.split(":")[0].lstrip("@")
                    pill = f'<a href="https://matrix.to/#/{user_id}">{local}</a>'
                    html = html.replace(f"@{local}", pill)
            content["format"] = "org.matrix.custom.html"
            content["formatted_body"] = html

        if thread_root_id is not None:
            content["m.relates_to"] = _thread_relation(thread_root_id)

        return await self._room_send(room_id, "m.room.message", content)

    async def send_event(
        self,
        room_id: str,
        event_type: str,
        content: dict[str, object],
    ) -> SendResult:
        return await self._room_send(room_id, event_type, content)

    async def send_media(
        self,
        room_id: str,
        uri: str,
        filename: str,
        mimetype: str,
        size: int,
        *,
        sender_name: str,
        msgtype: str,
        caption: str | None = None,
        thread_root_id: str | None = None,
        group: dict[str, object] | None = None,
    ) -> SendResult:
        # When a caption is given it becomes the event body, with the real
        # filename carried separately per the rich-media-caption convention.
        content: dict[str, object] = {
            "msgtype": msgtype,
            "body": caption if caption else filename,
            "url": uri,
            "info": {"mimetype": mimetype, "size": size},
            "sender_name": sender_name,
        }
        if caption:
            content["filename"] = filename
        if group is not None:
            content[ATTACHMENT_GROUP_KEY] = group
        if thread_root_id is not None:
            content["m.relates_to"] = _thread_relation(thread_root_id)

        return await self._room_send(room_id, "m.room.message", content)

    async def _room_send(
        self, room_id: str, event_type: str, content: dict[str, object]
    ) -> SendResult:
        resp = await self.raw_client.room_send(room_id, event_type, content)
        if isinstance(resp, RoomSendError):
            raise TransportError(
                f"Failed to send {event_type} to {room_id}: {resp.message}"
            )
        return SendResult(
            event_id=resp.event_id, event_type=event_type, content=content
        )

    async def upload_media(
        self, data: bytes, content_type: str, filename: str
    ) -> UploadResult:
        resp, _ = await self.raw_client.upload(
            data_provider=io.BytesIO(data),
            content_type=content_type,
            filename=filename,
            filesize=len(data),
        )
        if isinstance(resp, UploadError):
            raise TransportError(
                f"Failed to upload media '{filename}' to Matrix: {resp.message}"
            )
        return UploadResult(uri=resp.content_uri)

    async def download_media(self, uri: str) -> DownloadResult:
        resp = await self.raw_client.download(mxc=uri)
        if isinstance(resp, DownloadError):
            raise TransportError(f"Failed to download {uri}: {resp.message}")
        return DownloadResult(
            body=resp.body,
            content_type=getattr(resp, "content_type", None),
            filename=getattr(resp, "filename", None),
        )

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        logger.debug(
            "Setting typing %s in room %s for %s", is_typing, room_id, self.user_id
        )
        resp = await self.raw_client.room_typing(room_id, is_typing)
        if isinstance(resp, RoomTypingError):
            logger.error("Failed to set typing in %s: %s", room_id, resp.message)

    # ── History ───────────────────────────────────────────────────────────────

    async def get_event(self, room_id: str, event_id: str) -> InboundEvent | None:
        resp = await self.raw_client.room_get_event(room_id, event_id)
        if isinstance(resp, RoomGetEventError):
            return None
        return to_inbound(_RoomIdOnly(room_id), resp.event)

    async def read_history(
        self, room_id: str, *, start: str | None, limit: int
    ) -> HistoryPage:
        resp = await self.raw_client.room_messages(room_id, start=start, limit=limit)
        if isinstance(resp, RoomMessagesError):
            raise TransportError(f"Failed to read history in {room_id}: {resp.message}")
        room = _RoomIdOnly(room_id)
        return HistoryPage(
            events=[to_inbound(room, event) for event in resp.chunk],
            next_token=resp.end,
        )

    # ── Rooms ─────────────────────────────────────────────────────────────────

    async def join_room(self, room_id: str) -> bool:
        resp = await self.raw_client.join(room_id)
        if hasattr(resp, "room_id"):
            return True
        logger.error("Transport %s failed to join %s: %s", self.user_id, room_id, resp)
        return False

    async def joined_rooms(self) -> list[str]:
        resp = await self.raw_client.joined_rooms()
        if isinstance(resp, JoinedRoomsError):
            logger.error(
                "Failed to list joined rooms for %s: %s", self.user_id, resp.message
            )
            return []
        return list(resp.rooms)

    async def set_display_name(self, display_name: str) -> None:
        resp = await self.raw_client.set_displayname(display_name)
        if isinstance(resp, ProfileSetDisplayNameError):
            raise TransportError(
                f"Could not set the display name of {self.user_id}: {resp}"
            )
