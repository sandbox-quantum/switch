"""Transport-neutral types crossing the message-transport boundary.

Nothing here names Matrix. Identifiers are opaque strings: an `event_id` is
whatever the transport calls a message handle, and `uri` is whatever it calls
an uploaded blob. Callers must not parse either.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

MessageFormat = Literal["text", "markdown"]
SeekDirection = Literal["forward", "backward"]


class TransportError(RuntimeError):
    """A transport operation failed.

    Operations raise this rather than returning an error object, so a caller
    cannot proceed on a failure it forgot to check.
    """


class NotConnectedError(TransportError):
    """An operation was attempted before the transport was connected."""


# ── Outbound results ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SendResult:
    """A message or event accepted by the transport.

    `event_type` and `content` are what was actually put on the wire, which
    the transport assembles and the caller therefore does not otherwise see.
    Reporting them back means a caller recording what it sent transcribes the
    transport's own dict rather than reconstructing it and drifting from it.
    """

    event_id: str
    event_type: str
    content: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class UploadResult:
    """A blob accepted by the transport's media store."""

    uri: str


@dataclass(frozen=True)
class DownloadResult:
    """Bytes retrieved for a media URI."""

    body: bytes
    content_type: str | None = None
    filename: str | None = None


# ── Inbound events ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RoomRef:
    """The room an inbound event arrived in.

    Consumers only ever needed the id; this exists so handler signatures do not
    have to name a transport's room object.
    """

    room_id: str


@dataclass(frozen=True)
class InboundEvent:
    """Fields common to every inbound event."""

    room_id: str
    event_id: str
    sender: str
    timestamp: int
    content: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class InboundMessage(InboundEvent):
    """A text message.

    `content` is retained deliberately: `com.switch.*` markers ride on ordinary
    messages, and hiding them behind named fields would mean a new field for
    every marker.
    """

    body: str = ""
    sender_name: str | None = None
    formatted_body: str | None = None
    msgtype: str = "m.text"
    thread_root_id: str | None = None


@dataclass(frozen=True)
class InboundMedia(InboundMessage):
    """An attachment. `uri` is the handle to pass back to `download_media`.

    A media event is a message that happens to carry a file, so code that only
    cares about sender, body or thread can treat the two alike.
    """

    uri: str = ""
    filename: str | None = None
    mimetype: str | None = None
    size: int | None = None
    group: dict[str, object] | None = None


@dataclass(frozen=True)
class InboundMembership(InboundEvent):
    """A membership change.

    `state_key` names the member the change is about, which is not the same as
    `sender` — one member can change another's membership.
    """

    state_key: str = ""
    membership: str = ""
    prev_membership: str | None = None
    display_name: str | None = None


@dataclass(frozen=True)
class InboundCustomEvent(InboundEvent):
    """A non-message event carrying a `com.switch.*` payload in `content`."""

    event_type: str = ""
    thread_root_id: str | None = None


@dataclass(frozen=True)
class HistoryPage:
    """One page of backwards history.

    `next_token` is an opaque cursor for the following page, or None when the
    transport reports no more history.
    """

    events: list[object]
    next_token: str | None
