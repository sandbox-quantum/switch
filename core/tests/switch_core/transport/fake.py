"""A `MessageTransport` double for tests that need a client without a server.

Every test that used to attach a fake nio client attaches one of these
instead, so the thing under test talks to the port rather than to Matrix.
"""

from __future__ import annotations

from typing import Any

from switch_core.transport import (
    DownloadResult,
    HistoryPage,
    InboundEvent,
    MessageFormat,
    SeekDirection,
    SendResult,
    TransportError,
    TransportHandlers,
    UploadResult,
)


class FakeTransport:
    """Records what was sent and replays what it was primed with."""

    def __init__(
        self,
        *,
        joined: list[str] | None = None,
        upload_uri: str = "mxc://fake/abc",
        history: HistoryPage | None = None,
        download: DownloadResult | None = None,
        seek_token: str | None = None,
        fail_send: str | None = None,
    ) -> None:
        self._joined = joined if joined is not None else []
        self._upload_uri = upload_uri
        self._history = history or HistoryPage(events=[], next_token=None)
        self._download = download or DownloadResult(body=b"", content_type="text/plain")
        self._seek_token = seek_token
        self._fail_send = fail_send

        self.sent_messages: list[dict[str, Any]] = []
        self.sent_events: list[tuple[str, str, dict[str, object]]] = []
        self.sent_media: list[dict[str, Any]] = []
        self.uploads: list[tuple[bytes, str, str]] = []
        self.typing: list[tuple[str, bool]] = []
        self.joins: list[str] = []
        self.display_names: list[str] = []
        self.handlers = TransportHandlers()
        self.connected = False
        self.closed = False
        self.events_by_id: dict[str, InboundEvent] = {}
        self.next_event_id = 0

    # ── Session ───────────────────────────────────────────────────────────────

    @property
    def session_state(self) -> dict[str, str | None]:
        return {"access_token": "fake-token", "device_id": "FAKEDEVICE"}

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.closed = True

    async def relogin(self) -> None:
        self.connected = True

    def register_handlers(self, handlers: TransportHandlers) -> None:
        self.handlers = handlers

    async def receive_forever(self, *, since: str | None) -> None:
        return None

    # ── Outbound ──────────────────────────────────────────────────────────────

    def _next_id(self) -> str:
        self.next_event_id += 1
        return f"$fake{self.next_event_id}"

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
        if self._fail_send:
            raise TransportError(self._fail_send)
        self.sent_messages.append(
            {
                "room_id": room_id,
                "body": body,
                "sender_name": sender_name,
                "format": format,
                "mentions": mentions,
                "thread_root_id": thread_root_id,
                "extra_content": extra_content,
            }
        )
        return SendResult(event_id=self._next_id())

    async def send_event(
        self, room_id: str, event_type: str, content: dict[str, object]
    ) -> SendResult:
        if self._fail_send:
            raise TransportError(self._fail_send)
        self.sent_events.append((room_id, event_type, content))
        return SendResult(event_id=self._next_id())

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
        if self._fail_send:
            raise TransportError(self._fail_send)
        self.sent_media.append(
            {
                "room_id": room_id,
                "uri": uri,
                "filename": filename,
                "mimetype": mimetype,
                "size": size,
                "sender_name": sender_name,
                "msgtype": msgtype,
                "caption": caption,
                "thread_root_id": thread_root_id,
                "group": group,
            }
        )
        return SendResult(event_id=self._next_id())

    async def upload_media(
        self, data: bytes, content_type: str, filename: str
    ) -> UploadResult:
        self.uploads.append((data, content_type, filename))
        return UploadResult(uri=self._upload_uri)

    async def download_media(self, uri: str) -> DownloadResult:
        return self._download

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        self.typing.append((room_id, is_typing))

    # ── History ───────────────────────────────────────────────────────────────

    async def get_event(self, room_id: str, event_id: str) -> InboundEvent | None:
        return self.events_by_id.get(event_id)

    async def read_history(
        self, room_id: str, *, start: str | None, limit: int
    ) -> HistoryPage:
        return self._history

    async def seek_by_timestamp(
        self, room_id: str, timestamp_ms: int, *, direction: SeekDirection
    ) -> str | None:
        return self._seek_token

    # ── Rooms ─────────────────────────────────────────────────────────────────

    async def join_room(self, room_id: str) -> bool:
        self.joins.append(room_id)
        self._joined.append(room_id)
        return True

    async def joined_rooms(self) -> list[str]:
        return list(self._joined)

    async def set_display_name(self, display_name: str) -> None:
        self.display_names.append(display_name)
