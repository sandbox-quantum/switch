from typing import Annotated
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
)


class HostedControllerSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The workspaces whose members may use cloud machines; null for every one.
    allowed_tenant_ids: list[Annotated[str, Field(min_length=1)]] | None
    token: SecretStr = Field(min_length=32)
    agent_api_endpoint: str

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
