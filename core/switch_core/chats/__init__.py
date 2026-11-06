"""Chats: a gateway user taking part in Switch rooms as themselves.

A person reaches a room from Switch Console through a `member` client, one per
user per tenant, linked to their gateway user by `clients.user_id`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from switch_core.db.models import Room

MEMBER_CLIENT_TYPE = "member"
# In a room's `metadata` when Switch Console created it as a chat.
CHAT_OPERATION_ID_KEY = "chat_operation_id"


def is_console_chat(room: Room) -> bool:
    """Whether Switch Console created the room as a chat. Its people are the
    members it added, not accounts on a messaging app."""
    return CHAT_OPERATION_ID_KEY in (room.metadata_ or {})
