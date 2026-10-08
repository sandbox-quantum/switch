"""A person's service connections, and the grants on their agents.

Connections are listed and disconnected by the person who holds them; grants
are listed, set and removed by the agent's owner, on their own connection.
Someone else's agent answers 404, as a missing one does. The credential broker
(`connections/broker.py`) makes every change and runs the checks; this module
turns its refusals into the gateway's `{"detail": ...}`.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import parse_policy
from switch_core.bridges.agent.protocol.hosted_workers import hosted_launch_of
from switch_core.connections.broker import (
    ServiceBroker,
    ServiceError,
    effective_tools,
    get_service_broker,
)
from switch_core.connections.loader import CATALOG, AccessLevel
from switch_core.db.models import Agent, ServiceGrant, User, require_tenant_id
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session
from switch_core.gateway.known_agents import known_agent_for

router = APIRouter()
STORE = ServiceConnectionStore()


def service_refusal(error: ServiceError) -> JSONResponse:
    """A refusal as the gateway answers one: `detail` the message, as every
    client already reads it, with the reason `code` and whether a retry can
    succeed beside it."""
    return JSONResponse(
        status_code=error.status_code,
        content={
            "detail": error.message,
            "code": error.code,
            "retryable": error.retryable,
        },
    )


async def _owned_agent(session: AsyncSession, agent_id: str, user: User) -> Agent:
    agent = await session.scalar(
        select(Agent).where(
            Agent.tenant_id == require_tenant_id(), Agent.id == agent_id
        )
    )
    if agent is None or agent.owner_id != user.id:
        raise HTTPException(status_code=404, detail="Agent not found.")
    return agent


def _grant_view(broker: ServiceBroker, agent: Agent, grant: ServiceGrant) -> dict:
    entry = CATALOG.get(grant.service)
    access: AccessLevel = "write" if grant.access == "write" else "read"
    return {
        "service": grant.service,
        "name": grant.service if entry is None else entry.definition.name,
        "access": grant.access,
        "tool_mode": grant.tool_mode,
        "tools": list(grant.tools),
        "effective_tools": (
            []
            if entry is None
            else effective_tools(entry, access, grant.tool_mode, list(grant.tools))
        ),
        "resources": dict(grant.resources),
        "summary": broker.summary(agent.display_name or agent.name, grant),
    }


@router.get("/service-connections")
async def list_service_connections(
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """Every catalog service, with the person's connection to it."""
    connections = {
        connection.service: connection
        for connection in await STORE.list_connections(session, user.id)
    }
    entries = []
    for entry in CATALOG.values():
        definition = entry.definition
        connection = connections.get(definition.slug)
        unavailable = broker.availability(definition.slug)
        entries.append(
            {
                "slug": definition.slug,
                "name": definition.name,
                "category": definition.category,
                "description": definition.description,
                "enabled": definition.enabled,
                "auth_type": definition.auth.type,
                "connectable": broker.connectable(definition.slug),
                "configured": unavailable is None,
                "unavailable_reason": unavailable,
                "status": "not_connected" if connection is None else connection.status,
                "consent": None if connection is None else connection.consent,
                "external_identity": (
                    None if connection is None else connection.external_identity
                ),
            }
        )
    return {"connections": entries}


@router.delete("/service-connections/{service}", response_model=None)
async def disconnect_service(
    service: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any] | JSONResponse:
    """Disconnect: the grants on it go with it, and what was issued is revoked."""
    try:
        warning = await broker.disconnect(session, user.id, service)
    except ServiceError as error:
        return service_refusal(error)
    return {"warning": warning}


@router.get("/agents/{agent_id}/service-grants")
async def list_service_grants(
    agent_id: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any]:
    """The agent's grants, what it needs and lacks, and whether others can address it.

    `missing` names a grant the agent works without: a cloud agent's
    repository, whose grant the launch could not make or someone removed,
    with the grant that would restore it.
    """
    agent = await _owned_agent(session, agent_id, user)
    grants = await STORE.list_grants(session, agent.id)
    return {
        "grants": [_grant_view(broker, agent, grant) for grant in grants],
        "missing": await _missing_grants(session, agent, user, grants),
        "addressing_open": await _others_can_address(session, agent, user),
    }


async def _others_can_address(session: AsyncSession, agent: Agent, owner: User) -> bool:
    """Whether someone other than the owner, or another person's agent, may
    address the agent: what makes its grants usable by them."""
    policy = parse_policy(agent.addressing_policy)
    if policy.is_open():
        return True
    identities = await ExternalUserStore().get_by_user(session, owner.id)
    own_agents = await session.scalars(
        select(Agent.id).where(
            Agent.tenant_id == require_tenant_id(), Agent.owner_id == owner.id
        )
    )
    return policy.admits_others(
        owner_identity_ids={identity.id for identity in identities},
        owner_agent_ids=set(own_agents),
    )


async def _missing_grants(
    session: AsyncSession, agent: Agent, user: User, grants: list[ServiceGrant]
) -> list[dict[str, Any]]:
    launch_id = hosted_launch_of(agent.metadata_)
    if launch_id is None or any(grant.service == "github" for grant in grants):
        return []
    launch = await HostedLaunchStore().owned(session, launch_id, user.id)
    if (
        launch is None
        or launch.state in ("deleting", "deleted")
        or not launch.repository
    ):
        return []
    installation_id = launch.spec.get("installation_id")
    repository_id = launch.spec.get("repository_id")
    if type(installation_id) is not int or type(repository_id) is not int:
        return []
    return [
        {
            "service": "github",
            "reason": (
                f"This cloud agent works in {launch.repository}, but has no GitHub "
                "grant, so it cannot fetch or push. Grant it the repository again."
            ),
            "access": "write",
            "resources": {
                "installation_id": installation_id,
                "repository_ids": [repository_id],
            },
        }
    ]


class GrantBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    access: Literal["read", "write"] | None = None
    tool_mode: Literal["allow", "deny"] | None = None
    tools: list[str] | None = None
    resources: dict[str, Any]


@router.put("/agents/{agent_id}/service-grants/{service}", response_model=None)
async def set_service_grant(
    agent_id: str,
    service: str,
    body: GrantBody,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any] | JSONResponse:
    """Create or replace the grant. With no `access` it reads."""
    agent = await _owned_agent(session, agent_id, user)
    if known_agent_for(agent) is None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{agent.display_name or agent.name} runs on its own runtime, not "
                "one Switch Console starts, so nothing would start its service "
                "tools. It cannot be granted services."
            ),
        )
    try:
        grant, warning = await broker.set_grant(
            session,
            agent=agent,
            actor_id=user.id,
            service=service,
            access=body.access,
            tool_mode=body.tool_mode,
            tools=body.tools,
            resources=body.resources,
        )
    except ServiceError as error:
        return service_refusal(error)
    return {"grant": _grant_view(broker, agent, grant), "warning": warning}


@router.delete("/agents/{agent_id}/service-grants/{service}", response_model=None)
async def remove_service_grant(
    agent_id: str,
    service: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any] | JSONResponse:
    """Remove the grant; tokens issued under it are revoked."""
    agent = await _owned_agent(session, agent_id, user)
    grant = await STORE.get_grant(session, agent.id, service)
    if grant is None:
        raise HTTPException(status_code=404, detail="No such grant.")
    try:
        warning = await broker.revoke_grant(session, grant, user.id)
    except ServiceError as error:
        return service_refusal(error)
    return {"warning": warning}
