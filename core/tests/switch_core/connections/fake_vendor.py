"""Stand-ins for a service's vendor, for adapter, broker and route tests.

`FakeVendor` plays a vendor as the broker sees it through `ServiceAdapter`:
refresh, check a grant, issue, revoke, all counted. `FakeOAuthServer` plays
the HTTP side of an OAuth vendor with MCP servers, for the generic OAuth/MCP
adapter to talk to: its metadata, authorization, token, registration,
revocation and account endpoints, and an MCP server that takes its tokens.
`FakeSites` plays one vendor at several sites, each a `FakeOAuthServer` of
its own, as a vendor with regional deployments is.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, unquote_plus, urlsplit

import httpx

from switch_core.connections.adapters import (
    AccessToken,
    ConnectionSecret,
    IssuedToken,
    IssueRequest,
)
from switch_core.connections.loader import AccessLevel


class FakeVendor:
    """GitHub as the broker sees it: refresh, issue, revoke, counted."""

    def __init__(self) -> None:
        self.can_issue = True
        self.read_only = False
        self.refreshes = 0
        self.refresh_error: Exception | None = None
        self.issue_error: Exception | None = None
        self.lifetime = timedelta(hours=1)
        self.refreshed_lifetime = timedelta(hours=8)
        self.revocable = True
        # Hands out the owner's own access token, as a pass-through vendor's
        # adapter does, rather than minting one.
        self.pass_through = False
        self.during_issue: Callable[[], Awaitable[None]] | None = None
        self.issued: list[tuple[str, str]] = []
        self.revoked: list[str] = []
        self.connections_revoked: list[ConnectionSecret] = []
        self.grant_error: Exception | None = None
        self.checked: list[tuple[str, dict[str, Any]]] = []
        self.resolved: list[list[str]] = []
        self.client_id: str | None = None

    def current_client_id(self, choices: Mapping[str, str]) -> str | None:
        return self.client_id

    async def refresh(self, secret: ConnectionSecret) -> ConnectionSecret:
        self.refreshes += 1
        # Wide enough that a second, unserialised refresh would start here.
        await asyncio.sleep(0.2)
        if self.refresh_error is not None:
            raise self.refresh_error
        return ConnectionSecret(
            {
                **secret.values,
                "access_token": f"gho_access_{self.refreshes}",
                "expires_at": time.time() + self.refreshed_lifetime.total_seconds(),
                "refresh_token": f"ghr_refresh_{self.refreshes}",
            }
        )

    async def issue(self, access: AccessToken, request: IssueRequest) -> IssuedToken:
        if self.during_issue is not None:
            await self.during_issue()
        if self.issue_error is not None:
            raise self.issue_error
        if self.pass_through:
            self.issued.append((access.token, access.token))
            return IssuedToken(
                token=access.token,
                expires_at=access.expires_at,
                resources={},
                revocable=self.revocable,
            )
        token = f"ghs_{uuid.uuid4().hex}"
        self.issued.append((access.token, token))
        return IssuedToken(
            token=token,
            expires_at=datetime.now(UTC) + self.lifetime,
            resources=dict(request.resources),
            revocable=self.revocable,
        )

    async def revoke_issued(self, token: str) -> None:
        self.revoked.append(token)

    async def revoke_connection(self, secret: ConnectionSecret) -> None:
        self.connections_revoked.append(secret)

    async def resolve_repositories(
        self, access_token: str, names: list[str]
    ) -> dict[str, Any]:
        """Every repository is reachable, in installation 123, numbered from
        456 in the order named."""
        self.resolved.append(list(names))
        return {
            "installation_id": 123,
            "repository_ids": [456 + i for i in range(len(names))],
        }

    async def check_grant(
        self, access_token: str, request: IssueRequest
    ) -> dict[str, Any]:
        if self.grant_error is not None:
            raise self.grant_error
        self.checked.append((access_token, dict(request.resources)))
        return dict(request.resources)

    def summary(
        self, agent_name: str, access: AccessLevel, resources: dict[str, Any]
    ) -> str:
        verb = "push to" if access == "write" else "read"
        count = len(resources.get("repository_ids", []))
        return f"{agent_name} can {verb} {count} repositories, as the GitHub App."


SITE = "example.test"
MCP_URL = f"https://mcp.{SITE}/v1/mcp"
ISSUER = f"https://auth.{SITE}"
IDENTITY_URL = f"https://api.{SITE}/me"
STATIC_CLIENT_ID = "example-client"
STATIC_CLIENT_SECRET = "SYNTHETIC-CLIENT-SECRET"
MCP_TOOLS = [
    {
        "name": "search_items",
        "description": "Search work items.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
    }
]


GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke"
GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
GOOGLE_SCOPE = "https://www.googleapis.com/auth/"


class FakeGoogle:
    """Google's OAuth side, as a Workspace sign-in was seen to behave.

    A refresh token comes only with `access_type=offline`; access tokens live
    3,599 s; scopes come back as full URLs (`email` as `userinfo.email`); a
    refresh returns no new refresh token; revoking any token ends every token
    of the sign-in. `unticked` are the scopes the person unticks at consent.
    """

    def __init__(self) -> None:
        self.client_id = STATIC_CLIENT_ID
        self.client_secret = STATIC_CLIENT_SECRET
        self.unticked: set[str] = set()
        self.authorizations: list[dict[str, str]] = []
        self.token_requests: list[dict[str, str]] = []
        self.revoked: list[dict[str, str]] = []
        self.codes: dict[str, _Code] = {}
        self.offline: dict[str, bool] = {}
        self.live_access: dict[str, list[str]] = {}
        self.live_refresh: dict[str, list[str]] = {}
        self.account = {"sub": "100000000000000000001", "email": "ada@example.test"}

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

    def authorize(self, url: str) -> str:
        parts = urlsplit(url)
        assert f"{parts.scheme}://{parts.netloc}{parts.path}" == GOOGLE_AUTHORIZE
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        assert query["client_id"] == self.client_id
        assert query["response_type"] == "code"
        assert query["code_challenge_method"] == "S256"
        self.authorizations.append(query)
        granted = [
            GOOGLE_SCOPE + "userinfo.email" if scope == "email" else scope
            for scope in query["scope"].split()
            if scope not in self.unticked
        ]
        code = secrets.token_urlsafe(16)
        self.codes[code] = _Code(
            client_id=query["client_id"],
            redirect_uri=query["redirect_uri"],
            challenge=query["code_challenge"],
            scopes=granted,
            resource=None,
        )
        self.offline[code] = query.get("access_type") == "offline"
        return f"{query['redirect_uri']}?state={query['state']}&code={code}&scope=x"

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        where = f"{url.scheme}://{url.host}{url.path}"
        form = (
            {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if request.method == "POST"
            else {}
        )
        if where == GOOGLE_TOKEN and request.method == "POST":
            return self._token(form)
        if where == GOOGLE_REVOKE and request.method == "POST":
            self.revoked.append(form)
            token = form.get("token", "")
            if token in self.live_refresh or token in self.live_access:
                self.live_refresh.clear()
                self.live_access.clear()
                return httpx.Response(200)
            return _json(400, {"error": "invalid_token"})
        if where == GOOGLE_USERINFO and request.method == "GET":
            header = request.headers.get("authorization", "")
            if header.removeprefix("Bearer ") not in self.live_access:
                return _json(401, {"error": "invalid_token"})
            return _json(200, {**self.account, "email_verified": True})
        return _json(404, {"error": "not_found"})

    def _mint(self, scopes: list[str], *, refresh: bool) -> dict[str, Any]:
        access = f"ya29.synthetic-{secrets.token_hex(8)}"
        self.live_access[access] = scopes
        body: dict[str, Any] = {
            "access_token": access,
            "expires_in": 3599,
            "token_type": "Bearer",
            "scope": " ".join(scopes),
            "id_token": "synthetic-id-token",
        }
        if refresh:
            token = f"1//synthetic-{secrets.token_hex(8)}"
            self.live_refresh[token] = scopes
            body["refresh_token"] = token
        return body

    def _token(self, form: dict[str, str]) -> httpx.Response:
        self.token_requests.append(form)
        if (form.get("client_id"), form.get("client_secret")) != (
            self.client_id,
            self.client_secret,
        ):
            return _json(401, {"error": "invalid_client"})
        if form.get("grant_type") == "authorization_code":
            code = form.get("code", "")
            pending = self.codes.pop(code, None)
            if (
                pending is None
                or pending.redirect_uri != form.get("redirect_uri")
                or pending.challenge != s256(form.get("code_verifier", ""))
            ):
                return _json(400, {"error": "invalid_grant"})
            return _json(200, self._mint(pending.scopes, refresh=self.offline[code]))
        if form.get("grant_type") == "refresh_token":
            scopes = self.live_refresh.get(form.get("refresh_token", ""))
            if scopes is None:
                return _json(400, {"error": "invalid_grant"})
            return _json(200, self._mint(scopes, refresh=False))
        return _json(400, {"error": "unsupported_grant_type"})


def s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


@dataclass
class _Code:
    client_id: str
    redirect_uri: str
    challenge: str
    scopes: list[str]
    resource: str | None


def _json(
    status: int, body: Any, headers: dict[str, str] | None = None
) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


class UnregisteredRedirect(AssertionError):
    """The vendor's authorization page refusing a redirect it does not know."""


class FakeOAuthServer:
    """An OAuth vendor with an MCP server, over `httpx.MockTransport`.

    Codes are checked against their PKCE challenge, redirect URI and client;
    rotating refresh tokens are spent on use, as the vendor's would be, and
    refresh only for the client they were issued to (RFC 6749 §6).
    `fail` answers a path with a fixed status and body, before anything else.

    The MCP server's metadata is where `resource_metadata_path` says, which
    its 401 names (`advertise`). A registered client signs in only on a
    redirect it registered, port included, and a public client is given a
    secret it never needs, as some vendors do. `register_as` registers a
    client to authenticate otherwise than it asked, and the answer leaves the
    method out unless `answer_names_method`.
    """

    def __init__(
        self, *, rotating: bool = True, lifetime: int = 3600, site: str = SITE
    ) -> None:
        self.rotating = rotating
        self.lifetime = lifetime
        # Where it answers: `mcp.<site>`, `auth.<site>` and `api.<site>`.
        self.site = site
        self.mcp_url = f"https://mcp.{site}/v1/mcp"
        self.issuer = f"https://auth.{site}"
        self.identity_url = f"https://api.{site}/me"
        self.resource_metadata_path = "/.well-known/oauth-protected-resource/v1/mcp"
        self.advertise = True
        # Some vendors issue long codes: Atlassian's run past 2,000 characters.
        self.code_length = 22
        # Clients by id, with their secret (None: a public client).
        self.clients: dict[str, str | None] = {STATIC_CLIENT_ID: STATIC_CLIENT_SECRET}
        # A registered client's redirects; the static client's are not checked.
        self.registered_redirects: dict[str, list[str]] = {}
        # How each registered client authenticates; the static client, any
        # way the metadata lists.
        self.registered_methods: dict[str, str] = {}
        self.register_as: str | None = None
        self.answer_names_method = True
        self.authorizations: list[dict[str, str]] = []
        self.registrations: list[dict[str, Any]] = []
        self.codes: dict[str, _Code] = {}
        self.live_access: dict[str, list[str]] = {}
        self.live_refresh: dict[str, list[str]] = {}
        # The client each refresh token was issued to.
        self.refresh_clients: dict[str, str] = {}
        self.spent_refresh: set[str] = set()
        self.token_requests: list[dict[str, str]] = []
        self.revoked: list[dict[str, str]] = []
        self.mcp_calls: list[dict[str, Any]] = []
        self.paths: list[str] = []
        self.fail: dict[str, tuple[int, Any]] = {}
        self.metadata: dict[str, Any] = {
            "issuer": self.issuer,
            "authorization_endpoint": f"{self.issuer}/authorize",
            "token_endpoint": f"{self.issuer}/token",
            "registration_endpoint": f"{self.issuer}/register",
            "revocation_endpoint": f"{self.issuer}/revoke",
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": [
                "client_secret_post",
                "client_secret_basic",
            ],
        }
        self.account: dict[str, Any] = {"id": "acct-1", "email": "ada@example.test"}

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

    # ── The person, in their browser ─────────────────────────────────────────

    def authorize(self, url: str) -> str:
        """Consent at `url`; the redirect the browser is sent back to."""
        parts = urlsplit(url)
        assert (
            f"{parts.scheme}://{parts.netloc}{parts.path}" == f"{self.issuer}/authorize"
        )
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        assert query["response_type"] == "code"
        assert query["code_challenge_method"] == "S256"
        assert query["client_id"] in self.clients
        self.authorizations.append(query)
        registered = self.registered_redirects.get(query["client_id"])
        if registered is not None and query["redirect_uri"] not in registered:
            raise UnregisteredRedirect(query["redirect_uri"])
        code = secrets.token_urlsafe(self.code_length)[: self.code_length]
        self.codes[code] = _Code(
            client_id=query["client_id"],
            redirect_uri=query["redirect_uri"],
            challenge=query["code_challenge"],
            scopes=query["scope"].split(),
            resource=query.get("resource"),
        )
        separator = "&" if "?" in query["redirect_uri"] else "?"
        return f"{query['redirect_uri']}{separator}code={code}&state={query['state']}"

    def mint(self, scopes: list[str], client_id: str) -> dict[str, Any]:
        access = f"vendor_access_{secrets.token_hex(8)}"
        refresh = f"vendor_refresh_{secrets.token_hex(8)}"
        self.live_access[access] = scopes
        self.live_refresh[refresh] = scopes
        self.refresh_clients[refresh] = client_id
        return {
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": self.lifetime,
            "refresh_token": refresh,
            "scope": " ".join(scopes),
        }

    # ── HTTP ─────────────────────────────────────────────────────────────────

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        where = f"{url.scheme}://{url.host}{url.path}"
        self.paths.append(where)
        if where in self.fail:
            status, body = self.fail[where]
            return _json(status, body)
        mcp_origin = f"https://mcp.{self.site}"
        if where == f"{mcp_origin}{self.resource_metadata_path}":
            return _json(
                200, {"resource": self.mcp_url, "authorization_servers": [self.issuer]}
            )
        if where == f"{mcp_origin}/.well-known/oauth-protected-resource":
            # Another, older server's on the same host.
            return _json(
                200,
                {
                    "resource": f"{mcp_origin}/v0",
                    "authorization_servers": [f"https://legacy.{self.site}"],
                },
            )
        if where == f"{self.issuer}/.well-known/oauth-authorization-server":
            return _json(200, self.metadata)
        if where == f"{self.issuer}/token" and request.method == "POST":
            return self._token(request)
        if where == f"{self.issuer}/register" and request.method == "POST":
            return self._register(request)
        if where == f"{self.issuer}/revoke" and request.method == "POST":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.revoked.append(form)
            self.live_refresh.pop(form.get("token", ""), None)
            return httpx.Response(200)
        if where == self.identity_url and request.method == "GET":
            if self._bearer(request) is None:
                return _json(401, {"error": "invalid_token"})
            return _json(200, {"account": self.account})
        if where == self.mcp_url:
            return self._mcp(request)
        return _json(404, {"error": "not_found"})

    def _bearer(self, request: httpx.Request) -> list[str] | None:
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            return None
        return self.live_access.get(header.removeprefix("Bearer "))

    def _client_ok(self, request: httpx.Request, form: dict[str, str]) -> bool:
        """A known client, with its secret where it has one, sent one way
        only: the way it registered, or for the static client one the
        metadata lists, Basic where it lists none (RFC 8414 §2)."""
        header = request.headers.get("authorization", "")
        basic: tuple[str, str] | None = None
        if header.startswith("Basic "):
            pair = base64.b64decode(header.removeprefix("Basic ")).decode()
            user, _, password = pair.partition(":")
            # Each half was form-urlencoded (RFC 6749 §2.3.1).
            basic = (unquote_plus(user), unquote_plus(password))
            if "client_secret" in form or form.get("client_id", basic[0]) != basic[0]:
                return False
        client_id = form.get("client_id") if basic is None else basic[0]
        if client_id not in self.clients:
            return False
        secret = self.clients[client_id]
        if secret is None:
            return True
        methods = (
            [self.registered_methods[client_id]]
            if client_id in self.registered_methods
            else self.metadata.get(
                "token_endpoint_auth_methods_supported", ["client_secret_basic"]
            )
        )
        if basic is not None:
            return "client_secret_basic" in methods and basic[1] == secret
        return "client_secret_post" in methods and form.get("client_secret") == secret

    def _token(self, request: httpx.Request) -> httpx.Response:
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        self.token_requests.append(form)
        if not self._client_ok(request, form):
            return _json(401, {"error": "invalid_client"})
        if form.get("grant_type") == "authorization_code":
            pending = self.codes.pop(form.get("code", ""), None)
            if (
                pending is None
                or pending.client_id != form["client_id"]
                or pending.redirect_uri != form.get("redirect_uri")
                or pending.challenge != s256(form.get("code_verifier", ""))
                or pending.resource != form.get("resource")
            ):
                return _json(400, {"error": "invalid_grant"})
            return _json(200, self.mint(pending.scopes, pending.client_id))
        if form.get("grant_type") == "refresh_token":
            refresh = form.get("refresh_token", "")
            scopes = self.live_refresh.get(refresh)
            if (
                scopes is None
                or refresh in self.spent_refresh
                or self.refresh_clients.get(refresh) != form["client_id"]
            ):
                return _json(400, {"error": "invalid_grant"})
            if self.rotating:
                self.spent_refresh.add(refresh)
                del self.live_refresh[refresh]
                return _json(200, self.mint(scopes, form["client_id"]))
            minted = self.mint(scopes, form["client_id"])
            del self.live_refresh[minted.pop("refresh_token")]
            return _json(200, minted)
        return _json(400, {"error": "unsupported_grant_type"})

    def _register(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.registrations.append(body)
        client_id = f"registered-{len(self.registrations)}-at-{self.site}"
        method = self.register_as or body.get(
            "token_endpoint_auth_method", "client_secret_basic"
        )
        secret = f"SYNTHETIC-REGISTERED-{secrets.token_hex(4)}"
        self.clients[client_id] = None if method == "none" else secret
        self.registered_methods[client_id] = method
        self.registered_redirects[client_id] = list(body.get("redirect_uris", []))
        # Issued even to a public client, which never needs it.
        answer = {
            **body,
            "client_id": client_id,
            "client_secret": secret,
            "token_endpoint_auth_method": method,
        }
        if not self.answer_names_method:
            del answer["token_endpoint_auth_method"]
        return _json(201, answer)

    def _mcp(self, request: httpx.Request) -> httpx.Response:
        if self._bearer(request) is None:
            named = f"https://mcp.{self.site}{self.resource_metadata_path}"
            return _json(
                401,
                {"error": "invalid_token"},
                {
                    "WWW-Authenticate": f'Bearer resource_metadata="{named}"'
                    if self.advertise
                    else "Bearer"
                },
            )
        message = json.loads(request.content)
        self.mcp_calls.append(message)
        method = message.get("method")
        if method == "initialize":
            result: dict[str, Any] = {
                "protocolVersion": message["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "example", "version": "1.0.0"},
            }
        elif method == "tools/list":
            result = {"tools": MCP_TOOLS}
        elif method == "tools/call":
            result = {"content": [{"type": "text", "text": "2 items found"}]}
        elif "id" not in message:
            return httpx.Response(202)
        else:
            return _json(
                200,
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {"code": -32601, "message": "Method not found"},
                },
            )
        return _json(200, {"jsonrpc": "2.0", "id": message["id"], "result": result})


class FakeSites:
    """One vendor at several sites: a `FakeOAuthServer` for each, each with
    its own MCP server, accounts and authorization server, and none knowing
    another's clients or tokens. A request goes to the site whose host it
    names."""

    def __init__(self, *sites: str) -> None:
        self.sites = {site: FakeOAuthServer(site=site) for site in sites}

    def __getitem__(self, site: str) -> FakeOAuthServer:
        return self.sites[site]

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

    def _at(self, host: str) -> FakeOAuthServer:
        # The longest site a host names: `api.eu.example.test` is at
        # `eu.example.test`, not `example.test`.
        named = [site for site in self.sites if host.endswith(f".{site}")]
        assert named, f"no site serves {host}"
        return self.sites[max(named, key=len)]

    def handle(self, request: httpx.Request) -> httpx.Response:
        return self._at(request.url.host).handle(request)

    def authorize(self, url: str) -> str:
        return self._at(urlsplit(url).hostname or "").authorize(url)
