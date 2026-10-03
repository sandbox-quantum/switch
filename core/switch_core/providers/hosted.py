from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    StringConstraints,
    field_validator,
)


class HostedControllerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str = Field(min_length=1)
    token: SecretStr = Field(min_length=32)
    machine_slots: list[
        Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{2,39}$")]
    ] = Field(min_length=1, max_length=100)
    github_private_key_path: Path
    agent_api_endpoint: str

    @field_validator("machine_slots")
    @classmethod
    def unique_slots(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Cloud machine slots must be unique.")
        return value

    @field_validator("github_private_key_path")
    @classmethod
    def absolute_key_path(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("The GitHub signing key requires an absolute path.")
        return value

    @field_validator("agent_api_endpoint")
    @classmethod
    def https_endpoint(cls, value: str) -> str:
        url = urlsplit(value)
        if (
            url.scheme != "https"
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("Cloud agents require an HTTPS agent API endpoint.")
        return value.rstrip("/")
