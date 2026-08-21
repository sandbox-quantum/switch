from typing import Literal

from pydantic import BaseModel

ChannelType = Literal["lobby", "channel_public", "channel_private", "group", "direct"]


class ChannelCreationUnsupported(ValueError):
    """Raised when a bridge will not create a channel for a new room.

    Either the platform has no such call — a Telegram bot cannot create a chat
    — or an operator has withheld it from this connection. Both are answers to
    a caller's request rather than faults, so this is a ``ValueError``: every
    door into room creation already turns one into a 4xx carrying the message,
    where an unexpected exception becomes an opaque 500 and the explanation
    never leaves the server.
    """


class Attachment(BaseModel):
    """An inbound file attachment of any type, with its raw bytes.

    `data` holds the downloaded file content; the bridge uploads it to the
    Matrix media repository and discards the bytes afterwards.
    """

    filename: str
    mimetype: str
    data: bytes


class OutboundAttachment(BaseModel):
    """A file on its way out to an external platform, with its raw bytes."""

    filename: str
    mimetype: str
    data: bytes


class AttachmentFailure(BaseModel):
    """An inbound attachment that could not be relayed, and why.

    Carried alongside the successful attachments so the bridge can disclose the
    failure in the room. An attachment that fails must never vanish silently.
    """

    filename: str
    reason: str


class DirectoryUser(BaseModel):
    """A person as the messaging platform's own directory describes them.

    Distinct from an `ExternalUser`: that record only exists once Switch has
    seen someone speak, whereas this comes straight from the platform, so a
    user who has never posted can still be found and claimed (CHOO-2137).
    `email` is whatever the platform exposes — absent on platforms that do not
    carry one — and is offered to help a person recognise themselves in the
    list, never as proof of identity.
    """

    external_user_id: str
    username: str
    display_name: str
    email: str | None = None


class InboundMessage(BaseModel):
    channel_id: str
    channel_type: ChannelType
    sender_id: str
    sender_name: str
    content: str
    message_ref: str
    # External platform's thread root id (Mattermost root_id), set when this
    # message is a reply inside a thread. None for top-level messages.
    root_id: str | None = None
    agent_name: str | None = None
    channel_name: str | None = None
    attachments: list[Attachment] = []
    # Attachments the platform offered but the bridge could not relay (oversize,
    # download failure). Disclosed in the room rather than dropped.
    attachment_failures: list[AttachmentFailure] = []
    # The bridge's own bot handle when this message @-mentions the bridge bot
    # itself (e.g. Slack's "Agent Switch" app). None when the bot was not
    # tagged. Lets the bridge guide users who tag the app instead of an agent.
    self_mention_token: str | None = None


class InboundCommand(BaseModel):
    channel_id: str
    channel_type: ChannelType
    sender_id: str
    sender_name: str
    command: str
    args: str
    # External platform's id for the command post (Mattermost post_id), so the
    # command's bridged Matrix event can be mapped back to it and the result
    # can be threaded under the originating command message. None when the
    # platform gives us no post id.
    message_ref: str | None = None
    # External platform's thread root id (Mattermost root_id), set when the
    # command was typed as a reply inside an existing thread. None for a
    # top-level command. Used to thread the result under the thread's ROOT
    # post rather than the command post (a mid-thread reply cannot be a root).
    root_id: str | None = None
    agent_name: str | None = None
    channel_name: str | None = None


class InboundAgentJoin(BaseModel):
    channel_id: str
    channel_type: ChannelType
    agent_name: str
    channel_name: str | None = None


class InboundUserJoin(BaseModel):
    channel_id: str
    channel_type: ChannelType
    external_user_id: str
    external_username: str
    channel_name: str | None = None


class InboundAppJoin(BaseModel):
    """The bridge app/bot itself was added to a channel. Unlike an agent join
    there is no agent behind it (Slack is a single-app bridge), so this triggers
    auto-creation of the channel's room even when no agent can be associated."""

    channel_id: str
    channel_type: ChannelType
    channel_name: str | None = None


class BridgeInstallLink(BaseModel):
    """A link that adds this bridge's app to a channel in one step.

    Some platforms can express the whole install — pick a chat, grant the
    permissions the bridge needs, confirm — as a single URL, which is strictly
    better than a documented sequence of clicks an operator performs by hand.
    Adapters that can build one return it here and the operator dashboard
    offers it; the rest return nothing and the platform's own admin UI remains
    the way in.
    """

    key: str
    label: str
    description: str
    url: str


class BridgeConnectionConfig(BaseModel):
    pass


class BridgeCredentialError(Exception):
    """A bridge's credentials were rejected by the platform.

    Carries a message intended for the operator who typed them, so it is
    surfaced verbatim rather than being reduced to "invalid configuration" —
    the platform's own explanation is almost always the actionable part.
    """


class BridgeOperationError(RuntimeError):
    """A platform refused an operation the bridge asked it to perform.

    The counterpart to :class:`BridgeCredentialError` for everything after the
    credentials are accepted: a permission not granted, a name not allowed, a
    resource that is gone. A token proves only that the platform will talk to
    us, so these arrive long after registration reported success, and the
    platform's wording is again the actionable part — it names the permission
    to consent to, or the value to change.

    Distinct from :class:`ChannelCreationUnsupported`, which is Switch
    declining before it calls out at all. This one has been out to the platform
    and come back with an answer, which is why it is carried to the caller
    rather than logged behind an opaque 500.

    A ``RuntimeError`` so that callers already distinguishing "the request was
    wrong" (``ValueError``) from "the attempt failed" keep working unchanged.
    """
