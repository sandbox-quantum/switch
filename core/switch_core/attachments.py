"""Shared constants for multi-attachment messages.

An `m.room.message` media event carries exactly one `url`, a shape kept from
when Switch ran on Matrix, while messaging platforms put several files on one
post. So Switch groups at the edges: a message
with n files is sent as n media events that share a group id, and the
receiving side coalesces them back into a single logical message.

An event without the group key is a group of one, so this is fully backward
compatible with media events already in a room.
"""

# Event-content key carrying {"id": str, "index": int, "total": int}.
ATTACHMENT_GROUP_KEY = "com.switch.attachment_group"


def parse_attachment_group(
    content: dict[str, object],
) -> tuple[str, int, int] | None:
    """Extract (group_id, index, total) from event content, or None when the
    event is not part of a multi-attachment group (or the marker is malformed —
    a bad marker degrades to an ungrouped attachment rather than raising, so a
    single odd event can never stall a receiver's buffer)."""
    raw = content.get(ATTACHMENT_GROUP_KEY)
    if not isinstance(raw, dict):
        return None
    group_id = raw.get("id")
    index = raw.get("index")
    total = raw.get("total")
    if not isinstance(group_id, str) or not group_id:
        return None
    # bool is a subclass of int; a bool here means a malformed marker, not an
    # index of 0/1.
    if isinstance(index, bool) or isinstance(total, bool):
        return None
    if not isinstance(index, int) or not isinstance(total, int):
        return None
    if total < 1 or index < 0 or index >= total:
        return None
    return group_id, index, total
