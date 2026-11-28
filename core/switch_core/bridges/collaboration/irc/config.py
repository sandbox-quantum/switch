from __future__ import annotations

import ipaddress
import re
from typing import Self

from pydantic import Field, field_validator, model_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.collaboration.models import BridgeConnectionConfig

from .protocol import CaseMapping, is_channel, is_nick


class IrcConnectionConfig(BridgeConnectionConfig):
    server: str = Field(
        title="Server", description="IRC server hostname, without a scheme or port."
    )
    port: int = Field(default=6697, ge=1, le=65535, title="Port")
    tls: bool = Field(
        default=True, title="Use TLS", description="Required when sending passwords."
    )
    nick: str = Field(title="Bot nickname")
    account: str = Field(
        default="",
        title="SASL account",
        description="Leave blank to use the bot nickname.",
    )
    account_password: str = Field(default="", repr=False, title="SASL password")
    server_password: str = Field(
        default="",
        repr=False,
        title="Server password",
        description="Only for networks requiring an IRC PASS command.",
    )
    channels: str = Field(
        default="",
        title="Channels",
        description="Channels to join, separated by commas, for example #development, #support.",
    )
    # Saved after credential verification so quiet pods use the same room ids.
    network_case_mapping: SkipJsonSchema[CaseMapping | None] = None

    @field_validator("server")
    @classmethod
    def host_only(cls, value: str) -> str:
        value = value.strip().strip("[]").lower()
        try:
            ipaddress.ip_address(value)
        except ValueError:
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value):
                raise ValueError(
                    "Enter an IRC hostname or IP address without a scheme or port"
                ) from None
        return value

    @field_validator("nick")
    @classmethod
    def valid_nick(cls, value: str) -> str:
        if not is_nick(value):
            raise ValueError("Enter a valid IRC nickname of at most 30 characters")
        return value

    @field_validator("account", "account_password", "server_password")
    @classmethod
    def no_controls(cls, value: str) -> str:
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("IRC credentials cannot contain control characters")
        return value

    @field_validator("channels")
    @classmethod
    def valid_channels(cls, value: str) -> str:
        channels = re.split(r"[,\s]+", value.strip()) if value.strip() else []
        if any(not is_channel(channel) for channel in channels):
            raise ValueError(
                "Enter channel names beginning with # or &, separated by commas"
            )
        return ",".join(dict.fromkeys(channels))

    @model_validator(mode="after")
    def secure_credentials(self) -> Self:
        if not self.tls and (self.account_password or self.server_password):
            raise ValueError("Enable TLS before configuring an IRC password")
        return self
