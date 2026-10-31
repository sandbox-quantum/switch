"""Builds the agent event for a room message or join, for every code path.

A room row reaches an agent in one of two ways. The router builds an event when
the row is written and is for the agent (an addressed message, a join it listens
for), and stores it as one of the agent's own events (`agent_events`), the
events meant for the agent, not ones it sent. `EventBuffer` builds one later
from the `messages` row itself, for a reader that asked for the rest of the
room's conversation too. Both call the functions here, so the agent receives
the same event whichever path produced it.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AttachmentRef,
    MessagePayload,
    RoomJoinPayload,
)
from switch_core.clients.admin_messages import PLATFORM_MARKER, platform_on_behalf_of

if TYPE_CHECKING:
    from switch_core.transport.types import InboundMedia, InboundMessage


def attachment_ref(event: InboundMedia) -> AttachmentRef:
    """The file a media event carries. When the file was sent with a caption,
    `body` is the caption and the filename is in `filename`; without a
    caption, `body` is the filename."""
    return AttachmentRef(
        filename=event.filename or event.body,
        mimetype=event.mimetype or "",
        size=event.size or 0,
        mxc=event.uri,
        msgtype=event.msgtype,
    )


def message_event(
    *,
    room_id: str,
    bridge_id: str | None,
    channel_type: str | None,
    event: InboundMessage,
    addressed: bool,
    sender_name: str,
    body: str,
    thread_id: str | None,
    attachments: list[AttachmentRef] | None = None,
    opening_message: str | None = None,
    sender_role: str | None = None,
    sender_owns_agent: bool = False,
    switch_notice: str | None = None,
) -> AgentEvent:
    """Build the `message` event the agent receives, with any attached files.

    When a platform client posted the message on behalf of a person, the
    event names that person as the sender (and in `on_behalf_of`), because
    the agent should answer the person and not the client that carried the
    message.
    """
    sender_kind: str | None = None
    on_behalf_of: str | None = None
    if PLATFORM_MARKER in event.content:
        sender_kind = "platform"
        person = platform_on_behalf_of(event.content)
        if person is not None:
            on_behalf_of = person.name
            sender_name = person.name
    return AgentEvent(
        type="message",
        room_id=room_id,
        bridge_id=bridge_id,
        channel_type=channel_type,
        payload=MessagePayload(
            addressed=addressed,
            sender=event.sender,
            sender_name=sender_name,
            sender_kind=sender_kind,
            on_behalf_of=on_behalf_of,
            message_id=event.event_id,
            body=body,
            timestamp=event.timestamp,
            thread_id=thread_id,
            attachments=attachments or [],
            opening_message=opening_message,
            sender_role=sender_role,
            sender_owns_agent=sender_owns_agent,
            switch_notice=switch_notice,
        ),
    )


def room_join_event(
    *,
    room_id: str,
    bridge_id: str | None,
    channel_type: str | None,
    member: str,
    member_name: str,
    timestamp: int,
    listening: bool,
) -> AgentEvent:
    """Build the `room_join` event for someone arriving in a room.

    `listening` says whether this agent is set to receive join events in that
    room. The rest of the event is the same either way.
    """
    return AgentEvent(
        type="room_join",
        room_id=room_id,
        bridge_id=bridge_id,
        channel_type=channel_type,
        payload=RoomJoinPayload(
            member=member,
            member_name=member_name,
            timestamp=timestamp,
            listening=listening,
        ),
    )
