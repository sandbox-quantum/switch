"""The JSON a custom chat app and Switch exchange, version 1.

`InboundEvent` is what the app POSTs to the connection's address.
`OutboundEvent` is what Switch POSTs to the app's URL. The published schema in
`docs/messaging-platforms/webhook.schema.json` is generated from these models.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
from typing import Literal

from pydantic import BaseModel, Field, model_validator

SCHEMA_VERSION = 1
SIGNATURE_PREFIX = "v1="
MAX_CLOCK_SKEW_SECONDS = 300


class Person(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=256)
    is_app: bool = False


class ChannelRef(BaseModel):
    id: str = Field(min_length=1, max_length=256)
    name: str | None = Field(default=None, max_length=256)
    type: Literal["channel", "private", "group", "direct"] = "channel"


class InboundFile(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    mimetype: str = "application/octet-stream"
    data: str = Field(description="The file's bytes, base64 encoded.")


class InboundMessage(BaseModel):
    id: str | None = Field(
        default=None,
        max_length=256,
        description="The app's id for this message. Defaults to the event id.",
    )
    text: str = ""
    thread_id: str | None = Field(default=None, max_length=256)
    files: list[InboundFile] = []


class InboundEvent(BaseModel):
    version: Literal[1]
    id: str = Field(
        min_length=1,
        max_length=256,
        description="Unique per event. Send the same id when you retry.",
    )
    type: Literal["message", "channel.joined"]
    channel: ChannelRef
    sender: Person | None = None
    message: InboundMessage | None = None

    @model_validator(mode="after")
    def _message_needs_sender_and_body(self) -> InboundEvent:
        if self.type == "message" and (self.sender is None or self.message is None):
            raise ValueError("a message event needs both sender and message")
        return self


class SenderRef(BaseModel):
    name: str
    icon_url: str | None = None


class OutboundFile(BaseModel):
    filename: str
    mimetype: str
    size: int
    data: str = Field(description="The file's bytes, base64 encoded.")


class OutboundEvent(BaseModel):
    version: Literal[1] = 1
    type: Literal[
        "ping",
        "message.created",
        "message.updated",
        "message.deleted",
        "typing",
    ]
    sent_at: int = Field(description="Unix time in seconds.")
    channel_id: str | None = None
    message_id: str | None = Field(
        default=None,
        description="Chosen by Switch. Use it to apply later edits and deletes.",
    )
    sender: SenderRef | None = None
    text: str | None = Field(default=None, description="CommonMark.")
    thread_id: str | None = None
    files: list[OutboundFile] = []
    is_typing: bool | None = None


def sign(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(
        secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    return SIGNATURE_PREFIX + digest


def encode_file(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def decode_file(data: str) -> bytes | None:
    try:
        return base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        return None


def json_schema() -> dict[str, object]:
    return {
        "version": SCHEMA_VERSION,
        "inbound": InboundEvent.model_json_schema(),
        "outbound": OutboundEvent.model_json_schema(),
    }
