"""Build room connection instructions returned by `connect_to_room`.

Generated fresh on each connect so participants, capabilities, and room
state are accurate. Covers: interaction-mode selection (message / targeted
message), agent-status semantics (and how they should influence mode
choice), room setup including any external channel bridging, and any
room-specific instructions provided at room creation.
"""

from __future__ import annotations

from switch_core.bridges.agent.protocol.types import ParticipantDescriptor
from switch_core.db.models import Agent, CollaborationBridge, Room


def build_room_instructions(
    agent: Agent,
    room: Room,
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
                _interaction_modes(),
                _when_to_use_what(),
                _agent_statuses(participants),
                _room_setup(room, bridge),
            ]
        )
    if room.instructions:
        sections.append("## Room-specific instructions\n\n" + room.instructions.strip())
    return "\n\n".join(sections)


def _overview(agent: Agent, room: Room) -> str:
    return (
        f"# Connected to room: {room.name}\n\n"
        f"You are **{agent.name}** (agent_type: `{agent.agent_type}`). "
        f"{room.description or ''}"
    ).rstrip()


def _interaction_modes() -> str:
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
        '- **`send_targeted_message(target_names=["everyone"])`** — a '
        "room-wide mention: notifies every *person* in the room on its chat "
        "platform (`@channel` on Slack) and wakes no agent. Use it only when "
        "all of them need to see the message; writing `@channel` or "
        "`@everyone` into a body pages nobody.",
    ]
    return "\n".join(lines)


def _when_to_use_what() -> str:
    return (
        "## When to use which mode\n\n"
        "- **`post_message`** — discussion, status updates, results everyone "
        "should see, replies to messages addressed to you. No specific "
        "recipient expected to act.\n"
        "- **`send_targeted_message`** — when you need *a specific agent* to "
        "see and act: a question, a request, a handoff. Say what you need and "
        "what a finished answer looks like, then follow up in the room if it "
        "matters.\n\n"
        "**Rule of thumb:** message → conversation; targeted message → ask a "
        "specific participant to act. Coordinate with other agents through "
        "these two tools."
    )


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
        "targeted message: it reads your message when it next reads the room.",
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
            role_str = f", room role: `{p.room_role}`" if p.room_role else ""
            lines.append(f"- `{p.name}` (agent_type: `{p.agent_type}`{role_str})")
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
