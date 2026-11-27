"""One agent's state on the shared cloud, as a card, and the operators' overview count it
falls in.

One agent's state comes from what Core already holds: its controller's status report entry, its
box's lifecycle and its stop reason. The mapping follows Console's `sharedCloudFromSession` card rules,
plus the stop reasons, plus `busy` (whether any session is mid-turn) to tell working from idle. Only
the caller's own agents, only fixed states, flags, codes and times: never message text, prompts
or anything about other people's boxes.
"""

from __future__ import annotations

from typing import Any, Literal

from switch_core.db.models import CloudMachine
from switch_core.db.stores.hosted_machine_store import idle_sleeping
from switch_core.visibility.reason_codes import StopReason
from switch_core.visibility.stop_reasons import AgentStopReason

# The codes that change the card (the copy): the others keep its usual state and show in the
# Status panel.
_UNAVAILABLE_CODES = {
    StopReason.LOGIN_NEEDED,
    StopReason.CANT_REACH,
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
