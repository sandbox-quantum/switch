"""The service adapters this server runs, built from the catalog at startup.

Each enabled catalog entry names its adapter. An entry gets one where this
server is set up for it, and none where it is not: the broker then shows the
service as not set up here, never hides it. Settings that are set but cannot
be used stop the server, rather than surfacing at the first connect.

A static OAuth client's settings are a JSON file named by
`<PREFIX>_CLIENT_CONFIG_PATH`, the prefix being the entry's
`auth.oauth.client_settings`, beside `GITHUB_APP_CONFIG_PATH` for GitHub, or
the operator saves them from the dashboard; `connections/app_credentials.py`
resolves which applies, and hands the result here.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.adapters import ServiceAdapter
from switch_core.connections.adapters.api_key import ApiKeyAdapter
from switch_core.connections.adapters.github import GitHubAdapter, GitHubApp
from switch_core.connections.adapters.oauth import (
    OAuthAdapter,
    OAuthClientCredentials,
    StaticClient,
)
from switch_core.connections.loader import Connection, ConnectionDefinition
from switch_core.connections.oauth_clients import (
    RegisteredClient,
    client_name,
    redirect_uris,
)
from switch_core.keys import Keyring


class ServiceSetupError(RuntimeError):
    """A service's settings are set but cannot be used."""


class OAuthClientSettings(BaseModel):
    """An OAuth client the operator registered at the vendor."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    client_id: str = Field(min_length=1)
    client_secret: str = Field(min_length=1, repr=False)


def client_settings_variable(prefix: str) -> str:
    return f"{prefix}_CLIENT_CONFIG_PATH"


def load_client_settings(
    prefix: str, environ: Mapping[str, str]
) -> OAuthClientSettings | None:
    """The client named by `<prefix>_CLIENT_CONFIG_PATH`, or None when unset."""
    variable = client_settings_variable(prefix)
    raw_path = environ.get(variable, "")
    if not raw_path:
        return None
    path = Path(raw_path)
    if not path.is_absolute():
        raise ServiceSetupError(f"{variable} must be an absolute path.")
    try:
        return OAuthClientSettings.model_validate(json.loads(path.read_text("utf-8")))
    except OSError as error:
        raise ServiceSetupError(
            f"{variable} names a file that cannot be read: {error.strerror}."
        ) from None
    except (json.JSONDecodeError, ValidationError):
        raise ServiceSetupError(
            f"{variable} must name a JSON file holding a non-empty client_id and "
            "client_secret, and nothing else."
        ) from None


@dataclass(frozen=True)
class ClientRegistration:
    """What a client Core registers for itself needs: where it is kept, and
    the host the vendor's consent screen names and calls back."""

    session_factory: async_sessionmaker[AsyncSession]
    keyring: Keyring
    public_url: str | None
    server_name: str


def every_scope(definition: ConnectionDefinition) -> list[str]:
    """Every scope the entry's levels name, in order, each once."""
    access = definition.access
    assert access is not None
    levels = [access.read, *([access.write] if access.write is not None else [])]
    return list(
        dict.fromkeys(scope for level in levels for scope in level.scopes or [])
    )


def build_adapter(
    slug: str,
    definition: ConnectionDefinition,
    *,
    github_app: GitHubApp | None,
    oauth_client: OAuthClientCredentials | None,
    http: httpx.AsyncClient,
    registration: ClientRegistration,
) -> ServiceAdapter | None:
    """The adapter for one enabled entry, or None where it is not set up.

    `github_app` and `oauth_client` are the app the operator set up for the
    entry, where its adapter needs one.
    """
    if definition.adapter == "github":
        # With the App alone, GitHub can be connected but not granted.
        if github_app is None:
            return None
        return GitHubAdapter(
            github_app.connections,
            github_app.signer,
            read_only=github_app.read_only,
        )
    if definition.adapter == "oauth":
        oauth = definition.auth.oauth
        assert oauth is not None
        if oauth.registration == "dynamic":
            uris = redirect_uris(
                slug, oauth.redirect, registration.public_url, oauth.loopback_ports
            )
            if not uris:
                raise ServiceSetupError(
                    f"Connection {slug} signs in only through Core's callback, "
                    "which needs GATEWAY_PUBLIC_URL."
                )
            return OAuthAdapter(
                definition,
                RegisteredClient(
                    service=slug,
                    name=definition.name,
                    session_factory=registration.session_factory,
                    keyring=registration.keyring,
                    http=http,
                    client_name=client_name(
                        registration.public_url, registration.server_name
                    ),
                    redirect_uris=uris,
                    scopes=every_scope(definition),
                ),
                http,
            )
        if oauth_client is None:
            return None
        return OAuthAdapter(definition, StaticClient(oauth_client), http)
    if definition.adapter == "api_key":
        # A key needs nothing set up on the server: people paste their own.
        return ApiKeyAdapter(definition, http)
    raise ServiceSetupError(
        f"Connection {slug} names the {definition.adapter} adapter, which "
        "this server does not have."
    )


def build_adapters(
    catalog: dict[str, Connection],
    *,
    github_app: GitHubApp | None,
    oauth_clients: Mapping[str, OAuthClientCredentials],
    http: httpx.AsyncClient,
    registration: ClientRegistration,
) -> dict[str, ServiceAdapter]:
    """An adapter for each enabled entry this server is set up for.

    `oauth_clients` are the static clients the operator set up, by service.
    `http` is how OAuth/MCP adapters reach their vendors: one client, held to
    the server's outbound policy.
    """
    adapters: dict[str, ServiceAdapter] = {}
    for slug, entry in catalog.items():
        if not entry.definition.enabled:
            continue
        adapter = build_adapter(
            slug,
            entry.definition,
            github_app=github_app,
            oauth_client=oauth_clients.get(slug),
            http=http,
            registration=registration,
        )
        if adapter is not None:
            adapters[slug] = adapter
    return adapters
