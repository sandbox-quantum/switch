import json
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, TypeAdapter, field_validator


class OpenCodeApiCredential(BaseModel):
    type: Literal["api"]
    key: str = Field(min_length=1)


class OpenCodeOAuthCredential(BaseModel):
    type: Literal["oauth"]
    access: str = Field(min_length=1)
    refresh: str = Field(min_length=1)
    expires: int


class OpenCodeConsoleAccount(BaseModel):
    id: str = Field(min_length=1)
    email: str = Field(min_length=1)
    url: str
    access_token: str = Field(min_length=1)
    refresh_token: str = Field(min_length=1)
    token_expiry: int | None
    time_created: int
    time_updated: int

    @field_validator("url")
    @classmethod
    def https_url(cls, value: str) -> str:
        if TypeAdapter(HttpUrl).validate_python(value).scheme != "https":
            raise ValueError("An HTTPS account URL is required.")
        return value


class OpenCodeConsoleCredential(BaseModel):
    format: Literal["switch-opencode-console-v1"]
    account: OpenCodeConsoleAccount
    organization: str = Field(min_length=1)


PROVIDER_KINDS = {
    "claude": {"api-key", "setup-token"},
    "codex": {"api-key", "auth-json"},
    "cursor": {"api-key"},
    "opencode": {"auth-json"},
    "antigravity": {"auth-json"},
}


def validate_provider_credential(provider: str, kind: str, credential: str) -> str:
    if kind not in PROVIDER_KINDS.get(provider, set()):
        raise ValueError("Choose a supported credential type for this provider.")
    credential = credential.strip()
    if not credential or len(credential.encode()) > 16384:
        raise ValueError("The credential must be nonempty and smaller than 16 KiB.")
    if kind == "auth-json":
        try:
            value = json.loads(credential)
        except (ValueError, RecursionError):
            raise ValueError(
                "Choose the provider's JSON authentication file."
            ) from None
        if not isinstance(value, dict) or not value:
            raise ValueError("The authentication file must contain a JSON object.")
        if provider == "opencode":
            try:
                if value.get("format") == "switch-opencode-console-v1":
                    parsed = OpenCodeConsoleCredential.model_validate(value)
                    value = parsed.model_dump(mode="json")
                else:
                    login: OpenCodeApiCredential | OpenCodeOAuthCredential = (
                        TypeAdapter(
                            OpenCodeApiCredential | OpenCodeOAuthCredential
                        ).validate_python(value.get("opencode"))
                    )
                    value = {"opencode": login.model_dump()}
            except ValueError:
                raise ValueError(
                    "Sign in to OpenCode and choose its authentication file."
                ) from None
        return json.dumps(value, separators=(",", ":"))
    if any(not 33 <= ord(character) <= 126 for character in credential):
        raise ValueError(
            "The API key must not contain whitespace or control characters."
        )
    return credential
