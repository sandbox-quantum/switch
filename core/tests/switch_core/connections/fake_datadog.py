"""A stand-in for Datadog's MCP sign-in, at each of its sites, as probed.

Each site is a Datadog of its own, with its own accounts, MCP server and
authorization server, and none knows another's clients or tokens:

- The MCP server at `https://mcp.<site>/v1/mcp` answers a request without a
  token 401, naming its resource metadata (RFC 9728), which names the MCP
  server itself as the authorization server. That server's metadata (RFC
  8414) is at `/.well-known/oauth-authorization-server/v1/mcp` on the MCP
  host, and its endpoints are on the site's app host: `app.<site>` for US1
  and EU1, the site itself for the others.
- A client registers itself as a public client (PKCE S256 required, the one
  scope `mcp_all`), the same name and redirects getting the same client id.
  A loopback redirect needs nothing more; any other is refused until the
  organization's admin allow-lists it (`allow_listed`).
- The consent page offers Full access or Limited access; the token's scope
  lists every permission given, `mcp_write` only with Full. Access tokens
  live 3,599 seconds; a refresh token is reused, never rotated; there is no
  revocation endpoint.
- The browser comes back with `site`, `domain`, `dd_oid` and `dd_org_name`
  beside the code and state.
- `/api/v2/current_user` on `api.<site>` names the user signed in.
- A person may make a personal access token (`pats`) or an API key and an
  application key (`keys`) at a site instead. The MCP server takes a token
  as a bearer, and keys in `DD_API_KEY` and `DD_APPLICATION_KEY`; it answers
  `initialize` 200 for any it knows and 401 for any other. `current_user`
  names the user for a token with `user_access_read`, and answers 403 for
  one without, and for keys in those headers.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx

from tests.switch_core.connections.fake_vendor import s256

SITES = (
    "datadoghq.com",
    "us3.datadoghq.com",
    "us5.datadoghq.com",
    "datadoghq.eu",
    "ap1.datadoghq.com",
    "ap2.datadoghq.com",
    "uk1.datadoghq.com",
)
READ_PERMISSIONS = ["mcp_read", "dashboards_read", "logs_read_data", "monitors_read"]
WRITE_PERMISSIONS = ["mcp_write", "dashboards_write", "monitors_write"]
LIFETIME = 3599


def _json(
    status: int, body: Any, headers: dict[str, str] | None = None
) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


@dataclass
class _Code:
    client_id: str
    redirect_uri: str
    challenge: str
    permissions: list[str]


class FakeDatadogSite:
    """Datadog at one site."""

    def __init__(self, site: str) -> None:
        self.site = site
        self.mcp_url = f"https://mcp.{site}/v1/mcp"
        app = f"app.{site}" if site in ("datadoghq.com", "datadoghq.eu") else site
        self.authorize_url = f"https://{app}/oauth2/v1/authorize"
        self.token_url = f"https://{app}/api/v2/oauth2/token"
        self.register_url = f"https://{app}/api/v2/oauth2/register"
        self.identity_url = f"https://api.{site}/api/v2/current_user"
        self.user = {
            "id": f"user-at-{site}",
            "email": "ada@example.test",
            "name": "Ada",
            "org": f"org-at-{site}",
            "org_name": "Example Org",
        }
        # Redirects other than loopback the organization's admin allowed.
        self.allow_listed: set[str] = set()
        # Registered clients, by id, with the redirects each listed.
        self.clients: dict[str, list[str]] = {}
        self.registrations: list[dict[str, Any]] = []
        self.authorizations: list[dict[str, str]] = []
        self.token_requests: list[dict[str, str]] = []
        self.codes: dict[str, _Code] = {}
        self.live_access: dict[str, list[str]] = {}
        # Personal access tokens made here, with their scopes.
        self.pats: dict[str, list[str]] = {}
        # API and application keys made here, as pairs.
        self.keys: set[tuple[str, str]] = set()
        self.live_refresh: dict[str, tuple[str, list[str]]] = {}
        self.paths: list[str] = []

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "issuer": self.mcp_url,
            "authorization_endpoint": self.authorize_url,
            "token_endpoint": self.token_url,
            "registration_endpoint": self.register_url,
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "scopes_supported": ["mcp_all"],
            "code_challenge_methods_supported": ["S256"],
            "pkce_required": True,
            "token_endpoint_auth_methods_supported": ["none"],
        }

    # ── The person, in their browser ─────────────────────────────────────────

    def authorize(self, url: str, *, full: bool) -> str:
        """Consent at `url`, with Full access or Limited; the redirect the
        browser is sent back to."""
        parts = urlsplit(url)
        assert f"{parts.scheme}://{parts.netloc}{parts.path}" == self.authorize_url
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        assert query["response_type"] == "code"
        assert query["code_challenge_method"] == "S256"
        assert query["scope"] == "mcp_all"
        assert query["client_id"] in self.clients
        self.authorizations.append(query)
        redirect = query["redirect_uri"]
        assert redirect in self.clients[query["client_id"]]
        if not redirect.startswith("http://127.0.0.1:"):
            assert redirect in self.allow_listed, f"{redirect} is not allow-listed"
        code = secrets.token_urlsafe(24)
        self.codes[code] = _Code(
            client_id=query["client_id"],
            redirect_uri=redirect,
            challenge=query["code_challenge"],
            permissions=READ_PERMISSIONS + (WRITE_PERMISSIONS if full else []),
        )
        return f"{redirect}?" + urlencode(
            {
                "code": code,
                "state": query["state"],
                "site": f"https://app.{self.site}",
                "domain": f"app.{self.site}",
                "dd_oid": self.user["org"],
                "dd_org_name": self.user["org_name"],
            }
        )

    # ── HTTP ─────────────────────────────────────────────────────────────────

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        where = f"{url.scheme}://{url.host}{url.path}"
        self.paths.append(where)
        mcp_origin = f"https://mcp.{self.site}"
        if where == f"{mcp_origin}/.well-known/oauth-protected-resource/v1/mcp":
            return _json(
                200,
                {
                    "resource": self.mcp_url,
                    "authorization_servers": [self.mcp_url],
                    "bearer_methods_supported": ["header"],
                },
            )
        if where in (
            f"{mcp_origin}/.well-known/oauth-authorization-server/v1/mcp",
            f"{mcp_origin}/.well-known/oauth-authorization-server",
        ):
            return _json(200, self.metadata)
        if where == self.mcp_url and request.method == "POST":
            if self._bearer(request) is None and not self._keyed(request):
                return _json(
                    401,
                    {"errors": ["Unauthorized"]},
                    {
                        "WWW-Authenticate": 'Bearer resource_metadata="'
                        f'{mcp_origin}/.well-known/oauth-protected-resource/v1/mcp"'
                    },
                )
            message = json.loads(request.content)
            return _json(200, {"jsonrpc": "2.0", "id": message.get("id"), "result": {}})
        if where == self.register_url and request.method == "POST":
            return self._register(json.loads(request.content))
        if where == self.token_url and request.method == "POST":
            return self._token(
                {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            )
        if where == self.identity_url and request.method == "GET":
            if self._keyed(request):
                return _json(403, {"errors": ["Forbidden"]})
            scopes = self._bearer(request)
            if scopes is None:
                return _json(401, {"errors": ["Unauthorized"]})
            if self._pat(request) is not None and "user_access_read" not in scopes:
                return _json(403, {"errors": ["Forbidden"]})
            return _json(
                200,
                {
                    "data": {
                        "type": "users",
                        "id": self.user["id"],
                        "attributes": {
                            "email": self.user["email"],
                            "name": self.user["name"],
                        },
                        "relationships": {
                            "org": {"data": {"type": "orgs", "id": self.user["org"]}}
                        },
                    }
                },
            )
        return _json(404, {"errors": ["Not found"]})

    def _bearer(self, request: httpx.Request) -> list[str] | None:
        """The scopes of the sign-in's access token, or the personal access
        token, the request carries; None for neither."""
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer "):
            return None
        token = header.removeprefix("Bearer ")
        return self.live_access.get(token, self.pats.get(token))

    def _pat(self, request: httpx.Request) -> str | None:
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        return token if token in self.pats else None

    def _keyed(self, request: httpx.Request) -> bool:
        return (
            request.headers.get("DD_API_KEY", ""),
            request.headers.get("DD_APPLICATION_KEY", ""),
        ) in self.keys

    def _register(self, body: dict[str, Any]) -> httpx.Response:
        self.registrations.append(body)
        if body.get("token_endpoint_auth_method") != "none":
            return _json(400, {"error": "invalid_client_metadata"})
        redirects = list(body.get("redirect_uris", []))
        # The same name and redirects are the same client.
        client_id = hashlib.sha256(
            json.dumps([self.site, body.get("client_name"), redirects]).encode()
        ).hexdigest()[:32]
        self.clients[client_id] = redirects
        return _json(
            201,
            {
                "client_id": client_id,
                "client_name": "Datadog Generic MCP Client",
                "redirect_uris": redirects,
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
                "scope": "mcp_all",
            },
        )

    def _mint(self, permissions: list[str], refresh: str | None) -> dict[str, Any]:
        access = f"synthetic_dd_access_{secrets.token_hex(8)}"
        self.live_access[access] = permissions
        return {
            "access_token": access,
            "token_type": "bearer",
            "expires_in": LIFETIME,
            "refresh_token": refresh,
            "scope": " ".join(permissions),
        }

    def _token(self, form: dict[str, str]) -> httpx.Response:
        self.token_requests.append(form)
        client_id = form.get("client_id", "")
        if client_id not in self.clients or "client_secret" in form:
            return _json(401, {"error": "invalid_client"})
        if form.get("grant_type") == "authorization_code":
            pending = self.codes.pop(form.get("code", ""), None)
            if (
                pending is None
                or pending.client_id != client_id
                or pending.redirect_uri != form.get("redirect_uri")
                or pending.challenge != s256(form.get("code_verifier", ""))
            ):
                return _json(400, {"error": "invalid_grant"})
            refresh = f"synthetic_dd_refresh_{secrets.token_hex(8)}"
            self.live_refresh[refresh] = (client_id, pending.permissions)
            return _json(200, self._mint(pending.permissions, refresh))
        if form.get("grant_type") == "refresh_token":
            refresh = form.get("refresh_token", "")
            held = self.live_refresh.get(refresh)
            if held is None or held[0] != client_id:
                return _json(400, {"error": "invalid_grant"})
            # Reused, not rotated: the same refresh token comes back.
            return _json(200, self._mint(held[1], refresh))
        return _json(400, {"error": "unsupported_grant_type"})


class FakeDatadog:
    """Datadog at every site; a request goes to the site whose host it names."""

    def __init__(self) -> None:
        self.sites = {site: FakeDatadogSite(site) for site in SITES}

    def __getitem__(self, site: str) -> FakeDatadogSite:
        return self.sites[site]

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))

    def _at(self, host: str) -> FakeDatadogSite:
        # The longest site a host names: `api.us3.datadoghq.com` is at
        # `us3.datadoghq.com`, not `datadoghq.com`.
        named = [
            site for site in self.sites if host == site or host.endswith(f".{site}")
        ]
        assert named, f"no Datadog site serves {host}"
        return self.sites[max(named, key=len)]

    def handle(self, request: httpx.Request) -> httpx.Response:
        return self._at(request.url.host).handle(request)

    def authorize(self, url: str, *, full: bool) -> str:
        return self._at(urlsplit(url).hostname or "").authorize(url, full=full)
