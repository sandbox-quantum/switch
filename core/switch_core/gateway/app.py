from __future__ import annotations

from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.server_connectors.lifecycle import (
    ServerSideConnectorLifecycleService,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import router as agents_router
from switch_core.gateway.api_keys import router as api_keys_router
from switch_core.gateway.auth_routes import router as auth_router
from switch_core.gateway.collaborations import router as collaborations_router
from switch_core.gateway.connectors import router as connectors_router
from switch_core.gateway.dependencies import init_dependencies
from switch_core.gateway.documents import router as documents_router
from switch_core.gateway.ecosystem import router as ecosystem_router
from switch_core.gateway.engagements import router as engagements_router
from switch_core.gateway.oidc_routes import register_oidc_client
from switch_core.gateway.oidc_routes import router as oidc_router
from switch_core.gateway.packages import router as packages_router
from switch_core.gateway.references import router as references_router
from switch_core.gateway.room_groups import router as room_groups_router
from switch_core.gateway.room_links import router as room_links_router
from switch_core.gateway.rooms import router as rooms_router
from switch_core.room_service import RoomService


def create_gateway_app(
    *,
    agent_store: AgentStore,
    room_store: RoomStore,
    room_group_store: RoomGroupStore,
    room_service: RoomService,
    bridge_store: CollaborationBridgeStore,
    client_lifecycle: ClientLifecycleService,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    connector_lifecycle: ServerSideConnectorLifecycleService,
    connector_store: ServerConnectorStore,
    event_buffer: EventBuffer,
    session_factory: object,
    user_store: UserStore,
    external_user_store: ExternalUserStore,
    api_key_store: ApiKeyStore,
    resource_service: ResourceService,
    protocol: ProtocolService,
    config: SwitchConfig,
) -> FastAPI:
    init_dependencies(
        agent_store=agent_store,
        room_store=room_store,
        room_group_store=room_group_store,
        room_service=room_service,
        bridge_store=bridge_store,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        connector_lifecycle=connector_lifecycle,
        connector_store=connector_store,
        event_buffer=event_buffer,
        session_factory=session_factory,
        user_store=user_store,
        external_user_store=external_user_store,
        api_key_store=api_key_store,
        resource_service=resource_service,
        protocol=protocol,
        config=config,
    )

    app = FastAPI(title="Switch Gateway API")

    # authlib's OIDC client stores transient state/nonce/PKCE in the request
    # session across the IdP redirect round-trip; SameSite=Lax lets the cookie
    # survive the top-level GET navigation back to the callback. This cookie
    # (`session`) is separate from the `switch_auth` auth cookie.
    app.add_middleware(
        SessionMiddleware,
        secret_key=config.jwt_secret_key,
        same_site="lax",
        max_age=600,
    )
    if config.gateway_oidc_enabled:
        register_oidc_client(config)

    app.include_router(auth_router, tags=["auth"])
    app.include_router(oidc_router, tags=["auth"])
    app.include_router(rooms_router, prefix="/rooms", tags=["rooms"])
    app.include_router(engagements_router, prefix="/engagements", tags=["engagements"])
    app.include_router(room_groups_router, prefix="/room-groups", tags=["room-groups"])
    app.include_router(agents_router, prefix="/agents", tags=["agents"])
    app.include_router(
        collaborations_router, prefix="/collaborations", tags=["collaborations"]
    )
    app.include_router(connectors_router, prefix="/connectors", tags=["connectors"])
    app.include_router(api_keys_router, prefix="/api-keys", tags=["api-keys"])
    app.include_router(references_router, tags=["references"])
    app.include_router(room_links_router, tags=["linked-rooms"])
    app.include_router(documents_router, tags=["documents"])
    app.include_router(packages_router, tags=["packages"])
    app.include_router(ecosystem_router, prefix="/ecosystem", tags=["ecosystem"])

    return app
