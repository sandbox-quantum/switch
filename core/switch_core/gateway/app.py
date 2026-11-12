from __future__ import annotations

from collections.abc import Callable

from fastapi import Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.middleware.sessions import SessionMiddleware

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.collaboration.install_service import (
    MessagingInstallService,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.resource.service import ResourceService
from switch_core.chats.service import ChatError, ChatService
from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.config import SwitchConfig
from switch_core.connections.app_credentials import ConnectorApps, install_github_app
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.budget_store import BudgetStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.join_domain_store import JoinDomainStore
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.template_store import TemplateStore
from switch_core.db.stores.usage_store import UsageStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agent_sessions import router as agent_sessions_router
from switch_core.gateway.agents import router as agents_router
from switch_core.gateway.api_keys import router as api_keys_router
from switch_core.gateway.auth_routes import router as auth_router
from switch_core.gateway.changes import router as changes_router
from switch_core.gateway.chats import chat_error_response
from switch_core.gateway.chats import router as chats_router
from switch_core.gateway.cloud_files import router as cloud_files_router
from switch_core.gateway.collaborations import router as collaborations_router
from switch_core.gateway.connection_catalog import router as connection_catalog_router
from switch_core.gateway.connector_apps import router as connector_apps_router
from switch_core.gateway.decision_settings import router as decision_settings_router
from switch_core.gateway.dependencies import init_dependencies
from switch_core.gateway.documents import router as documents_router
from switch_core.gateway.ecosystem import router as ecosystem_router
from switch_core.gateway.feature_flags import router as feature_flags_router
from switch_core.gateway.github_connections import router as github_connections_router
from switch_core.gateway.hosted_controller import router as hosted_controller_router
from switch_core.gateway.hosted_machines import router as hosted_machines_router
from switch_core.gateway.hosted_provisioner import router as hosted_provisioner_router
from switch_core.gateway.invite_mail import InviteMailer
from switch_core.gateway.messaging_installs import (
    router as messaging_installs_router,
)
from switch_core.gateway.oidc_routes import register_oidc_client
from switch_core.gateway.oidc_routes import router as oidc_router
from switch_core.gateway.organization_connector_apps import (
    router as organization_connector_apps_router,
)
from switch_core.gateway.organization_services import (
    router as organization_services_router,
)
from switch_core.gateway.organizations import router as organizations_router
from switch_core.gateway.origin_check import (
    OriginCheckMiddleware,
    allowed_origins,
    log_origin_setup,
)
from switch_core.gateway.ownership import router as ownership_router
from switch_core.gateway.packages import router as packages_router
from switch_core.gateway.providers import router as providers_router
from switch_core.gateway.references import router as references_router
from switch_core.gateway.room_groups import router as room_groups_router
from switch_core.gateway.room_links import router as room_links_router
from switch_core.gateway.rooms import router as rooms_router
from switch_core.gateway.service_connections import (
    router as service_connections_router,
)
from switch_core.gateway.service_flows import router as service_flows_router
from switch_core.gateway.teams_placements import router as teams_placements_router
from switch_core.gateway.template_runs import router as template_runs_router
from switch_core.gateway.templates import router as templates_router
from switch_core.gateway.tenants import router as tenants_router
from switch_core.gateway.trust_settings import router as trust_settings_router
from switch_core.gateway.workos_sign_in_routes import (
    router as workos_sign_in_router,
)
from switch_core.gateway.workspace_services import (
    router as workspace_services_router,
)
from switch_core.hosted_v2 import require_hosted_v2, set_process_hosted_v2
from switch_core.keys import Purpose
from switch_core.organization_directory import OrganizationDirectory
from switch_core.providers.hosted import (
    load_hosted_settings,
    log_operator_overlaps,
    warn_if_open_to_all,
)
from switch_core.request_validation import validation_error_response
from switch_core.room_service import RoomService
from switch_core.sessions.errors import SessionError
from switch_core.sessions.http import session_error_response
from switch_core.user_changes import LocalUserChanges
from switch_core.visibility.audit_routes import router as operator_audit_router
from switch_core.visibility.dependencies import (
    load_keyed_id_key,
    set_process_keyed_id_key,
)
from switch_core.visibility.hosted_access_routes import router as hosted_access_router
from switch_core.visibility.hosted_usage import router as hosted_usage_router
from switch_core.visibility.operator_action_routes import (
    router as operator_action_router,
)
from switch_core.visibility.operator_limits import configure_limits
from switch_core.visibility.operators import OperatorList
from switch_core.visibility.read_views import admin_router as visibility_admin_router
from switch_core.visibility.read_views import (
    operator_router as visibility_operator_router,
)
from switch_core.visibility.shared_cloud_agents import (
    router as shared_cloud_agents_router,
)


def create_gateway_app(
    *,
    agent_store: AgentStore,
    room_store: RoomStore,
    room_group_store: RoomGroupStore,
    room_service: RoomService,
    bridge_store: CollaborationBridgeStore,
    client_lifecycle: ClientLifecycleService,
    collab_lifecycle: CollaborationBridgeLifecycleService,
    event_buffer: EventBuffer,
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    external_user_store: ExternalUserStore,
    api_key_store: ApiKeyStore,
    invitation_store: InvitationStore,
    join_domain_store: JoinDomainStore,
    organization_store: OrganizationStore,
    organization_directory: OrganizationDirectory,
    template_store: TemplateStore,
    usage_store: UsageStore,
    budget_store: BudgetStore,
    resource_service: ResourceService,
    protocol: AgentCore,
    install_service: MessagingInstallService | None,
    invite_mailer: InviteMailer | None,
    user_changes: LocalUserChanges,
    chat_service: ChatService,
    connector_apps: ConnectorApps,
    config: SwitchConfig,
    trust_settings_changed: Callable[[], None] | None = None,
) -> FastAPI:
    init_dependencies(
        agent_store=agent_store,
        room_store=room_store,
        room_group_store=room_group_store,
        room_service=room_service,
        bridge_store=bridge_store,
        client_lifecycle=client_lifecycle,
        collab_lifecycle=collab_lifecycle,
        event_buffer=event_buffer,
        session_factory=session_factory,
        user_store=user_store,
        external_user_store=external_user_store,
        api_key_store=api_key_store,
        invitation_store=invitation_store,
        join_domain_store=join_domain_store,
        organization_store=organization_store,
        organization_directory=organization_directory,
        template_store=template_store,
        usage_store=usage_store,
        budget_store=budget_store,
        resource_service=resource_service,
        protocol=protocol,
        install_service=install_service,
        invite_mailer=invite_mailer,
        user_changes=user_changes,
        config=config,
        trust_settings_changed=trust_settings_changed,
    )

    app = FastAPI(title="Switch Gateway API")
    app.state.chat_service = chat_service
    app.state.hosted_controller_settings = load_hosted_settings(
        config.hosted_controller_config_path
    )
    if config.hosted_launch_capacity and app.state.hosted_controller_settings is None:
        raise ValueError(
            "HOSTED_LAUNCH_CAPACITY above 0 requires HOSTED_CONTROLLER_CONFIG_PATH."
        )
    warn_if_open_to_all(
        app.state.hosted_controller_settings, config.hosted_launch_capacity
    )
    # The operator bearer's overlaps: open ones named with their
    # end, lapsed ones still in the file warned about.
    log_operator_overlaps(app.state.hosted_controller_settings)
    # Before any route can need it; an unsafe key file stops the start here.
    app.state.keyed_id_key = load_keyed_id_key(config)
    set_process_keyed_id_key(app.state.keyed_id_key)
    # The v1/v2 switch, once per start, for code with no config to hand.
    set_process_hosted_v2(config)
    app.state.operator_list = OperatorList(config.visibility_operators_path)
    # Operator rate limits: the bulk-action alert's title takes its window from
    # the setting, and a limit set looser than the default is named once at start.
    configure_limits(config)
    # The v1/v2 switch: every v2-only router answers 404 with v2 off, before
    # any authentication or work, exactly as a route that doesn't exist.
    v2_only = [Depends(require_hosted_v2)]
    app.include_router(
        operator_audit_router, tags=["hosted-operator"], dependencies=v2_only
    )
    app.include_router(
        hosted_access_router, tags=["hosted-operator"], dependencies=v2_only
    )
    app.include_router(
        operator_action_router, tags=["hosted-operator"], dependencies=v2_only
    )
    app.include_router(hosted_usage_router, tags=["hosted-admin"], dependencies=v2_only)
    # The signed-in person's own agents on the shared cloud, with their states.
    app.include_router(
        shared_cloud_agents_router, tags=["shared-cloud"], dependencies=v2_only
    )
    # Your cloud files: the owner's files on their own box, behind its own flag too.
    app.include_router(cloud_files_router, tags=["cloud-files"], dependencies=v2_only)
    # v1 hosted uses these two, so they stay up; their v2 parts are gated inside.
    app.include_router(hosted_machines_router, tags=["hosted-machines"])
    app.include_router(hosted_controller_router, tags=["hosted-controller"])
    app.include_router(
        hosted_provisioner_router, tags=["hosted-provisioner"], dependencies=v2_only
    )
    # The operator's overview and "Show name", and the admin's
    # People data. They answer 503 until a keyed-id key is set.
    app.include_router(
        visibility_operator_router, tags=["visibility"], dependencies=v2_only
    )
    app.include_router(
        visibility_admin_router, tags=["visibility"], dependencies=v2_only
    )
    app.state.connector_apps = connector_apps
    install_github_app(app.state, connector_apps.github_app())
    app.include_router(
        github_connections_router,
        tags=["provider-connections"],
    )
    app.include_router(connection_catalog_router, tags=["provider-connections"])
    app.include_router(providers_router, tags=["agent providers"])
    # Sign-ins under way, GitHub's and the catalog's, in Postgres so that any
    # switch-core process can take any step of one.
    app.state.sign_in_flows = SignInFlows(session_factory, config.keyring)
    # Set by the server when changes to linked organizations' members are
    # sent to WorkOS (`workos_sign_in.py`).
    app.state.workos_sign_in = None
    app.state.service_flows = ServiceFlows(
        config.gateway_public_url, app.state.sign_in_flows
    )
    if config.service_connections_enabled:
        app.include_router(service_connections_router, tags=["service-connections"])
        app.include_router(service_flows_router, tags=["service-connections"])
        app.include_router(workspace_services_router, tags=["service-connections"])
        app.include_router(connector_apps_router, tags=["connector-apps"])
        if config.organization_connector_apps_enabled:
            app.include_router(
                organization_connector_apps_router, tags=["connector-apps"]
            )
            app.include_router(
                organization_services_router, tags=["service-connections"]
            )

    # authlib's OIDC client stores transient state/nonce/PKCE in the request
    # session across the IdP redirect round-trip; SameSite=Lax lets the cookie
    # survive the top-level GET navigation back to the callback. This cookie
    # (`session`) is separate from the `switch_auth` auth cookie.
    app.add_middleware(
        SessionMiddleware,
        # Current key only: this cookie lives for one login round trip, so a
        # rotation costs at most a login started in the minutes before it.
        secret_key=config.keyring.derive(Purpose.OIDC_LOGIN_COOKIE).hex(),
        same_site="lax",
        max_age=600,
        https_only=config.gateway_cookie_secure,
    )
    if config.gateway_oidc_enabled:
        register_oidc_client(config)
    # One Origin check for every cookie-authenticated change, and
    # `X-Frame-Options: DENY` on every answer.
    origins = allowed_origins(config)
    log_origin_setup(config, origins)
    app.add_middleware(OriginCheckMiddleware, allowed=origins)

    app.add_exception_handler(RequestValidationError, validation_error_response)
    app.add_exception_handler(SessionError, session_error_response)
    app.add_exception_handler(ChatError, chat_error_response)
    app.include_router(
        agent_sessions_router, prefix="/agent-sessions", tags=["session activity"]
    )
    app.include_router(auth_router, tags=["auth"])
    app.include_router(oidc_router, tags=["auth"])
    app.include_router(workos_sign_in_router, tags=["auth"])
    app.include_router(tenants_router, tags=["tenants"])
    app.include_router(organizations_router, tags=["organizations"])
    app.include_router(rooms_router, prefix="/rooms", tags=["rooms"])
    app.include_router(changes_router, tags=["changes"])
    app.include_router(chats_router, prefix="/chats", tags=["chats"])
    app.include_router(room_groups_router, prefix="/room-groups", tags=["room-groups"])
    app.include_router(agents_router, prefix="/agents", tags=["agents"])
    app.include_router(
        collaborations_router, prefix="/collaborations", tags=["collaborations"]
    )
    app.include_router(
        teams_placements_router, prefix="/collaborations", tags=["collaborations"]
    )
    app.include_router(api_keys_router, prefix="/api-keys", tags=["api-keys"])
    app.include_router(references_router, tags=["references"])
    app.include_router(room_links_router, tags=["linked-rooms"])
    app.include_router(documents_router, tags=["documents"])
    app.include_router(packages_router, tags=["packages"])
    app.include_router(templates_router, tags=["templates"])
    app.include_router(ownership_router, tags=["ownership"])
    app.include_router(template_runs_router, tags=["templates"])
    app.include_router(ecosystem_router, prefix="/ecosystem", tags=["ecosystem"])
    app.include_router(trust_settings_router, tags=["trust-settings"])
    app.include_router(decision_settings_router, tags=["decision-settings"])
    app.include_router(feature_flags_router, tags=["feature-flags"])
    app.include_router(
        messaging_installs_router,
        prefix="/messaging-apps",
        tags=["messaging-apps"],
    )

    return app
