"""The signed-in person's agents on the shared cloud, each with its state (Console's existing
`GET /shared-cloud/agents` contract).

One agent's state comes from what Core already holds: its controller's status report entry, its
box's lifecycle and its stop reason. The mapping follows Console's `sharedCloudFromSession` card rules,
plus the stop reasons, plus `busy` (whether any session is mid-turn) to tell working from idle. Only
the caller's own agents, only fixed states, flags, codes and times: never message text, prompts
or anything about other people's boxes.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import CloudMachine, User, require_tenant_id
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.hosted_machine_store import idle_sleeping
from switch_core.db.stores.switch_core_process_store import SwitchCoreProcessStore
from switch_core.gateway.dependencies import get_session
from switch_core.process_lease import read_leases
from switch_core.visibility.guards import require_user
from switch_core.visibility.reason_codes import StopReason
from switch_core.visibility.stop_reason_sources import (
    agent_entry,
    load_reason_signals,
    reason_inputs,
)
from switch_core.visibility.stop_reasons import AgentStopReason, stop_reason

router = APIRouter()

# The codes that change the card (the copy): the others keep its usual state and show in the
# Status panel.
_UNAVAILABLE_CODES = {
    StopReason.LOGIN_NEEDED,
    StopReason.CANT_REACH,
    StopReason.DAILY_CAP_REACHED,
    StopReason.BUDGET_REACHED,
}


def shared_cloud_agent(
    agent_id: str,
    desired_state: str,
    entry: dict[str, Any] | None,
    box: CloudMachine | None,
    reason: AgentStopReason | None,
    last_reply_at: str | None = None,
) -> dict[str, Any] | None:
    """One agent's card state, or None for an agent its owner stopped (Console shows its own
    "Stopped" for that)."""
    if desired_state == "stopped":
        return None
    base: dict[str, Any] = {"agent_id": agent_id, "last_reply_at": last_reply_at}

    def unavailable(**flags: Any) -> dict[str, Any]:
        return {**base, "state": "unavailable", **flags}

    if reason is not None:
        code = reason.code
        reset = reason.reset_at.isoformat() if reason.reset_at is not None else None
        if code == StopReason.PAUSED_BY_SWITCH:
            return unavailable(paused=True, stop_reason=code.value)
        if code == StopReason.TURNED_OFF_BY_ADMIN:
            return unavailable(turned_off=True, stop_reason=code.value)
        if code in _UNAVAILABLE_CODES:
            return unavailable(stop_reason=code.value, reset_at=reset)
        if code == StopReason.MEMORY_GUARD:
            return unavailable(memory_stopped=True, stop_reason=code.value)
    entry = entry or {}
    process = entry.get("process")
    if process == "failed":
        # A host its controller gave up on stays down until a restart; any other reason
        # is the machine's to explain, so the owner is sent to the agent's page.
        if entry.get("reason") == "internal":
            return unavailable(needs_restart=True)
        return unavailable(needs_check=True)
    if process == "crashed":
        return unavailable(needs_check=True)
    if box is not None:
        # A box stopped by a pause or turn-off mark, where no reason was passed (an operator's count): the
        # mark's own flag, as the reason would give.
        if box.desired_state == "stopped" and box.stop_reason == "paused":
            return unavailable(paused=True)
        if box.desired_state == "stopped" and box.stop_reason == "turned_off":
            return unavailable(turned_off=True)
        if idle_sleeping(box):
            return {**base, "state": "resting", "box_stopped": True}
        if box.state == "error":
            return unavailable(needs_check=True)
        if box.desired_state == "stopped":
            # Stopped by its owner (or on its way down): not working, and not broken.
            return {**base, "state": "resting"}
        if box.desired_state == "running" and box.state != "ready":
            return {**base, "state": "waking", "box_starting": True}
    if process == "stopped" and entry.get("reason") == "out_of_memory":
        # The memory guard stopped only this agent, where no reason was passed.
        return unavailable(memory_stopped=True)
    waiting = entry.get("waiting_for_room")
    if (
        isinstance(waiting, dict)
        and isinstance(waiting.get("count"), int)
        and waiting["count"] > 0
    ):
        return {**base, "state": "waking", "waiting_for_room": True}
    session = entry.get("session")
    if session == "parked":
        return {**base, "state": "resting"}
    if session == "waking":
        return {**base, "state": "waking"}
    # Working versus idle: whether any of its sessions is mid-turn, as its host reports.
    return {**base, "state": "working" if entry.get("busy") is True else "idle"}


OverviewBucket = Literal["working", "idle", "resting", "unavailable"]
_BUCKETS: dict[str, OverviewBucket] = {
    "working": "working",
    "idle": "idle",
    "waking": "idle",
    "resting": "resting",
    "unavailable": "unavailable",
}


def overview_bucket(card: dict[str, Any] | None) -> OverviewBucket:
    """The operators' overview count an agent falls in, from its card (`shared_cloud_agent`),
    so the overview and the person's own Console can never disagree (one mapping, here; the
    overview calls this). Back in a moment counts as idle; an agent its owner stopped as resting."""
    if card is None:
        return "resting"
    return _BUCKETS.get(card["state"], "unavailable")


@router.get("/shared-cloud/agents")
async def list_shared_cloud_agents(
    user: Annotated[User, Depends(require_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> dict[str, Any]:
    """The caller's own agents on a Switch cloud box. `available` is false when they have no box,
    which Console reads as "no shared cloud here"."""
    tenant_id = require_tenant_id()
    rows = await AgentDefinitionStore().list_for_owner(session, tenant_id, user.id)
    controllers = {
        c.id: c
        for c in await AgentControllerStore().list_for_owner(
            session, tenant_id, user.id
        )
    }
    leases = await read_leases(session, SwitchCoreProcessStore())
    signals = await load_reason_signals(
        session,
        tenant_id,
        [agent.id for _, agent in rows],
        controller_ids=list(controllers),
        owner_ids=[user.id],
    )
    await session.commit()
    now = datetime.now(UTC)
    agents = []
    for row, agent in rows:
        controller = controllers.get(row.controller_id) if row.controller_id else None
        box = signals.boxes.get(controller.id) if controller is not None else None
        if box is None:
            continue  # not on the shared cloud
        provider = (row.definition or {}).get("provider")
        reason = stop_reason(
            reason_inputs(
                agent,
                controller,
                leases,
                signals,
                now,
                provider=provider if isinstance(provider, str) else None,
            )
        )
        worked = signals.last_worked.get(agent.id)
        shown = shared_cloud_agent(
            agent.id,
            row.desired_state,
            agent_entry(controller, agent.id),
            box,
            reason,
            worked.isoformat() if worked is not None else None,
        )
        if shown is not None:
            agents.append(shown)
    return {"available": bool(signals.boxes), "agents": agents}
