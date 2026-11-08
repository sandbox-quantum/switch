"""An edit to a room message, as a room row of its own.

A row is never changed once written (`RoomDeliveryCache` relies on that, and so
does the record of what was said), so an edit is a new row that points at the
original and carries the new text. Nothing here is about what an edit is for: a
queued prompt is one reader of this row, and other platforms and other kinds of
replacement can write and read the same shape.

The row's `m.relates_to` and `m.new_content` are stable wire shapes, like
`m.room.message`; no Matrix server is involved.
"""

from __future__ import annotations

from dataclasses import dataclass

MESSAGE_EDIT_EVENT_TYPE = "com.switch.message_edit"
REPLACE_RELATION = "m.replace"


@dataclass(frozen=True)
class MessageEdit:
    """What one edit says, read from or written to its row's content."""

    original_event_id: str
    new_body: str
    # Which edit of the message this is, on the platform's own clock: a later
    # edit has a higher revision whatever order the two arrive in.
    revision: int
    # Who edited it, as the `sender_id` of a room row.
    author: str
    # The room the edit was made in, as `messages.room_id`.
    room: str
    # When the platform says it was made, in epoch milliseconds.
    timestamp: int


def edit_content(edit: MessageEdit) -> dict[str, object]:
    """The content of the row an edit is written as."""
    return {
        "m.relates_to": {
            "rel_type": REPLACE_RELATION,
            "event_id": edit.original_event_id,
        },
        "m.new_content": {"msgtype": "m.text", "body": edit.new_body},
        "revision": edit.revision,
        "author": edit.author,
        "room": edit.room,
        "timestamp": edit.timestamp,
    }


def parse_edit(content: dict[str, object]) -> MessageEdit | None:
    """The edit a row's content describes, or None when it does not describe one."""
    relates = content.get("m.relates_to")
    new_content = content.get("m.new_content")
    if not isinstance(relates, dict) or not isinstance(new_content, dict):
        return None
    if relates.get("rel_type") != REPLACE_RELATION:
        return None
    original = relates.get("event_id")
    body = new_content.get("body")
    revision = content.get("revision")
    author = content.get("author")
    room = content.get("room")
    timestamp = content.get("timestamp")
    if (
        not isinstance(original, str)
        or not original
        or not isinstance(body, str)
        or not isinstance(revision, int)
        or isinstance(revision, bool)
        or not isinstance(author, str)
        or not isinstance(room, str)
        or not isinstance(timestamp, int)
        or isinstance(timestamp, bool)
    ):
        return None
    return MessageEdit(
        original_event_id=original,
        new_body=body,
        revision=revision,
        author=author,
        room=room,
        timestamp=timestamp,
    )


def edit_source(original_event_id: str, revision: int) -> str:
    """What an edit's row id is derived from (`transport/derived_ids.py`): the
    message and the revision, so the same edit delivered twice is one row."""
    return f"edit\x1f{original_event_id}\x1f{revision}"
