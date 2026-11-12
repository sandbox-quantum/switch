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
"""

from __future__ import annotations

import asyncio
import base64
import functools
import hashlib
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from urllib.parse import quote, urlencode, urlsplit

import httpx
from fastmcp import Client
from fastmcp.client.logging import LogMessage
from fastmcp.client.transports import StreamableHttpTransport
from mcp.shared.exceptions import McpError
from mcp.types import (
    CONNECTION_CLOSED,
    INVALID_PARAMS,
    CallToolRequest,
    CallToolRequestParams,
    CallToolResult,
    ClientRequest,
    TextContent,
    Tool,
)

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
from switch_core.connections.loader import AccessLevel, ConnectionDefinition
from switch_core.logging_context import (
    MCP_IDENTITY_DIAGNOSTICS,
    McpIdentityDiagnosticFilter,
)
from switch_core.outbound import (
    GuardedAsyncClient,
    OutboundHostUnresolved,
    OutboundPolicy,
    OutboundURLRefused,
    guarded_transport,
)

MAX_METADATA_BYTES = 64 * 1024
# The MCP identity call's limits: its whole time, the bytes of one response
# and of all of them, the tools/list pages it reads, and the tool's result.
MCP_IDENTITY_SECONDS: float = 15
MCP_RESPONSE_BYTES = 1024 * 1024
MCP_IDENTITY_BYTES = 4 * 1024 * 1024
MCP_TOOL_PAGES = 20
MCP_RESULT_BYTES = 64 * 1024

# How a client's secret goes with a token or revocation request (RFC 8414's
# names): in the form body, or as HTTP Basic.
ClientAuthentication = Literal["client_secret_post", "client_secret_basic"]

McpIdentityReason = Literal[
    "tool_not_found",
    "not_read_only",
    "needs_arguments",
    "tool_error",
    "bad_result",
    "protocol_error",
]

_MCP_IDENTITY_FAILURES: dict[McpIdentityReason, str] = {
    "tool_not_found": "the server lists no single tool with the catalog's name",
    "not_read_only": "the identity tool is not marked read-only",
    "needs_arguments": "the identity tool needs arguments",
    "tool_error": "the identity tool returned an error",
    "bad_result": "the server's answer is too large or is not one JSON object",
    "protocol_error": "the server's answer is not valid MCP",
}


class McpIdentityError(ServiceAdapterError):
    """MCP identity failed for one reason from a fixed set. The message is
    fixed text, because vendor text can hold account data or credentials."""

    def __init__(self, service: str, reason: McpIdentityReason) -> None:
        super().__init__(
            f"{service} could not identify the account through MCP: "
            f"{_MCP_IDENTITY_FAILURES[reason]} ({reason})."
        )
        self.reason: McpIdentityReason = reason


# The root handler's filter (`logging_config.py`) sees only what reaches
# root. `fastmcp.client.client` stops at the `fastmcp` logger, which does not
# propagate and has its own handlers, so it needs this filter.
# `mcp.client.streamable_http` reaches root; its filter covers handlers Core
# did not install, such as pytest's `caplog`.
for _sdk_logger in ("mcp.client.streamable_http", "fastmcp.client.client"):
    logging.getLogger(_sdk_logger).addFilter(McpIdentityDiagnosticFilter())


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
    # Where a token is introspected (RFC 7662), as the metadata advertises it.
    introspection: str | None
    # The resource the MCP server's metadata names (its URL where it names
    # none), sent as the `resource` of every authorization and token request
    # (RFC 8707). None where the catalog names the endpoints.
    resource: str | None
    client_authentication: ClientAuthentication


def client_fields(
    endpoints: AuthorizationEndpoints, client: OAuthClientCredentials
) -> tuple[dict[str, str], dict[str, str]]:
    """The form fields and headers a request to the token, revocation or
    introspection endpoint identifies the client with."""
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
    """Where the adapter has its OAuth client from."""

    def known_client_id(self) -> str | None:
        """The client's id where it is already known, without asking anyone."""
        ...

    async def credentials(
        self, endpoints: AuthorizationEndpoints
    ) -> OAuthClientCredentials: ...


@dataclass(frozen=True)
class StaticClient:
    """A client the operator registered, from its settings file."""

    client: OAuthClientCredentials

    def known_client_id(self) -> str | None:
        return self.client.client_id

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
    try:
        parts = urlsplit(url) if isinstance(url, str) else None
        valid = (
            parts is not None
            and parts.scheme == "https"
            and bool(parts.hostname)
            and parts.username is None
            and parts.password is None
        )
    except ValueError:
        valid = False
    if not valid:
        raise ServiceAdapterError(f"The vendor's {what} is not an https URL.")
    assert isinstance(url, str)
    return url


def _resource_covers(resource: str, url: str) -> bool:
    """Whether `resource` is the MCP server at `url` or a parent path of it
    on the same origin.

    RFC 9728 §3.3 wants an exact match for metadata found through
    WWW-Authenticate, but Airtable advertises its origin for its `/mcp`
    server. So this takes the same origin, and the MCP Python SDK's path
    rule: a prefix on a segment boundary. A live test on 2026-11-09 showed that
    Airtable ignores `resource`, so the origin works for it.

    RFC 8707 forbids a fragment, and Core takes no query either.
    """
    if "?" in resource or "#" in resource:
        return False
    advertised = urlsplit(resource)
    server = urlsplit(url)
    try:
        origins = [
            (
                parts.scheme.lower(),
                parts.hostname,
                443 if parts.port is None else parts.port,
            )
            for parts in (advertised, server)
        ]
    except ValueError:
        return False
    if origins[0] != origins[1]:
        return False
    return f"{server.path.rstrip('/')}/".startswith(f"{advertised.path.rstrip('/')}/")


class _BudgetExceeded(Exception):
    def __init__(self) -> None:
        super().__init__("The MCP identity call read more than its byte budget.")


@dataclass
class _McpBudget:
    """The bytes the MCP identity call may read, per response and in total."""

    per_response: int
    total: int
    deadline: asyncio.Timeout
    used: int = 0
    tripped: bool = False

    def trip(self) -> None:
        # The first trip ends the call; the deadline cannot move after that.
        if self.tripped:
            return
        self.tripped = True
        # The SDK swallows a read error in its task group and waits for an
        # answer that never comes, so the call ends now instead.
        self.deadline.reschedule(asyncio.get_running_loop().time())


class _BudgetStream(httpx.AsyncByteStream):
    def __init__(self, inner: httpx.AsyncByteStream, budget: _McpBudget) -> None:
        self._inner = inner
        self._budget = budget
        self._seen = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._inner:
            self._seen += len(chunk)
            self._budget.used += len(chunk)
            if (
                self._seen > self._budget.per_response
                or self._budget.used > self._budget.total
            ):
                self._budget.trip()
                raise _BudgetExceeded()
            yield chunk

    async def aclose(self) -> None:
        await self._inner.aclose()


class _BudgetTransport(httpx.AsyncBaseTransport):
    """Counts the bytes of each response as they arrive, JSON or SSE."""

    def __init__(self, inner: httpx.AsyncBaseTransport, budget: _McpBudget) -> None:
        self._inner = inner
        self._budget = budget

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._inner.handle_async_request(request)
        if request.method == "POST" and response.status_code == 404:
            # The SDK reads a 404 as an ended session and drops the status,
            # so it is raised here the way the SDK raises any other 4xx.
            await response.aclose()
            raise httpx.HTTPStatusError("Not Found", request=request, response=response)
        # Compressed bytes do not bound the decoded size.
        if response.headers.get("content-encoding", "identity").lower() != "identity":
            await response.aclose()
            self._budget.trip()
            raise _BudgetExceeded()
        assert isinstance(response.stream, httpx.AsyncByteStream)
        return httpx.Response(
            response.status_code,
            headers=response.headers,
            stream=_BudgetStream(response.stream, self._budget),
            extensions=response.extensions,
        )

    async def aclose(self) -> None:
        await self._inner.aclose()


def _mcp_http_client(
    *,
    budget: _McpBudget,
    policy: OutboundPolicy,
    verify: bool,
    headers: dict[str, str] | None,
    auth: httpx.Auth | None,
    follow_redirects: bool,
    timeout: httpx.Timeout,
) -> httpx.AsyncClient:
    """The identity call's own client and transport, held to the shared
    client's policy. Closing it never closes the shared client's transport.
    Redirects are not followed, whatever the SDK asks."""
    return httpx.AsyncClient(
        headers={**(headers or {}), "Accept-Encoding": "identity"},
        auth=auth,
        follow_redirects=False,
        trust_env=False,
        timeout=timeout,
        transport=_BudgetTransport(guarded_transport(policy, verify=verify), budget),
    )


async def _drop_vendor_log(message: LogMessage) -> None:
    # A vendor's log notification is its own text, which Core never logs.
    return None


def _leaves(error: BaseException) -> Iterator[BaseException]:
    """The exceptions in `error`, with every exception group opened and
    every explicit cause followed: fastmcp raises a connect failure as a
    RuntimeError from the transport's error."""
    pending, seen = [error], set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
        else:
            yield current
        if current.__cause__ is not None:
            pending.append(current.__cause__)


def _accepts_no_arguments(schema: object) -> bool:
    """Whether a tool's input schema says it needs no arguments: an object
    schema with no required property. Nothing else is read, so a vendor's
    schema costs no work: a JSON Schema validator can spend minutes of CPU
    time on a small hostile schema. A tool that still refuses `{}` fails
    loudly when called (`tool_error`)."""
    return (
        isinstance(schema, dict)
        and schema.get("type") == "object"
        and schema.get("required", []) == []
    )


def _identity_body(result: CallToolResult) -> dict[str, Any] | None:
    """The one JSON object an identity tool returned, or None."""
    if result.structuredContent is not None:
        return result.structuredContent
    if len(result.content) != 1 or not isinstance(result.content[0], TextContent):
        return None
    try:
        body = json.loads(result.content[0].text)
    except (ValueError, RecursionError):
        return None
    return body if isinstance(body, dict) else None


def _path_value(document: Any, path: str) -> Any:
    value = document
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


class OAuthAdapter:
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
                introspection=None,
                resource=None,
                client_authentication="client_secret_post",
            )
            return self._endpoints
        mcp_url = self._mcp_url
        if mcp_url is None:
            raise ServiceAdapterError(
                f"{self._name} names no OAuth endpoints and has no MCP server to "
                "discover them from."
            )
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
        # Checked before its authorization servers are trusted: metadata for
        # another server names that server's.
        advertised = _https(resource.get("resource", mcp_url), "resource identifier")
        if not _resource_covers(advertised, mcp_url):
            raise ServiceAdapterError(
                f"{self._name}'s MCP server names another server as its resource."
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
        introspection = metadata.get("introspection_endpoint")
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
            introspection=(
                None
                if introspection is None
                else _https(introspection, "introspection endpoint")
            ),
            resource=advertised,
            client_authentication=(
                "client_secret_basic" if basic_only else "client_secret_post"
            ),
        )
        return self._endpoints

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

    def current_client_id(self) -> str | None:
        return self._client.known_client_id()

    async def client_id(self) -> str:
        """The client a sign-in starting now goes through."""
        return (await self._client.credentials(await self.endpoints())).client_id

    async def _token_request(self, form: dict[str, str]) -> TokenAnswer:
        endpoints = await self.endpoints()
        client = await self._client.credentials(endpoints)
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
            f"(HTTP {response.status_code})."
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
                f"{self._name} returned a token type other than bearer."
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
                "the connector signed in."
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
        # Refuse before consent: after it, the sign-in could not name an account.
        if self._identity.introspection and endpoints.introspection is None:
            raise self._no_introspection()
        client = await self._client.credentials(endpoints)
        query: dict[str, str] = {
            "response_type": "code",
            "client_id": client.client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        access = self._definition.access
        if access is None or not access.unscoped:
            query["scope"] = " ".join(scopes)
        for key, value in self._oauth.authorization_params.items():
            query[key] = value
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
        answer = await self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": redirect_uri,
            }
        )
        values = self._credentials(answer.body, {})
        granted = values.get("scope")
        return SignIn(
            ConnectionSecret(values),
            granted.split() if isinstance(granted, str) else list(scopes),
            answer.client_id,
        )

    async def identify(self, access_token: str) -> Identity:
        """The account the token acts as, as the catalog says to read it."""
        if self._identity.mcp_tool is not None:
            body = await self._mcp_identity(access_token)
        elif self._identity.introspection:
            body = await self._introspect(access_token)
        else:
            assert self._identity.url is not None
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
        paths = self._identity.account_id
        parts = (
            [_path_value(body, path) for path in paths]
            if isinstance(paths, list)
            else [_path_value(body, paths)]
        )
        if any(type(part) not in (str, int) or not str(part).strip() for part in parts):
            raise ServiceAdapterError(f"{self._name} did not name the account's id.")
        # Escape each component so a separator in an id cannot alias another account.
        account_id = (
            ":".join(quote(str(part), safe="") for part in parts)
            if isinstance(paths, list)
            else str(parts[0])
        )
        label = _path_value(body, self._identity.label)
        return Identity(
            account_id, label if isinstance(label, str) and label else account_id
        )

    async def _introspect(self, access_token: str) -> dict[str, Any]:
        """What the authorization server says of the token (RFC 7662), asked
        as the client is at the token endpoint. Only an active token's answer
        names an account."""
        endpoints = await self.endpoints()
        if endpoints.introspection is None:
            raise self._no_introspection()
        client = await self._client.credentials(endpoints)
        identifying, headers = client_fields(endpoints, client)
        response = await self._send(
            self._http.build_request(
                "POST",
                endpoints.introspection,
                data={
                    "token": access_token,
                    "token_type_hint": "access_token",
                    **identifying,
                },
                headers={"Accept": "application/json", **headers},
            )
        )
        if response.status_code != 200:
            raise ServiceAdapterError(
                f"{self._name} would not say whose sign-in this is "
                f"(HTTP {response.status_code})."
            )
        body = self._json(response, "token introspection")
        if body.get("active") is not True:
            raise ReauthorizationRequiredError(
                f"{self._name} says the new sign-in is not active."
            )
        return body

    def _no_introspection(self) -> ServiceAdapterError:
        return ServiceAdapterError(
            f"{self._name}'s authorization server offers no token "
            "introspection, so Switch cannot tell whose sign-in this is."
        )

    async def _mcp_identity(self, access_token: str) -> dict[str, Any]:
        if self._mcp_url is None or self._identity.mcp_tool is None:
            raise ServiceAdapterError(f"{self._name} has no MCP identity source.")
        http = self._http
        if not isinstance(http, GuardedAsyncClient):
            raise ServiceAdapterError(
                f"{self._name} was not asked whose sign-in this is: Core's HTTP "
                "client is not held to its outbound policy."
            )
        deadline = asyncio.timeout(MCP_IDENTITY_SECONDS)
        budget = _McpBudget(MCP_RESPONSE_BYTES, MCP_IDENTITY_BYTES, deadline)
        failure: ServiceAdapterError | None = None
        result: CallToolResult | None = None
        diagnostics = MCP_IDENTITY_DIAGNOSTICS.set(True)
        try:
            async with deadline:
                result = await self._call_identity_tool(http, access_token, budget)
        except Exception as error:
            failure = self._mcp_failure(error, budget)
        except BaseExceptionGroup as group:
            # A cancel the SDK's task group wrapped: ours if the deadline
            # passed, otherwise the caller's, which must go on.
            if not (budget.tripped or deadline.expired()):
                raise
            failure = self._mcp_failure(group, budget)
        finally:
            MCP_IDENTITY_DIAGNOSTICS.reset(diagnostics)
        # Raised here, not in the handler, so the error carries no SDK
        # exception: those hold vendor text and the request's bearer token.
        if failure is not None:
            raise failure
        assert result is not None
        if result.isError:
            raise McpIdentityError(self._name, "tool_error")
        if len(result.model_dump_json().encode()) > MCP_RESULT_BYTES:
            raise McpIdentityError(self._name, "bad_result")
        body = _identity_body(result)
        if body is None:
            raise McpIdentityError(self._name, "bad_result")
        return body

    async def _call_identity_tool(
        self, http: GuardedAsyncClient, access_token: str, budget: _McpBudget
    ) -> CallToolResult:
        assert self._mcp_url is not None and self._identity.mcp_tool is not None
        transport = StreamableHttpTransport(
            self._mcp_url,
            headers={"Authorization": f"Bearer {access_token}"},
            httpx_client_factory=functools.partial(
                _mcp_http_client,
                budget=budget,
                policy=http.policy,
                verify=http.verify,
            ),
        )
        async with Client(
            transport,
            timeout=MCP_IDENTITY_SECONDS,
            init_timeout=MCP_IDENTITY_SECONDS,
            log_handler=_drop_vendor_log,
        ) as client:
            # Paged here, not by the SDK, which stops quietly on a repeated
            # cursor and reads any number of pages.
            tools: list[Tool] = []
            cursor: str | None = None
            seen: set[str] = set()
            for _ in range(MCP_TOOL_PAGES):
                page = await client.list_tools_mcp(cursor=cursor)
                tools.extend(page.tools)
                cursor = page.nextCursor
                if not cursor:
                    break
                if cursor in seen:
                    raise McpIdentityError(self._name, "bad_result")
                seen.add(cursor)
            else:
                raise McpIdentityError(self._name, "bad_result")
            matches = [tool for tool in tools if tool.name == self._identity.mcp_tool]
            if len(matches) != 1:
                raise McpIdentityError(self._name, "tool_not_found")
            tool = matches[0]
            if tool.annotations is None or tool.annotations.readOnlyHint is not True:
                raise McpIdentityError(self._name, "not_read_only")
            if not _accepts_no_arguments(tool.inputSchema):
                raise McpIdentityError(self._name, "needs_arguments")
            # Sent as a plain request: the SDK's `call_tool` checks the result
            # against the vendor's outputSchema, which can fetch any URL.
            try:
                result: CallToolResult = await client.session.send_request(
                    ClientRequest(
                        CallToolRequest(
                            params=CallToolRequestParams(
                                name=self._identity.mcp_tool, arguments={}
                            )
                        )
                    ),
                    CallToolResult,
                )
            except McpError as refused:
                # A tool can refuse `{}` this way, not with an isError result.
                if refused.error.code == INVALID_PARAMS:
                    raise McpIdentityError(self._name, "tool_error") from None
                raise
            return result

    def _mcp_failure(
        self, error: BaseException, budget: _McpBudget
    ) -> ServiceAdapterError:
        """A new error, of fixed text, for what failed in the identity call."""
        if budget.tripped:
            return McpIdentityError(self._name, "bad_result")
        leaves = list(_leaves(error))
        for leaf in leaves:
            if isinstance(leaf, McpIdentityError):
                return McpIdentityError(self._name, leaf.reason)
        for leaf in leaves:
            # A name that does not resolve is not the policy's refusal: it
            # is unreachable, below.
            if isinstance(leaf, OutboundURLRefused) and not isinstance(
                leaf, OutboundHostUnresolved
            ):
                return ServiceAdapterError(
                    f"{self._name}'s MCP server address is not allowed by this "
                    "server's outbound policy."
                )
        for leaf in leaves:
            if isinstance(leaf, httpx.HTTPStatusError):
                status = leaf.response.status_code
                if status == 401:
                    return ReauthorizationRequiredError(
                        f"{self._name} refused the new sign-in when asked whose it is."
                    )
                if status == 429 or status >= 500:
                    return ServiceUnavailableError(
                        f"{self._name} is unavailable (HTTP {status}). "
                        "Please try again."
                    )
                if 400 <= status < 500:
                    return ServiceAdapterError(
                        f"{self._name} would not say whose sign-in this is "
                        f"(HTTP {status})."
                    )
                # A redirect, which Core does not follow, is not an MCP answer.
                return McpIdentityError(self._name, "protocol_error")
        if budget.deadline.expired() or any(
            isinstance(
                leaf, (TimeoutError, httpx.TransportError, OutboundHostUnresolved)
            )
            or (
                isinstance(leaf, McpError)
                and leaf.error.code in (httpx.codes.REQUEST_TIMEOUT, CONNECTION_CLOSED)
            )
            for leaf in leaves
        ):
            return ServiceUnavailableError(
                f"{self._name} could not be reached. Please try again."
            )
        return McpIdentityError(self._name, "protocol_error")

    # ── ServiceAdapter ───────────────────────────────────────────────────────

    async def refresh(self, secret: ConnectionSecret) -> ConnectionSecret:
        refresh_token = secret.values.get("refresh_token")
        if not isinstance(refresh_token, str) or not refresh_token:
            raise ReauthorizationRequiredError(
                f"The {self._name} connector holds no refresh token."
            )
        answer = await self._token_request(
            {"grant_type": "refresh_token", "refresh_token": refresh_token}
        )
        return ConnectionSecret(self._credentials(answer.body, secret.values))

    async def check_grant(
        self, access_token: str, request: IssueRequest
    ) -> dict[str, Any]:
        if request.resources:
            raise ServiceAdapterError(
                f"A {self._name} grant reaches the whole connector; it names "
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
