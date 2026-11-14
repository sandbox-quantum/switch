"""The vendor's side of a service connection: one adapter per service.

The credential broker (`connections/broker.py`) owns everything Switch
decides: the grant, the checks, the lock, the record. It calls an adapter only
for what the vendor must do: refresh the connection's sign-in, issue a token
for a grant, and revoke what the vendor lets it revoke. Adapters are registered
per service at startup, where the server is configured for that service; a
service with none cannot be issued.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

from switch_core.connections.loader import AccessLevel, PasteExpiry, PasteMethod


class ServiceAdapterError(Exception):
    """The vendor refused. The message says why, in words for the owner."""


class ServiceUnavailableError(ServiceAdapterError):
    """The vendor could not be reached, or asked to be retried later."""


class ReauthorizationRequiredError(ServiceAdapterError):
    """The vendor refused the connection's sign-in for good: revoked or lapsed."""


class ConnectionNotRevocable(ServiceAdapterError):
    """Switch cannot revoke this kind of credential (a pasted key, or a
    sign-in at a vendor with no revocation endpoint): only the vendor can. The
    message tells the person to, and is shown as it is."""


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
    """The owner's access token for a connection, fresh, and when it expires:
    None for a credential the owner pasted, which its vendor ends on a date
    Switch is not told."""

    token: str = field(repr=False)
    expires_at: datetime | None


@dataclass(frozen=True)
class IssueRequest:
    """What one issue is for: the grant's level, what it reaches, and where."""

    service: str
    access: AccessLevel
    # The catalog's entry for the level: {"permissions": {...}} or {"scopes": [...]}.
    reach: dict[str, Any]
    resources: dict[str, Any]
    # Whether the owner's connection holds a credential they pasted (a token,
    # or keys) rather than a sign-in: it reaches what the vendor let it, and
    # is handed out as it is.
    pasted: bool


@dataclass(frozen=True)
class IssuedToken:
    token: str = field(repr=False)
    # None for a credential the owner pasted, handed out as it is.
    expires_at: datetime | None
    resources: dict[str, Any]
    # Whether the vendor can revoke this one token. Only then is it kept,
    # encrypted, until it expires.
    revocable: bool


@dataclass(frozen=True)
class Identity:
    """The connected account: its stable id, and a label people recognise."""

    account_id: str
    label: str


@dataclass(frozen=True)
class Pasted:
    """A credential a connection was made with in place of a sign-in: how it
    was pasted, its fields, and the choices it was pasted for (a site)."""

    method: PasteMethod
    values: dict[str, str] = field(repr=False)
    choices: dict[str, str]


@runtime_checkable
class PastingAdapter(Protocol):
    """An adapter whose service also takes a credential pasted in place of
    its sign-in (`auth.paste`): the OAuth adapter, and GitHub's."""

    def paste_method(self, name: str) -> PasteMethod:
        """The entry's method `name`; ServiceAdapterError where it has none."""
        ...

    def checked_paste(
        self, method: PasteMethod, submitted: Mapping[str, str]
    ) -> dict[str, str]:
        """The pasted fields, each as the method allows, and nothing else."""
        ...

    def pasted_secret(
        self, method: PasteMethod, values: Mapping[str, str], choices: Mapping[str, str]
    ) -> ConnectionSecret:
        """What a connection made with a pasted credential stores."""
        ...

    def pasted(self, secret: ConnectionSecret) -> Pasted | None:
        """The pasted credential a connection's secret holds; None for a
        sign-in. `ReauthorizationRequiredError` for one this server no longer
        takes as it was pasted."""
        ...

    async def check_pasted(
        self, method: PasteMethod, values: Mapping[str, str], choices: Mapping[str, str]
    ) -> PasteExpiry:
        """Whether the vendor still takes the credential, and who ends it:
        `vendor` for one that ends on a date, `never` for one that works until
        it is revoked. A refusal for good is `ReauthorizationRequiredError`."""
        ...

    async def identify_pasted(
        self, method: PasteMethod, values: Mapping[str, str], choices: Mapping[str, str]
    ) -> Identity:
        """The account the credential acts as."""
        ...


class ServiceAdapter(Protocol):
    # False where this server can keep a connection's sign-in fresh but cannot
    # issue for it (GitHub without its App's signing key): people can connect,
    # nothing can be granted.
    can_issue: bool
    # True where this server's app lets agents read only (a GitHub App short
    # of the permissions the write level asks for): the broker refuses a
    # write grant, and a token for one made before.
    read_only: bool

    def current_client_id(self, choices: Mapping[str, str]) -> str | None:
        """The vendor client this adapter signs in through for a connection
        made with `choices` (a vendor's site), where it knows it without
        asking anyone; None for a service with no client, or one not yet
        known. A connection signed in through another must reconnect."""
        ...

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

    async def revoke_connection(self, secret: ConnectionSecret, method: str) -> bool:
        """Revoke the connection's credential at the vendor, where it can be.
        `method` is how the connection was made (`oauth`, `token` or `keys`),
        as its row says: what the secret holds follows from it. True where
        the vendor ended a credential it knew; False where there was none to
        end, or the vendor no longer knew it.
        `ConnectionNotRevocable` says what the person must do instead."""
        ...

    def summary(
        self, agent_name: str, access: AccessLevel, resources: dict[str, Any]
    ) -> str:
        """What a grant reaches, in one sentence for its owner."""
        ...
