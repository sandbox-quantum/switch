"""The message-transport port.

`MessageTransport` is the whole contract between Switch and whatever carries
its messages. Implementations live beside this module; nothing outside the
`switch_core.transport` package may import a transport library directly.

The contract is deliberately narrow and derived from what callers actually do:
send a message, send a typed event, move media, read history back, and receive
events. Operations raise `TransportError` on failure instead of returning an
error object.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from switch_core.transport.types import (
    DownloadResult,
    HistoryPage,
    MessageFormat,
    SendResult,
    UploadResult,
)

Handler = Callable[[Any, Any], Awaitable[None]]


@dataclass
class TransportHandlers:
    """Inbound callbacks a client registers with its transport.

    Each is optional so a client only pays for the events it cares about. The
    transport decides how to bind them; the client never names an event class.
    """

    on_message: Handler | None = None
    on_media: Handler | None = None
    on_reaction: Handler | None = None
    on_member_event: Handler | None = None
    on_custom_event: Handler | None = None
    on_invite: Handler | None = None


@runtime_checkable
class MessageTransport(Protocol):
    """Carries messages between Switch and its participants."""

    # ── Session ───────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Prepare the connection for use."""
        ...

    async def close(self) -> None:
        """Release the connection. Safe to call when never connected."""
        ...

    def register_handlers(self, handlers: TransportHandlers) -> None:
        """Bind inbound callbacks. Call before `receive_forever`."""
        ...

    async def receive_forever(self) -> None:
        """Deliver inbound events to the registered handlers until closed."""
        ...

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
        """Post a text message. Raises `TransportError` if it is not accepted."""
        ...

    async def send_event(
        self,
        room_id: str,
        event_type: str,
        content: dict[str, object],
    ) -> SendResult:
        """Post a typed non-message event, e.g. a `com.switch.*` payload."""
        ...

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
        """Post an event pointing at an already-uploaded `uri`.

        `group` marks this as one part of a multi-attachment message —
        `{"id": ..., "index": i, "total": n}` — for transports that cannot
        carry several files on one event.
        """
        ...

    async def upload_media(
        self, data: bytes, content_type: str, filename: str
    ) -> UploadResult:
        """Store bytes and return the handle to reference them by."""
        ...

    async def download_media(self, uri: str) -> DownloadResult:
        """Retrieve bytes for a handle returned by `upload_media`."""
        ...

    async def set_typing(self, room_id: str, is_typing: bool) -> None:
        """Signal composing state. Best-effort: never raises."""
        ...

    # ── History ───────────────────────────────────────────────────────────────

    async def get_event(self, room_id: str, event_id: str) -> Any | None:
        """Fetch one event by id, or None when it cannot be retrieved."""
        ...

    async def read_history(
        self, room_id: str, *, start: str | None, limit: int
    ) -> HistoryPage:
        """Read one page of history backwards from `start`."""
        ...

    # ── Rooms ─────────────────────────────────────────────────────────────────

    async def join_room(self, room_id: str) -> bool:
        """Join a room. Returns whether the join was accepted."""
        ...

    async def joined_rooms(self) -> list[str]:
        """Rooms this connection is currently a member of."""
        ...

    async def set_display_name(self, display_name: str) -> None:
        """Change the name this connection shows under."""
        ...
