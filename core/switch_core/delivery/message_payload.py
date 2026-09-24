from switch_core.bridges.agent.protocol.types import AttachmentRef, MessagePayload
from switch_core.clients.admin_messages import PLATFORM_MARKER, platform_on_behalf_of
from switch_core.transport import InboundMessage


def message_payload(
    event: InboundMessage,
    *,
    addressed: bool,
    body: str,
    sender_name: str,
    thread_id: str | None,
    attachments: list[AttachmentRef],
) -> MessagePayload:
    sender_kind = None
    on_behalf_of = None
    if PLATFORM_MARKER in event.content:
        sender_kind = "platform"
        person = platform_on_behalf_of(event.content)
        if person is not None:
            on_behalf_of = person.name
            sender_name = person.name
    return MessagePayload(
        addressed=addressed,
        sender=event.sender,
        sender_name=sender_name,
        sender_kind=sender_kind,
        on_behalf_of=on_behalf_of,
        message_id=event.event_id,
        body=body,
        timestamp=event.timestamp,
        thread_id=thread_id,
        attachments=attachments,
    )
