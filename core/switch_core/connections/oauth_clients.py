"""The OAuth client Core registers for itself at a vendor that offers no other.

Dynamic client registration (RFC 7591): on the first connect to such a
service, Core registers once for the whole deployment and keeps the vendor's
answer in `service_oauth_clients`, encrypted with the keyring. Every
workspace's sign-ins to the service then go through that one client. The
table is deployment-wide and carries no tenant, so it is read in a session
bound to none.

Where a sign-in may return is fixed at registration: Switch Console's
listener on 127.0.0.1 (any port, as RFC 8252 lets a native client ask), and
Core's own callback where the server knows its public address.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import (
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.adapters.oauth_mcp import (
    AuthorizationEndpoints,
    OAuthClientCredentials,
)
from switch_core.connections.loader import RedirectMode
from switch_core.db.models import ServiceOAuthClient
from switch_core.keys import Keyring

# Where Switch Console's listener takes a sign-in's code back.
LOOPBACK_CALLBACK_PATH = "/switch-services/callback"
LOOPBACK_REDIRECT_URI = f"http://127.0.0.1{LOOPBACK_CALLBACK_PATH}"


def core_callback(public_url: str, service: str) -> str:
    """Core's own callback for `service`'s sign-ins."""
    return (
        f"{public_url.rstrip('/')}/gateway/service-connections/{service}/flows/callback"
    )


def redirect_uris(
    service: str, modes: list[RedirectMode], public_url: str | None
) -> list[str]:
    """Every redirect a registration lists, for the modes this server can use."""
    uris = []
    for mode in modes:
        if mode == "loopback":
            uris.append(LOOPBACK_REDIRECT_URI)
        elif public_url is not None:
            uris.append(core_callback(public_url, service))
    return uris


def client_name(public_url: str | None, server_name: str) -> str:
    """What the vendor's consent screen calls Switch: it and its host."""
    host = urlsplit(public_url).hostname if public_url else None
    return f"Switch ({host or server_name})"


class RegisteredClient:
    """The client Core registered at `service`'s vendor, registering it once.

    Registration takes a lock held in the database, so two connects at once,
    on any replica, register one client. A vendor that moves its registration
    endpoint gets a new registration rather than an unknown client.
    """

    def __init__(
        self,
        *,
        service: str,
        name: str,
        session_factory: async_sessionmaker[AsyncSession],
        keyring: Keyring,
        http: httpx.AsyncClient,
        client_name: str,
        redirect_uris: list[str],
    ) -> None:
        if not redirect_uris:
            raise ValueError(f"{service} has no redirect this server can register.")
        self._service = service
        self._name = name
        self._session_factory = session_factory
        self._keyring = keyring
        self._http = http
        self._client_name = client_name
        self._redirect_uris = redirect_uris
        self._known: tuple[str, OAuthClientCredentials] | None = None
        self._lock = asyncio.Lock()

    async def credentials(
        self, endpoints: AuthorizationEndpoints
    ) -> OAuthClientCredentials:
        endpoint = endpoints.registration
        if endpoint is None:
            raise ServiceAdapterError(
                f"{self._name}'s authorization server offers no client "
                "registration, so Switch has no client to sign in with."
            )
        async with self._lock:
            if self._known is not None and self._known[0] == endpoint:
                return self._known[1]
            async with self._session_factory() as session:
                await session.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {"key": f"service-oauth-client:{self._service}"},
                )
                row = await session.get(
                    ServiceOAuthClient, self._service, populate_existing=True
                )
                if row is not None and row.registration_endpoint == endpoint:
                    client = _credentials(
                        json.loads(self._keyring.decrypt(row.encrypted_secret))
                    )
                else:
                    answer = await self._register(endpoint)
                    client = _credentials(answer)
                    encrypted = self._keyring.encrypt(json.dumps(answer))
                    if row is None:
                        session.add(
                            ServiceOAuthClient(
                                service=self._service,
                                registration_endpoint=endpoint,
                                client_id=client.client_id,
                                encrypted_secret=encrypted,
                            )
                        )
                    else:
                        row.registration_endpoint = endpoint
                        row.client_id = client.client_id
                        row.encrypted_secret = encrypted
                await session.commit()
            self._known = (endpoint, client)
            return client

    async def _register(self, endpoint: str) -> dict[str, Any]:
        try:
            response = await self._http.post(
                endpoint,
                json={
                    "client_name": self._client_name,
                    "redirect_uris": self._redirect_uris,
                    "grant_types": ["authorization_code", "refresh_token"],
                    "response_types": ["code"],
                    "token_endpoint_auth_method": "none",
                },
                headers={"Accept": "application/json"},
                follow_redirects=False,
            )
        except httpx.HTTPError:
            raise ServiceUnavailableError(
                f"{self._name} could not be reached to register Switch. Please try again."
            ) from None
        if response.status_code == 429 or response.status_code >= 500:
            raise ServiceUnavailableError(
                f"{self._name} is unavailable (HTTP {response.status_code}). "
                "Please try again."
            )
        if response.status_code not in (200, 201):
            raise ServiceAdapterError(
                f"{self._name} refused to register Switch as a client "
                f"(HTTP {response.status_code})."
            )
        try:
            answer = response.json()
        except ValueError:
            answer = None
        if not isinstance(answer, dict):
            raise ServiceAdapterError(f"{self._name}'s registration is not JSON.")
        _credentials(answer)
        return answer


def _credentials(answer: dict[str, Any]) -> OAuthClientCredentials:
    client_id = answer.get("client_id")
    secret = answer.get("client_secret")
    if not isinstance(client_id, str) or not client_id:
        raise ServiceAdapterError("The vendor's registration named no client.")
    return OAuthClientCredentials(
        client_id, secret if isinstance(secret, str) and secret else None
    )
