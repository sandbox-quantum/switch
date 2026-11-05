"""An edit of a message already in a room.

An edit is a room message of its own that refers to the message it replaces
and carries the new text, the shape Matrix uses (`m.replace`):

    {
      "msgtype": "m.text",
      "body": "* <new text>",
      "m.new_content": {"msgtype": "m.text", "body": "<new text>"},
      "m.relates_to": {"rel_type": "m.replace", "event_id": "<original>"},
    }

`body` is a fallback for a reader that does not know about edits. The shape
says nothing about why the message was edited or what should happen next, so
anything that reacts to a message changing (a queued prompt, a platform that
reports edits, a cancel that is a delete) can read the same row.
"""

from __future__ import annotations

from dataclasses import dataclass

EDIT_REL_TYPE = "m.replace"


@dataclass(frozen=True)
class Edit:
    """What an edit row says: the message it replaces and that message's
    new text."""

    original_event_id: str
    body: str


def edit_content(original_event_id: str, body: str) -> dict[str, object]:
    """The content fields that make a room message an edit of
    `original_event_id`, to merge into an ordinary message's content."""
    return {
        "m.new_content": {"msgtype": "m.text", "body": body},
        "m.relates_to": {"rel_type": EDIT_REL_TYPE, "event_id": original_event_id},
    }


def edit_fallback(body: str) -> str:
    """The `body` an edit row carries for readers that do not read edits."""
    return f"* {body}"


def parse_edit(content: dict[str, object]) -> Edit | None:
    """The edit `content` describes, or None when it is not an edit."""
    relation = content.get("m.relates_to")
    if not isinstance(relation, dict) or relation.get("rel_type") != EDIT_REL_TYPE:
        return None
    original = relation.get("event_id")
    if not isinstance(original, str) or not original:
        return None
    new_content = content.get("m.new_content")
    body = new_content.get("body") if isinstance(new_content, dict) else None
    if not isinstance(body, str):
        return None
    return Edit(original_event_id=original, body=body)


def is_edit(content: dict[str, object]) -> bool:
    return parse_edit(content) is not None
