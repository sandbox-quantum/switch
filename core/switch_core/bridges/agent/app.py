from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from switch_core.bridges.agent.api.handlers import router as api_router
from switch_core.bridges.agent.api.operations import router as operations_router
from switch_core.bridges.agent.api.version_routes import router as version_router
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.bridges.agent.deeplink import router as deeplink_router
from switch_core.bridges.agent.dependencies import init_dependencies
from switch_core.bridges.agent.mcp import create_mcp_app
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.request_tracker import RequestTracker
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.bridges.resource.tracker import ResourceRequestTracker
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
    request_tracker: RequestTracker,
    resource_request_tracker: ResourceRequestTracker,
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
        request_tracker=request_tracker,
        resource_request_tracker=resource_request_tracker,
        resource_service=resource_service,
        api_key_store=api_key_store,
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
        request_tracker=request_tracker,
        resource_request_tracker=resource_request_tracker,
        resource_service=resource_service,
        api_key_store=api_key_store,
        external_user_store=external_user_store,
        bridge_store=bridge_store,
        session_factory=session_factory,  # type: ignore[arg-type]
        config=config,
    )

    app = FastAPI(title="Switch Agent Bridge API")

    @app.exception_handler(HTTPException)
    async def log_http_exceptions(request: Request, exc: HTTPException) -> JSONResponse:
        if exc.status_code >= 400:
            logger.error(
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

    app.include_router(api_router, prefix="/agents", tags=["api"])
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
        session_factory=session_factory,  # type: ignore[arg-type]
    )

    return app, protocol
