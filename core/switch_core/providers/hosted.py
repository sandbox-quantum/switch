from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class HostedControllerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_id: str = Field(min_length=1)
    token: SecretStr = Field(min_length=32)
    agent_ids: list[UUID] = Field(min_length=1, max_length=100)
    github_private_key_path: Path
    agent_api_endpoint: str

    @field_validator("agent_ids")
    @classmethod
    def unique_ids(cls, value: list[UUID]) -> list[UUID]:
        if len(set(value)) != len(value):
            raise ValueError("Cloud worker identities must be unique.")
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
