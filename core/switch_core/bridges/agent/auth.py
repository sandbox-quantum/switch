from __future__ import annotations

import hashlib
import logging

import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.db.models import Agent, ApiKey
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore

logger = logging.getLogger(__name__)


# Path prefixes that bypass the Bearer middleware entirely. These are either
# public (health, OAuth flow, external webhooks) or use their own auth scheme
# (gateway uses cookie-based JWT).
PUBLIC_PATH_PREFIXES: tuple[str, ...] = (
    "/health",
    "/.well-known",
    "/oauth",
    "/gateway",
    # Public switchdash:// deeplink HTTP redirect — followed by whoever clicks
    # the "Open in Switch Console" link in an external channel, so no bearer token.
    "/deeplink",
)


class OIDCTokenValidator:
    def __init__(
        self,
        issuer_url: str,
        audience: str | None = None,
        verify_issuer: bool = True,
    ) -> None:
        self._issuer = issuer_url
        self._audience = audience
        self._verify_issuer = verify_issuer
        jwks_url = f"{issuer_url}/protocol/openid-connect/certs"
        self._jwk_client = PyJWKClient(jwks_url, cache_keys=True)

    def validate(self, token: str) -> dict:
        signing_key = self._jwk_client.get_signing_key_from_jwt(token)
        options: dict[str, bool] = {}
        if self._audience is None:
            options["verify_aud"] = False
        if not self._verify_issuer:
            options["verify_iss"] = False
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=self._issuer if self._verify_issuer else None,
            audience=self._audience,
            options=options,  # type: ignore[arg-type]
        )


class BearerAuthMiddleware:
    """Authenticate requests carrying a Bearer token.

    Accepts three kinds of credentials:

    1. Agent API key — sets ``scope["agent"]`` and ``scope["agent_id"]``.
       Used by agent-bridge HTTP endpoints and MCP.
    2. OIDC token — validated against the configured issuer, mapped to an
       agent via the ``oauth_client_id`` field on Agent.
    3. Registration token — an ApiKey row of type ``"registration"`` that
       has no associated agent. Used by the registration endpoint
       (``POST /agents``). Sets ``scope["api_key"]`` so downstream
       handlers can validate it again.

    Public paths (see ``PUBLIC_PATH_PREFIXES``) bypass authentication
    entirely. The MCP path also requires an agent — registration tokens
    are not enough to open an MCP session.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        agent_store: AgentStore,
        api_key_store: ApiKeyStore,
        api_key_cache: ApiKeyCache,
        session_factory: async_sessionmaker[AsyncSession],
        oidc_validator: OIDCTokenValidator | None = None,
    ) -> None:
        self.app = app
        self._agent_store = agent_store
        self._api_key_store = api_key_store
        self._api_key_cache = api_key_cache
        self._session_factory = session_factory
        self._oidc_validator = oidc_validator

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")
        if _is_public_path(path):
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        auth_header = headers.get(b"authorization", b"").decode()

        if not auth_header.startswith("Bearer "):
            response = Response(
                "Missing or invalid Authorization header", status_code=401
            )
            await response(scope, receive, send)
            return

        token = auth_header[7:]

        # Single ApiKey lookup. If the row exists, branch on its type:
        # agent token → resolve to Agent; registration token → pass through.
        # If no row exists, fall through to OIDC (where applicable).
        api_key, agent = await self._resolve_api_key(token)

        if agent is None and api_key is None and self._oidc_validator is not None:
            agent = await self._try_oidc(token)

        if agent is not None:
            scope["agent"] = agent
            scope["agent_id"] = agent.id
            await self.app(scope, receive, send)
            return

        # Registration token: pass through (handler validates again). MCP rejects.
        if (
            api_key is not None
            and api_key.type == "registration"
            and not path.startswith("/mcp")
        ):
            scope["api_key"] = api_key
            await self.app(scope, receive, send)
            return

        response = Response("Invalid credentials", status_code=401)
        await response(scope, receive, send)

    async def _resolve_api_key(self, token: str) -> tuple[ApiKey | None, Agent | None]:
        """Look up the token in api_keys once; return (api_key_row, agent_or_None).

        ``agent`` is populated only when the row is an ``agent``-type key that
        resolves to an Agent. For registration tokens (or any key with no
        backing Agent), ``agent`` is ``None`` but ``api_key`` carries the row
        so the caller can decide what to do with it.

        A resolved agent is memoised for a few seconds (see
        :class:`ApiKeyCache`); everything else — an unknown token, a
        registration token, an agent key with no agent — always reads the
        database.
        """
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        cached = self._api_key_cache.get(token_hash)
        if cached is not None:
            return cached

        async with self._session_factory() as session:
            found = await self._api_key_store.get_with_agent_by_hash(
                session, token_hash
            )
            if found is None:
                return None, None
            api_key, agent = found
            if api_key.type != "agent":
                agent = None
            session.expunge_all()

        if agent is not None:
            self._api_key_cache.put(token_hash, api_key, agent)
        return api_key, agent

    async def _try_oidc(self, token: str) -> Agent | None:
        assert self._oidc_validator is not None
        try:
            claims = self._oidc_validator.validate(token)
        except Exception:
            logger.debug("OIDC token validation failed", exc_info=True)
            return None

        client_id = claims.get("azp") or claims.get("client_id")
        if client_id is None:
            logger.warning("OIDC token has no azp or client_id claim")
            return None

        async with self._session_factory() as session:
            return await self._agent_store.get_by_oauth_client_id(session, client_id)


def _is_public_path(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in PUBLIC_PATH_PREFIXES)


def get_agent_from_scope(request: Request) -> Agent:
    """Get authenticated agent from request scope (set by middleware)."""
    agent: object = request.scope.get("agent")
    if not isinstance(agent, Agent):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return agent
