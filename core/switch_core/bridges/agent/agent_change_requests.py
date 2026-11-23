"""Changes an agent makes to its owner's other agents, and the ones the owner
has to confirm first.

An agent changes its owner's other agents through `update_agent_detail`
and, with "can manage agents", makes new ones through `create_agent`. Most of
that applies at once. A change that widens what another agent may do on its
own, or who may reach it, is held instead: turning its bypass mode or auto
mode on, setting the provider's own permission mode to bypass or to auto,
moving its working folder, machine or provider, opening who may address it,
or new instructions for an agent that skips every permission check once the
change is made; and a new agent with bypass on or a folder other than its
machine's own workspace for it. It is posted in the room the asking agent is
connected to and kept (`AgentRequests`, in memory, like a deletion request)
until the owner confirms it there with `!agent-change <name> confirm` within
two minutes. A prompt injected into anything an agent reads can make it ask
for one; only its owner can make it so. Nothing is held in a frozen or
archived room, which takes no command, and a confirmation makes nothing while
the owner, the asking agent or the agent it changes is suspended. A change in
the safer direction (bypass or auto mode off, any other permission mode, a
narrower addressing policy) applies at once, as do a person's own changes in
Switch Console or the gateway, which do not come through here.

Every change an agent makes to another agent, held or not, is written to the
audit log.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.suspension import owner_is_suspended
from switch_core.addressing import ANY, AddressingPolicy, parse_policy
from switch_core.agent_display_name import agent_label_with_identifier
from switch_core.bridges.agent.protocol.agent_core import VALID_AGENT_NAME_RE
from switch_core.bridges.agent.protocol.agent_detail import addressing_policy_for
from switch_core.bridges.agent.protocol.agent_management import (
    AgentManagementPort,
    CheckedPlacement,
    ManagedAgentChanges,
    NewManagedAgent,
)
from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import AdminMessageType
from switch_core.clients.agent_admin import (
    CONFIRM_SECONDS,
    AgentRequests,
    ChangeRequest,
)
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import Agent, User, require_tenant_id
from switch_core.room_read_only import require_postable

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.agent_core import AgentCore

logger = logging.getLogger(__name__)

CONFIRM_COMMAND = "agent-change"

# The advanced setting that sets a provider's own permission mode (Claude
# Code's `permissionMode`); the value of it that skips every check as
# `auto_approve` does, so it waits for the owner as `auto_approve` does; and
# the one that lets the provider's own review decide as `auto_mode` does, so
# it waits as turning `auto_mode` on does.
PERMISSION_MODE = "permissionMode"
BYPASS_PERMISSION_MODE = "bypassPermissions"
AUTO_PERMISSION_MODE = "auto"

# How much of an agent's text the owner is shown in a request.
_SHOWN_CHARS = 200

_CONFIRM_MINUTES = int(CONFIRM_SECONDS // 60)


def confirm_with(agent_name: str) -> str:
    """What the owner sends to confirm the change waiting for `agent_name`."""
    return f"!{CONFIRM_COMMAND} {agent_name} confirm"


def _code(value: object) -> str:
    """`value` as a code span, where no platform resolves a mention or link."""
    return "`" + str(value).replace("`", "'") + "`"


def _on_off(value: bool) -> str:
    return "on" if value else "off"


def _shown(text: object) -> str:
    """`text` on one line, cut to what a request shows of it, as a code span:
    how every value an agent supplied is written into a request, so none of
    it can add a line the owner reads as Switch's."""
    line = " ".join(str(text).split())
    return _code(line if len(line) <= _SHOWN_CHARS else line[: _SHOWN_CHARS - 1] + "…")


def changed_fields(changes: ManagedAgentChanges) -> tuple[str, ...]:
    """Every field `changes` sets, in a stable order."""
    fields = list(changes.definition_changes())
    if changes.machine is not None:
        fields.append("machine")
    if changes.desired_state is not None:
        fields.append("desired_state")
    return tuple(fields)


def _permission_mode_widens(new: object, current: object) -> bool:
    """Whether the provider's permission mode going from `current` to `new`
    lets the agent do more on its own: to bypass from anything else, or to
    auto from anything but bypass or auto."""
    if new == BYPASS_PERMISSION_MODE:
        return current != BYPASS_PERMISSION_MODE
    if new == AUTO_PERMISSION_MODE:
        return current not in (AUTO_PERMISSION_MODE, BYPASS_PERMISSION_MODE)
    return False


def _bypasses_once_made(
    changes: ManagedAgentChanges, current: Mapping[str, Any]
) -> bool:
    """Whether the agent `current` shows skips every permission check once
    `changes` is made: bypass mode on, or the provider's permission mode set
    to bypass, whether it is so now or `changes` makes it so."""
    auto_approve = (
        current.get("auto_approve")
        if changes.auto_approve is None
        else changes.auto_approve
    )
    advanced = (
        current.get("advanced_config") or {}
        if changes.advanced_config is None
        else changes.advanced_config
    )
    return bool(auto_approve) or advanced.get(PERMISSION_MODE) == BYPASS_PERMISSION_MODE


def fields_to_confirm(
    changes: ManagedAgentChanges, current: Mapping[str, Any]
) -> tuple[str, ...]:
    """What in `changes` widens what the agent `current` shows (as
    `AgentManagementPort.managed_agent` does) may do on its own: bypass or
    auto mode turned on, the provider's permission mode set to bypass or to
    auto, a new working folder, machine or provider, or new instructions for
    an agent that skips every permission check once `changes` is made
    (`_bypasses_once_made`): what an agent with no checks is told to do, it
    does with nobody asked.

    Turning bypass or auto mode off, or any other permission mode, only
    narrows it, and a value it already has is no change. Instructions that
    land with bypass turned off steer an agent that asks again. A directory
    of "" puts the agent back in its machine's own workspace for it, which
    needs no confirmation."""
    machine = current.get("machine") or {}
    current_advanced = current.get("advanced_config") or {}
    held = []
    if changes.auto_approve and not current.get("auto_approve"):
        held.append("auto_approve")
    if changes.auto_mode and not current.get("auto_mode"):
        held.append("auto_mode")
    if changes.directory and changes.directory != current.get("directory"):
        held.append("directory")
    if changes.machine is not None and changes.machine not in (
        machine.get("id"),
        machine.get("name"),
    ):
        held.append("machine")
    if changes.provider is not None and changes.provider != current.get("provider"):
        held.append("provider")
    if changes.advanced_config is not None and _permission_mode_widens(
        changes.advanced_config.get(PERMISSION_MODE),
        current_advanced.get(PERMISSION_MODE),
    ):
        held.append("advanced_config")
    if changes.instructions is not None and _bypasses_once_made(changes, current):
        held.append("instructions")
    return tuple(held)


def _admits_owner_agents_everywhere(policy: AddressingPolicy) -> bool:
    return any(
        rule.rooms == ANY
        and rule.room_groups == ANY
        and (rule.owner_agents or rule.agents == ANY)
        for rule in policy.rules
    )


def addressing_widens(current: dict[str, Any] | None, choice: str) -> bool:
    """Whether setting an agent's addressing to `choice` (one of the choices
    `update_agent_detail` takes) could let someone address it whom its
    current policy (`current`, as stored) turns away.

    "anyone" opens it, unless it is open already. "owner_and_owner_agents"
    opens it to the owner's agents wherever its current policy does not
    already admit them everywhere. "owner_only" admits nobody but the owner,
    so it never opens it to anyone else."""
    policy = parse_policy(current)
    if policy.is_open():
        return False
    if choice == "anyone":
        return True
    if choice == "owner_and_owner_agents":
        return not _admits_owner_agents_everywhere(policy)
    return False


def _own_workspace(placement: CheckedPlacement, name: str) -> set[str]:
    """The folder the machine makes for an agent named `name`, written either
    way round, or nothing when the machine has not said where it keeps them."""
    if placement.workspaces_dir is None:
        return set()
    root = placement.workspaces_dir.rstrip("/\\")
    return {f"{root}/{name}", f"{root}\\{name}"}


def bypass_fields(
    auto_approve: bool, advanced_config: Mapping[str, Any]
) -> tuple[str, ...]:
    """Which ways of skipping every permission check a new agent asks for:
    bypass mode, and the provider's own permission mode set to bypass.

    Auto mode, and the provider's permission mode set to auto, are not among
    them: a new agent is made in auto mode unless it says otherwise, so
    neither waits for the owner when an agent is made."""
    held = []
    if auto_approve:
        held.append("auto_approve")
    if advanced_config.get(PERMISSION_MODE) == BYPASS_PERMISSION_MODE:
        held.append("advanced_config")
    return tuple(held)


def new_agent_fields_to_confirm(
    spec: NewManagedAgent, placement: CheckedPlacement
) -> tuple[str, ...]:
    """What makes a new agent wait for its owner: bypass mode, the provider's
    permission mode set to bypass (`bypass_fields`), or a folder other than
    its machine's own workspace for it."""
    held = bypass_fields(spec.auto_approve, spec.advanced_config)
    if spec.directory is not None and spec.directory not in _own_workspace(
        placement, spec.name
    ):
        held += ("directory",)
    return held


def _advanced_line(config: Mapping[str, Any]) -> str:
    if not config:
        return "advanced settings cleared"
    settings = ", ".join(f"{key}={value}" for key, value in config.items())
    return f"advanced settings {_shown(settings)}"


_ADDRESSING_LINES = {
    "owner_only": "who may address it: only its owner",
    "owner_and_owner_agents": "who may address it: its owner and the owner's agents",
    "anyone": "who may address it: anyone",
}


def _change_lines(changes: ManagedAgentChanges) -> tuple[str, ...]:
    """What `changes` does, a line per change, as its owner is shown it."""
    lines = []
    if changes.auto_approve is not None:
        lines.append(
            f"bypass mode {_on_off(changes.auto_approve)}"
            + (
                ": every tool runs without asking anyone"
                if changes.auto_approve
                else ""
            )
        )
    if changes.auto_mode is not None:
        lines.append(f"auto mode {_on_off(changes.auto_mode)}")
    if changes.directory is not None:
        lines.append(
            f"working folder {_shown(changes.directory)}"
            if changes.directory
            else "working folder: its machine's own workspace for it"
        )
    if changes.machine is not None:
        lines.append(f"move to machine {_shown(changes.machine)}")
    if changes.provider is not None:
        lines.append(f"provider {_shown(changes.provider)}")
    if changes.model is not None:
        lines.append(
            f"model {_shown(changes.model)}"
            if changes.model
            else "model: the provider's default"
        )
    if changes.advanced_config is not None:
        lines.append(_advanced_line(changes.advanced_config))
    if changes.instructions is not None:
        lines.append(f"instructions {_shown(changes.instructions)}")
    if changes.isolation is not None:
        lines.append(f"isolation {_shown(changes.isolation)}")
    if changes.desired_state is not None:
        lines.append(f"run state {_shown(changes.desired_state)}")
    return tuple(lines)


def _new_agent_lines(
    spec: NewManagedAgent, placement: CheckedPlacement
) -> tuple[str, ...]:
    lines = [
        f"on machine {_shown(placement.machine_name)}, run by {_shown(spec.provider)}",
    ]
    if spec.auto_approve:
        lines.append("bypass mode on: every tool runs without asking anyone")
    if spec.directory is not None:
        lines.append(f"working folder {_shown(spec.directory)}")
    if spec.advanced_config:
        lines.append(_advanced_line(spec.advanced_config))
    lines.append("started at once" if spec.start else "created stopped")
    return tuple(lines)


def _requests(protocol: AgentCore) -> AgentRequests:
    if protocol.agent_requests is None:
        raise RuntimeError(
            "Requests for an owner to confirm are not available: the process "
            "wiring did not set them up"
        )
    return protocol.agent_requests


async def _caller_and_room(
    protocol: AgentCore, caller_id: str, room_id: str
) -> tuple[Agent, str]:
    """The asking agent, and the transport id of the room it asks in.

    Raises `RoomReadOnly` for a frozen or archived room: it takes no
    command, so the owner could never confirm a request held there."""
    async with protocol.session_factory() as session:
        caller = await protocol.agent_store.get(session, caller_id)
        room = await protocol.room_store.get(session, room_id)
    if caller is None:
        raise ValueError(f"Unknown agent: {caller_id}")
    if room is None:
        raise ValueError(f"Room not found: {room_id}")
    require_postable(room)
    return caller, room.transport_room_id


async def suspension_refusal(
    session: AsyncSession, request: ChangeRequest
) -> str | None:
    """Why `request` can no longer be made, or None: the owner confirming
    it, the agent that asked for it, or the agent it changes is suspended
    (`accounts/suspension.py`)."""
    if await owner_is_suspended(session, request.owner_id):
        return "Your account is suspended"
    if (
        await session.scalar(
            select(Agent.suspended_at).where(Agent.id == request.requested_by_id)
        )
        is not None
    ):
        return f"{_code(request.requested_by)}, which asked for it, is suspended"
    if (
        request.agent_id is not None
        and await session.scalar(
            select(Agent.suspended_at).where(Agent.id == request.agent_id)
        )
        is not None
    ):
        return f"{_code(request.agent_name)} is suspended"
    return None


async def owner_of(protocol: AgentCore, agent_id: str) -> User:
    """The person who owns the agent `agent_id`."""
    async with protocol.session_factory() as session:
        agent = await protocol.agent_store.get(session, agent_id)
        owner = (
            await session.get(User, agent.owner_id)
            if agent is not None and agent.owner_id is not None
            else None
        )
    if owner is None:
        raise ValueError(f"Agent {agent_id} has no owner to confirm a change")
    return owner


async def current_addressing(
    protocol: AgentCore, agent_id: str
) -> dict[str, Any] | None:
    """The addressing policy the agent `agent_id` has stored now."""
    async with protocol.session_factory() as session:
        agent = await protocol.agent_store.get(session, agent_id)
    if agent is None:
        raise ValueError(f"Agent not found: {agent_id}")
    return agent.addressing_policy


async def hold_change(
    protocol: AgentCore,
    port: AgentManagementPort | None,
    *,
    room_id: str,
    caller_id: str,
    owner: User,
    agent_id: str,
    changes: ManagedAgentChanges | None,
    addressing: str | None,
    confirming: Sequence[str],
) -> dict[str, Any]:
    """Hold, for its owner to confirm in `room_id`, the managed `changes` to
    the agent `agent_id` and its new `addressing`, either of which may be
    None, and return what the asking agent is told. Every managed change in
    the call is held together: a provider and its model, or a machine and the
    run state, only make sense as one.

    Raises `ChangeAlreadyWaiting` while another change to the agent waits."""
    tenant_id = require_tenant_id()
    caller, transport_room_id = await _caller_and_room(protocol, caller_id, room_id)
    async with protocol.session_factory() as session:
        target = await protocol.agent_store.get(session, agent_id)
    if target is None:
        raise ValueError(f"Agent not found: {agent_id}")
    if changes is not None and port is None:
        raise RuntimeError("A managed change was held with no agent management")

    async def apply() -> None:
        if changes is not None:
            assert port is not None
            await port.update_managed_agent(
                tenant_id, owner.id, agent_id, changes, protocol
            )
        if addressing is not None:
            async with protocol.session_factory() as session:
                await protocol.agent_store.update(
                    session,
                    agent_id,
                    addressing_policy=addressing_policy_for(addressing),
                )
                await session.commit()

    fields = changed_fields(changes) if changes is not None else ()
    summary = _change_lines(changes) if changes is not None else ()
    if addressing is not None:
        fields += ("addressing",)
        summary += (_ADDRESSING_LINES[addressing],)
    return await _hold(
        protocol,
        room_id=room_id,
        transport_room_id=transport_room_id,
        caller=caller,
        owner=owner,
        confirming=confirming,
        asks_to=(
            f"change **{agent_label_with_identifier(target.display_name, target.name)}**"
        ),
        request=ChangeRequest(
            requested_by_id=caller.id,
            requested_by=caller.name,
            owner_id=owner.id,
            agent_name=target.name,
            agent_id=agent_id,
            fields=fields,
            summary=summary,
            apply=apply,
        ),
    )


async def hold_new_agent(
    protocol: AgentCore,
    port: AgentManagementPort,
    *,
    room_id: str,
    caller_id: str,
    owner: User,
    spec: NewManagedAgent,
    placement: CheckedPlacement,
    confirming: Sequence[str],
) -> dict[str, Any]:
    """Hold a new agent for its owner to confirm in `room_id`, on the machine
    `placement` checked, and return what the asking agent is told."""
    tenant_id = require_tenant_id()
    if not VALID_AGENT_NAME_RE.match(spec.name):
        raise ValueError(
            f"Nothing was created: {spec.name!r} is not an agent name: use "
            "lowercase letters, digits, '.', '-' and '_', starting with a "
            "letter or digit."
        )
    caller, transport_room_id = await _caller_and_room(protocol, caller_id, room_id)
    async with protocol.session_factory() as session:
        if await protocol.agent_store.get_by_name_insensitive(session, spec.name):
            raise ValueError(
                f"Nothing was created: an agent named '{spec.name}' already exists."
            )
    # The machine as checked, by id, so its name cannot come to mean another.
    pinned = replace(spec, machine=placement.machine_id)

    async def apply() -> None:
        await port.create_agent(tenant_id, owner.id, pinned, protocol)

    result = await _hold(
        protocol,
        room_id=room_id,
        transport_room_id=transport_room_id,
        caller=caller,
        owner=owner,
        confirming=confirming,
        asks_to=f"create the agent {_shown(spec.name)}",
        request=ChangeRequest(
            requested_by_id=caller.id,
            requested_by=caller.name,
            owner_id=owner.id,
            agent_name=spec.name,
            agent_id=None,
            fields=("new_agent", *confirming),
            summary=_new_agent_lines(spec, placement),
            apply=apply,
        ),
    )
    return {
        **result,
        "machine": {"id": placement.machine_id, "name": placement.machine_name},
    }


async def _hold(
    protocol: AgentCore,
    *,
    room_id: str,
    transport_room_id: str,
    caller: Agent,
    owner: User,
    confirming: Sequence[str],
    asks_to: str,
    request: ChangeRequest,
) -> dict[str, Any]:
    tenant_id = require_tenant_id()
    requests = _requests(protocol)
    requests.hold_change(room_id, request)

    admin = next(
        (
            client
            for client in protocol.client_lifecycle.get_by_type("admin", tenant_id)
            if isinstance(client, SystemActor)
        ),
        None,
    )
    command = confirm_with(request.agent_name)
    try:
        posted = (
            await admin.send_admin(
                transport_room_id,
                f"🛠️ **{agent_label_with_identifier(caller.display_name, caller.name)}** "
                f"asks to {asks_to}:\n"
                + "".join(f"- {line}\n" for line in request.summary)
                + f"Nothing has changed yet. Only the owner, {owner.name}, can make "
                f"it so, by sending `{command}` here within {_CONFIRM_MINUTES} "
                f"minutes, or drop it with `!{CONFIRM_COMMAND} {request.agent_name} "
                "drop`; otherwise it lapses.",
                message_type=AdminMessageType.AGENT_LIFECYCLE,
                thread_root_id=None,
            )
            if admin is not None
            else None
        )
    except Exception as exc:
        # The owner was never shown it, so it must not stay confirmable.
        requests.take_change(room_id, request.agent_name)
        raise RuntimeError(
            "Nothing was changed: the request for your owner to confirm could "
            f"not be posted in the room: {exc}"
        ) from exc
    if posted is None:
        requests.take_change(room_id, request.agent_name)
        raise RuntimeError(
            "Nothing was changed: the request for your owner to confirm could "
            "not be posted in the room."
        )

    async with protocol.session_factory() as session:
        await record_audit_event(
            session,
            tenant_id=tenant_id,
            actor_user_id=None,
            action=AuditAction.AGENT_CHANGE_REQUESTED,
            target_type="agent",
            target_id=request.agent_id,
            details={
                "agent_name": request.agent_name,
                "requested_by_agent_id": caller.id,
                "requested_by_agent_name": caller.name,
                "room_id": room_id,
                "fields": list(request.fields),
                "needs_confirmation_for": list(confirming),
                "summary": list(request.summary),
            },
        )
        await session.commit()
    logger.info(
        "Agent %s asked for a change to %s that waits for its owner, in room %s",
        caller.id,
        request.agent_name,
        room_id,
    )
    return {
        "status": "awaiting_confirmation",
        "agent_name": request.agent_name,
        "owner": owner.name,
        "fields": list(request.fields),
        "needs_confirmation_for": list(confirming),
        "confirm_with": command,
        "expires_in_seconds": int(CONFIRM_SECONDS),
        "message": (
            "Nothing in this request has been applied yet. It waits for "
            f"{owner.name}, the owner, to send `{command}` in this room within "
            f"{_CONFIRM_MINUTES} minutes, and lapses otherwise. Tell them what "
            "it changes and what to send."
        ),
    }


async def record_change_by_agent(
    protocol: AgentCore,
    *,
    caller_id: str,
    agent_id: str,
    fields: Sequence[str],
) -> None:
    """Write to the audit log that the agent `caller_id` changed `fields` of
    the agent `agent_id` itself, with nobody confirming."""
    async with protocol.session_factory() as session:
        caller = await protocol.agent_store.get(session, caller_id)
        target = await protocol.agent_store.get(session, agent_id)
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=None,
            action=AuditAction.AGENT_CHANGED_BY_AGENT,
            target_type="agent",
            target_id=agent_id,
            details={
                "agent_name": target.name if target is not None else None,
                "changed_by_agent_id": caller_id,
                "changed_by_agent_name": caller.name if caller is not None else None,
                "fields": list(fields),
            },
        )
        await session.commit()


async def record_new_agent_by_agent(
    protocol: AgentCore, *, caller_id: str, created: Mapping[str, Any]
) -> None:
    """Write to the audit log that the agent `caller_id` created an agent,
    as `create_agent` describes it, with nobody confirming."""
    async with protocol.session_factory() as session:
        caller = await protocol.agent_store.get(session, caller_id)
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=None,
            action=AuditAction.AGENT_CREATED_BY_AGENT,
            target_type="agent",
            target_id=created["agent_id"],
            details={
                "agent_name": created["name"],
                "created_by_agent_id": caller_id,
                "created_by_agent_name": caller.name if caller is not None else None,
                "machine_id": created["machine"]["id"],
            },
        )
        await session.commit()


async def record_confirmed(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    owner_id: str,
    request: ChangeRequest,
) -> None:
    """Write to the audit log that the owner confirmed `request`, and it was
    made."""
    async with session_factory() as session:
        await record_audit_event(
            session,
            tenant_id=require_tenant_id(),
            actor_user_id=owner_id,
            action=AuditAction.AGENT_CHANGE_CONFIRMED,
            target_type="agent",
            target_id=request.agent_id,
            details={
                "agent_name": request.agent_name,
                "requested_by_agent_id": request.requested_by_id,
                "requested_by_agent_name": request.requested_by,
                "fields": list(request.fields),
                "summary": list(request.summary),
                "via": "chat command",
            },
        )
        await session.commit()
