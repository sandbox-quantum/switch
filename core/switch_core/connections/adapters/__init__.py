"""The vendor's side of a service connection: one adapter per service.

The credential broker (`connections/broker.py`) owns everything Switch
decides: the grant, the checks, the lock, the record. It calls an adapter only
for what the vendor must do: refresh the connection's sign-in, issue a token
for a grant, and revoke what the vendor lets it revoke. Adapters are registered
per service at startup, where the server is configured for that service; a
service with none cannot be issued.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from switch_core.connections.loader import AccessLevel


class ServiceAdapterError(Exception):
    """The vendor refused. The message says why, in words for the owner."""


class ServiceUnavailableError(ServiceAdapterError):
    """The vendor could not be reached, or asked to be retried later."""


class ReauthorizationRequiredError(ServiceAdapterError):
    """The vendor refused the connection's sign-in for good: revoked or lapsed."""


@dataclass(frozen=True)
class ConnectionSecret:
    """A connection's decrypted secret, as stored.

    The shape GitHub's connection already stores, so its rows move over as
    they are: `access_token` with `expires_at` (Unix seconds) for the cached
    access token, `refresh_token` with `refresh_expires_at` for the sign-in,
    and whatever else the adapter keeps beside them.
    """

    values: dict[str, Any] = field(repr=False)

    @property
    def access_token(self) -> str | None:
        token = self.values.get("access_token")
        return token if isinstance(token, str) and token else None

    @property
    def expires_at(self) -> float:
        expires_at = self.values.get("expires_at")
        return float(expires_at) if isinstance(expires_at, int | float) else 0.0


@dataclass(frozen=True)
class AccessToken:
    """The owner's access token for a connection, fresh, and when it expires."""

    token: str = field(repr=False)
    expires_at: datetime


@dataclass(frozen=True)
class IssueRequest:
    """What one issue is for: the grant's level, what it reaches, and where."""

    service: str
    access: AccessLevel
    # The catalog's entry for the level: {"permissions": {...}} or {"scopes": [...]}.
    reach: dict[str, Any]
    resources: dict[str, Any]


@dataclass(frozen=True)
class IssuedToken:
    token: str = field(repr=False)
    expires_at: datetime
    resources: dict[str, Any]
    # Whether the vendor can revoke this one token. Only then is it kept,
    # encrypted, until it expires.
    revocable: bool


class ServiceAdapter(Protocol):
    # False where this server can keep a connection's sign-in fresh but cannot
    # issue for it (GitHub without its App's signing key): people can connect,
    # nothing can be granted.
    can_issue: bool

    async def refresh(self, secret: ConnectionSecret) -> ConnectionSecret:
        """The secret with a fresh access token, and a new refresh token where
        the vendor rotates them."""
        ...

    async def check_grant(
        self, access_token: str, request: IssueRequest
    ) -> dict[str, Any]:
        """The request's resources as the vendor will honour them, checked
        against what the owner can reach; ServiceAdapterError says what not."""
        ...

    async def issue(self, access: AccessToken, request: IssueRequest) -> IssuedToken:
        """A token for the request, living no longer than the catalog entry's
        `token.max_lifetime`. A `pass_through` entry's adapter hands out the
        owner's own token, which it cannot revoke alone: never `revocable`."""
        ...

    async def revoke_issued(self, token: str) -> None: ...

    async def revoke_connection(self, secret: ConnectionSecret) -> None: ...

    def summary(
        self, agent_name: str, access: AccessLevel, resources: dict[str, Any]
    ) -> str:
        """What a grant reaches, in one sentence for its owner."""
        ...
