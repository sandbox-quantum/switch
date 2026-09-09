from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from switch_core.bridges.agent.api.handlers import router as api_router
from switch_core.bridges.agent.api.operations import router as operations_router
from switch_core.bridges.agent.api.version_routes import router as version_router
from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.bridges.agent.deeplink import router as deeplink_router
from switch_core.bridges.agent.dependencies import init_dependencies
from switch_core.bridges.agent.mcp import create_mcp_app
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.sessions.errors import (
    SessionApiError,
    code_for_status,
    is_session_path,
    session_api_error_handler,
    session_error_response,
)
from switch_core.bridges.agent.sessions.routes import router as sessions_router
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
from switch_core.room_service import RoomService

logger = logging.getLogger(__name__)


async def log_http_exceptions(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, HTTPException)
    if exc.status_code >= 400:
        logger.error(
            "%s %s → %d: %s",
            request.method,
            request.url.path,
            exc.status_code,
            exc.detail,
        )
    response: JSONResponse
    if is_session_path(request.url.path):
        response = session_error_response(
            code_for_status(exc.status_code),
            str(exc.detail),
            retryable=False,
            status_code=exc.status_code,
        )
    else:
        response = JSONResponse(
            status_code=exc.status_code, content={"detail": exc.detail}
        )
    # Registering this against Starlette's class displaces the built-in handler,
    # which carried these through. A 405's `Allow` and a 401's
    # `WWW-Authenticate` are part of the answer, not decoration.
    if exc.headers:
        response.headers.update(exc.headers)
    return response


async def log_validation_errors(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    logger.error(
        "%s %s → 422 validation: errors=%s body=%r",
        request.method,
        request.url.path,
        exc.errors(),
        exc.body,
    )
    if is_session_path(request.url.path):
        return session_error_response(
            "INVALID_REQUEST",
            f"The request body does not match the contract: {exc.errors()}",
            retryable=False,
            status_code=422,
        )
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


def install_exception_handlers(app: FastAPI) -> None:
    """The app's three failure shapes, registered together.

    Module-level rather than closures so a test can mount the same three on a
    router-sized app. The envelope a session path gets is decided here, and a
    test that registered its own approximation of these would pin nothing.
    """
    # Starlette's `HTTPException`, not FastAPI's subclass. Starlette dispatches
    # on the exact class, walking the raised type's MRO, so a handler registered
    # against the subclass never sees the router's own 404 and 405 — the parent
    # is what the router raises. Registering the parent catches both.
    app.add_exception_handler(HTTPException, log_http_exceptions)
    app.add_exception_handler(RequestValidationError, log_validation_errors)
    app.add_exception_handler(SessionApiError, session_api_error_handler)


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
    connections: ConnectionRegistry | None = None,
) -> tuple[FastAPI, ProtocolService]:
    # One registry for the whole process: the live connection set is the source
    # of truth for reachability, so every service must see the same one. The
    # caller may supply it — main.py does, because the Matrix agent clients are
    # wired before this app is built and read presence from the same registry.
    if connections is None:
        connections = ConnectionRegistry()

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
    )

    protocol = ProtocolService(
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
        session_factory=session_factory,  # type: ignore[arg-type]
        config=config,
    )

    app = FastAPI(title="Switch Agent Bridge API")
    install_exception_handlers(app)

    app.include_router(api_router, prefix="/agents", tags=["api"])
    app.include_router(operations_router)
    app.include_router(deeplink_router, tags=["deeplink"])
    app.include_router(version_router, tags=["version"])
    app.include_router(sessions_router, tags=["sessions"])

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
    )

    return app, protocol
