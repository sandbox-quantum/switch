"""The version-one contract for a custom messaging application."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_FILES = 5
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_MESSAGE_CHARS = 4000
Id = Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_.:-]+$")]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class File(Model):
    name: str = Field(min_length=1, max_length=200, pattern=r"^[^/\\\x00-\x1f]+$")
    mime_type: str = Field(min_length=1, max_length=200)
    data_base64: str = Field(max_length=4 * ((MAX_FILE_BYTES + 2) // 3))

    @model_validator(mode="after")
    def valid_bytes(self) -> File:
        try:
            data = self.decode()
        except (ValueError, binascii.Error):
            raise ValueError("Attachment data must be valid base64") from None
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("Attachment exceeds the 5 MiB limit")
        return self

    def decode(self) -> bytes:
        return base64.b64decode(self.data_base64, validate=True)


class Sender(Model):
    id: Id
    name: str = Field(min_length=1, max_length=200, pattern=r"^[^\x00-\x1f]+$")
    kind: Literal["human", "app", "switch"] = "human"


class Incoming(Model):
    version: Literal[1]
    event_id: Id
    type: Literal["message", "command", "channel.join"]
    channel_id: Id
    channel_name: str | None = Field(default=None, max_length=200)
    channel_type: Literal["channel_public", "channel_private", "group", "direct"]
    sender: Sender
    message_id: Id
    thread_id: Id | None = None
    text: str = Field(default="", max_length=32_000)
    attachments: list[File] = Field(default_factory=list, max_length=MAX_FILES)

    @model_validator(mode="after")
    def valid_content(self) -> Incoming:
        if sum(len(file.decode()) for file in self.attachments) > MAX_FILE_BYTES:
            raise ValueError("Attachments together exceed the 5 MiB limit")
        if self.type == "message" and not self.text.strip() and not self.attachments:
            raise ValueError("A message needs text or an attachment")
        if self.type == "command" and (
            not self.text.startswith("!") or self.attachments
        ):
            raise ValueError("A command needs !command text and no attachments")
        if self.type == "command" and not re.match(
            r"^![A-Za-z][A-Za-z0-9_-]{0,63}(?:\s|$)", self.text
        ):
            raise ValueError("Invalid command name")
        return self


class Outgoing(Model):
    version: Literal[1] = 1
    event_id: Id
    type: Literal[
        "connection.check",
        "publication.lookup",
        "message.create",
        "message.update",
        "message.delete",
        "typing",
        "activity",
        "request",
    ]
    channel_id: Id | None = None
    message_id: Id | None = None
    thread_id: Id | None = None
    group_id: Id | None = None
    sender_name: str | None = Field(default=None, max_length=200)
    text: str = Field(default="", max_length=32_000)
    attachments: list[File] = Field(default_factory=list, max_length=MAX_FILES)
    marker: str | None = Field(default=None, max_length=1000)
    is_typing: bool | None = None

    @model_validator(mode="after")
    def valid_event(self) -> Outgoing:
        if self.type != "connection.check" and (
            not self.channel_id or not self.message_id
        ):
            raise ValueError("This event requires a channel and message id")
        if sum(len(file.decode()) for file in self.attachments) > MAX_FILE_BYTES:
            raise ValueError("Attachments together exceed the 5 MiB limit")
        return self


class Acknowledgment(Model):
    version: Literal[1]
    event_id: Id
    found: bool | None = None


def signature(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256)
    return "sha256=" + digest.hexdigest()


def split_text(text: str) -> list[str]:
    parts: list[str] = []
    while len(text) > MAX_MESSAGE_CHARS:
        cut = text.rfind("\n", 0, MAX_MESSAGE_CHARS + 1)
        if cut < MAX_MESSAGE_CHARS // 2:
            cut = MAX_MESSAGE_CHARS
        else:
            cut += 1
        parts.append(text[:cut])
        text = text[cut:]
    return [*parts, text] if text or not parts else parts
