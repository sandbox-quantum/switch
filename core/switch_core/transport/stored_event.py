from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.db.models import Message, MessageAttachment
from switch_core.messages.row import text_field
from switch_core.transport.types import (
    InboundCustomEvent,
    InboundEvent,
    InboundMedia,
    InboundMembership,
    InboundMessage,
)

MEMBERSHIP_EVENT_TYPE = "m.room.member"


def to_inbound(
    row: Message,
    attachments: list[MessageAttachment],
    *,
    transport_room_id: str,
) -> InboundEvent:
    """One stored row as the event a handler expects.

    Which of the four inbound shapes a row becomes is read off the row itself,
    the same way the Matrix transport reads it off the event class: an
    arrival, a file, a `com.switch.*` payload, or a message. The row keeps the
    whole content dict, so nothing is reconstructed here that was not sent.
    """
    content = dict(row.content)
    room_id = transport_room_id
    event_id = row.transport_event_id
    sender = row.sender_id
    timestamp = int(row.sent_at.timestamp() * 1000)

    if row.event_type == MEMBERSHIP_EVENT_TYPE:
        return InboundMembership(
            room_id=room_id,
            event_id=event_id,
            sender=sender,
            timestamp=timestamp,
            content=content,
            state_key=row.sender_id,
            membership=text_field(content.get("membership")) or "join",
            # Only an arrival is ever written, so there is no previous state
            # to read back — and a row that carries one is honoured rather
            # than second-guessed.
            prev_membership=text_field(content.get("prev_membership")),
            display_name=row.sender_name,
        )

    if row.event_type != "m.room.message":
        return InboundCustomEvent(
            room_id=room_id,
            event_id=event_id,
            sender=sender,
            timestamp=timestamp,
            content=content,
            event_type=row.event_type,
            thread_root_id=row.thread_root_event_id,
        )

    if not attachments:
        return InboundMessage(
            room_id=room_id,
            event_id=event_id,
            sender=sender,
            timestamp=timestamp,
            content=content,
            body=row.body or "",
            sender_name=row.sender_name,
            formatted_body=row.formatted_body,
            msgtype=row.msgtype or "m.text",
            thread_root_id=row.thread_root_event_id,
        )

    file = attachments[0]
    group = content.get(ATTACHMENT_GROUP_KEY)
    return InboundMedia(
        room_id=room_id,
        event_id=event_id,
        sender=sender,
        timestamp=timestamp,
        content=content,
        body=row.body or "",
        sender_name=row.sender_name,
        formatted_body=row.formatted_body,
        msgtype=row.msgtype or "m.file",
        thread_root_id=row.thread_root_event_id,
        uri=file.uri,
        filename=file.filename,
        mimetype=file.mimetype,
        size=file.size,
        group=group if isinstance(group, dict) else None,
    )
