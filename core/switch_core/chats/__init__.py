"""Chats: a gateway user taking part in Switch rooms as themselves.

A person reaches a room from Switch Console through a `member` client, one per
user per tenant, linked to their gateway user by `clients.user_id`.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from switch_core.db.models import Room

MEMBER_CLIENT_TYPE = "member"
# In a room's `metadata` when Switch Console created it as a chat.
CHAT_OPERATION_ID_KEY = "chat_operation_id"
# In a room's `metadata` when a client app made it as one of its own kind of
# room: that app lists only rooms of its kind, and every other client (Switch
# Console included) lists only rooms of none.
ROOM_KIND_KEY = "room_kind"
ROOM_KIND_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,39}$")


def require_room_kind(value: str) -> str:
    """`value` if it is a room kind: a lowercase slug of at most 40 characters."""
    if not ROOM_KIND_PATTERN.fullmatch(value):
        raise ValueError(
            "A room kind is a lowercase slug: a letter, then up to 39 letters, "
            "digits or hyphens."
        )
    return value


def room_kind_of(room: Room) -> str | None:
    kind = (room.metadata_ or {}).get(ROOM_KIND_KEY)
    return kind if isinstance(kind, str) else None


def is_console_chat(room: Room) -> bool:
    """Whether Switch Console created the room as a chat."""
    return CHAT_OPERATION_ID_KEY in (room.metadata_ or {})


def people_are_members(room: Room) -> bool:
    """Whether the room's people are the members Switch Console put in it: a
    Console chat on no messaging app. A Console chat made a channel on one
    (a Slack direct chat) counts the accounts in that channel, as any other
    bridged room does."""
    return is_console_chat(room) and room.bridge_id is None
