"""Agent operations on the owner's agent management: machines and managed agents.

These exist only on a server running agent management
(the `agent_management` feature flag): they are declared in their own operation group,
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
from typing import TYPE_CHECKING, Any

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
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.decision.admin import (
    DecisionSettingsRefused,
    clear_settings,
    save_settings,
    settings_view,
)
from switch_core.decision.machine import is_removed, offered_models
from switch_core.gateway.schemas import DecisionSettingsUpdateRequest

if TYPE_CHECKING:
    from switch_core.decision.client import DynamicDecisionClient

AGENT_MANAGEMENT_OPERATIONS = "agent_management"

CAPABILITY_LABEL = "can manage agents"

NOT_A_WORKSPACE_ADMIN = (
    "Your owner isn't an admin of this workspace, and only a workspace admin "
    "can choose where auto-route's decisions run. A workspace admin can choose "
    "it in Switch Console → Admin → Decision routing."
)

_port: AgentManagementPort | None = None
_decisions: DynamicDecisionClient | None = None


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


def use_decision_routing(client: DynamicDecisionClient) -> None:
    """The decision client `get_decision_routing` and `set_decision_routing`
    read and save the workspace's decision settings through."""
    global _decisions
    _decisions = client


def _decision_client() -> DynamicDecisionClient:
    if _decisions is None:
        raise RuntimeError(
            "decision-routing operations were called without a decision "
            "client; use_decision_routing was never called"
        )
    return _decisions


def management_port() -> AgentManagementPort | None:
    """Management's implementation, or None when agent management is off."""
    return _port


def _management() -> AgentManagementPort:
    if _port is None:
        raise RuntimeError(
            "agent-management operations were called without a management "
            "implementation; enable_agent_management was never called"
        )
    return _port


@dataclass(frozen=True)
class Permitted:
    tenant_id: str
    owner: User


async def management_permission() -> Permitted | str:
    """The calling agent's owner, once the agent is allowed to act on the
    owner's agent management; otherwise the sentence saying why not."""
    agent_id = get_agent_id()
    protocol = get_protocol()
    async with protocol.session_factory() as session:
        agent = await protocol.agent_store.get(session, agent_id)
        if agent is None:
            raise ValueError(f"Unknown agent: {agent_id}")
        if agent.owner_id is None:
            return (
                f"Agent {agent.name} has no owner, and only an agent acting for "
                "its owner can manage agents."
            )
        if not agent.can_manage_agents:
            return (
                f"Agent {agent.name} is not allowed to manage agents. Ask your "
                f"owner to enable '{CAPABILITY_LABEL}' for {agent.name} on its "
                "agent page in the Switch gateway."
            )
        owner = await session.get(User, agent.owner_id)
        if owner is None:
            return (
                f"Agent {agent.name}'s owner no longer exists, so it cannot "
                "manage agents."
            )
    return Permitted(tenant_id=require_tenant_id(), owner=owner)


def refuse_managing_self(agent_id: str) -> None:
    """Refuse an agent changing itself: its settings, permissions and services
    are its owner's to change, never its own."""
    if agent_id == get_agent_id():
        raise PermissionError(
            "An agent can't change its own settings, permissions or services. "
            "Your owner changes them on your page in Switch Console."
        )


async def permitted_to_manage() -> Permitted:
    """The calling agent's owner, once the agent is allowed to act on the
    owner's agent management; a clear refusal otherwise."""
    permission = await management_permission()
    if isinstance(permission, str):
        raise PermissionError(permission)
    return permission


@gated_operation(AGENT_MANAGEMENT_OPERATIONS)
async def list_machines() -> list[dict[str, Any]]:
    """List your owner's machines: the computers that can run managed agents.

    Requires the "can manage agents" capability, which your owner turns on for
    you; without it the call is refused with a sentence to relay. Only your
    owner's machines are listed, never anyone else's, and revoked (removed)
    machines are left out.

    Returns:
        A list of machines, each {id, name, description, kind, state,
        last_seen_at, providers, agents_running, decision}.
        `kind` is "console" (Switch Console's own machine), "daemon" (a
        headless controller) or "ec2". `state` is "online" (connected to Switch
        now), "offline" (was connected, and is not now: stopped, asleep, off
        or disconnected) or "unknown" (has never connected).
        `providers` lists the agent CLIs the machine last reported, each
        {provider, installed, version, auth}, `auth` being "ok", "missing",
        "expired" or "unknown". `agents_running` counts the managed agents
        whose process the machine last reported as running, null before it
        has reported. Pass a machine's `id` or exact `name` to `create_agent`.
        `decision` says whether the machine can run auto-route's decision
        model: {supported, offered?, state?, model?}, `offered` being the
        models it can run ({model, label, speed}, speed "fast" or "slow"),
        and `state` that of the one it serves ("off", "downloading",
        "starting", "running" or "failed"). `set_decision_routing` chooses
        one for the workspace.
    """
    permitted = await permitted_to_manage()
    return await _management().list_machines(permitted.tenant_id, permitted.owner.id)


@gated_operation(AGENT_MANAGEMENT_OPERATIONS)
async def get_advanced_config(provider: str) -> list[dict[str, Any]]:
    """List the advanced settings a managed agent of this provider can carry.

    Requires the "can manage agents" capability. These are the keys
    `create_agent` and `update_agent_detail` accept in `advanced_config` for
    the provider, the same "Advanced configuration" Switch Console offers.

    Args:
        provider: A provider's id, as `list_machines` reports it, such as
            "claude" for Claude Code. An unknown id is refused with the ids
            Switch runs.

    Returns:
        A list of fields, each {key, label, type, help, placeholder, options,
        catalogue}. `type` is "text" or "textarea" (a string), "number",
        "boolean", "list" (a list of strings) or "select" (one of `options`).
        `options` is a select's choices, each {value, label}, the first being
        {"value": "", ...}: that one means unset, so leave the key out rather
        than sending "". `catalogue` is null, or {kind: "model"} for a model
        name, or {kind: "model-variant", model_field} for a variant of the
        model named by that field. An empty list means the provider has no
        advanced settings. Leave a setting out of `advanced_config` to leave it
        unset; never send null, "" or [].
    """
    await permitted_to_manage()
    return _management().advanced_config_fields(provider)


@gated_operation(AGENT_MANAGEMENT_OPERATIONS)
async def create_agent(
    name: str,
    description: str,
    machine: str,
    provider: str,
    model: str | None = None,
    advanced_config: dict[str, Any] | None = None,
    instructions: str = "",
    directory: str | None = None,
    auto_mode: bool = True,
    auto_approve: bool = False,
    display_name: str | None = None,
    icon_url: str | None = None,
    start: bool = True,
) -> dict[str, Any]:
    """Create a new managed agent for your owner, running on one of their machines.

    Requires the "can manage agents" capability, which your owner turns on for
    you. The new agent is owned by your owner (not by you), runs on the
    machine you name, and can be addressed by your owner and your owner's
    other agents (you included) until they say otherwise. It does not get the
    "can manage agents" capability itself.
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
        provider: The agent CLI to run, by its id as `list_machines` reports
            it, such as "claude" for Claude Code. An unknown id is refused
            with the ids Switch runs.
        model: The model to run, or null for the provider's default.
        advanced_config: The provider's advanced settings, such as
            {"effort": "high"} for Claude Code or Codex, keyed by the fields
            `get_advanced_config(provider)` lists; a field left out is left
            unset. Each value is checked against that field. Null for none.
        instructions: Standing instructions for the agent (at most 32 KiB).
        directory: The working directory on the machine, or null for the
            machine's own workspace for the agent; Switch fills that path in
            when the machine has reported where it keeps workspaces, and the
            machine makes the directory if it is missing. Any other directory
            must already exist there.
        auto_mode: Auto mode, on by default: the provider's own automatic
            review lets safe actions run without asking and still asks a
            person before risky ones. Leave it on unless the person asks for
            every action to be approved.
        auto_approve: Bypass mode: the agent runs every tool without any
            permission check, and this overrides `auto_mode`. Unsafe; set it
            only when the person explicitly asks for bypass.
        display_name: A human label shown next to `name`, or null for none.
        icon_url: An https link to the agent's icon, or null for the icon
            its name generates, the same one Switch Console offers first. A
            server with third-party avatars off generates none, and the agent
            then shows each platform's default icon.
        start: Start the agent now (true) or create it stopped (false).

    Returns:
        {agent_id, name, machine: {id, name}, desired_state, hint}.
        `desired_state` is "running" or "stopped". Check the agent with
        `list_managed_agents` straight away; while its `actual` is still
        null, "pending" or "starting", check again every 2 seconds, for at
        most a minute.
    """
    permitted = await permitted_to_manage()
    return await _management().create_agent(
        permitted.tenant_id,
        permitted.owner.id,
        NewManagedAgent(
            name=name,
            description=description,
            display_name=display_name,
            icon_url=icon_url,
            machine=machine,
            provider=provider,
            model=model,
            advanced_config={} if advanced_config is None else advanced_config,
            instructions=instructions,
            directory=directory,
            auto_mode=auto_mode,
            auto_approve=auto_approve,
            isolation="shared",
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
        description, provider, model, advanced_config, auto_mode,
        auto_approve, directory, machine, desired_state, actual, revision}.
        `auto_mode` is whether the provider's automatic review decides which
        actions need a person's approval. `auto_approve` is bypass: it runs
        every tool without asking anyone, whatever `auto_mode` says.
        `directory` is the working directory the definition names (null only
        when its machine has not said where it keeps workspaces).
        `machine` is {id, name, state} (null when the agent is not placed on
        a machine), `state` being "online", "offline", "unknown" or "revoked".
        `desired_state` is what your owner wants: "running" or "stopped".
        `actual` is what the machine last reported for the agent,
        {process, reason, detail, applied_revision, since, directory}, or
        null before it has reported on it; `process` is one of "pending",
        "starting", "running", "stopping", "stopped", "crashed" or "failed",
        and `reason` says why when it is crashed or failed. `actual.directory`
        is where it runs, null until the machine has resolved it. `revision` is the
        definition's revision: the agent runs the current definition once
        `actual.applied_revision` equals it.
    """
    permitted = await permitted_to_manage()
    return await _management().list_managed_agents(
        permitted.tenant_id, permitted.owner.id
    )


async def _permitted_admin() -> Permitted:
    """The calling agent's owner, once the agent may manage agents and its
    owner administers this workspace; a sentence saying why not otherwise."""
    permitted = await permitted_to_manage()
    async with get_protocol().session_factory() as session:
        if not await UserStore().administers(session, permitted.owner):
            raise PermissionError(NOT_A_WORKSPACE_ADMIN)
    return permitted


@gated_operation(AGENT_MANAGEMENT_OPERATIONS)
async def get_decision_routing() -> dict[str, Any]:
    """Show how auto-route decides who answers in this workspace's rooms.

    Requires the "can manage agents" capability, and an owner who is an admin
    of this workspace; otherwise it is refused with a sentence to relay. This
    is what Switch Console shows in Admin → Decision routing. Keys are never
    shown.

    Returns:
        {source, effective, workspace, server_default, options}. `source` is
        "workspace" (its admins chose) or "server_default". `effective` is
        what applies now: {backend, endpoint, threshold, available, reason,
        machine}, `backend` being "none", "endpoint", "haiku_anthropic",
        "haiku_bedrock" or "machine", and `reason` saying why auto-route is
        unavailable when it is. For "machine", `effective.machine` is {id,
        name, model, state, ready, connected, since, progress?, reason?,
        last_decision_ms?}: `state` is "off", "downloading", "starting",
        "running", "failed", "offline" or "removed", and `ready` whether the
        machine has reported the model running (until then auto-route is
        unavailable, without notices in the rooms). `options.machines` are
        your owner's own machines in this workspace, each {id, name,
        connected, decision: {supported, offered, hardware?, reason?}};
        `offered` lists the models it can run, each {model, label, speed,
        ...}.
    """
    permitted = await _permitted_admin()
    protocol = get_protocol()
    async with tenant_session(protocol.session_factory, permitted.tenant_id) as session:
        view = await settings_view(
            session,
            _decision_client(),
            protocol.config.keyring,
            tenant_id=permitted.tenant_id,
            user_id=permitted.owner.id,
        )
    return view.model_dump(mode="json")


@gated_operation(AGENT_MANAGEMENT_OPERATIONS)
async def set_decision_routing(
    choice: str,
    machine: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Choose where auto-route's decisions run for this workspace: on one of
    your owner's machines, or back on the server default.

    Requires the "can manage agents" capability, and an owner who is an admin
    of this workspace and owns the machine; otherwise it is refused with a
    sentence to relay. Confirm with the person before you call this: it
    changes how every auto-route room in the workspace is decided, and with
    "machine" the room's messages are read by the model on that machine.

    With "machine", the machine downloads and starts the model by itself;
    until it reports the model running, auto-route is unavailable in the
    workspace's rooms (without notices). Check progress with
    `get_decision_routing`. Moving away stops the model there and keeps the
    download.

    Args:
        choice: "machine" to run the decisions on one of your owner's
            machines, or "server_default" to go back to the server's own
            decision service.
        machine: With "machine": the machine's `id`, or its exact `name`, from
            `list_machines` or `get_decision_routing`'s `options.machines`.
        model: With "machine": the model to run, from the machine's offered
            models, such as "qwen3.5-4b-q4_k_m". Left out when the machine
            offers exactly one.

    Returns:
        The workspace's decision routing afterwards, as `get_decision_routing`
        returns it.
    """
    permitted = await _permitted_admin()
    client = _decision_client()
    protocol = get_protocol()
    tenant_id = permitted.tenant_id
    owner_id = permitted.owner.id
    async with tenant_session(protocol.session_factory, tenant_id) as session:
        if choice == "server_default":
            await clear_settings(session, client, tenant_id=tenant_id)
            view = await settings_view(
                session,
                client,
                protocol.config.keyring,
                tenant_id=tenant_id,
                user_id=owner_id,
            )
            return view.model_dump(mode="json")
        if choice != "machine":
            raise ValueError('choice must be "machine" or "server_default".')
        if not machine:
            raise ValueError(
                "Name the machine to run the decision model on: its id or exact "
                "name from list_machines."
            )
        mine = [
            c
            for c in await client.availability.controllers.list_for_owner(
                session, tenant_id, owner_id
            )
            if not is_removed(c)
        ]
        found = [c for c in mine if c.id == machine] or [
            c for c in mine if c.name == machine
        ]
        if not found:
            raise ValueError(
                f"Nothing was changed: your owner has no machine with the id or "
                f"name '{machine}' in this workspace. list_machines shows the "
                "machines you can use."
            )
        if len(found) > 1:
            listed = "; ".join(f"{c.id} ({c.name})" for c in found)
            raise ValueError(
                f"Nothing was changed: your owner has {len(found)} machines named "
                f"'{machine}': {listed}. Pass the id of the one you mean."
            )
        controller = found[0]
        if model is None:
            offered = [str(entry.get("model")) for entry in offered_models(controller)]
            if len(offered) != 1:
                raise ValueError(
                    f"Nothing was changed: name the model to run on "
                    f"{controller.name}; it offers "
                    f"{', '.join(offered) or 'none'}."
                )
            model = offered[0]
        existing = await client.availability.store.get(session, tenant_id)
        try:
            view = await save_settings(
                session,
                client,
                protocol.config.keyring,
                tenant_id=tenant_id,
                user_id=owner_id,
                req=DecisionSettingsUpdateRequest(
                    backend="machine",
                    machine_id=controller.id,
                    model=model,
                    threshold=existing.threshold if existing is not None else None,
                ),
            )
        except DecisionSettingsRefused as refused:
            raise ValueError(f"Nothing was changed: {refused}") from refused
    return view.model_dump(mode="json")
