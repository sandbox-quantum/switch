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
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.addressing import parse_policy
from switch_core.connections.broker import (
    KEY_CONSENT,
    ServiceBroker,
    ServiceError,
    effective_tools,
    get_service_broker,
)
from switch_core.connections.loader import CATALOG, AccessLevel, ConnectionDefinition
from switch_core.db.models import (
    Agent,
    ServiceConnection,
    ServiceGrant,
    User,
    require_tenant_id,
)
from switch_core.db.stores.external_user_store import ExternalUserStore
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
    switched_off = await broker.workspace_disabled(session)
    entries = []
    for entry in CATALOG.values():
        definition = entry.definition
        connection = connections.get(definition.slug)
        unavailable = broker.unavailable(definition.slug)
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
                "unavailable_reason": None
                if unavailable is None
                else unavailable.reason,
                # Why, for a client to say what each person can do about it:
                # `UnavailableCode` in `connections/broker.py`.
                "unavailable_code": None if unavailable is None else unavailable.code,
                # Whether it waits on the server's operator setting up its app
                # under Connectors, so a client can offer them that.
                "server_setup_needed": broker.server_setup_needed(definition.slug),
                # Whether a workspace admin left it on for this workspace.
                "workspace_enabled": definition.slug not in switched_off,
                # A grant hands the agent the owner's own token: it is on or
                # off, at the connection's level, and lasts the token's life.
                "pass_through": (
                    definition.token is not None
                    and definition.token.kind == "pass_through"
                ),
                "token_lifetime": (
                    None if definition.token is None else definition.token.max_lifetime
                ),
                # The ports Switch Console's listener may take a sign-in back
                # on, for a vendor that matches them; null for any port.
                "loopback_ports": (
                    None
                    if definition.auth.oauth is None
                    else definition.auth.oauth.loopback_ports
                ),
                # What a person pastes to connect a service connected with a
                # key, and where they make one; null for any other.
                "key": _key_form(definition),
                "status": broker.connection_status(connection),
                "consent": None if connection is None else connection.consent,
                "external_identity": (
                    None if connection is None else connection.external_identity
                ),
            }
        )
    return {"connections": entries}


@router.get("/service-connections/{service}/agents")
async def list_service_agents(
    service: str,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[dict[str, Any]]:
    """The person's own agents in this workspace, whether each has a grant
    on `service`, and whether others can address it."""
    entry = CATALOG.get(service)
    if entry is None or not entry.definition.enabled:
        raise HTTPException(status_code=404, detail=f"No service named {service!r}.")
    agents = list(
        await session.scalars(
            select(Agent)
            .where(Agent.tenant_id == require_tenant_id(), Agent.owner_id == user.id)
            .order_by(Agent.name)
        )
    )
    granted = set(
        await session.scalars(
            select(ServiceGrant.agent_id).where(
                ServiceGrant.tenant_id == require_tenant_id(),
                ServiceGrant.owner_id == user.id,
                ServiceGrant.service == service,
            )
        )
    )
    return [
        {
            "agent_id": agent.id,
            "name": agent.display_name or agent.name,
            "granted": agent.id in granted,
            "addressing_open": await _others_can_address(session, agent, user),
        }
        for agent in agents
    ]


def _key_form(definition: ConnectionDefinition) -> dict[str, Any] | None:
    sign_in = definition.auth.api_key
    if definition.adapter != "api_key" or sign_in is None:
        return None
    return {
        "fields": [
            {
                "name": field.name,
                "label": field.label,
                "secret": field.secret,
                "help": field.help,
                "choices": field.choices,
            }
            for field in sign_in.fields
        ],
        "help_url": sign_in.help_url,
    }


class KeyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fields: dict[str, str]


@router.put("/service-connections/{service}/key", response_model=None)
async def connect_with_key(
    service: str,
    body: KeyBody,
    user: Annotated[User, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
    broker: Annotated[ServiceBroker, Depends(get_service_broker)],
) -> dict[str, Any] | JSONResponse:
    """Connect a service with a pasted key, once its vendor accepts the key.

    The key is checked with the vendor before anything is stored, and never
    sent back. Re-pasting replaces it in place, keeping the grants.
    """
    try:
        await broker.require_workspace_enabled(session, service)
        await session.commit()
        checked = await broker.check_key(service, body.fields)
    except ServiceError as error:
        return service_refusal(error)
    name = CATALOG[service].definition.name
    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"service-link:{require_tenant_id()}:{service}"},
    )
    taken = await session.scalar(
        select(ServiceConnection.user_id).where(
            ServiceConnection.tenant_id == require_tenant_id(),
            ServiceConnection.service == service,
            ServiceConnection.user_id != user.id,
            ServiceConnection.account_id == checked.account_id,
        )
    )
    if taken is not None:
        return JSONResponse(
            status_code=409,
            content={
                "detail": (
                    f"This {name} key's account is already linked to another "
                    "Switch user in this workspace. Remove that link first."
                ),
                "code": "account_linked_elsewhere",
                "retryable": False,
            },
        )
    try:
        warning = await broker.connect(
            session,
            user_id=user.id,
            service=service,
            consent=KEY_CONSENT,
            granted_scopes=[],
            account_id=checked.account_id,
            external_identity=checked.label,
            secret=checked.secret,
            oauth_client_id=None,
        )
    except ServiceError as error:
        return service_refusal(error)
    return {"warning": warning, "external_identity": checked.label}


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
    """The agent's grants, and whether others can address it."""
    agent = await _owned_agent(session, agent_id, user)
    grants = await STORE.list_grants(session, agent.id)
    return {
        "grants": [_grant_view(broker, agent, grant) for grant in grants],
        "addressing_open": await _others_can_address(session, agent, user),
    }


async def _others_can_address(session: AsyncSession, agent: Agent, owner: User) -> bool:
    """Whether someone other than the owner, or any agent, may address the
    agent: what makes its grants usable by them."""
    policy = parse_policy(agent.addressing_policy)
    if policy.is_open():
        return True
    identities = await ExternalUserStore().get_by_user(session, owner.id)
    return policy.admits_others(
        owner_identity_ids={identity.id for identity in identities}
    )


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
