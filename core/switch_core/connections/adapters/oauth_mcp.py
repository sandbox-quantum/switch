"""A vendor reached over OAuth whose tools are its own MCP servers.

Any catalog entry with `adapter: oauth-mcp`: the person signs in to the
vendor with OAuth (PKCE, the code exchanged by Core), Core keeps the sign-in
fresh, and an agent granted the service is handed the owner's own access
token, which its session uses to call the vendor's MCP servers. That token
can be neither narrowed nor revoked per agent, so the grant is the whole
connection's consent, and a token handed out is never `revocable`.

The OAuth endpoints are the catalog's, or discovered from the first MCP
server as the MCP authorization spec describes: its protected-resource
metadata (RFC 9728) names the authorization server, whose metadata
(RFC 8414) names the endpoints. The OAuth client is the operator's
(`StaticClient`) or one Core registered at the vendor.
"""

from __future__ import annotations

import base64
import hashlib
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlencode, urlsplit

import httpx

from switch_core.connections.adapters import (
    AccessToken,
    ConnectionSecret,
    IssuedToken,
    IssueRequest,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.loader import AccessLevel, ConnectionDefinition

MAX_METADATA_BYTES = 64 * 1024


@dataclass(frozen=True)
class OAuthClientCredentials:
    """Core's OAuth client at the vendor. A public client has no secret."""

    client_id: str
    client_secret: str | None = field(repr=False)


@dataclass(frozen=True)
class AuthorizationEndpoints:
    authorization: str
    token: str
    # Where a client registers itself (RFC 7591), where the vendor offers it.
    registration: str | None
    # Where a sign-in is revoked (RFC 7009), as the metadata advertises it.
    revocation: str | None
    # The MCP server the endpoints were discovered from, named as the
    # `resource` of every authorization and token request (RFC 8707). None
    # where the catalog names the endpoints.
    resource: str | None


class ClientSource(Protocol):
    """Where the adapter has its OAuth client from."""

    async def credentials(
        self, endpoints: AuthorizationEndpoints
    ) -> OAuthClientCredentials: ...


@dataclass(frozen=True)
class StaticClient:
    """A client the operator registered, from its settings file."""

    client: OAuthClientCredentials

    async def credentials(
        self, endpoints: AuthorizationEndpoints
    ) -> OAuthClientCredentials:
        return self.client


@dataclass(frozen=True)
class Identity:
    """The connected account: its stable id, and a label people recognise."""

    account_id: str
    label: str


@dataclass(frozen=True)
class SignIn:
    """What an authorization code was exchanged for."""

    secret: ConnectionSecret
    granted_scopes: list[str]


def s256(verifier: str) -> str:
    """The PKCE challenge for `verifier` (RFC 7636, S256)."""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _https(url: object, what: str) -> str:
    if not isinstance(url, str) or urlsplit(url).scheme != "https":
        raise ServiceAdapterError(f"The vendor's {what} is not an https URL.")
    return url


def _path_value(document: Any, path: str) -> Any:
    value = document
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


class OAuthMcpAdapter:
    can_issue = True

    def __init__(
        self,
        definition: ConnectionDefinition,
        client: ClientSource,
        http: httpx.AsyncClient,
    ) -> None:
        oauth = definition.auth.oauth
        identity = definition.auth.identity
        if (
            definition.adapter != "oauth-mcp"
            or oauth is None
            or identity is None
            or definition.mcp is None
        ):
            raise ValueError(f"{definition.slug} is not a complete oauth-mcp entry.")
        self._definition = definition
        self._oauth = oauth
        self._identity = identity
        self._mcp_url = definition.mcp.servers[0].url
        self._client = client
        self._http = http
        self._endpoints: AuthorizationEndpoints | None = None

    @property
    def _name(self) -> str:
        return self._definition.name

    # ── The vendor's HTTP side ───────────────────────────────────────────────

    async def _send(self, request: httpx.Request) -> httpx.Response:
        try:
            response = await self._http.send(request, follow_redirects=False)
        except httpx.HTTPError:
            raise ServiceUnavailableError(
                f"{self._name} could not be reached. Please try again."
            ) from None
        if response.status_code == 429 or response.status_code >= 500:
            raise ServiceUnavailableError(
                f"{self._name} is unavailable (HTTP {response.status_code}). "
                "Please try again."
            )
        return response

    def _json(self, response: httpx.Response, what: str) -> dict[str, Any]:
        if len(response.content) > MAX_METADATA_BYTES:
            raise ServiceAdapterError(f"{self._name}'s {what} is too large.")
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            raise ServiceAdapterError(f"{self._name}'s {what} is not a JSON object.")
        return body

    async def _metadata(self, candidates: list[str], what: str) -> dict[str, Any]:
        for url in candidates:
            response = await self._send(
                self._http.build_request(
                    "GET", url, headers={"Accept": "application/json"}
                )
            )
            if response.status_code == 200:
                return self._json(response, what)
            if response.status_code not in (404, 405):
                raise ServiceAdapterError(
                    f"{self._name}'s {what} could not be read "
                    f"(HTTP {response.status_code})."
                )
        raise ServiceAdapterError(f"{self._name} publishes no {what}.")

    async def endpoints(self) -> AuthorizationEndpoints:
        """The vendor's OAuth endpoints: the catalog's, or discovered once."""
        if self._endpoints is not None:
            return self._endpoints
        if self._oauth.authorization_url is not None and self._oauth.token_url:
            self._endpoints = AuthorizationEndpoints(
                authorization=self._oauth.authorization_url,
                token=self._oauth.token_url,
                registration=None,
                revocation=None,
                resource=None,
            )
            return self._endpoints
        server = urlsplit(self._mcp_url)
        origin = f"{server.scheme}://{server.netloc}"
        path = server.path.rstrip("/")
        # The server's own answer names its metadata; the well-known addresses
        # are the fallback, and on a host serving several MCP servers the
        # root one may describe another.
        named = await self._resource_metadata_url()
        resource = await self._metadata(
            [named]
            if named is not None
            else [
                *(
                    [f"{origin}/.well-known/oauth-protected-resource{path}"]
                    if path
                    else []
                ),
                f"{origin}/.well-known/oauth-protected-resource",
            ],
            "protected resource metadata",
        )
        servers = resource.get("authorization_servers")
        if not isinstance(servers, list) or not servers:
            raise ServiceAdapterError(
                f"{self._name}'s MCP server names no authorization server."
            )
        issuer = urlsplit(_https(servers[0], "authorization server"))
        issuer_origin = f"{issuer.scheme}://{issuer.netloc}"
        issuer_path = issuer.path.rstrip("/")
        candidates = (
            [
                f"{issuer_origin}/.well-known/oauth-authorization-server{issuer_path}",
                f"{issuer_origin}/.well-known/openid-configuration{issuer_path}",
                f"{issuer_origin}{issuer_path}/.well-known/openid-configuration",
            ]
            if issuer_path
            else [
                f"{issuer_origin}/.well-known/oauth-authorization-server",
                f"{issuer_origin}/.well-known/openid-configuration",
            ]
        )
        metadata = await self._metadata(candidates, "authorization server metadata")
        methods = metadata.get("code_challenge_methods_supported")
        if not isinstance(methods, list) or "S256" not in methods:
            raise ServiceAdapterError(
                f"{self._name}'s authorization server does not offer PKCE with "
                "S256, so Switch cannot sign in to it safely."
            )
        registration = metadata.get("registration_endpoint")
        revocation = metadata.get("revocation_endpoint")
        self._endpoints = AuthorizationEndpoints(
            authorization=_https(
                metadata.get("authorization_endpoint"), "authorization endpoint"
            ),
            token=_https(metadata.get("token_endpoint"), "token endpoint"),
            registration=(
                None
                if registration is None
                else _https(registration, "registration endpoint")
            ),
            revocation=(
                None
                if revocation is None
                else _https(revocation, "revocation endpoint")
            ),
            resource=self._mcp_url,
        )
        return self._endpoints

    async def _resource_metadata_url(self) -> str | None:
        """Where the MCP server says its metadata is: the `resource_metadata`
        of the 401 it answers a request without a token with (RFC 9728 §5)."""
        response = await self._send(
            self._http.build_request(
                "POST",
                self._mcp_url,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "switch", "version": "1.0.0"},
                    },
                },
                headers={"Accept": "application/json, text/event-stream"},
            )
        )
        if response.status_code != 401:
            return None
        match = re.search(
            r'resource_metadata="([^"]+)"', response.headers.get("www-authenticate", "")
        )
        return None if match is None else _https(match.group(1), "resource metadata")

    async def _token_request(self, form: dict[str, str]) -> dict[str, Any]:
        endpoints = await self.endpoints()
        client = await self._client.credentials(endpoints)
        data = {**form, "client_id": client.client_id}
        if client.client_secret is not None:
            data["client_secret"] = client.client_secret
        if endpoints.resource is not None:
            data["resource"] = endpoints.resource
        response = await self._send(
            self._http.build_request(
                "POST",
                endpoints.token,
                data=data,
                headers={"Accept": "application/json"},
            )
        )
        if response.status_code == 200:
            return self._json(response, "token response")
        try:
            error = response.json().get("error")
        except (ValueError, AttributeError):
            error = None
        if error == "invalid_grant":
            raise ReauthorizationRequiredError(
                f"{self._name} refused the sign-in: it was revoked or has lapsed."
            )
        raise ServiceAdapterError(
            f"{self._name} refused Switch's token request "
            f"(HTTP {response.status_code}{f', {error}' if isinstance(error, str) else ''})."
        )

    def _credentials(
        self, body: dict[str, Any], previous: dict[str, Any]
    ) -> dict[str, Any]:
        """The stored secret's values from a token response."""
        access_token = body.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise ServiceAdapterError(f"{self._name} returned no access token.")
        token_type = body.get("token_type")
        if isinstance(token_type, str) and token_type.lower() != "bearer":
            raise ServiceAdapterError(
                f"{self._name} returned a {token_type} token, not a bearer token."
            )
        expires_in = body.get("expires_in")
        if type(expires_in) is not int or expires_in <= 0:
            raise ServiceAdapterError(
                f"{self._name} did not say when its access token expires."
            )
        # Without a new one, the refresh token in hand stays good (RFC 6749 §6).
        refresh_token = body.get("refresh_token", previous.get("refresh_token"))
        if not isinstance(refresh_token, str) or not refresh_token:
            raise ServiceAdapterError(
                f"{self._name} returned no refresh token, so Switch could not keep "
                "the connection signed in."
            )
        values = {
            **previous,
            "access_token": access_token,
            "expires_at": time.time() + expires_in,
            "refresh_token": refresh_token,
        }
        scope = body.get("scope")
        if isinstance(scope, str):
            values["scope"] = scope
        return values

    # ── Signing in ───────────────────────────────────────────────────────────

    async def authorization_url(
        self,
        *,
        redirect_uri: str,
        state: str,
        code_challenge: str,
        scopes: list[str],
    ) -> str:
        """Where the person's browser goes to sign in and consent."""
        endpoints = await self.endpoints()
        client = await self._client.credentials(endpoints)
        query = {
            "response_type": "code",
            "client_id": client.client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(scopes),
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if self._oauth.prompt is not None:
            query["prompt"] = self._oauth.prompt
        if endpoints.resource is not None:
            query["resource"] = endpoints.resource
        separator = "&" if urlsplit(endpoints.authorization).query else "?"
        return f"{endpoints.authorization}{separator}{urlencode(query)}"

    async def exchange_code(
        self, *, code: str, verifier: str, redirect_uri: str, scopes: list[str]
    ) -> SignIn:
        """The sign-in an authorization code stands for; Core keeps it."""
        body = await self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": redirect_uri,
            }
        )
        values = self._credentials(body, {})
        granted = values.get("scope")
        return SignIn(
            ConnectionSecret(values),
            granted.split() if isinstance(granted, str) else list(scopes),
        )

    async def identify(self, access_token: str) -> Identity:
        """The account the token acts as, as the catalog says to read it."""
        response = await self._send(
            self._http.build_request(
                "GET",
                self._identity.url,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/json",
                },
            )
        )
        if response.status_code == 401:
            raise ReauthorizationRequiredError(
                f"{self._name} refused the new sign-in when asked whose it is."
            )
        if response.status_code != 200:
            raise ServiceAdapterError(
                f"{self._name} would not say whose sign-in this is "
                f"(HTTP {response.status_code})."
            )
        body = self._json(response, "account")
        account_id = _path_value(body, self._identity.account_id)
        label = _path_value(body, self._identity.label)
        if type(account_id) is int:
            account_id = str(account_id)
        if not isinstance(account_id, str) or not account_id:
            raise ServiceAdapterError(f"{self._name} did not name the account's id.")
        return Identity(
            account_id, label if isinstance(label, str) and label else account_id
        )

    # ── ServiceAdapter ───────────────────────────────────────────────────────

    async def refresh(self, secret: ConnectionSecret) -> ConnectionSecret:
        refresh_token = secret.values.get("refresh_token")
        if not isinstance(refresh_token, str) or not refresh_token:
            raise ReauthorizationRequiredError(
                f"The {self._name} connection holds no refresh token."
            )
        body = await self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )
        return ConnectionSecret(self._credentials(body, secret.values))

    async def check_grant(
        self, access_token: str, request: IssueRequest
    ) -> dict[str, Any]:
        if request.resources:
            raise ServiceAdapterError(
                f"A {self._name} grant reaches the whole connection; it names "
                "no resources."
            )
        return {}

    async def issue(self, access: AccessToken, request: IssueRequest) -> IssuedToken:
        await self.check_grant(access.token, request)
        return IssuedToken(
            token=access.token,
            expires_at=access.expires_at,
            resources={},
            revocable=False,
        )

    async def revoke_issued(self, token: str) -> None:
        raise ServiceAdapterError(
            f"A {self._name} token is the owner's own and cannot be revoked alone."
        )

    async def revoke_connection(self, secret: ConnectionSecret) -> None:
        endpoints = await self.endpoints()
        url = (
            endpoints.revocation
            if self._oauth.revocation_discovered
            else self._oauth.revocation_url
        )
        if url is None:
            raise ServiceAdapterError(
                f"{self._name} gives Switch no way to revoke a sign-in."
            )
        refresh_token = secret.values.get("refresh_token")
        token, hint = (
            (refresh_token, "refresh_token")
            if isinstance(refresh_token, str) and refresh_token
            else (secret.access_token, "access_token")
        )
        if token is None:
            return
        client = await self._client.credentials(endpoints)
        data = {"token": token, "token_type_hint": hint, "client_id": client.client_id}
        if client.client_secret is not None:
            data["client_secret"] = client.client_secret
        response = await self._send(self._http.build_request("POST", url, data=data))
        # RFC 7009: a token the server no longer knows is answered 200, but
        # some answer invalid_token; either way it is gone.
        if response.status_code == 200:
            return
        if response.status_code == 400 and "invalid_token" in response.text:
            return
        raise ServiceAdapterError(
            f"{self._name} refused to revoke the sign-in (HTTP {response.status_code})."
        )

    def summary(
        self, agent_name: str, access: AccessLevel, resources: dict[str, Any]
    ) -> str:
        verb = "reads and writes" if access == "write" else "reads"
        return f"{agent_name} {verb} {self._name} as you."
