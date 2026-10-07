from __future__ import annotations

import logging
import re
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from switch_core.bridges.agent.api.activity_routes import router as activity_router
from switch_core.bridges.agent.api.handlers import router as api_router
from switch_core.bridges.agent.api.hosted_routes import router as hosted_router
from switch_core.bridges.agent.api.operations import router as operations_router
from switch_core.bridges.agent.api.version_routes import router as version_router
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import (
    BearerAuthMiddleware,
    ControllerAuthenticator,
)
from switch_core.bridges.agent.deeplink import router as deeplink_router
from switch_core.bridges.agent.dependencies import get_protocol, init_dependencies
from switch_core.bridges.agent.mcp import create_mcp_app
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.task_store import TaskStore
from switch_core.logging_context import log_context
from switch_core.observability.http import MetricsMiddleware
from switch_core.request_context import RequestContextMiddleware
from switch_core.room_service import RoomService
from switch_core.session_activity.outcomes import ApprovalOutcomes
from switch_core.sessions.errors import SessionError
from switch_core.sessions.http import session_error_response
from switch_core.telemetry import TelemetryService

logger = logging.getLogger(__name__)


def create_agent_bridge_app(
    *,
    agent_store: AgentStore,
    agent_session_store: AgentSessionStore,
    room_store: RoomStore,
    room_service: RoomService,
    client_lifecycle: ClientLifecycleService,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    event_buffer: EventBuffer,
    task_store: TaskStore,
    resource_service: ResourceService,
    api_key_store: ApiKeyStore,
    external_user_store: ExternalUserStore,
    bridge_store: CollaborationBridgeStore,
    session_factory: object,
    config: SwitchConfig,
    approval_outcomes: ApprovalOutcomes,
    controller_auth: ControllerAuthenticator | None,
    connections: AgentConnectionRegistry | None = None,
    telemetry: TelemetryService | None = None,
) -> tuple[FastAPI, AgentCore]:
    # One registry for the whole process: the live connection set is the source
    # of truth for reachability, so every service must see the same one. The
    # caller may supply it, and main.py does, because the agent clients are
    # wired before this app is built and read presence from the same registry.
    if connections is None:
        connections = AgentConnectionRegistry()

    # One cache for the whole process, for the same reason as `connections`:
    # the HTTP door and the MCP door each carry their own auth middleware, and
    # a rotated key must stop working on both the moment it is rotated.
    api_key_cache = ApiKeyCache(
        ttl_seconds=config.agent_auth_cache_ttl_seconds,
        max_entries=config.agent_auth_cache_max_entries,
    )

    init_dependencies(
        agent_store=agent_store,
        agent_session_store=agent_session_store,
        room_store=room_store,
        room_service=room_service,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        event_buffer=event_buffer,
        connections=connections,
        task_store=task_store,
        resource_service=resource_service,
        api_key_store=api_key_store,
        api_key_cache=api_key_cache,
        external_user_store=external_user_store,
        bridge_store=bridge_store,
        session_factory=session_factory,
        config=config,
        approval_outcomes=approval_outcomes,
        telemetry=telemetry,
    )

    # The one `init_dependencies` just built, not a second of its own. Every
    # HTTP handler resolves that instance through `Depends(get_protocol)`, so
    # a second one here is an object whose wiring no request ever sees — which
    # is how the agent bridge came to emit every session event into a
    # telemetry service that was None.
    protocol = get_protocol()

    app = FastAPI(title="Switch Agent Bridge API")

    app.exception_handler(HTTPException)(log_http_exceptions)

    @app.exception_handler(RequestValidationError)
    async def log_validation_errors(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        logger.error(
            "%s %s → 422 validation: errors=%s body=%r",
            request.method,
            request.url.path,
            exc.errors(),
            exc.body,
        )
        return JSONResponse(status_code=422, content={"detail": exc.errors()})

    app.add_exception_handler(SessionError, session_error_response)
    app.include_router(activity_router, tags=["session activity"])
    app.include_router(api_router, prefix="/agents", tags=["api"])
    app.include_router(hosted_router, tags=["hosted"])
    app.include_router(operations_router)
    app.include_router(deeplink_router, tags=["deeplink"])
    app.include_router(version_router, tags=["version"])

    app.state.config = config

    mcp_asgi, mcp_lifespan = create_mcp_app(
        agent_store=agent_store,
        api_key_store=api_key_store,
        protocol=protocol,
        config=config,
    )
    app.mount("/mcp", mcp_asgi)
    app.router.lifespan_context = mcp_lifespan

    app.add_middleware(
        BearerAuthMiddleware,
        agent_store=agent_store,
        api_key_store=api_key_store,
        api_key_cache=api_key_cache,
        session_factory=session_factory,  # type: ignore[arg-type]
        controller_auth=controller_auth,
    )
    # Outside the bearer middleware, so a request rejected for bad credentials
    # is still counted and timed — an authentication failure is traffic, and a
    # spike of it is the thing you most want a dashboard to show.
    app.add_middleware(MetricsMiddleware)
    # Outside the bearer middleware: a browser carries no bearer token, and
    # would otherwise be answered 401 for an old link to an agent page.
    app.add_middleware(LegacyAgentPageRedirectMiddleware)
    # Tags every log line of an agent request as the agent bridge's, as a
    # field. Only agent paths: the gateway is mounted on this same app.
    app.add_middleware(AgentBridgeLogContextMiddleware)
    # Added last, so it wraps the bearer middleware: a request rejected for bad
    # credentials is logged with a request id like any other.
    app.add_middleware(RequestContextMiddleware)

    return app, protocol


async def log_http_exceptions(request: Request, exc: HTTPException) -> JSONResponse:
    if exc.status_code >= 400:
        # A 4xx is the caller's mistake or an expected refusal; only a 5xx is
        # the bridge's own failure.
        logger.log(
            logging.ERROR if exc.status_code >= 500 else logging.WARNING,
            "%s %s → %d: %s",
            request.method,
            request.url.path,
            exc.status_code,
            exc.detail,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


class LegacyAgentPageRedirectMiddleware:
    """Sends a browser following an old `/agents[/<id>]` page link to the
    gateway's agent directory.

    On a shared origin the ingress routes `/agents` here, to the agent API, so
    the gateway's former agent pages are unreachable by URL. Only a page load
    is redirected — a GET that accepts HTML and carries no Authorization
    header — which no agent API client sends.
    """

    _PAGE = re.compile(r"/agents(?:/(?P<agent_id>[^/]+))?/?")

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        target = self._redirect_target(scope)
        if target is None:
            await self.app(scope, receive, send)
            return
        await RedirectResponse(target, status_code=302)(scope, receive, send)

    def _redirect_target(self, scope: Scope) -> str | None:
        if scope["type"] != "http" or scope["method"] not in ("GET", "HEAD"):
            return None
        match = self._PAGE.fullmatch(scope["path"])
        if match is None:
            return None
        headers = dict(scope["headers"])
        if b"authorization" in headers:
            return None
        if b"text/html" not in headers.get(b"accept", b""):
            return None
        agent_id = match.group("agent_id")
        if agent_id is None:
            return "/agent-directory"
        return f"/agent-directory/{quote(agent_id, safe='')}"


class AgentBridgeLogContextMiddleware:
    """Binds `bridge="agent"` for requests to the agent bridge's own paths.

    Pure ASGI rather than `BaseHTTPMiddleware`, so the binding covers a
    streamed response (the SSE stream) for as long as it runs, and is reset in
    the same context it was set in.
    """

    _PREFIXES = ("/agents", "/mcp")

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "") if scope["type"] in ("http", "websocket") else ""
        if not path.startswith(self._PREFIXES):
            await self.app(scope, receive, send)
            return
        with log_context(bridge="agent"):
            await self.app(scope, receive, send)
