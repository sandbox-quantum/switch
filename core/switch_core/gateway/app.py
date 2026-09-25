from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.server_connectors.lifecycle import (
    ServerSideConnectorLifecycleService,
)
from switch_core.bridges.collaboration.install_service import (
    MessagingInstallService,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.server_connector_store import ServerConnectorStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agent_sessions import router as agent_sessions_router
from switch_core.gateway.agents import router as agents_router
from switch_core.gateway.api_keys import router as api_keys_router
from switch_core.gateway.auth_routes import router as auth_router
from switch_core.gateway.collaborations import router as collaborations_router
from switch_core.gateway.connectors import router as connectors_router
from switch_core.gateway.dependencies import init_dependencies
from switch_core.gateway.documents import router as documents_router
from switch_core.gateway.ecosystem import router as ecosystem_router
from switch_core.gateway.github_connections import router as github_connections_router
from switch_core.gateway.hosted_controller import router as hosted_controller_router
from switch_core.gateway.hosted_launches import router as hosted_launches_router
from switch_core.gateway.messaging_installs import (
    router as messaging_installs_router,
)
from switch_core.gateway.oidc_routes import register_oidc_client
from switch_core.gateway.oidc_routes import router as oidc_router
from switch_core.gateway.packages import router as packages_router
from switch_core.gateway.provider_connections import (
    router as provider_connections_router,
)
from switch_core.gateway.provider_verifications import (
    router as provider_verifications_router,
)
from switch_core.gateway.references import router as references_router
from switch_core.gateway.room_groups import router as room_groups_router
from switch_core.gateway.room_links import router as room_links_router
from switch_core.gateway.rooms import router as rooms_router
from switch_core.gateway.templates import router as templates_router
from switch_core.gateway.tenants import router as tenants_router
from switch_core.providers.claude_verifier import ClaudeVerifier
from switch_core.providers.github import GitHubConnections
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.room_service import RoomService
from switch_core.sessions.errors import SessionError
from switch_core.sessions.http import session_error_response


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
    invitation_store: InvitationStore,
    template_store: TemplateStore,
    usage_store: UsageStore,
    budget_store: BudgetStore,
    resource_service: ResourceService,
    protocol: ProtocolService,
    install_service: MessagingInstallService | None,
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
        invitation_store=invitation_store,
        template_store=template_store,
        usage_store=usage_store,
        budget_store=budget_store,
        resource_service=resource_service,
        protocol=protocol,
        install_service=install_service,
        config=config,
    )

    app = FastAPI(title="Switch Gateway API")
    app.state.hosted_controller_settings = (
        HostedControllerSettings.model_validate_json(
            Path(config.hosted_controller_config_path).read_text()
        )
        if config.hosted_controller_config_path
        else None
    )
    if config.hosted_launch_capacity and (
        app.state.hosted_controller_settings is None
        or len(app.state.hosted_controller_settings.agent_ids)
        < config.hosted_launch_capacity
    ):
        raise ValueError(
            "Cloud launch capacity requires enough configured worker identities."
        )
    if config.hosted_idle_stop_minutes:
        raise ValueError(
            "HOSTED_IDLE_STOP_MINUTES is not supported yet: idle auto-stop needs session activity from the worker (WP3)."
        )
    app.include_router(hosted_launches_router, tags=["hosted-launches"])
    if (
        config.hosted_provider_verification_enabled
        and app.state.hosted_controller_settings is None
    ):
        raise ValueError("Provider verification requires a hosted controller.")
    app.include_router(hosted_controller_router, tags=["hosted-controller"])
    app.include_router(provider_verifications_router, tags=["provider-verifications"])
    app.state.github_connections = (
        GitHubConnections(config.hosted_github_config_path)
        if config.hosted_github_config_path
        else None
    )
    app.include_router(
        github_connections_router,
        tags=["provider-connections"],
    )
    app.state.claude_verifier = (
        ClaudeVerifier(config.hosted_claude_verifier_path)
        if config.hosted_claude_verifier_path
        else None
    )
    app.include_router(
        provider_connections_router,
        prefix="/provider-connections",
        tags=["provider-connections"],
    )

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

    app.add_exception_handler(SessionError, session_error_response)
    app.include_router(
        agent_sessions_router, prefix="/agent-sessions", tags=["session activity"]
    )
    app.include_router(auth_router, tags=["auth"])
    app.include_router(oidc_router, tags=["auth"])
    app.include_router(tenants_router, tags=["tenants"])
    app.include_router(rooms_router, prefix="/rooms", tags=["rooms"])
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
    app.include_router(templates_router, tags=["templates"])
    app.include_router(ecosystem_router, prefix="/ecosystem", tags=["ecosystem"])
    app.include_router(
        messaging_installs_router,
        prefix="/messaging-apps",
        tags=["messaging-apps"],
    )

    return app
