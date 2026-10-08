"""The service adapters this server runs, built from the catalog at startup.

Each enabled catalog entry names its adapter. An entry gets one where this
server is set up for it, and none where it is not: the broker then shows the
service as not set up here, never hides it. Settings that are set but cannot
be used stop the server, rather than surfacing at the first connect.

A static OAuth client's settings are a JSON file named by
`<PREFIX>_CLIENT_CONFIG_PATH`, the prefix being the entry's
`auth.oauth.client_settings`, beside `GITHUB_APP_CONFIG_PATH` for GitHub.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from switch_core.connections.adapters import ServiceAdapter
from switch_core.connections.adapters.github import GitHubAdapter, GitHubApp
from switch_core.connections.adapters.oauth_mcp import (
    OAuthClientCredentials,
    OAuthMcpAdapter,
    StaticClient,
)
from switch_core.connections.loader import Connection


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


def build_adapters(
    catalog: dict[str, Connection],
    *,
    github_app: GitHubApp | None,
    environ: Mapping[str, str],
    http: httpx.AsyncClient,
) -> dict[str, ServiceAdapter]:
    """An adapter for each enabled entry this server is set up for.

    `http` is how OAuth/MCP adapters reach their vendors: one client, held to
    the server's outbound policy.
    """
    adapters: dict[str, ServiceAdapter] = {}
    for slug, entry in catalog.items():
        definition = entry.definition
        if not definition.enabled:
            continue
        if definition.adapter == "github":
            # With the App alone, GitHub can be connected but not granted.
            if github_app is not None:
                adapters[slug] = GitHubAdapter(
                    github_app.connections, github_app.signer
                )
        elif definition.adapter == "oauth-mcp":
            oauth = definition.auth.oauth
            assert oauth is not None
            if oauth.registration != "static":
                raise ServiceSetupError(
                    f"Connection {slug} registers its OAuth client dynamically, "
                    "which this server cannot do."
                )
            assert oauth.client_settings is not None
            settings = load_client_settings(oauth.client_settings, environ)
            if settings is not None:
                adapters[slug] = OAuthMcpAdapter(
                    definition,
                    StaticClient(
                        OAuthClientCredentials(
                            settings.client_id, settings.client_secret
                        )
                    ),
                    http,
                )
        else:
            raise ServiceSetupError(
                f"Connection {slug} names the {definition.adapter} adapter, which "
                "this server does not have."
            )
    return adapters
