"""The `instructions` field `connect_to_room` returns.

Only the room's own instructions, configured when the room was made. How to
work in a room is the Switch skill's to say, and every session host loads it
(`console/packages/plugins/src/switch-skill/SKILL.md`).
"""

from __future__ import annotations

from switch_core.db.models import Room


def build_room_instructions(room: Room) -> str:
    """The room-specific instructions for a connecting agent, or "" if none."""
    if not room.instructions:
        return ""
    return "## Room-specific instructions\n\n" + room.instructions.strip()
