"""Version-one wire models and shared signing primitives.

Files travel inline so an inbound payload can never make Switch fetch a URL.
Limits apply before decoding as well as after decoding.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_FILE_BYTES = 1024 * 1024
MAX_BODY_BYTES = 6 * 1024 * 1024
MAX_TEXT = 100_000
MAX_SKEW_SECONDS = 300
Identifier = Annotated[
    str, Field(min_length=1, max_length=256, pattern=r"^[^\s\x00-\x1f\x7f]+$")
]
Text = Annotated[str, Field(max_length=MAX_TEXT)]


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class File(WireModel):
    filename: Annotated[
        str, Field(min_length=1, max_length=255, pattern=r"^[^/\\\x00-\x1f\x7f]+$")
    ]
    mimetype: Annotated[
        str,
        Field(
            min_length=3, max_length=127, pattern=r"^[a-zA-Z0-9.+_-]+/[a-zA-Z0-9.+_-]+$"
        ),
    ]
    data_base64: Annotated[str, Field(max_length=4 * ((MAX_FILE_BYTES + 2) // 3))]

    def decoded(self) -> bytes:
        try:
            data = base64.b64decode(self.data_base64, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("attachment must contain valid base64") from exc
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("attachment exceeds the 1 MiB limit")
        return data

    @model_validator(mode="after")
    def validate_file(self) -> Self:
        if self.filename in (".", ".."):
            raise ValueError("invalid attachment filename")
        self.decoded()
        return self


class Incoming(WireModel):
    version: Literal[1]
    event_id: Identifier
    type: Literal[
        "message.created", "message.updated", "message.deleted", "channel.connected"
    ]
    channel_id: Identifier
    channel_type: Literal["channel_public", "channel_private", "group", "direct"] = (
        "channel_public"
    )
    channel_name: Annotated[str, Field(min_length=1, max_length=256)] | None = None
    sender_id: Identifier
    sender_name: Annotated[
        str, Field(min_length=1, max_length=128, pattern=r"^[^\x00-\x1f\x7f]+$")
    ]
    message_id: Identifier
    thread_id: Identifier | None = None
    text: Text = ""
    attachments: Annotated[list[File], Field(max_length=4)] = []

    @model_validator(mode="after")
    def validate_event(self) -> Self:
        if self.type in ("message.created", "message.updated"):
            if not self.text.strip() and not self.attachments:
                raise ValueError("a message needs text or attachments")
        elif self.text or self.attachments:
            raise ValueError("this event cannot contain text or attachments")
        if self.thread_id == self.message_id:
            raise ValueError("a message cannot reply to itself")
        return self


class Outgoing(WireModel):
    version: Literal[1] = 1
    event_id: Identifier
    type: Literal[
        "connection.check",
        "message.created",
        "message.updated",
        "message.deleted",
        "activity",
    ]
    channel_id: Identifier | None = None
    message_id: Identifier | None = None
    thread_id: Identifier | None = None
    sender_name: Annotated[str, Field(max_length=256)] | None = None
    text: Text | None = None
    attachments: Annotated[list[File], Field(max_length=4)] = []
    is_typing: bool | None = None
    part: int = 1
    parts: int = 1
    challenge: str | None = None


def encode(event: Outgoing) -> bytes:
    return event.model_dump_json(exclude_none=True).encode("utf-8")


def signature(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(
        secret.encode("utf-8"), timestamp.encode("ascii") + b"." + body, hashlib.sha256
    ).hexdigest()
    return "sha256=" + digest


def verify_signature(
    secret: str, timestamp: str, body: bytes, supplied: str, *, now: float | None = None
) -> bool:
    """Verify the exact bytes and an authenticated timestamp, without parsing."""
    if not timestamp.isascii() or not timestamp.isdecimal() or len(timestamp) > 12:
        return False
    if abs((time.time() if now is None else now) - int(timestamp)) > MAX_SKEW_SECONDS:
        return False
    return hmac.compare_digest(
        signature(secret, timestamp, body).encode(), supplied.encode("utf-8")
    )


def parse_incoming(body: bytes) -> Incoming:
    # Reject duplicate keys rather than let different implementations disagree.
    def pairs(items: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    if len(body) > MAX_BODY_BYTES:
        raise ValueError("payload exceeds the 6 MiB limit")
    payload = json.loads(body, object_pairs_hook=pairs)
    if isinstance(payload, dict) and type(payload.get("version")) is not int:
        raise ValueError("version must be the integer 1")
    return Incoming.model_validate(payload)
