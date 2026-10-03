"""Agent operations on the owner's agent management: machines and managed agents.

These exist only on a server running agent management
(`AGENT_MANAGEMENT_ENABLED`): they are declared in their own operation group,
and the group is enabled when the process wiring hands over management's
implementation of `AgentManagementPort` (`enable_agent_management`). Until
then they are on neither front door.

An agent acts here for its owner, on its owner's machines, and only when its
owner has turned on its "can manage agents" capability (`agents.can_manage_agents`).
The capability is the agent's, so it is checked on the agent the call is made
as, however that call authenticated: with the agent's own key, or a controller
acting as the agent. Listing is gated too, since it discloses the owner's
infrastructure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from switch_core.bridges.agent.operations.context import get_agent_id, get_protocol
from switch_core.bridges.agent.operations.registry import (
    disable_operation_group,
    enable_operation_group,
    gated_operation,
)
from switch_core.bridges.agent.protocol.agent_management import (
    AgentManagementPort,
    NewManagedAgent,
)
from switch_core.db.models import User, require_tenant_id

AGENT_MANAGEMENT_OPERATIONS = "agent_management"

CAPABILITY_LABEL = "can manage agents"

_port: AgentManagementPort | None = None


def enable_agent_management(port: AgentManagementPort) -> None:
    """Make the agent-management operations exist, served by `port`."""
    global _port
    _port = port
    enable_operation_group(AGENT_MANAGEMENT_OPERATIONS)


def disable_agent_management() -> None:
    """Take the agent-management operations away again."""
    global _port
    disable_operation_group(AGENT_MANAGEMENT_OPERATIONS)
    _port = None


def _management() -> AgentManagementPort:
    if _port is None:
        raise RuntimeError(
            "agent-management operations were called without a management "
            "implementation; enable_agent_management was never called"
        )
    return _port


@dataclass(frozen=True)
class _Permitted:
    tenant_id: str
    owner: User


async def _permitted() -> _Permitted:
    """The calling agent's owner, once the agent is allowed to act on the
    owner's agent management; a clear refusal otherwise."""
    agent_id = get_agent_id()
    protocol = get_protocol()
    async with protocol.session_factory() as session:
        agent = await protocol.agent_store.get(session, agent_id)
        if agent is None:
            raise ValueError(f"Unknown agent: {agent_id}")
        if agent.owner_id is None:
            raise PermissionError(
                f"Agent {agent.name} has no owner, and only an agent acting for "
                "its owner can manage agents."
            )
        if not agent.can_manage_agents:
            raise PermissionError(
                f"Agent {agent.name} is not allowed to manage agents. Ask your "
                f"owner to enable '{CAPABILITY_LABEL}' for {agent.name} on its "
                "agent page in the Switch gateway."
            )
        owner = await session.get(User, agent.owner_id)
        if owner is None:
            raise PermissionError(
                f"Agent {agent.name}'s owner no longer exists, so it cannot "
                "manage agents."
            )
    return _Permitted(tenant_id=require_tenant_id(), owner=owner)


@gated_operation(AGENT_MANAGEMENT_OPERATIONS)
async def list_machines() -> list[dict[str, Any]]:
    """List your owner's machines: the computers that can run managed agents.

    Requires the "can manage agents" capability, which your owner turns on for
    you; without it the call is refused with a sentence to relay. Only your
    owner's machines are listed, never anyone else's, and revoked (removed)
    machines are left out.

    Returns:
        A list of machines, each {id, name, description, kind, state,
        last_seen_at, providers, agents_running}.
        `kind` is "console" (Switch Console's own machine), "daemon" (a
        headless controller) or "ec2". `state` is "online" (reporting now) or
        "unknown" (has not reported recently: asleep, off or disconnected).
        `providers` lists the agent CLIs the machine last reported, each
        {provider, installed, version, auth}, `auth` being "ok", "missing",
        "expired" or "unknown". `agents_running` counts the managed agents
        whose process the machine last reported as running, null before it
        has reported. Pass a machine's `id` or exact `name` to `create_agent`.
    """
    permitted = await _permitted()
    return await _management().list_machines(permitted.tenant_id, permitted.owner.id)


@gated_operation(AGENT_MANAGEMENT_OPERATIONS)
async def create_agent(
    name: str,
    description: str,
    machine: str,
    provider: str,
    model: str | None = None,
    instructions: str = "",
    directory: str | None = None,
    auto_approve: bool = False,
    display_name: str | None = None,
    start: bool = True,
) -> dict[str, Any]:
    """Create a new managed agent for your owner, running on one of their machines.

    Requires the "can manage agents" capability, which your owner turns on for
    you. The new agent is owned by your owner (not by you), runs on the
    machine you name, and only your owner can address it until they say
    otherwise. It does not get the "can manage agents" capability itself.
    Confirm the name, machine and provider with the person asking before you
    call this: it creates a real agent on their computer.

    The machine must be online and have the provider installed and logged in.
    When it is not, nothing is created and the error says why (with a reason
    code such as `controller_offline`, `provider_not_installed`,
    `provider_login_missing` or `provider_login_expired`); relay it as it is.

    Args:
        name: The new agent's name, unique on this Switch instance; it is what
            people address it by.
        description: What the agent is for, shown to people and agents.
        machine: The machine's `id`, or its exact `name`, from
            `list_machines`. A name shared by several machines is refused with
            the candidates listed; pass the id instead.
        provider: The agent CLI to run: "claude" (Claude Code), "codex",
            "opencode", "antigravity" or "cursor".
        model: The model to run, or null for the provider's default.
        instructions: Standing instructions for the agent (at most 32 KiB).
        directory: The working directory on the machine, or null for a fresh
            workspace the machine chooses.
        auto_approve: Let the agent run tools without asking for approval.
        display_name: A human label shown next to `name`, or null for none.
        start: Start the agent now (true) or create it stopped (false).

    Returns:
        {agent_id, name, machine: {id, name}, desired_state, hint}.
        `desired_state` is "running" or "stopped". The agent's actual state
        appears once the machine reports, within about a minute; check it
        with `list_managed_agents`.
    """
    permitted = await _permitted()
    return await _management().create_agent(
        permitted.tenant_id,
        permitted.owner.id,
        NewManagedAgent(
            name=name,
            description=description,
            display_name=display_name,
            machine=machine,
            provider=provider,
            model=model,
            instructions=instructions,
            directory=directory,
            auto_approve=auto_approve,
            start=start,
        ),
        get_protocol(),
    )


@gated_operation(AGENT_MANAGEMENT_OPERATIONS)
async def list_managed_agents() -> list[dict[str, Any]]:
    """List your owner's managed agents: where each runs, and whether it is up.

    Requires the "can manage agents" capability. Use it to check that an agent
    you created with `create_agent` came up.

    Returns:
        A list of managed agents, each {agent_id, name, display_name,
        description, provider, model, machine, desired_state, actual,
        revision}.
        `machine` is {id, name, state} (null when the agent is not placed on
        a machine), `state` being "online", "unknown" or "revoked".
        `desired_state` is what your owner wants: "running" or "stopped".
        `actual` is what the machine last reported for the agent,
        {process, reason, detail, applied_revision, since}, or null before it
        has reported on it; `process` is one of "pending", "starting",
        "running", "stopping", "stopped", "crashed" or "failed", and
        `reason` says why when it is crashed or failed. `revision` is the
        definition's revision: the agent runs the current definition once
        `actual.applied_revision` equals it.
    """
    permitted = await _permitted()
    return await _management().list_managed_agents(
        permitted.tenant_id, permitted.owner.id
    )
