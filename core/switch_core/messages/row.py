"""How an event's content becomes the columns beside it.

`messages` keeps the whole event in `content` and denormalises a few fields out
of it for querying. Which fields, and how they are read out, is one rule — the
writer and anything reconstructing a row from history have to agree on it, or
the same event stored twice would be two different rows.
"""

from __future__ import annotations

from switch_core.db.models import MessageAttachment


def text_field(value: object) -> str | None:
    return value if isinstance(value, str) else None


def thread_root_of(content: dict[str, object]) -> str | None:
    relation = content.get("m.relates_to")
    if not isinstance(relation, dict) or relation.get("rel_type") != "m.thread":
        return None
    return text_field(relation.get("event_id"))


def attachments_in(content: dict[str, object]) -> list[MessageAttachment]:
    """A media event carries exactly one file.

    A message with several files is sent as one event per file sharing a group
    id, so each of those events records a single attachment. The column exists
    as a list because reassembling the group is the reader's job, not the
    writer's.
    """
    uri = text_field(content.get("url"))
    if uri is None:
        return []
    info = content.get("info")
    info = info if isinstance(info, dict) else {}
    size = info.get("size")
    return [
        MessageAttachment(
            uri=uri,
            filename=text_field(content.get("filename"))
            or text_field(content.get("body")),
            mimetype=text_field(info.get("mimetype")),
            size=size if isinstance(size, int) else None,
            position=0,
        )
    ]
