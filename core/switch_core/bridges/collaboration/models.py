from dataclasses import dataclass
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict

from switch_core.sessions.attachments import normalise_mime_type

MimeType = Annotated[str, AfterValidator(normalise_mime_type)]
"""A media type with its parameters stripped.

Platforms report the type of a text file with a charset attached — Mattermost
and Discord both return ``text/plain; charset=utf-8`` — and every consumer of
an attachment compares against bare types, so the parameter comes off here,
once, rather than in each adapter.
"""

ChannelType = Literal["lobby", "channel_public", "channel_private", "group", "direct"]

ChannelRetirement = Literal["archived", "deleted", "left", "kept"]
"""What deleting a room does to its platform channel when all goes to plan.

`left` is the bot leaving a chat it cannot archive or delete; `kept` is a
channel Switch has no permission to touch, which somebody removes on the
platform itself.
"""

PrivateNoticeDelivery = Literal["ephemeral", "direct_message", "in_channel"]
"""How a bridge says something to one person about a message they posted.

`ephemeral` is shown in the channel to that person alone; `direct_message`
goes to a private chat between them and the bot; `in_channel` is a platform
where a bot can do neither unprompted, so the notice is posted where everyone
in the channel sees it.
"""


class RetireOutcome(BaseModel):
    """What happened to a room's platform channel when the room was deleted.

    `failed` means the channel is still there and needs cleaning up by hand;
    `reason` says why, in the platform's or the bridge's words.
    """

    outcome: Literal["archived", "deleted", "left", "kept", "failed"]
    reason: str | None = None

    @classmethod
    def failed(cls, reason: str) -> Self:
        return cls(outcome="failed", reason=reason)


class CreatedChannel(BaseModel):
    """A channel a bridge provisioned for a room.

    `name` is the name the platform shows for it, in the form the bridge
    reports when the channel is renamed. It can differ from what was asked
    for: the platform's naming rules applied, and a suffix where the name was
    taken.
    """

    id: str
    name: str


class ChannelCreationUnsupported(ValueError):
    """Raised when a bridge will not create a channel for a new room.

    Either the platform has no such call — a Telegram bot cannot create a chat
    — or an operator has withheld it from this connection. Both are answers to
    a caller's request rather than faults, so this is a ``ValueError``: every
    door into room creation already turns one into a 4xx carrying the message,
    where an unexpected exception becomes an opaque 500 and the explanation
    never leaves the server.
    """


class ChannelNotUsable(ValueError):
    """A room was asked to use an existing channel the platform says it cannot.

    Not found, or the Switch app is not in it. The message carries the
    platform's own reason, since that is what tells the person what to fix.
    """


class ChannelInUse(ValueError):
    """A room was asked to use a channel another room already uses.

    A channel maps to at most one room. A `ValueError` so that paths without
    a status of their own still answer it as the caller's mistake; the gateway
    answers it with a 409.
    """

    def __init__(self, external_channel_id: str) -> None:
        super().__init__(
            f"Channel {external_channel_id} is already used by a room. A "
            "channel can belong to only one room: choose another channel, or "
            "move that room off it first."
        )
        self.external_channel_id = external_channel_id


class PrivateChannelOwnerMissing(ValueError):
    """A private channel was asked for on a platform that needs a person to own
    it, and the person asking has no linked account there to name."""


class WebhookDeliveryUnsupported(RuntimeError):
    """A verified inbound event was routed to a bridge that cannot take one.

    Only reachable when a bridge is recorded as serving an installed workspace
    and its adapter receives events some other way — so it is a deployment
    inconsistency rather than anything the sender did, and it is raised rather
    than logged-and-dropped so the route answers with a failure the platform's
    own delivery log records.
    """


class Attachment(BaseModel):
    """An inbound file attachment of any type, with its raw bytes.

    `data` holds the downloaded file content; the bridge stores it in
    Switch's media store and discards the bytes afterwards.
    """

    filename: str
    mimetype: MimeType
    data: bytes


class OutboundAttachment(BaseModel):
    """A file on its way out to an external platform, with its raw bytes."""

    filename: str
    mimetype: MimeType
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
    # The platform reported this post as coming from an app rather than a
    # person (a Slack workflow, a third-party integration, another Switch
    # server's agent). Such a post is relayed like any other, but it cannot
    # answer a request: a decision is attributed to whoever made it, and an app
    # made none. Usage telemetry leaves it out of every count of people for the
    # same reason. Slack, Discord and Mattermost report it. Telegram never
    # delivers another bot's posts, and Teams does not mark them, so both leave
    # this False and their cards accept the answer.
    sender_is_app: bool = False
    # Content keys for the room message, beside its body.
    extra_content: dict[str, object] = {}


class InboundCommand(BaseModel):
    channel_id: str
    channel_type: ChannelType
    sender_id: str
    sender_name: str
    command: str
    args: str
    # External platform's id for the command post (Mattermost post_id), so the
    # command's bridged room event can be mapped back to it and the result
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
    # The adapter's own handle for answering this one command where only its
    # sender sees the answer, wherever it was run (Slack's `response_url`, a
    # pending Discord interaction). None when the platform gives the command
    # no private reply; `PlatformAdapter.answer_command` is what reads it.
    reply_ref: str | None = None


@dataclass(frozen=True)
class DirectPrompt:
    """A direct message to one person with a row of buttons (CHOO-4121).

    `text` is Switch Markdown, rendered by the adapter like any other body.
    Every button carries `token`, and a press names which button by its
    position in `labels`, from one: the same `(token, position)` pair the
    platforms' card buttons carry, so a press comes back through the path a
    card's does, as `position_action(position)` with the token as its value.
    """

    text: str
    token: str
    labels: tuple[str, ...]


class DirectMessageUnavailable(Exception):
    """The platform cannot message this person directly.

    The message says why in words a Switch user can act on, because it is shown
    to them in Switch Console beside the code that works instead.
    """


class InboundInteraction(BaseModel):
    """Someone operated a control the bridge put on one of its own messages.

    Unlike a message this carries no words. What it means is entirely in the
    control's id and in `value`, an opaque token the bridge minted when it
    posted the message and resolves against its own record. Neither is identity:
    who acted is `sender_id`, which comes from the platform's envelope.
    """

    channel_id: str
    sender_id: str
    # The handle Switch files the person under, and the name the platform
    # shows them by, which is what a card says answered it.
    sender_name: str
    sender_display_name: str
    action_id: str
    value: str
    # The platform's id for the message the control sits on, in the same form
    # `InboundMessage.message_ref` uses.
    message_ref: str | None = None
    # The platform's thread root the pressed message sits in, None at the top
    # level. Only a platform that answers a press with a new post rather than
    # through the interaction needs it, so most adapters leave it unset.
    thread_ref: str | None = None


class InboundAgentJoin(BaseModel):
    channel_id: str
    channel_type: ChannelType
    agent_name: str
    channel_name: str | None = None
    # The platform account that added the agent, where the platform says.
    added_by_external_user_id: str | None = None


class InboundUserJoin(BaseModel):
    channel_id: str
    channel_type: ChannelType
    external_user_id: str
    external_username: str
    channel_name: str | None = None
    # Written to the room's history without waking any agent: someone who
    # came to see the channel without being added to it (joining a Discord
    # server makes its public channels visible), not someone added to it.
    quiet: bool = False


class InboundUserLeave(BaseModel):
    """A person left a bridged channel, or was taken out of it.

    `removed_by_name` is what the platform calls whoever removed them, where
    the platform says and it was not the person themselves; None when they
    left on their own or the platform did not say.
    """

    channel_id: str
    external_user_id: str
    external_username: str | None = None
    removed_by_name: str | None = None


class ChannelMembers(BaseModel):
    """Who a platform says is in a channel, for lining a room up with it.

    `complete` is False when the listing stopped short (a page failed, a
    limit was hit): then it is good for adding people and never for removing
    them, since someone missing from it may simply not have been reached.
    `members` maps each person's platform id to their name; bots, the app
    itself and Switch's agents are left out by the adapter.
    """

    members: dict[str, str]
    complete: bool


class InboundAppJoin(BaseModel):
    """The bridge app/bot itself was added to a channel. Unlike an agent join
    there is no agent behind it (Slack is a single-app bridge), so this triggers
    auto-creation of the channel's room even when no agent can be associated."""

    channel_id: str
    channel_type: ChannelType
    channel_name: str | None = None
    # The platform account that added the app, where the platform says (Slack's
    # inviter, the Teams user who added it). Its linked Switch user owns the
    # room the channel becomes.
    added_by_external_user_id: str | None = None


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


#: Why a bridge failed, in the closed set telemetry reports it as. Never the
#: exception's message, which routinely carries a workspace name or a token
#: fragment. `PlatformAdapter.classify_failure` answers with one of these for
#: its own SDK's exceptions; the lifecycle classifies everything else.
FailureReason = Literal[
    "auth_failed", "network", "platform_error", "config_invalid", "unknown"
]


class BridgeConnectionConfig(BaseModel):
    # Validation errors reach the operator as the HTTP error, and a field's
    # input is often a token.
    model_config = ConfigDict(hide_input_in_errors=True)


class BridgeCredentialError(Exception):
    """A bridge's credentials were rejected by the platform.

    Carries a message intended for the operator who typed them, so it is
    surfaced verbatim rather than being reduced to "invalid configuration" —
    the platform's own explanation is almost always the actionable part.
    """


class BridgeStartRefused(RuntimeError):
    """A start guard refused to let a bridge run, with the reason.

    Raised before the bridge's adapter is built, so nothing of it ran. Also
    answers an edit that would leave a bridge unable to start, before the edit
    is stored.
    """


class BridgeNotRunning(RuntimeError):
    """What was asked needs the bridge running, and it is not.

    Usually the moment of a restart, so worth trying again shortly.
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
