"""The generic adapter for a vendor whose people paste a key rather than sign in.

The catalog entry (`auth.api_key`) names the fields a person pastes (the key,
or several, as Datadog's API and application keys) and picks (a site), and the
call that checks them. The connection's secret holds them as the token a
session host is handed: compact JSON, `{"secret": {...}, "public": {...}}`, so
the host puts each field where the entry's templates say (an MCP request's
headers, a CLI run's environment) and redacts every secret one.

A key is the owner's own and does not expire, so nothing is refreshed and
nothing can be revoked: disconnecting forgets it, and only the vendor can
revoke it. For the same reason it is never handed to an agent: whatever ran
beside the agent could keep it for good, and neither a removed grant nor a
disconnect would end it. The catalog says so (`token.max_lifetime: null`),
and the broker refuses before it gets here.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from switch_core.connections.adapters import (
    AccessToken,
    ConnectionNotRevocable,
    ConnectionSecret,
    IssuedToken,
    IssueRequest,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.loader import (
    AccessLevel,
    ApiKeyField,
    ApiKeySignIn,
    ConnectionDefinition,
    render,
    url_placements,
)

# A key may carry any printable character but a space, which keeps it a
# single header value or argument; longer than this is not a key.
FIELD_VALUE_RE = re.compile(r"^[\x21-\x7e]{1,1024}$")
# What a pattern field may hold where a URL puts it, whatever its pattern
# allows: one DNS label in a host, one unreserved segment in a path.
HOST_LABEL_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
PATH_SEGMENT_RE = re.compile(r"^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,255}$")
MAX_IDENTITY_BYTES = 256 * 1024


class InvalidKeyError(ServiceAdapterError):
    """The fields are malformed, or the vendor refused the key."""


@dataclass(frozen=True)
class KeyIdentity:
    account_id: str
    label: str


def credential_token(secret: Mapping[str, str], public: Mapping[str, str]) -> str:
    """A pasted credential as a session host is handed it: compact JSON of
    its secret fields and its public ones (a site)."""
    return json.dumps(
        {"secret": dict(secret), "public": dict(public)},
        separators=(",", ":"),
        sort_keys=True,
    )


def key_token(sign_in: ApiKeySignIn, values: dict[str, str]) -> str:
    """The token a session host is handed: the fields, split by secrecy."""
    return credential_token(
        {f.name: values[f.name] for f in sign_in.fields if f.secret},
        {f.name: values[f.name] for f in sign_in.fields if not f.secret},
    )


def checked_fields(
    name: str,
    fields: list[ApiKeyField],
    submitted: Mapping[str, str],
    placements: Mapping[str, set[str]],
) -> dict[str, str]:
    """The submitted fields, each as `fields` allows, and nothing else: a
    choice among its choices, a pattern field to its pattern and to where
    `placements` says the entry's URLs put it, a secret one line of printable
    characters. `name` is the service's, for the refusal."""
    expected = {field.name: field for field in fields}
    unknown = sorted(set(submitted) - set(expected))
    if unknown:
        raise InvalidKeyError(f"{name} takes no field named {', '.join(unknown)}.")
    values: dict[str, str] = {}
    for field_name, field in expected.items():
        value = submitted.get(field_name, "").strip()
        if not value:
            raise InvalidKeyError(f"{field.label} is required.")
        if field.choices is not None:
            if value not in field.choices:
                raise InvalidKeyError(
                    f"{field.label} must be one of {', '.join(field.choices)}."
                )
        elif field.pattern is not None:
            places = placements.get(field_name, set())
            if (
                not FIELD_VALUE_RE.fullmatch(value)
                or not re.fullmatch(field.pattern, value)
                or ("host" in places and not HOST_LABEL_RE.fullmatch(value))
                or ("path" in places and not PATH_SEGMENT_RE.fullmatch(value))
            ):
                raise InvalidKeyError(f"{field.label} is not in the form {name} uses.")
        elif not FIELD_VALUE_RE.fullmatch(value):
            raise InvalidKeyError(
                f"{field.label} must be one line of printable characters, "
                "without spaces."
            )
        values[field_name] = value
    return values


def secret_digest(values: list[str]) -> str:
    """A pasted credential's SHA-256, which stands for its account where the
    vendor will not say whose it is."""
    return hashlib.sha256("\0".join(values).encode()).hexdigest()


def _path_value(document: Any, path: str) -> Any:
    value = document
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


class ApiKeyAdapter:
    can_issue = False
    read_only = False

    def __init__(self, definition: ConnectionDefinition, http: httpx.AsyncClient):
        sign_in = definition.auth.api_key
        if definition.adapter != "api_key" or sign_in is None:
            raise ValueError(f"{definition.slug} is not a complete api_key entry.")
        self._name = definition.name
        self._sign_in = sign_in
        self._http = http
        # Where each pattern field lands in the entry's URLs.
        self._placements: dict[str, set[str]] = {}
        urls = [sign_in.identity.url]
        if definition.mcp is not None:
            urls += [server.url for server in definition.mcp.servers]
        for url in urls:
            for name, places in url_placements(url).items():
                self._placements.setdefault(name, set()).update(places)

    def current_client_id(self, choices: Mapping[str, str]) -> str | None:
        return None

    def checked_fields(self, submitted: dict[str, str]) -> dict[str, str]:
        """The submitted fields, each as the entry allows, and nothing else."""
        return checked_fields(
            self._name, self._sign_in.fields, submitted, self._placements
        )

    async def identify(self, values: dict[str, str]) -> KeyIdentity:
        """Check the key with the vendor and say whose it is.

        The answer is read only for the account's id and label; a refusal is
        the person's to fix, so it says which fields to check.
        """
        identity = self._sign_in.identity
        request = self._http.build_request(
            identity.method,
            render(identity.url, values),
            headers={
                **{
                    name: render(value, values)
                    for name, value in identity.headers.items()
                },
                "Accept": "application/json",
            },
            json=identity.body,
        )
        try:
            response = await self._http.send(request, follow_redirects=False)
        except httpx.HTTPError:
            raise ServiceUnavailableError(
                f"{self._name} could not be reached to check the key. Please try again."
            ) from None
        if response.status_code == 429 or response.status_code >= 500:
            raise ServiceUnavailableError(
                f"{self._name} is unavailable (HTTP {response.status_code}). "
                "Please try again."
            )
        if response.status_code in (401, 403):
            raise InvalidKeyError(
                f"{self._name} refused the key (HTTP {response.status_code}). Check "
                "that it is right, still active, and allowed to do what the agent "
                "needs."
            )
        if response.status_code != 200:
            raise InvalidKeyError(
                f"{self._name} would not check the key (HTTP {response.status_code})."
            )
        account_id, label = self._read_identity(response, values)
        return KeyIdentity(account_id, label)

    def _read_identity(
        self, response: httpx.Response, values: dict[str, str]
    ) -> tuple[str, str]:
        identity = self._sign_in.identity
        body: Any = None
        if any(
            path is not None
            for path in (identity.account_id, identity.label, identity.requires)
        ):
            if len(response.content) > MAX_IDENTITY_BYTES:
                raise InvalidKeyError(f"{self._name}'s answer is too large.")
            try:
                body = response.json()
            except ValueError:
                raise InvalidKeyError(
                    f"{self._name}'s answer is not JSON, so whose key it is is unknown."
                ) from None
        if (
            identity.requires is not None
            and _path_value(body, identity.requires) is None
        ):
            raise InvalidKeyError(self._refusal(body))
        if identity.account_id is None:
            account_id = secret_digest(
                [values[f.name] for f in self._sign_in.fields if f.secret]
            )
        else:
            found = _path_value(body, identity.account_id)
            if type(found) is int:
                found = str(found)
            if not isinstance(found, str) or not found:
                raise InvalidKeyError(f"{self._name} did not name the key's account.")
            account_id = found
        label: Any = (
            None if identity.label is None else _path_value(body, identity.label)
        )
        if not isinstance(label, str) or not label:
            choices = [values[f.name] for f in self._sign_in.fields if not f.secret]
            label = " · ".join([f"{self._name} key", *choices])
        return account_id, label

    def _refusal(self, body: Any) -> str:
        """Why an answer without what the identity call requires is a refusal:
        the vendor's own first line, when it gives one as a JSON-RPC error."""
        message = _path_value(body, "error.message")
        if isinstance(message, str) and message.strip():
            line = message.strip().splitlines()[0][:200]
            return f"{self._name} did not accept the key and settings: {line}"
        return f"{self._name} did not accept the key and settings."

    def secret(self, values: dict[str, str]) -> ConnectionSecret:
        """What the connection stores: the token a session host is handed."""
        return ConnectionSecret({"access_token": key_token(self._sign_in, values)})

    def choices(self, values: dict[str, str]) -> dict[str, str]:
        """The fields picked from a list (a site), which are not secret."""
        return {f.name: values[f.name] for f in self._sign_in.fields if not f.secret}

    # ── ServiceAdapter ───────────────────────────────────────────────────────

    async def refresh(self, secret: ConnectionSecret) -> ConnectionSecret:
        # The catalog's refresh is none, so the broker never asks.
        raise ServiceAdapterError(f"A {self._name} key is not refreshed.")

    async def check_grant(
        self, access_token: str, request: IssueRequest
    ) -> dict[str, Any]:
        if request.resources:
            raise ServiceAdapterError(
                f"A {self._name} grant reaches the whole key; it names no resources."
            )
        return {}

    async def issue(self, access: AccessToken, request: IssueRequest) -> IssuedToken:
        raise ServiceAdapterError(
            f"A {self._name} key does not expire, so it is never handed to an agent."
        )

    async def revoke_issued(self, token: str) -> None:
        raise ServiceAdapterError(
            f"A {self._name} key is the owner's own and cannot be revoked alone."
        )

    async def revoke_connection(self, secret: ConnectionSecret, method: str) -> bool:
        raise ConnectionNotRevocable(
            f"Switch has forgotten the {self._name} key but cannot revoke it. "
            f"Revoke it in {self._name} if it should stop working."
        )

    def summary(
        self, agent_name: str, access: AccessLevel, resources: dict[str, Any]
    ) -> str:
        return f"{agent_name} uses {self._name} with your key, as far as it allows."
