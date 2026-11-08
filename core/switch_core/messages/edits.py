"""An edit: a row that names an earlier message and carries its new text.

The message itself is never rewritten. Rows are append-only, and every process
keeps a room's recent rows in memory on the strength of that
(`transport/room_cache.py`), so an edit is a row of its own, written after the
message it changes, in the shape Matrix gives one: an `m.room.message` whose
`m.relates_to` names the original with `rel_type` `m.replace`, and whose
`m.new_content` is what the original now says. Its `body` is the fallback a
reader that knows nothing of edits shows, the new text marked with `* `.

Where an edit goes is decided as it is written (`delivery/router.py`): to the
agents the original went to, as a `message_edit` event, never as a message of
its own. Whether an agent acts on it is the agent's business.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Mapping

REPLACE = "m.replace"

# When the platform says the edit was made, in milliseconds since the epoch.
# Two edits of one message can reach Switch out of order (a platform sends one
# again after a later one went through), and this is what puts them back in
# order.
EDITED_AT_KEY = "com.switch.edited_at"


@dataclass(frozen=True)
class Edit:
    """What an edit row says: the message it changes, by its room event id,
    the text that message now has, and when it was changed."""

    original_event_id: str
    body: str
    edited_at: int


def edit_content(edit: Edit) -> dict[str, object]:
    """The content that makes a message row an edit, beside its fallback body."""
    return {
        "m.new_content": {"msgtype": "m.text", "body": edit.body},
        "m.relates_to": {"rel_type": REPLACE, "event_id": edit.original_event_id},
        EDITED_AT_KEY: edit.edited_at,
    }


def edit_of(content: Mapping[str, object]) -> Edit | None:
    """The edit a row's content makes, or None when it is not one."""
    relation = content.get("m.relates_to")
    new_content = content.get("m.new_content")
    edited_at = content.get(EDITED_AT_KEY)
    if not isinstance(relation, dict) or relation.get("rel_type") != REPLACE:
        return None
    original = relation.get("event_id")
    body = new_content.get("body") if isinstance(new_content, dict) else None
    if (
        not isinstance(original, str)
        or not isinstance(body, str)
        or not isinstance(edited_at, int)
    ):
        return None
    return Edit(original_event_id=original, body=body, edited_at=edited_at)
