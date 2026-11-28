"""The SMS connect form.

Console renders every field that isn't a boolean as a text box and sends what
was typed, so the allow-list is one string and a limit left blank takes its
default.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import Field, ValidationInfo, field_validator, model_validator

from switch_core.bridges.collaboration.models import BridgeConnectionConfig

_ACCOUNT_SID = re.compile(r"AC[0-9a-fA-F]{32}")
_E164 = re.compile(r"\+[1-9][0-9]{6,14}")
_NUMBER_PUNCTUATION = re.compile(r"[\s().-]")
_LIST_SEPARATOR = re.compile(r"[,;\n]")

DEFAULT_MAX_SEGMENTS_PER_REPLY = 5
DEFAULT_MAX_SEGMENTS_PER_HOUR = 20


def normalize_number(raw: str) -> str:
    """A phone number in E.164, or ValueError naming the entry that isn't one."""
    number = _NUMBER_PUNCTUATION.sub("", raw)
    if not _E164.fullmatch(number):
        raise ValueError(
            f"{raw.strip()!r} is not a phone number in E.164 format, with its "
            "country code, such as +14155550100."
        )
    return number


class SmsConnectionConfig(BridgeConnectionConfig):
    account_sid: str = Field(
        title="Account SID",
        description=(
            "Starts with AC. Twilio Console → Account Dashboard → Account Info."
        ),
    )
    auth_token: str = Field(
        title="Auth Token",
        description=(
            "Your account's primary Auth Token, from the same page. Twilio "
            "signs every webhook with it, so an API key can't be used instead."
        ),
    )
    phone_number: str = Field(
        title="Twilio phone number",
        description=(
            "The number people text, in E.164 format, such as +14155550100. "
            "It must belong to this account."
        ),
    )
    allowed_senders: str = Field(
        title="Allowed phone numbers",
        description=(
            "The numbers that may text this connection and be texted by it, in "
            "E.164 format and separated by commas. Texts from any other number "
            "are ignored without a reply, so a stranger can't run up costs."
        ),
    )
    default_agent: str = Field(
        title="Agent",
        description=(
            "The name of the agent added to the room when someone texts for "
            "the first time."
        ),
    )
    max_segments_per_reply: int = Field(
        default=DEFAULT_MAX_SEGMENTS_PER_REPLY,
        ge=1,
        title="Most SMS segments per reply",
        description=(
            "Twilio bills per segment. A longer reply is cut, with a note "
            f"saying so. Defaults to {DEFAULT_MAX_SEGMENTS_PER_REPLY}."
        ),
    )
    max_segments_per_hour: int = Field(
        default=DEFAULT_MAX_SEGMENTS_PER_HOUR,
        ge=1,
        title="Most SMS segments per number, per hour",
        description=(
            "Stops an agent stuck in a loop. Counted per clock hour across "
            "every server, so up to twice this can go out across the turn of "
            "an hour; set a Twilio usage trigger as a hard limit too. Defaults "
            f"to {DEFAULT_MAX_SEGMENTS_PER_HOUR}."
        ),
    )

    @field_validator(
        "account_sid", "auth_token", "phone_number", "allowed_senders", "default_agent"
    )
    @classmethod
    def _not_blank(cls, value: str, info: ValidationInfo) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError(f"{info.field_name} is empty.")
        return stripped

    @field_validator("account_sid")
    @classmethod
    def _account_sid_shape(cls, value: str) -> str:
        if not _ACCOUNT_SID.fullmatch(value):
            raise ValueError(
                "account_sid is AC followed by 32 hexadecimal characters, as "
                "shown under Account Info in the Twilio Console."
            )
        return value

    @field_validator("phone_number")
    @classmethod
    def _phone_number_shape(cls, value: str) -> str:
        return normalize_number(value)

    @field_validator("allowed_senders")
    @classmethod
    def _allowed_senders_shape(cls, value: str) -> str:
        entries = [e for e in _LIST_SEPARATOR.split(value) if e.strip()]
        if not entries:
            raise ValueError("allowed_senders lists no phone numbers.")
        return ",".join(sorted({normalize_number(entry) for entry in entries}))

    @field_validator("max_segments_per_reply", "max_segments_per_hour", mode="before")
    @classmethod
    def _blank_limit_takes_default(cls, value: Any, info: ValidationInfo) -> Any:
        if isinstance(value, str) and not value.strip():
            return cls.model_fields[str(info.field_name)].default
        return value

    @model_validator(mode="after")
    def _settings_agree(self) -> SmsConnectionConfig:
        if self.phone_number in self.allowed_numbers:
            raise ValueError(
                "allowed_senders includes this connection's own Twilio number, "
                "which would have it answering itself."
            )
        if self.max_segments_per_reply > self.max_segments_per_hour:
            raise ValueError(
                "max_segments_per_reply is above max_segments_per_hour, so a "
                "single reply could never be sent whole."
            )
        return self

    @property
    def allowed_numbers(self) -> frozenset[str]:
        return frozenset(self.allowed_senders.split(","))
