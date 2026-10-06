from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from typing import Protocol

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.controller_auth_cache import ControllerAuthCache
from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.bridges.agent.registration_bootstrap import REGISTRATION_KEY_TYPES
from switch_core.bridges.collaboration.install import (
    PUBLIC_PATH_PREFIX as MESSAGING_INSTALL_PREFIX,
)
from switch_core.db.models import Agent, ApiKey
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.tenant_lookup import tenant_of_api_key
from switch_core.logging_context import log_context
from switch_core.tenant_context import tenant_scope

logger = logging.getLogger(__name__)


# Path prefixes that bypass the Bearer middleware entirely. These are either
# public (health, external webhooks) or use their own auth scheme (gateway
# uses cookie-based JWT).
PUBLIC_PATH_PREFIXES: tuple[str, ...] = (
    "/health",
    "/gateway",
    # Public switchdash:// deeplink HTTP redirect — followed by whoever clicks
    # the "Open in Switch Console" link in an external channel, so no bearer token.
    "/deeplink",
    # Workspace installs of the distributed messaging apps: the OAuth callback
    # and the platforms' event webhooks. Unauthenticated by nature — an inbound
    # Slack event carries no credential of ours — so each route proves its own
    # origin from the platform's signature before it does anything else.
    MESSAGING_INSTALL_PREFIX,
    # A cloud machine's supervisor, which holds a machine capability rather
    # than an agent key; the routes check the capability themselves.
    "/hosted/machines",
)


# The contract's reason codes this module answers with. Named here rather than
# imported, because Core does not import the management module that owns the
# full list (`management/reason_codes.py` carries the same strings).
NOT_ASSIGNED = "not_assigned"
MANAGED_BY_CONTROLLER = "managed_by_controller"
FORBIDDEN = "forbidden"
VALIDATION_ERROR = "validation_error"

AGENT_ID_HEADER = b"x-switch-agent-id"

# Agent routes a controller acts as an agent on: everything under
# `/agents/{agent_id}/` and `/agent-sessions/`.
_AGENT_PATH = re.compile(r"/agents/(?P<segment>[^/]+)(?P<rest>/.*)?")
_AGENT_SESSIONS_PREFIX = "/agent-sessions/"
# Registration: a controller registers nothing, so its token is refused here.
_REGISTRATION_SEGMENTS = frozenset({"register-known", "register-known-bulk"})
# The connection surface a controller serves its agents itself, from its own
# stream (`GET /v1/controllers/{id}/events`). A controller-backed agent has no
# connection of its own, and the legacy heartbeats would make it look live from
# a second source.
_SERVED_ON_THE_CONTROLLER_STREAM = re.compile(
    r"/(events|connection/.*|watch/heartbeat)"
)


@dataclass(frozen=True)
class ControllerPrincipal:
    """An authenticated agent controller, as ``scope["controller"]`` carries it."""

    controller_id: str
    owner_id: str
    tenant_id: str


class ControllerAuthError(Exception):
    """A controller credential was refused; ``code`` is a contract reason code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ControllerAuthenticator(Protocol):
    """The agent-management side of bearer authentication.

    Supplied only when agent management is enabled. The middleware asks it
    which paths it owns and hands it their tokens: what a controller token
    is, and which of its routes authenticate by their body instead, belong to
    the management module.

    `presence` is Core's own record of which controller runs which agent,
    which Management keeps current. The middleware reads it to let a
    controller act as the agents bound to it, and to keep a controller-backed
    agent's own credential out.

    `auth_cache` memoises the rows a controller token makes the server read,
    and is kept in step with `presence`.
    """

    @property
    def presence(self) -> ControllerPresence: ...

    @property
    def auth_cache(self) -> ControllerAuthCache: ...

    def handles(self, path: str) -> bool: ...

    def is_public(self, path: str) -> bool: ...

    def is_controller_token(self, token: str) -> bool: ...

    async def authenticate(self, token: str) -> ControllerPrincipal: ...


class BearerAuthMiddleware:
    """Authenticate requests carrying a Bearer token.

    Accepts two kinds of credentials:

    1. Agent API key — sets ``scope["agent"]`` and ``scope["agent_id"]``.
       Used by the agent-bridge HTTP endpoints.
    2. Registration token — an ApiKey row of type ``"registration"`` or
       ``"bootstrap"`` (see ``registration_bootstrap.py``) that has no
       associated agent. Used by the registration endpoint
       (``POST /agents``). Sets ``scope["api_key"]`` so downstream
       handlers can validate it again.

    Public paths (see ``PUBLIC_PATH_PREFIXES``) bypass authentication
    entirely.

    With agent management enabled, a ``ControllerAuthenticator`` owns the
    controller paths outright: their tokens are controller access tokens and
    nothing else, the principal lands in ``scope["controller"]``, and a refusal
    is answered in the controller contract's error envelope.

    A controller access token is also accepted on the agent routes, acting as
    one agent bound to that controller (``_serve_act_as``), and a
    controller-backed agent's own credential is refused everywhere: a
    controller is the one way in for the agents it runs.

    This is where a request's tenant gets bound (see
    ``switch_core.tenant_context``), for every credential — registration
    tokens included, since the request one of those carries is the request
    that *creates* the rows every later request is authenticated against.

    A middleware rather than a FastAPI dependency: this class runs ahead of
    routing and dependency injection entirely, so there is no ordering
    question about whether a downstream ``get_session`` might query before the
    tenant is known — it cannot, since it does not run until after
    ``self.app(...)`` is called below. The lookup that resolves the credential
    itself (``_resolve_api_key``) runs ahead of that, on sessions of its own,
    and in two steps: the credential's *tenant* comes from one of the
    ``SECURITY DEFINER`` lookups that are the
    whole exemption from row-level security (``db/tenant_lookup.py``), and the
    row itself is then read with that tenant bound, subject to the same
    policies as everything else.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        agent_store: AgentStore,
        api_key_store: ApiKeyStore,
        api_key_cache: ApiKeyCache,
        session_factory: async_sessionmaker[AsyncSession],
        controller_auth: ControllerAuthenticator | None = None,
    ) -> None:
        self.app = app
        self._agent_store = agent_store
        self._api_key_store = api_key_store
        self._api_key_cache = api_key_cache
        self._session_factory = session_factory
        self._controller_auth = controller_auth

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

        if self._controller_auth is not None and self._controller_auth.handles(path):
            await self._serve_controller(
                self._controller_auth, path, auth_header, scope, receive, send
            )
            return

        if not auth_header.startswith("Bearer "):
            response = Response(
                "Missing or invalid Authorization header", status_code=401
            )
            await response(scope, receive, send)
            return

        token = auth_header[7:]

        if (
            self._controller_auth is not None
            and self._controller_auth.is_controller_token(token)
        ):
            if _is_agent_route(path):
                await self._serve_act_as(
                    self._controller_auth, path, headers, token, scope, receive, send
                )
                return
            await _controller_refusal(
                FORBIDDEN, "A controller access token is not accepted here.", 403
            )(scope, receive, send)
            return

        # Single ApiKey lookup. If the row exists, branch on its type:
        # agent token → resolve to Agent; registration token → pass through.
        api_key, agent = await self._resolve_api_key(token)

        if agent is not None and api_key is not None:
            if (
                self._controller_auth is not None
                and self._controller_auth.presence.is_bound(agent.id)
            ):
                await _controller_refusal(
                    MANAGED_BY_CONTROLLER,
                    f"Agent {agent.id} is run by an agents controller, which acts "
                    "for it; its own credential is not accepted while it is.",
                    409,
                )(scope, receive, send)
                return
            scope["agent"] = agent
            scope["agent_id"] = agent.id
            # api_key.tenant_id is the source of truth (docs/old/
            # multi-tenancy-phase1-db.md, "Setting the tenant").
            tenant_id = api_key.tenant_id
            with (
                tenant_scope(tenant_id),
                log_context(agent_id=agent.id, tenant_id=tenant_id),
            ):
                await self.app(scope, receive, send)
            return

        # Registration token: pass through (handler validates again).
        if api_key is not None and api_key.type in REGISTRATION_KEY_TYPES:
            scope["api_key"] = api_key
            # The endpoints this reaches *insert* the `api_keys` and `agents`
            # rows a later request will be authenticated against, and the
            # branch above then treats `api_keys.tenant_id` as the source of
            # truth. Registering with no tenant bound would land those rows in
            # tenant zero by fallback and make that wrong answer permanent and
            # self-confirming — so bind the token's own tenant here, exactly
            # as an agent key does.
            with (
                tenant_scope(api_key.tenant_id),
                log_context(tenant_id=api_key.tenant_id),
            ):
                await self.app(scope, receive, send)
            return

        response = Response("Invalid credentials", status_code=401)
        await response(scope, receive, send)

    async def _serve_controller(
        self,
        controller_auth: ControllerAuthenticator,
        path: str,
        auth_header: str,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if controller_auth.is_public(path):
            await self.app(scope, receive, send)
            return
        if not auth_header.startswith("Bearer "):
            await _controller_refusal(
                "invalid_credential", "Missing or invalid Authorization header", 401
            )(scope, receive, send)
            return
        try:
            principal = await controller_auth.authenticate(auth_header[7:])
        except ControllerAuthError as exc:
            await _controller_refusal(exc.code, exc.message, 401)(scope, receive, send)
            return
        scope["controller"] = principal
        with (
            tenant_scope(principal.tenant_id),
            log_context(tenant_id=principal.tenant_id, user_id=principal.owner_id),
        ):
            await self.app(scope, receive, send)

    async def _serve_act_as(
        self,
        controller_auth: ControllerAuthenticator,
        path: str,
        headers: dict[bytes, bytes],
        token: str,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        """A controller acting as one of its agents on an agent route.

        The agent comes from the path, or from `X-Switch-Agent-Id` where the
        path names none; both present and different is refused. It must be
        bound to this controller now: Management's binding is the whole of
        the authorization, checked here once so that no handler has to. The
        handlers then see the agent in `scope["agent"]`, exactly as an agent's
        own key would leave it, and the controller in `scope["controller"]`.

        Nothing here touches the API-key cache, which maps a token to one
        agent. A controller token is verified on every request; its
        controller and the agent row come from the controller-token cache
        when it holds them, which forgets a controller the moment it is
        revoked and an agent the moment its binding changes. The binding
        itself is checked against `presence` every time.
        """
        try:
            principal = await controller_auth.authenticate(token)
        except ControllerAuthError as exc:
            await _controller_refusal(exc.code, exc.message, 401)(scope, receive, send)
            return

        header = headers.get(AGENT_ID_HEADER, b"").decode() or None
        path_agent, rest = _path_agent(path)
        if header is not None and path_agent is not None and header != path_agent:
            await _controller_refusal(
                VALIDATION_ERROR,
                f"X-Switch-Agent-Id names agent {header} but the path names "
                f"agent {path_agent}.",
                400,
            )(scope, receive, send)
            return
        agent_id = path_agent or header
        if agent_id is None:
            await _controller_refusal(
                VALIDATION_ERROR,
                "Name the agent this controller is acting as with X-Switch-Agent-Id.",
                400,
            )(scope, receive, send)
            return

        binding = controller_auth.presence.binding(agent_id)
        if (
            binding is None
            or binding.controller_id != principal.controller_id
            or binding.tenant_id != principal.tenant_id
        ):
            await _controller_refusal(
                NOT_ASSIGNED,
                f"Agent {agent_id} is not assigned to this controller.",
                403,
            )(scope, receive, send)
            return

        if path_agent is not None and _SERVED_ON_THE_CONTROLLER_STREAM.fullmatch(rest):
            await _controller_refusal(
                MANAGED_BY_CONTROLLER,
                "A controller receives its agents' events on its own stream, "
                "GET /v1/controllers/{id}/events; this agent route is not "
                "served to it.",
                409,
            )(scope, receive, send)
            return

        auth_cache = controller_auth.auth_cache
        agent = auth_cache.agent(principal.tenant_id, agent_id)
        if agent is None:
            generation = auth_cache.generation
            async with tenant_session(
                self._session_factory, principal.tenant_id
            ) as session:
                agent = await self._agent_store.get(session, agent_id)
                if agent is not None:
                    session.expunge(agent)
            if agent is not None:
                auth_cache.put_agent(principal.tenant_id, agent, generation)
        if agent is None:
            await _controller_refusal(
                NOT_ASSIGNED, f"Agent {agent_id} does not exist.", 403
            )(scope, receive, send)
            return

        scope["agent"] = agent
        scope["agent_id"] = agent.id
        scope["controller"] = principal
        with (
            tenant_scope(principal.tenant_id),
            log_context(agent_id=agent.id, tenant_id=principal.tenant_id),
        ):
            await self.app(scope, receive, send)

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

        # Two steps, because a credential's tenant has to be known before its
        # row can be read. `api_keys` is scoped like everything else, so a
        # session with nothing bound reads nothing from it — this used to be a
        # single unbound read, and under the restricted runtime role it failed
        # on every request that missed the cache. The hash is resolved to a
        # tenant through the `SECURITY DEFINER` exemption
        # (`db/tenant_lookup.py`), which answers with a tenant id and nothing
        # else, and the row itself is then read the ordinary scoped way.
        #
        # An unknown token resolves to no tenant and stops here, without a
        # second round trip — which is also the shape that matters for load,
        # since an unauthenticated flood never reaches the second query.
        tenant_id = await tenant_of_api_key(self._session_factory, token_hash)
        if tenant_id is None:
            return None, None

        async with tenant_session(self._session_factory, tenant_id) as session:
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


def _controller_refusal(code: str, message: str, status_code: int) -> Response:
    return JSONResponse(
        {"error": {"code": code, "message": message, "retryable": False}},
        status_code=status_code,
    )


def _is_agent_route(path: str) -> bool:
    if path.startswith(_AGENT_SESSIONS_PREFIX):
        return True
    match = _AGENT_PATH.fullmatch(path)
    return match is not None and match["segment"] not in _REGISTRATION_SEGMENTS


def _path_agent(path: str) -> tuple[str | None, str]:
    """The agent an agent route's path names, if any, and the rest of the path."""
    match = _AGENT_PATH.fullmatch(path)
    if match is None:
        return None, ""
    return match["segment"], match["rest"] or ""


def _is_public_path(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in PUBLIC_PATH_PREFIXES)


def get_agent_from_scope(request: Request) -> Agent:
    """Get authenticated agent from request scope (set by middleware)."""
    agent: object = request.scope.get("agent")
    if not isinstance(agent, Agent):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return agent
