"""`get_my_context`: where an agent is, and for whom, in one read.

An assistant like switch-buddy has to know who it is talking to, what kind of
server it runs on, and how that person's workspace is set up before it can
say anything useful about setting something up: whether Slack is installed
with the official app or would need an app of the person's own, whether their
chat account is linked, which services they connected and which agents use
them. Each of those lives in a different table; this answers them together,
from the server's own data at the moment of asking.

It shows what the agent's owner may see and nothing more: the workspace's
messaging apps, which every member sees, and otherwise the owner's own
connections, agents and machines.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import func, select

from switch_core import messaging_platforms
from switch_core.addressing import owner_and_owner_agents_policy, owner_only_policy
from switch_core.bridges.agent.operations.agent_management import management_port
from switch_core.bridges.agent.operations.context import get_agent_id, get_protocol
from switch_core.bridges.agent.operations.registry import operation
from switch_core.connections.loader import CATALOG
from switch_core.db.models import (
    Agent,
    MessagingInstall,
    Tenant,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.feature_flags import SWITCH_CLOUD
from switch_core.version import switch_core_version

_CONNECTIONS = ServiceConnectionStore()


@operation
async def get_my_context() -> dict[str, Any]:
    """Who you are talking for, and how their Switch is set up, in one read.

    Call it at the start of a conversation in which you help someone set
    something up or explain their setup, and again when what you need may have
    changed. It reads the server as it is now. Shows only what your owner may
    see: the workspace's messaging apps, and otherwise your owner's own
    connections, agents and machines.

    Returns:
        {you, person, workspace, server, messaging_apps, services, agents,
        machines}.

        `you`: {name, can_manage_agents}, the agent making the call.
        `person`: your owner, {name, email, workspace_role, workspace_admin,
        runs_server}. `workspace_role` is "owner", "admin" or "member".
        `workspace_admin` is whether they may set up messaging apps and invite
        people: an owner or admin of the workspace, or the server's own
        administrator, which `runs_server` marks.
        `workspace`: {id, name, members}.
        `server`: {kind, version, features}. `kind` is "switch_cloud",
        "managed_by_console" (Switch Console runs it, on this computer or a
        host it set up) or "self_hosted". `features` lists the feature flags
        this server turned on.

        `messaging_apps`: {connected, how_to_add}.
        `connected` lists the workspace's messaging apps, each {platform,
        name, status, is_default, installed_with, your_account_linked}.
        `installed_with` is "official_app" (the Switch app, added with one
        click) or "own_app" (an app someone created and pasted tokens from).
        `your_account_linked` is whether your owner's account on that platform
        is linked to their Switch user; until it is, agents that answer only
        their owner do not recognise them there.
        `how_to_add` lists every platform this server can connect, each
        {platform, name, path, who}. `path` is "official_app" when this server
        offers the Switch app for it (Add to Slack, or adding the bot to a
        chat) and "own_app" when someone has to create an app on the
        platform and paste its tokens. `who` is "admins" or "anyone".

        `services`: what agents can be given access to (GitHub and the like),
        each {slug, name, available, unavailable_reason, connection,
        agents_using}. `available` is whether this server has it set up;
        `connection` is your owner's: "not_connected", "active",
        "needs_reauthorization" or "error". `agents_using` names your owner's
        agents granted it. Empty when this server has service connections off.

        `agents`: your owner's agents, each {id, name, display_name,
        who_can_talk, can_manage_agents, services, managed}. `who_can_talk`
        is "owner_only", "owner_and_owner_agents", "anyone" or "custom".
        `managed` is null for an agent Switch does not run on a machine, else
        {machine, desired_state, process}.

        `machines`: your owner's machines as `list_machines` reports them, or
        null when this server does not run agent management.
    """
    protocol = get_protocol()
    tenant_id = require_tenant_id()
    async with tenant_session(protocol.session_factory, tenant_id) as session:
        caller = await protocol.agent_store.get(session, get_agent_id())
        if caller is None:
            raise ValueError(f"Unknown agent: {get_agent_id()}")
        if caller.owner_id is None:
            raise PermissionError(
                f"Agent {caller.name} has no owner, so there is nobody whose "
                "context it could describe."
            )
        owner = await session.get(User, caller.owner_id)
        if owner is None:
            raise PermissionError(f"Agent {caller.name}'s owner no longer exists.")
        tenant = await session.get(Tenant, tenant_id)
        role = await protocol.user_store.tenant_role(session, tenant_id, owner.id)
        members = await session.scalar(select(func.count()).select_from(TenantMember))
        agents = await protocol.agent_store.get_by_owner(session, owner.id)
        linked_bridges = {
            identity.bridge_id
            for identity in await protocol.external_user_store.get_by_user(
                session, owner.id
            )
        }
        installed_bridges = set(
            await session.scalars(
                select(MessagingInstall.bridge_id).where(
                    MessagingInstall.status == "active",
                    MessagingInstall.bridge_id.is_not(None),
                )
            )
        )
        connections = {
            connection.service: connection.status
            for connection in await _CONNECTIONS.list_connections(session, owner.id)
        }
        grants = {
            agent.id: [
                grant.service
                for grant in await _CONNECTIONS.list_grants(session, agent.id)
            ]
            for agent in agents
        }
        bridges = await protocol.bridge_store.get_all(session)

    admin = role in {"owner", "admin"} or owner.role == "admin"
    port = management_port()
    managed = (
        {
            entry["agent_id"]: entry
            for entry in await port.list_managed_agents(tenant_id, owner.id)
        }
        if port is not None
        else {}
    )
    machines = (
        await port.list_machines(tenant_id, owner.id) if port is not None else None
    )

    return {
        "you": {"name": caller.name, "can_manage_agents": caller.can_manage_agents},
        "person": {
            "name": owner.name,
            "email": owner.email,
            "workspace_role": role,
            "workspace_admin": admin,
            "runs_server": owner.role == "admin",
        },
        "workspace": {
            "id": tenant_id,
            "name": tenant.name if tenant is not None else None,
            "members": members,
        },
        "server": {
            "kind": _server_kind(protocol.config),
            "version": switch_core_version(),
            "features": sorted(
                key for key, enabled in protocol.config.feature_flags.items() if enabled
            ),
        },
        "messaging_apps": {
            "connected": [
                {
                    "platform": bridge.type,
                    "name": bridge.display_name,
                    "status": bridge.status,
                    "is_default": bridge.is_default,
                    "installed_with": (
                        "official_app" if bridge.id in installed_bridges else "own_app"
                    ),
                    "your_account_linked": bridge.id in linked_bridges,
                }
                for bridge in bridges
            ],
            "how_to_add": _how_to_add(protocol),
        },
        "services": _services(protocol, connections, agents, grants),
        "agents": [
            {
                "id": agent.id,
                "name": agent.name,
                "display_name": agent.display_name,
                "who_can_talk": _who_can_talk(agent),
                "can_manage_agents": agent.can_manage_agents,
                "services": grants[agent.id],
                "managed": (
                    {
                        "machine": managed[agent.id].get("machine"),
                        "desired_state": managed[agent.id].get("desired_state"),
                        "process": (managed[agent.id].get("actual") or {}).get(
                            "process"
                        ),
                    }
                    if agent.id in managed
                    else None
                ),
            }
            for agent in agents
        ],
        "machines": machines,
    }


def _server_kind(config: Any) -> str:
    if config.feature_flags[SWITCH_CLOUD]:
        return "switch_cloud"
    if config.managed_by_console:
        return "managed_by_console"
    return "self_hosted"


def _how_to_add(protocol: Any) -> list[dict[str, Any]]:
    service = protocol.install_service
    official = set(service.platforms()) if service is not None else set()
    entries = []
    for platform in sorted(protocol.collab_lifecycle.get_registered_types()):
        claimed = platform in official and service.installer(platform).installs_by_claim
        entries.append(
            {
                "platform": platform,
                "name": messaging_platforms.display_name(platform),
                "path": "official_app" if platform in official else "own_app",
                # Turning a platform on is an admin's; once on, anyone adds a
                # chat by adding the bot to it.
                "who": "anyone" if claimed else "admins",
            }
        )
    return entries


def _services(
    protocol: Any,
    connections: dict[str, str],
    agents: list[Agent],
    grants: dict[str, list[str]],
) -> list[dict[str, Any]]:
    broker = protocol.service_broker
    if broker is None:
        return []
    names = {agent.id: agent.display_name or agent.name for agent in agents}
    entries = []
    for entry in CATALOG.values():
        definition = entry.definition
        if not definition.enabled:
            continue
        unavailable = broker.availability(definition.slug)
        entries.append(
            {
                "slug": definition.slug,
                "name": definition.name,
                "available": unavailable is None
                and broker.connectable(definition.slug),
                "unavailable_reason": unavailable,
                "connection": connections.get(definition.slug, "not_connected"),
                "agents_using": sorted(
                    names[agent_id]
                    for agent_id, services in grants.items()
                    if definition.slug in services
                ),
            }
        )
    return entries


def _who_can_talk(agent: Agent) -> str:
    policy = agent.addressing_policy
    if policy is None:
        return "anyone"
    if policy == owner_only_policy([]).model_dump():
        return "owner_only"
    if policy == owner_and_owner_agents_policy().model_dump():
        return "owner_and_owner_agents"
    return "custom"
