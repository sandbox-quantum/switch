"""An agent giving its owner's other agents access to services, or taking it away.

The same grants Switch Console's agent page makes (GitHub, Atlassian and the
rest): an agent may use its owner's own connection to a service. Made by an
agent acting for its owner, so it takes the "can manage agents" capability
the agent-management tools do, and reaches only the owner's own agents.
"""

from __future__ import annotations

from typing import Any

from switch_core.bridges.agent.operations.agent_management import (
    permitted_to_manage,
    refuse_managing_self,
)
from switch_core.bridges.agent.operations.context import get_protocol
from switch_core.bridges.agent.operations.registry import operation
from switch_core.connections.broker import ServiceBroker, ServiceError
from switch_core.db.models import Agent
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.gateway.known_agents import known_agent_for

_CONNECTIONS = ServiceConnectionStore()


def _broker() -> ServiceBroker:
    broker = get_protocol().service_broker
    if broker is None:
        raise ValueError("This Switch server has service connections turned off.")
    return broker


async def _owned_agent(session: Any, owner_id: str, agent_name: str) -> Agent:
    agent = await get_protocol().agent_store.get_by_name(session, agent_name)
    if agent is None or agent.owner_id != owner_id:
        raise ValueError(f"Your owner has no agent named {agent_name!r}.")
    return agent


@operation
async def set_agent_service(
    agent_name: str,
    service: str,
    access: str | None = None,
    resources: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Give one of your owner's agents access to a service your owner connected.

    The agent then uses your owner's own connection to the service (their
    GitHub, their Atlassian…), within what this grant allows. Replaces any
    grant the agent already has on that service. Propose it to your owner and
    wait for a yes before calling: it hands their access to another agent.

    Requires the "can manage agents" capability. Only your owner's own agents,
    never yourself, and only services your owner has connected
    (`get_my_context` lists both).
    Some services need a choice only a person can make, such as which GitHub
    repositories: when the refusal says so, link your owner to the agent's
    Connections tab (`switchdash://open/agent/<agent-id>?tab=connections`), where
    Switch Console asks for it.

    Args:
        agent_name: The agent to give access to, by its name.
        service: The service's slug, as `get_my_context` lists it ("github").
        access: "read" or "write"; omit for read. Leave it out for a service
            that is on or off and reaches what your owner's connection does.
        resources: What the service needs to know about the grant's reach;
            omit unless a refusal asked for something.

    Returns:
        {agent, service, access, summary, warning}: `summary` says in a
        sentence what the agent can now do; `warning` is set when access the
        previous grant gave could not all be revoked yet.
    """
    if access not in {None, "read", "write"}:
        raise ValueError('access must be "read" or "write".')
    permitted = await permitted_to_manage()
    broker = _broker()
    protocol = get_protocol()
    async with tenant_session(protocol.session_factory, permitted.tenant_id) as session:
        agent = await _owned_agent(session, permitted.owner.id, agent_name)
        refuse_managing_self(agent.id)
        if known_agent_for(agent) is None:
            raise ValueError(
                f"{agent.name} runs on its own runtime, not one Switch starts, so "
                "nothing would start its service tools. It cannot be given services."
            )
        try:
            grant, warning = await broker.set_grant(
                session,
                agent=agent,
                actor_id=permitted.owner.id,
                service=service,
                access=access,  # type: ignore[arg-type]
                tool_mode=None,
                tools=None,
                resources=resources or {},
            )
        except ServiceError as error:
            raise ValueError(error.message) from error
        return {
            "agent": agent.name,
            "service": grant.service,
            "access": grant.access,
            "summary": broker.summary(agent.display_name or agent.name, grant),
            "warning": warning,
        }


@operation
async def remove_agent_service(agent_name: str, service: str) -> dict[str, Any]:
    """Take away one of your owner's agents' access to a service.

    What was issued under the grant is revoked. Propose it and wait for a yes,
    as for `set_agent_service`. Requires the "can manage agents" capability,
    and reaches only your owner's own agents, never yourself.

    Args:
        agent_name: The agent, by its name.
        service: The service's slug ("github").

    Returns:
        {agent, service, warning}: `warning` is set when some issued access
        could not be revoked yet; Switch keeps trying.
    """
    permitted = await permitted_to_manage()
    broker = _broker()
    protocol = get_protocol()
    async with tenant_session(protocol.session_factory, permitted.tenant_id) as session:
        agent = await _owned_agent(session, permitted.owner.id, agent_name)
        refuse_managing_self(agent.id)
        grant = await _CONNECTIONS.get_grant(session, agent.id, service)
        if grant is None:
            raise ValueError(f"{agent.name} has no access to {service!r} to take away.")
        try:
            warning = await broker.revoke_grant(session, grant, permitted.owner.id)
        except ServiceError as error:
            raise ValueError(error.message) from error
    return {"agent": agent.name, "service": service, "warning": warning}
