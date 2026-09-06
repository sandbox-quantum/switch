"""Build room connection instructions returned by `connect_to_room`.

Generated fresh on each connect so participants, capabilities, and room
state are accurate. Covers: interaction-mode selection (message / targeted
message / task), the task lifecycle, agent-status semantics (and how they
should influence mode choice), room setup including any external channel
bridging, and any room-specific instructions provided at room creation.
"""

from __future__ import annotations

from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    ParticipantDescriptor,
)
from switch_core.db.models import Agent, CollaborationBridge, Room
from switch_core.disclosure import audience_of, bridge_is_external

_AUDIENCE_MEANING: dict[str, str] = {
    "private": "one person and you",
    "restricted": "a named, closed group",
    "open": "anyone in the workspace",
    "external": "includes people outside the organisation",
    "unknown": (
        "not established — treat it as the widest it could be, in both directions"
    ),
}


def build_room_instructions(
    agent: Agent,
    room: Room,
    profile: IntegrationProfile,
    participants: list[ParticipantDescriptor],
    bridge: CollaborationBridge | None,
    include_general: bool = True,
) -> str:
    """Compose the instructions string for the connecting agent.

    When ``include_general`` is False, only the room-specific instructions
    (configured at room creation) are returned; the general Switch workflow
    sections are omitted. This is used by hosts that already inject the
    general usage instructions out-of-band (e.g. via a Claude Code skill).
    """
    sections: list[str] = []
    if include_general:
        sections.extend(
            [
                _overview(agent, room),
                _interaction_modes(profile),
                _when_to_use_what(),
                _task_protocol(profile),
                _agent_statuses(participants),
                _room_setup(room, bridge),
            ]
        )
    # Outside the `include_general` gate on purpose. That flag means "this host
    # already teaches the Switch workflow out-of-band", and all three connector
    # skills set it — but who can read *this* room is not workflow, it is this
    # room's state, and a skill written once cannot carry it.
    sections.append(_disclosure(room, bridge))
    if room.instructions:
        sections.append("## Room-specific instructions\n\n" + room.instructions.strip())
    return "\n\n".join(sections)


def _overview(agent: Agent, room: Room) -> str:
    return (
        f"# Connected to room: {room.name}\n\n"
        f"You are **{agent.name}** (agent_type: `{agent.agent_type}`). "
        f"{room.description or ''}"
    ).rstrip()


def _interaction_modes(profile: IntegrationProfile) -> str:
    caps = profile.task_protocol
    lines = [
        "## Interaction modes",
        "",
        "- **`post_message`** — broadcasts to the room. Visible to everyone; "
        "delivered as *unaddressed* context to other agents.",
        "- **`send_targeted_message`** — broadcasts to the room but prepends "
        "`@mentions` for specific agents (via `target_names`) and/or roles "
        "(via `target_roles`), who then receive it as an *addressed* event "
        "(they will respond). A role target fans out to every live holder of "
        "that role. Others see it as context.",
    ]
    if caps.can_delegate or caps.can_accept:
        lines.append(
            "- **Task tools** (`delegate_task`, `accept_task`, `update_task`, "
            "`finalise_task`, `cancel_task`, `list_tasks`) — formal tracked "
            "work with a persistent lifecycle. Tasks survive disconnects and "
            "are queryable later."
        )
    return "\n".join(lines)


def _when_to_use_what() -> str:
    return (
        "## When to use which mode\n\n"
        "- **`post_message`** — discussion, status updates, results everyone "
        "should see, replies to messages addressed to you. No specific "
        "recipient expected to act.\n"
        "- **`send_targeted_message`** — when you need *a specific agent* to "
        "see and respond, but the work is informal (a question, a nudge, a "
        "handoff) and doesn't need lifecycle tracking. Use for things you "
        "expect a quick answer to.\n"
        "- **`delegate_task`** — when the work is concrete, the outcome "
        "matters, and you'll want to check on it later. Tasks are the right "
        "mode when (a) the performer is `session_passive` (so async work is "
        "expected anyway), (b) you'll want to enumerate outstanding items "
        "later, or (c) you need a recorded outcome.\n\n"
        "**Rule of thumb:** message → conversation; targeted message → "
        "request a synchronous response; task → request tracked work."
    )


def _task_protocol(profile: IntegrationProfile) -> str:
    caps = profile.task_protocol
    if not (caps.can_delegate or caps.can_accept):
        return (
            "## Task protocol\n\n"
            "You are not configured to delegate or accept tasks "
            "(`task_protocol.can_delegate=false`, `can_accept=false`). "
            "Task events from others may still appear as context."
        )

    lines = [
        "## Task protocol",
        "",
        "Lifecycle: `pending` → `ongoing` → `finalised` (or `cancelled`).",
        "",
    ]
    if caps.can_delegate:
        lines += [
            "**You can delegate** (`can_delegate=true`):",
            "- Call `delegate_task(performer_agent_id, summary, description)`. "
            "Task starts `pending`.",
            "- Watch for `task_update` events (progress) and `task_finalise` "
            "(completed with `outcome`).",
            "- Call `cancel_task(task_id, reason)` to abandon.",
            "",
        ]
    if caps.can_accept:
        lines += [
            "**You can accept** (`can_accept=true`):",
            "- On `task_delegate` event: call `accept_task(task_id)` → moves "
            "to `ongoing`.",
            "- Optionally `update_task(task_id, update)` with progress "
            "messages (persisted to the task).",
            "- Call `finalise_task(task_id, outcome)` when done. `outcome` "
            "describes success or failure in one string.",
            "",
        ]
    lines.append(
        "Use `list_tasks(role='delegated'|'assigned', status=...)` to enumerate."
    )
    return "\n".join(lines)


def _agent_statuses(participants: list[ParticipantDescriptor]) -> str:
    lines = [
        "## Agent statuses (and how they affect mode choice)",
        "",
        "Agents run in one of three connection models, which determines how "
        "responsive they are:",
        "",
        "- **`always_on`** — connected continuously. Safe to use messages "
        "or targeted messages — expect prompt responses.",
        "- **`session_addressable`** — connected only when a session is "
        "active. Targeted messages work when they are online; otherwise "
        "delivery is deferred.",
        "- **`session_passive`** — connected via MCP but only reads room "
        "context on demand. **Do not** expect a synchronous response from a "
        "targeted message. Prefer `delegate_task` so the work is tracked and "
        "the agent picks it up when they next read context.",
        "",
        "**Participants in this room:**",
        "",
    ]
    if not participants:
        lines.append("- (none)")
    else:
        for p in participants:
            if p.type == "user":
                lines.append(f"- `{p.name}` (user)")
                continue
            caps = []
            if p.can_delegate:
                caps.append("delegate")
            if p.can_accept:
                caps.append("accept")
            cap_str = f" — tasks: {', '.join(caps)}" if caps else ""
            role_str = f", room role: `{p.room_role}`" if p.room_role else ""
            lines.append(
                f"- `{p.name}` (agent_type: `{p.agent_type}`{role_str}){cap_str}"
            )
    return "\n".join(lines)


def _disclosure(room: Room, bridge: CollaborationBridge | None) -> str:
    """State who can read this room, and what may be repeated into it.

    A connection covering several rooms holds a private DM and an open channel
    in one context window. The model cannot be discreet about a boundary it
    cannot see, so the boundary is named here — in the standing instructions,
    where it applies for the whole session rather than arriving attached to one
    event.
    """
    audience = audience_of(
        room.channel_type,
        bridge_is_external=bridge_is_external(bridge.type if bridge else None),
    )
    lines = [
        "## Who can read this room",
        "",
        f"- Audience: **{audience}** — {_AUDIENCE_MEANING[audience]}",
        "",
        "You may be connected to several rooms at once, and they will not all "
        "have the same audience. Anything said here may be repeated here. "
        "Repeating it in a **different** room is free only when this room is "
        "`open` *and* the other room is inside the organisation — never into "
        "one whose audience is `external` or `unknown`, whatever this room's "
        "is.",
        "",
        "Otherwise — including into another room with the same label — assume "
        "you may not. **A different DM is a different person; one outside "
        "correspondent is not another.** Two rooms sharing an audience are "
        "almost never the same audience.",
        "",
        "The permission you need belongs to the people whose room it came "
        "from, given in that room. It is not the permission of whoever you are "
        "talking to now: they cannot ask for something they do not know exists, "
        "and asking them would itself be the disclosure.",
        "",
        "This is about repeating, not knowing. Use everything you know to give "
        "the best answer you can — what you must not do is carry across the "
        "substance of what was said elsewhere, attributed or not. A paraphrase "
        "somebody can work backwards from is the same disclosure as a quote. "
        "Refusing to *use* what you know produces a visibly worse answer and "
        "protects nobody.",
    ]
    return "\n".join(lines)


def _room_setup(room: Room, bridge: CollaborationBridge | None) -> str:
    lines = ["## Room setup", ""]
    lines.append(f"- Channel type: `{room.channel_type or 'group'}`")
    if room.admin_mode:
        lines.append("- Room is in **admin mode** (elevated capabilities).")
    if bridge is not None:
        lines.append(
            f"- Room is **bridged** to an external `{bridge.type}` channel "
            f"({bridge.display_name}, external id: "
            f"`{room.external_channel_id}`). "
            "Human users may post directly from that channel — their "
            "messages appear here as room participants. Reply with "
            "`post_message` (or `send_targeted_message` if addressing a "
            "specific agent); the bridge will deliver it back to the "
            "external channel."
        )
    else:
        lines.append(
            "- Room is **not bridged** — only the agents listed above are participants."
        )
    return "\n".join(lines)
