from __future__ import annotations

from urllib.parse import urlsplit, urlunsplit

from pydantic import Field, field_validator

from switch_core.bridges.collaboration.models import BridgeConnectionConfig


class MatrixConnectionConfig(BridgeConnectionConfig):
    """How Switch reaches one external Matrix homeserver as a bot account."""

    homeserver_url: str = Field(
        title="Homeserver URL",
        description=(
            "The base URL of the Matrix homeserver, for example "
            "https://matrix.example.org. It is the address Element signs in to."
        ),
    )
    access_token: str = Field(
        title="Bot access token",
        description=(
            "An access token for the bot account on that homeserver. Create it "
            "by signing the bot in with a Matrix client and copying the access "
            "token from its settings, or by calling the login API."
        ),
        json_schema_extra={"format": "password"},
    )

    @field_validator("homeserver_url")
    @classmethod
    def _normalise_homeserver(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("homeserver_url is required")
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https"):
            raise ValueError(
                "homeserver_url must start with http:// or https://, for "
                "example https://matrix.example.org"
            )
        if not parts.netloc:
            raise ValueError("homeserver_url must name a host")
        if parts.query or parts.fragment:
            raise ValueError(
                "homeserver_url must not carry a query or fragment; give only "
                "the homeserver's base address"
            )
        path = parts.path.rstrip("/")
        return urlunsplit((parts.scheme, parts.netloc, path, "", ""))

    @field_validator("access_token")
    @classmethod
    def _token_present(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("access_token is required")
        return value
