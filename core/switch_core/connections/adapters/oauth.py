"""A vendor reached over OAuth.

Any catalog entry with `adapter: oauth`: the person signs in to the
vendor with OAuth (PKCE, the code exchanged by Core), Core keeps the sign-in
fresh, and an agent granted the service is handed the owner's own access
token, which its session uses to call the vendor's MCP servers or to run the
vendor's command-line tool. That token can be neither narrowed nor revoked per
agent, so the grant is the whole connection's consent, and a token handed out
is never `revocable`.

The OAuth endpoints are the catalog's, or discovered from the first MCP
server as the MCP authorization spec describes: its protected-resource
metadata (RFC 9728) names the authorization server, whose metadata
(RFC 8414) names the endpoints. The OAuth client is the operator's
(`StaticClient`) or one Core registered at the vendor.

An entry that asks for choices before its sign-in (`auth.oauth.choices`, a
vendor's site) has its URLs rendered with them: a sign-in's from its flow,
and a connection's from its secret, which keeps the choices it was made
with, so a refresh or a revocation calls the site the sign-in was made at.
"""

from __future__ import annotations

import base64
import hashlib
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from urllib.parse import quote, urlencode, urlsplit

import httpx

from switch_core.connections.adapters import (
    AccessToken,
    ConnectionNotRevocable,
    ConnectionSecret,
    IssuedToken,
    IssueRequest,
    ReauthorizationRequiredError,
    ServiceAdapterError,
    ServiceUnavailableError,
)
from switch_core.connections.loader import (
    AccessLevel,
    ChoicesError,
    ConnectionDefinition,
    choice_key,
    render,
)

MAX_METADATA_BYTES = 64 * 1024

# How a client's secret goes with a token or revocation request (RFC 8414's
# names): in the form body, or as HTTP Basic.
ClientAuthentication = Literal["client_secret_post", "client_secret_basic"]


@dataclass(frozen=True)
class OAuthClientCredentials:
    """Core's OAuth client at the vendor. A public client has no secret."""

    client_id: str
    client_secret: str | None = field(repr=False)
    # How the secret goes, where the client's registration says; None to send
    # it as the vendor's endpoints take it.
    authentication: ClientAuthentication | None


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
    client_authentication: ClientAuthentication


def client_fields(
    endpoints: AuthorizationEndpoints, client: OAuthClientCredentials
) -> tuple[dict[str, str], dict[str, str]]:
    """The form fields and headers a request to the token or revocation
    endpoint identifies the client with."""
    form = {"client_id": client.client_id}
    if client.client_secret is None:
        return form, {}
    authentication = client.authentication or endpoints.client_authentication
    if authentication == "client_secret_basic":
        # Each half form-urlencoded first (RFC 6749 §2.3.1).
        pair = f"{quote(client.client_id, safe='')}:{quote(client.client_secret, safe='')}".encode()
        return form, {"Authorization": f"Basic {base64.b64encode(pair).decode()}"}
    return {**form, "client_secret": client.client_secret}, {}


class ClientSource(Protocol):
    """Where the adapter has its OAuth client from, for each choice (the
    entry's choices as `choice_key` writes them, empty for none)."""

    def known_client_id(self, choice: str) -> str | None:
        """The client's id where it is already known, without asking anyone."""
        ...

    async def credentials(
        self, endpoints: AuthorizationEndpoints, choice: str
    ) -> OAuthClientCredentials: ...


@dataclass(frozen=True)
class StaticClient:
    """A client the operator registered, from its settings file: the one
    client for every choice."""

    client: OAuthClientCredentials

    def known_client_id(self, choice: str) -> str | None:
        return self.client.client_id

    async def credentials(
        self, endpoints: AuthorizationEndpoints, choice: str
    ) -> OAuthClientCredentials:
        return self.client


@dataclass(frozen=True)
class Identity:
    """The connected account: its stable id, and a label people recognise."""

    account_id: str
    label: str


@dataclass(frozen=True)
class SignIn:
    """What an authorization code was exchanged for, and through which client."""

    secret: ConnectionSecret
    granted_scopes: list[str]
    client_id: str


@dataclass(frozen=True)
class TokenAnswer:
    body: dict[str, Any]
    client_id: str


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


class OAuthAdapter:
    can_issue = True
    read_only = False

    def __init__(
        self,
        definition: ConnectionDefinition,
        client: ClientSource,
        http: httpx.AsyncClient,
    ) -> None:
        oauth = definition.auth.oauth
        identity = definition.auth.identity
        if (
            definition.adapter != "oauth"
            or oauth is None
            or identity is None
            or (definition.mcp is None and definition.cli is None)
        ):
            raise ValueError(f"{definition.slug} is not a complete oauth entry.")
        self._definition = definition
        self._oauth = oauth
        self._identity = identity
        self._mcp_url = (
            None if definition.mcp is None else definition.mcp.servers[0].url
        )
        self._client = client
        self._http = http
        # By choice key: each choice may be another authorization server.
        self._endpoints: dict[str, AuthorizationEndpoints] = {}

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

    def _checked(self, choices: Mapping[str, str]) -> dict[str, str]:
        """A sign-in's choices, as the entry offers them."""
        try:
            return self._oauth.checked_choices(choices)
        except ChoicesError as error:
            raise ServiceAdapterError(str(error)) from None

    def _choices_of(self, secret: ConnectionSecret) -> dict[str, str]:
        """The choices a connection was made with, which its secret keeps;
        none for one made before an entry offered any."""
        stored = secret.values.get("choices", {})
        try:
            return self._oauth.checked_choices(
                stored if isinstance(stored, dict) else {}
            )
        except ChoicesError as error:
            raise ReauthorizationRequiredError(
                f"The {self._name} connection was made for a choice this server "
                f"no longer offers. {error}"
            ) from None

    async def endpoints(self, choices: Mapping[str, str]) -> AuthorizationEndpoints:
        """The vendor's OAuth endpoints for `choices`: the catalog's, or
        discovered once per choice."""
        checked = self._checked(choices)
        key = choice_key(checked)
        known = self._endpoints.get(key)
        if known is None:
            known = await self._find_endpoints(checked)
            self._endpoints[key] = known
        return known

    async def _find_endpoints(self, choices: dict[str, str]) -> AuthorizationEndpoints:
        if self._oauth.authorization_url is not None and self._oauth.token_url:
            return AuthorizationEndpoints(
                authorization=render(self._oauth.authorization_url, choices),
                token=render(self._oauth.token_url, choices),
                registration=None,
                revocation=None,
                resource=None,
                client_authentication="client_secret_post",
            )
        if self._mcp_url is None:
            raise ServiceAdapterError(
                f"{self._name} names no OAuth endpoints and has no MCP server to "
                "discover them from."
            )
        mcp_url = render(self._mcp_url, choices)
        server = urlsplit(mcp_url)
        origin = f"{server.scheme}://{server.netloc}"
        path = server.path.rstrip("/")
        # The server's own answer names its metadata; the well-known addresses
        # are the fallback, and on a host serving several MCP servers the
        # root one may describe another.
        named = await self._resource_metadata_url(mcp_url)
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
        # The form body, unless the vendor takes a secret only as HTTP Basic:
        # Airtable refuses one in the body. Metadata that lists no methods
        # means Basic (RFC 8414 §2).
        auth_methods = metadata.get(
            "token_endpoint_auth_methods_supported", ["client_secret_basic"]
        )
        basic_only = (
            isinstance(auth_methods, list)
            and "client_secret_basic" in auth_methods
            and "client_secret_post" not in auth_methods
        )
        return AuthorizationEndpoints(
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
            resource=mcp_url,
            client_authentication=(
                "client_secret_basic" if basic_only else "client_secret_post"
            ),
        )

    async def _resource_metadata_url(self, mcp_url: str) -> str | None:
        """Where the MCP server says its metadata is: the `resource_metadata`
        of the 401 it answers a request without a token with (RFC 9728 §5)."""
        response = await self._send(
            self._http.build_request(
                "POST",
                mcp_url,
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

    def current_client_id(self, choices: Mapping[str, str]) -> str | None:
        return self._client.known_client_id(choice_key(choices))

    async def client_id(self, choices: Mapping[str, str]) -> str:
        """The client a sign-in starting now with `choices` goes through."""
        checked = self._checked(choices)
        return (
            await self._client.credentials(
                await self.endpoints(checked), choice_key(checked)
            )
        ).client_id

    async def _token_request(
        self, form: dict[str, str], choices: Mapping[str, str]
    ) -> TokenAnswer:
        endpoints = await self.endpoints(choices)
        client = await self._client.credentials(endpoints, choice_key(choices))
        identifying, headers = client_fields(endpoints, client)
        data = {**form, **identifying}
        if endpoints.resource is not None:
            data["resource"] = endpoints.resource
        response = await self._send(
            self._http.build_request(
                "POST",
                endpoints.token,
                data=data,
                headers={"Accept": "application/json", **headers},
            )
        )
        if response.status_code == 200:
            return TokenAnswer(self._json(response, "token response"), client.client_id)
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
        choices: Mapping[str, str],
    ) -> str:
        """Where the person's browser goes to sign in and consent."""
        endpoints = await self.endpoints(choices)
        client = await self._client.credentials(endpoints, choice_key(choices))
        query: dict[str, str] = {
            "response_type": "code",
            "client_id": client.client_id,
            "redirect_uri": redirect_uri,
            "scope": " ".join(scopes),
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        for key, value in self._oauth.authorization_params.items():
            query[key] = value
        if self._oauth.prompt is not None:
            query["prompt"] = self._oauth.prompt
        if endpoints.resource is not None:
            query["resource"] = endpoints.resource
        separator = "&" if urlsplit(endpoints.authorization).query else "?"
        return f"{endpoints.authorization}{separator}{urlencode(query)}"

    async def exchange_code(
        self,
        *,
        code: str,
        verifier: str,
        redirect_uri: str,
        scopes: list[str],
        choices: Mapping[str, str],
    ) -> SignIn:
        """The sign-in an authorization code stands for; Core keeps it, with
        the choices it was made with."""
        checked = self._checked(choices)
        answer = await self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": redirect_uri,
            },
            checked,
        )
        values = self._credentials(answer.body, {"choices": checked})
        granted = values.get("scope")
        return SignIn(
            ConnectionSecret(values),
            granted.split() if isinstance(granted, str) else list(scopes),
            answer.client_id,
        )

    async def identify(self, access_token: str, choices: Mapping[str, str]) -> Identity:
        """The account the token acts as, as the catalog says to read it."""
        response = await self._send(
            self._http.build_request(
                "GET",
                render(self._identity.url, self._checked(choices)),
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
        answer = await self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token},
            self._choices_of(secret),
        )
        return ConnectionSecret(self._credentials(answer.body, secret.values))

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
        if self._oauth.revocation_url is None and not self._oauth.revocation_discovered:
            raise ConnectionNotRevocable(
                f"Switch has stopped using the {self._name} sign-in but cannot "
                f"revoke it, so it still works. {self._oauth.remove_access}"
            )
        choices = self._choices_of(secret)
        endpoints = await self.endpoints(choices)
        url = (
            endpoints.revocation
            if self._oauth.revocation_discovered
            else None
            if self._oauth.revocation_url is None
            else render(self._oauth.revocation_url, choices)
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
        client = await self._client.credentials(endpoints, choice_key(choices))
        identifying, headers = client_fields(endpoints, client)
        response = await self._send(
            self._http.build_request(
                "POST",
                url,
                data={"token": token, "token_type_hint": hint, **identifying},
                headers=headers,
            )
        )
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
