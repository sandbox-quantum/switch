from __future__ import annotations

import logging
import math
import sys
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import (
    TYPE_CHECKING,
    Any,
    ClassVar,
    Literal,
    Protocol,
    final,
    runtime_checkable,
)

from switch_core.agent_display_name import defuse_label_markup
from switch_core.agent_icon import (
    generated_icon_url,
    initials_icon_url,
    is_third_party_avatar,
)
from switch_core.bridges.collaboration.ingress import CallbackEndpoint
from switch_core.bridges.collaboration.install import InboundWebhook, WebhookRequest
from switch_core.bridges.collaboration.models import (
    BridgeInstallLink,
    ChannelCreationUnsupported,
    ChannelMembers,
    ChannelRetirement,
    ChannelType,
    CreatedChannel,
    DirectMessageUnavailable,
    DirectoryUser,
    DirectPrompt,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    InboundUserLeave,
    OutboundAttachment,
    PrivateNoticeDelivery,
    RetireOutcome,
    WebhookDeliveryUnsupported,
)
from switch_core.bridges.collaboration.session.renderers import (
    MARKDOWN,
    Markup,
    RequestReference,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    request_summary,
    turn_summary,
)
from switch_core.deeplinks import rewrite_console_links
from switch_core.messaging_platforms import MessagingPlatform
from switch_core.outbound import OutboundPolicy
from switch_core.room_wide_mention import (
    ROOM_WIDE_TARGET,
    defuse_mass_mention_words,
    strip_room_wide_target,
)
from switch_core.sessions.contract import (
    Item,
    SnapshotRequest,
    TurnUpsert,
)
from switch_core.ui_spec import UISpec

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.models import Agent

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AgentIdentity:
    """An agent as a bridge needs it to keep the agent's platform handle.

    ``agent_id`` is the stable key: it never changes, so a platform object
    tied to it survives a rename on either side. ``name`` is the identifier
    people type and mention, and it can change.
    """

    agent_id: str
    name: str
    description: str
    display_name: str | None


def agent_identity(agent: Agent) -> AgentIdentity:
    """The identity a bridge keeps for this stored agent."""
    return AgentIdentity(
        agent_id=agent.id,
        name=agent.name,
        description=agent.description,
        display_name=agent.display_name,
    )


class AgentIdentityConflict(ValueError):
    """The platform already has something that is not this agent under the
    handle the agent would need, so the agent cannot take that name there."""


@dataclass(frozen=True)
class AgentPresentation:
    """The presentation columns of one agent, exactly as they are stored.

    Raw on purpose: ``None`` in either field means the agent was given no value
    for it, and what stands in for a missing value is per-platform — Mattermost
    wants a default icon in a format it can upload, Slack wants one drawn on its
    own background. Deciding that here would take the choice away from the
    adapter that has to live with it.
    """

    display_name: str | None
    icon_url: str | None


@dataclass(frozen=True)
class AgentRendering:
    """How one agent is presented on one send, resolved for this platform.

    The two labels are separate members rather than one because they are not
    interchangeable: ``field_label`` is safe only in a platform field that
    carries a name on its own, and putting it in message text is how a display
    name forges markup. A caller building a body string reaches for the member
    whose name says so.
    """

    field_label: str
    body_label: str
    # None when the platform should draw its own default icon for the sender.
    icon_url: str | None


@dataclass(frozen=True)
class TurnActivity:
    """A turn's items and its own status, as `post_rich` / `update_rich` draw it.

    Carries the contract types directly rather than a pre-rendered payload —
    an adapter with a card of its own reads them to build one; the base,
    which has none, reads them to build `turn_summary` instead. Neither has to
    agree on a shape neither of them owns.

    `elapsed_seconds` is not part of the contract — neither a turn nor an item
    carries a timestamp — so it travels here instead, from whatever tracked
    one against the session's own event log. `None` until a caller has one to
    give. Running turns use it for the live clock; ended turns show the final duration.
    """

    items: list[Item]
    turn: TurnUpsert
    elapsed_seconds: float | None = None
    status_only: bool = False
    # Stable recovery marker for a reserved platform post, not an answer token.
    publication_token: str | None = None
    notify_external_id: str | None = None
    # There was someone who should be told and nobody here to name: the agent
    # has no owner, or an owner who has claimed no account on this platform.
    # Distinct from `notify_external_id` being None on a redraw, which means
    # the mention has already been made and must not be repeated.
    notify_unreachable: bool = False
    # Canned, room-safe attention message. Never raw host/provider output.
    error_summary: str | None = None
    # The turn a stop control on this message interrupts, which is the session's
    # running turn and not necessarily `turn`: a queued turn's message offers to
    # stop whatever is in front of it, because that is what has to end before
    # this one starts. None where there is nothing to stop — no running turn, or
    # a session that cannot be interrupted — and the control is not drawn.
    #
    # It is carried rather than looked up when the press arrives, because the
    # reader pressed what they could see. A message drawn against turn A and not
    # yet redrawn still names A after B has started, so a press on it is refused
    # for naming an ended turn rather than silently stopping B.
    interrupt_turn_id: str | None = None


@dataclass(frozen=True)
class ActivitySnapshot:
    """The same turn as `TurnActivity`, read back because a reader asked.

    `TurnActivity` is pushed at an adapter when a turn changes; this is pulled
    by one because somebody operated a control on the message a turn is being
    shown in, and wants what is behind it. What that reader is shown must
    therefore say when it was read: a view opened ten minutes ago and never
    refreshed is not wrong, but it is not current either, and it has no way of
    knowing that unless it is told.
    """

    items: list[Item]
    turn: TurnUpsert
    elapsed_seconds: float | None
    read_at: datetime


@dataclass(frozen=True)
class RequestCard:
    """A request and how a platform refers back to it, as `post_rich` /
    `update_rich` draw it. See `TurnActivity` for why the contract type
    travels rather than a rendering of it.

    `turn`/`items`/`elapsed_seconds` are set only once the request's own
    turn is drawn with it rather than apart from it — a card whose turn has
    not been folded in yet, or never will be, carries `turn=None` and draws
    exactly as it always has. `turn` alone is the switch: `items` defaults
    to empty rather than to `None`, so a turn that has emitted nothing yet
    is a state this can represent and draw correctly, not one a caller can
    accidentally leave unset and have silently dropped.
    """

    request: SnapshotRequest
    reference: RequestReference
    turn: TurnUpsert | None = None
    items: list[Item] = field(default_factory=list)
    elapsed_seconds: float | None = None

    responder_external_id: str | None = None
    # Presentation only: never changes the SDK request or its authorization.
    unavailable_reason: str | None = None
    notify_external_id: str | None = None
    # As on `TurnActivity`, and for the same reason: a card being asked of
    # nobody is not the same as a redraw of one already asked, and only the
    # first is worth saying out loud.
    notify_unreachable: bool = False
    # The request's turn was asked at the channel root, so a card threaded
    # under that message is somewhere the channel does not look. Set on the
    # first post only; an adapter that can also show a thread reply in the
    # channel (Slack's `reply_broadcast`) does.
    asked_at_root: bool = False


RichContent = TurnActivity | RequestCard


class RichContentFailed(Exception):
    """`post_rich` or `update_rich` could not draw its content on this platform.

    Every implementation raises this — chaining the platform's own error as
    `__cause__` where there is one, the way `SlackAdapter`'s does with
    `SlackApiError` — so a caller has one thing to catch regardless of which
    platform posted the content. Unlike `send_message` and `update_message`,
    which report failure by return value or not at all, this seam raises on
    both ends: a caller cannot forget to check what it did not ask to be told.

    `text` is what the platform was attempting to show — the same string a
    reader would have seen, whichever renderer produced it. A caller updating
    a card, in particular, needs it: the existing "could not be updated, here
    is the outcome" fallback reply is only honest if it names what the card
    now can't, and it must do that without knowing how any given platform
    drew it.
    """

    def __init__(self, message: str, *, text: str) -> None:
        super().__init__(message)
        self.text = text


class MessagePartlySent(Exception):
    """A message split over several platform messages stopped part way.

    Raised by `send_message` and `admin_message` once at least one part is on
    the platform, never when none is: nothing posted is still a `None` ref.
    The parts that went out stay, followed where the platform allowed it by a
    notice in the channel saying the rest is missing.

    `first_ref` names the first part, which is what a caller records the
    message as, the same ref a complete send would have returned. A caller that
    let the message be sent again instead would post the delivered parts a
    second time.
    """

    def __init__(
        self, *, platform: str, first_ref: str, delivered: int, total: int
    ) -> None:
        super().__init__(
            f"Only {delivered} of {total} parts of a message reached {platform}; "
            f"the first is {first_ref}."
        )
        self.first_ref = first_ref
        self.delivered = delivered
        self.total = total


class PrivateNoticeRefused(Exception):
    """The platform would not let the bot reach this person privately, as it
    refuses for someone who never opened a chat with the bot, blocked it, or
    takes no direct messages. Expected on those platforms, so the caller logs
    it without a traceback and posts the notice in the channel instead."""


class CardRejectedError(Exception):
    """The platform refused a card, or it could not be drawn there, before
    anything was posted: the caller posts the message's text instead. Any other
    failure leaves it unknown whether the card landed."""


class ChannelNotBindable(ValueError):
    """A room was asked to bind to a channel that is not this bridge's to bind.

    A `ValueError` because it is the caller's input that is wrong, and every
    path that binds a channel already answers those as a bad request.
    """


class ConfigEditRefused(ValueError):
    """An edit of a connection's settings that the platform says is wrong.

    A `ValueError` for the same reason as `ChannelNotBindable`: it is the
    caller's input, answered as a bad request.
    """


class DirectorySearchBusy(RuntimeError):
    """The platform's directory is being searched too often to take one more.

    Refused at once rather than queued: a search is someone waiting on a
    dialog, and one that sat behind a spent budget would only time out later.
    A `RuntimeError`, so anything that reads directory failures as the
    platform's still does.
    """

    def __init__(self, retry_after: float) -> None:
        super().__init__(
            "Too many directory searches right now — try again in "
            f"{math.ceil(retry_after)} seconds"
        )
        self.retry_after = retry_after


class RemovalFailed(Exception):
    """A published message could not be taken back, or not provably.

    Deliberately not `delete_message`, which every adapter but Teams' answers
    by logging: that one is best-effort housekeeping for things like the
    typing indicator, where a leftover is untidy and nothing more. Taking back
    an answered permission card is the opposite — the caller has to write down
    that the card is gone, and writing that down on a refusal it never heard
    about is how a restart comes to skip a card still sitting in the channel.

    So this seam raises, the way `post_rich` and `update_rich` do, and a
    platform's own error is chained as `__cause__`. A refusal and a request
    that never came back are one exception because the caller does the same
    thing with both: keep the settled card, record no removal, and try again
    on a widening interval. What is *not* folded in here is a wait the
    platform asked for — that is `RichContentThrottled`, and it carries the
    delay, so being busy cannot be read as being unable.
    """


class RichContentThrottled(RichContentFailed):
    """The platform asked us to wait before attempting another update."""

    def __init__(self, *, retry_after: float, text: str) -> None:
        super().__init__("Platform updates are rate limited.", text=text)
        self.retry_after = retry_after


class RichContentFailedAfterPost(RichContentFailed):
    """The message was posted, but what goes in it could not be drawn.

    Slack opens a turn's stream and then takes its content in a separate call,
    and the second can fail after the first has made the message. `ref` names
    that message, so the caller keeps it and draws into it later rather than
    posting again, which would leave a second message in the thread and the
    first one empty.
    """

    def __init__(self, message: str, *, ref: str, text: str) -> None:
        super().__init__(message, text=text)
        self.ref = ref


class RichContentThrottledAfterPost(RichContentThrottled, RichContentFailedAfterPost):
    """The message was posted, and the platform asked for a wait before what
    goes in it could be drawn.

    A `RichContentThrottled` as well, so the wait is the one asked for.
    """

    def __init__(self, *, ref: str, retry_after: float, text: str) -> None:
        # Not through `RichContentThrottled.__init__`: its `super()` call
        # reaches `RichContentFailedAfterPost` here, which needs the ref.
        RichContentFailedAfterPost.__init__(
            self, "Platform updates are rate limited.", ref=ref, text=text
        )
        self.retry_after = retry_after


class RichContentWedged(RichContentFailed):
    """The platform will not change this message, and never will again.

    Slack leaves a message flagged as streaming while dropping the stream that
    flag refers to. An edit is then refused as an edit to something streaming,
    both stream calls are refused because the stream is gone, and a delete is
    refused as well — measured, not assumed. Nothing sendable moves it, so it
    keeps whatever it last showed, which for a turn that has since ended is a
    card still drawn as running.

    Separate from `RichContentFailed` because the two want opposite things. An
    ordinary failure is worth another attempt; this one is worth none, and
    retrying spends the workspace's rate budget on a message that cannot move.
    What it does deserve is for the reader to be told, since what they are
    looking at is untrue and nothing about the message itself can say so.

    Raised on the attempt that discovers the state. Later attempts on the same
    message return quietly: the caller has already been told, and the point of
    telling it was to stop.
    """


class ThreadUnavailable(RichContentFailed):
    """No thread exists under the root message, and none could be made.

    A statement of fact, not a verdict on where the content should go instead.
    An absent thread looks the same whether it was never made or was made
    privately and then deleted, and only the caller knows which: it holds the
    recorded origin of the command, and the platform does not. Posting to the
    parent channel is right in the first case and hands a private
    conversation's contents to an audience in the second.

    Nothing has been posted when this is raised, so a caller may post
    elsewhere — or release its reservation, as for any `RichContentFailed`.
    """


class ActivityMarkRefused(RuntimeError):
    """The platform will not change the work mark, and another attempt will not.

    Reactions switched off in the chat, or a permission the bot does not have:
    refused now means refused for the life of the turn. Anything a retry might
    fix is left to raise as itself, so the publisher can tell the two apart.

    Raised for a refused *removal* as well as a refused addition. Whether that
    matters is not the adapter's to decide — it depends on whether a mark was
    ever put there, which only the durable record knows after a restart.
    """


#: Which indicator a message is carrying, where a platform can carry one.
#:
#: "working" is the agent reading and acting on the message. "queued" is the
#: agent holding it behind something else and not started, which is a different
#: thing to be told and is why it is a mark of its own rather than a second
#: meaning for the first.
ActivityMark = Literal["working", "queued"]

#: How a platform refused a send, for a caller deciding whether to send it again.
#:
#: "permanent": sending the same thing again is refused again (the request is
#: too large, the method is not allowed). "bounded": a refusal that is usually
#: final but can clear on its own, such as a bot not yet added to the channel
#: or a post not yet visible, so worth a few more attempts and no more.
#: "transient": a timeout, a dropped connection, a server error, a rate limit,
#: an expired session, or anything the adapter cannot recognise.
RefusalKind = Literal["permanent", "bounded", "transient"]


@runtime_checkable
class SupportsSharedConnection(Protocol):
    """An adapter that runs on a shared, deployment-level connection it does not
    own, attached after it starts rather than dialled at start.

    A distributed bridge (currently only Discord) starts inert and is handed the
    one shared connection once it is up — at boot for installs that already
    exist, and lazily on first event for one added at runtime. Attaching also
    re-runs whatever start-time work needed the connection (agent identities).

    Structural on purpose: the lifecycle, the gateway and boot narrow to this
    with `isinstance` and stay ignorant of the concrete adapter, and an adapter
    with no shared connection (Slack, Mattermost, Teams, Telegram) never matches
    and is left alone. A bridge on the distributed Teams app shares the
    deployment's app too, but has nothing to wait for: it is handed the app
    before it starts, by its own bridge-starting listener, and never matches.
    """

    def attach_shared_connection(self, connection: Any) -> None: ...

    def set_on_attached(self, callback: Callable[[], None]) -> None: ...

    def awaiting_shared_connection(self) -> bool:
        """Whether this bridge runs on the shared connection and has not been
        attached to it yet, so nothing that reaches the platform can run."""
        ...


class PlatformAdapter(ABC):
    #: The platform as a person names it — "Microsoft Teams", not "teams".
    #:
    #: Required: registration refuses an adapter without one. It is what
    #: Console labels the platform with, what a card says an answer came
    #: "from", and what the adapter's own messages call the platform.
    display_name: ClassVar[str]

    #: The page under the messaging-apps docs that explains how to connect
    #: this platform (`docs/.../messaging-apps/<docs_slug>`), or None where
    #: there is none yet. Console links "how do I set this up?" to it.
    docs_slug: ClassVar[str | None] = None

    #: The name of the logo file shipped in the adapter's own folder. Served to
    #: Console as the platform's icon; a platform without one is drawn with a
    #: generic icon. SVG only, because Console draws it at every size.
    icon_file: ClassVar[str] = "icon.svg"

    #: Whether this platform delivers its events by calling Switch over HTTP,
    #: on an address of each connection's own (`/messaging/bridges/<id>/events`).
    #:
    #: Set by an adapter that implements `verify_webhook` and `parse_webhook`.
    #: Most adapters dial out to their platform and are handed events on a
    #: connection they opened; they leave this False.
    receives_webhooks: ClassVar[bool] = False

    #: Whether this platform draws agents' session activity: each turn step by
    #: step, and the approval and question cards a session waits on.
    draws_session_activity: ClassVar[bool] = False

    #: Whether a problem somebody has to act on gets a message of its own.
    #:
    #: One durable reply per turn, reused as the problem changes and cleared
    #: when it goes away — never a second one. A turn's own activity stays in
    #: the one message it is drawn in; this is the exception, because a failure
    #: has to arrive as something a reader is notified about rather than as an
    #: edit to a message they have already scrolled past.
    separate_attention_slot: ClassVar[bool] = False

    #: Whether a mention is the only way an attention post reaches anyone.
    #:
    #: True where nobody follows a thread they are not already in, so a post
    #: that names no one is read by no one. What follows from that is the
    #: admission: an attention post with nobody to name says so, because one
    #: that notified no one otherwise looks exactly like one that notified the
    #: right person. Who gets named is not decided here — the asker leads
    #: everywhere, with the agent's owner as the fallback.
    #:
    #: False where the platform's own following does that work: a Slack
    #: participant gets the threaded reply without being named, and naming
    #: them is a notification they already had.
    notifies_only_by_mention: ClassVar[bool] = False

    #: Whether a reply posted in a thread can also be shown in the channel the
    #: thread hangs under.
    #:
    #: True where one message can be in both at once, the way Slack's
    #: `reply_broadcast` is: the thread keeps the conversation, and the
    #: channel still sees the question, without a second post to answer.
    #:
    #: False everywhere else, and a request card for a turn that was asked at
    #: the channel root goes to the root itself there. A card filed in a
    #: thread nobody opened is a question nobody sees, and the answer it waits
    #: for can only come from that thread — so whoever replies in the channel,
    #: where they were asked, leaves the agent waiting on a thread they never
    #: knew about.
    broadcasts_thread_replies: ClassVar[bool] = False

    #: The token that pages every member of a channel, for a room-wide mention.
    #:
    #: None where the platform has none a bot can send. A room-wide mention
    #: there still posts, opening with an inert `@everyone`, and the agent is
    #: told it paged nobody — unless `every_message_notifies_members` says the
    #: platform does that work itself.
    channel_mention: ClassVar[str | None] = None

    #: Whether every message already notifies every member of the chat, so a
    #: room-wide mention needs no token of its own to reach them all.
    every_message_notifies_members: ClassVar[bool] = False

    #: Whether a ticking clock is reason enough to redraw a running turn.
    #:
    #: True where the status is a small line of its own that a reader watches
    #: for exactly that, so the seconds advancing is the message doing its job.
    #: False where the status is the turn's one post: there the elapsed time
    #: rides along with the next real change — a tool, a state, the ending —
    #: rather than rewriting the post a reader is in the middle of, and the
    #: final update still shows what the turn actually took.
    redraws_for_elapsed_time: ClassVar[bool] = False

    supports_activity_reactions: ClassVar[bool] = False

    #: Whether a prompt still waiting its turn can be marked as well.
    #:
    #: A second reaction beside the working one, saying the agent has the
    #: prompt but has not started on it. Separate from
    #: `supports_activity_reactions` because it asks more of the platform: not
    #: that a bot can react, but that it can hold two reactions on one message
    #: at once. Telegram allows a bot exactly one, so the queued state is
    #: carried by its status text alone and never by a mark.
    supports_queue_reaction: ClassVar[bool] = False

    #: Whether the work reaction belongs to the agent that added it.
    #:
    #: True where each agent posts as its own bot, so two agents working on one
    #: message leave two independent marks and each must be claimed, held and
    #: removed on its own. False where every agent shares one bot account: the
    #: platform has one reaction between them, so the first turn to want it
    #: puts it on and the last to finish takes it off.
    activity_reactions_per_agent: ClassVar[bool] = False

    #: Whether this platform can create a channel from Switch at all.
    #:
    #: A ceiling, not a preference: an operator may withhold channel creation
    #: from a connection whose platform allows it, but cannot grant it to one
    #: that does not. Declared on the class rather than resolved from a running
    #: bridge so the answer is available before a connection is registered and
    #: while it is stopped — the operator asks "can this platform do it?" at
    #: exactly those moments.
    supports_channel_creation: ClassVar[bool] = True

    #: Whether this platform has a user directory Switch can search.
    #:
    #: False where the only people Switch can name are the ones who have
    #: spoken to it — a Telegram bot cannot enumerate anyone else. That is not
    #: a smaller directory, it is a different question: on a freshly connected
    #: connection of such a type the answer is always "nobody", so asking a
    #: user to pick themselves from it is asking them to pick from an empty
    #: list. Declared on the class for the same reason as
    #: `supports_channel_creation` — the answer is needed before a connection
    #: exists and while one is stopped.
    supports_directory_search: ClassVar[bool] = True

    #: Whether this platform can make a private channel from Switch.
    #:
    #: Reported per connection so a room form offers "New private channel"
    #: only where it can work, rather than each client keeping its own list.
    #: Meaningless where `supports_channel_creation` is False.
    supports_private_channels: ClassVar[bool] = True

    #: Whether a private channel here has to be created with a person as its
    #: owner. True on Teams, where Microsoft refuses a private channel an app
    #: creates unless the request names a user to own it. Switch names the
    #: person asking for the room, through the account they linked on this
    #: platform, and refuses before asking the platform when they have none.
    private_channel_needs_owner: ClassVar[bool] = False

    #: Whether Switch puts the person a room is for into a new public channel
    #: it makes for the room, through their confirmed linked account. False
    #: where joining a public channel means more than the channel: on Teams a
    #: standard channel's members are the whole team's, so adding someone
    #: would add them to the team.
    adds_creator_to_public_channel: ClassVar[bool] = True

    #: Whether this platform renders a link whose scheme is not http(s).
    #:
    #: False for platforms that linkify only the web schemes. It matters
    #: because the "Open in Switch Console" deeplink is a `switchdash://` URL:
    #: where this is False that link cannot work as written, and the deployment
    #: needs `GATEWAY_PUBLIC_URL` set so Switch can rewrite it to the https
    #: redirect. Declared here so the lifecycle can say so once at startup
    #: instead of each bridge discovering it in its own way. Where it is
    #: False, `translate_outbound` also rewrites links an agent writes to
    #: Switch Console pages (`switchdash://open/…`).
    renders_custom_url_schemes: ClassVar[bool] = True

    #: Whether `find_request_card` can actually search this platform.
    #:
    #: False here because the base `find_request_card` returns `None` for
    #: every call: it has nowhere to look. An adapter that implements the
    #: search sets this True, and the difference is not cosmetic — `None`
    #: from a platform that searched means "not there yet, ask again", while
    #: `None` from a platform that cannot search means "never, however long
    #: you wait". Retrying the second one forever leaves a card visible in
    #: the chat that silently refuses the answer it asks for, which is the
    #: outcome the publisher discloses instead.
    recovers_uncertain_posts: ClassVar[bool] = False

    #: Whether a publication carries a marker `find_request_card` can match on
    #: regardless of what the message says.
    #:
    #: Slack writes the token into a `block_id` and message metadata,
    #: Mattermost into a post prop: both are exact, invisible, and present on
    #: every publication, so anything this bridge posted can be recognised
    #: again. Discord has nowhere to put one on a webhook message, so it
    #: recognises a card by the handle the card itself prints — which works
    #: for a card and cannot work for a turn's activity, because activity
    #: prints no handle.
    #:
    #: Separate from `recovers_uncertain_posts` because the two answer
    #: different questions. That one asks whether the platform can be searched
    #: at all; this one asks whether a search can find a publication that
    #: prints nothing to search for. A platform can recover its cards and
    #: still never recover a status, and a caller that cannot tell those apart
    #: either repeats a lookup that has no way to succeed or abandons a card
    #: that would have been found.
    #:
    #: Not a statement about the platform — a statement about this adapter. An
    #: adapter that starts carrying a marker of its own sets this True and the
    #: publications it could not recognise before become recoverable.
    carries_publication_marker: ClassVar[bool] = False

    #: Whether this platform may say in the channel that a card's delivery was
    #: never confirmed.
    #:
    #: Deliberately not implied by `recovers_uncertain_posts`. That one is a
    #: fact about the adapter — whether a lost publication can be looked for.
    #: This is a decision about what the people in the channel are told when it
    #: cannot be, and it posts a message they did not ask for into a
    #: conversation this bridge does not own. The two were one flag, and a
    #: platform gaining the first answer silently acquired the second.
    #:
    #: False here so a new platform discloses nothing until somebody has agreed
    #: it should. Where it is False and recovery is impossible, the reservation
    #: is still kept and the request is still answerable in Console — what is
    #: withheld is the notice, not the request.
    discloses_unconfirmed_posts: ClassVar[bool] = False

    # Whether this adapter keeps quiet when told not to listen
    # (`set_listening`): it opens nothing the platform delivers events over,
    # no socket, no poll, no subscription it keeps alive, and only calls the
    # platform's API. A bridge is listened to by the one switch-core process
    # that holds it (`ownership.py`); every other runs it quietly to serve the
    # requests and webhooks that reach it. An adapter that cannot keep quiet
    # listens wherever it runs, so its platform delivers to every process.
    keeps_quiet_unless_listening: ClassVar[bool] = False

    #: What `retire_channel` does to a deleted room's channel when it works.
    #:
    #: Console reads it, through room detail, to tell the person deleting a
    #: room what will become of its channel before they confirm, so it has to
    #: say what this adapter's `retire_channel` actually does. `kept` here
    #: because the base leaves the channel alone.
    channel_on_delete: ClassVar[ChannelRetirement] = "kept"

    #: How `notify_privately` reaches one person about their own message.
    #:
    #: A Switch Trust notice about what a person posted (blocked, redacted,
    #: flagged, not fully checked) is theirs alone, and posting it in the
    #: channel tells everyone there what they tried to say. `in_channel` here
    #: because the base has no private route: the caller posts the notice in
    #: the channel instead and logs a warning saying so.
    private_notice_delivery: ClassVar[PrivateNoticeDelivery] = "in_channel"

    def __init__(self) -> None:
        # Whether this process holds the bridge: see
        # `keeps_quiet_unless_listening`. Set by the lifecycle before `start`.
        self._listening = True
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        self._on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]] | None = (
            None
        )
        self._on_user_joined: Callable[[InboundUserJoin], Awaitable[None]] | None = None
        self._on_app_joined: Callable[[InboundAppJoin], Awaitable[None]] | None = None
        # Set by set_user_left_handler: called when a person leaves a bridged
        # channel or is taken out of it. Unset on an adapter running without
        # a bridge core behind it, where a departure is dropped.
        self._on_user_left: Callable[[InboundUserLeave], Awaitable[None]] | None = None
        # Set by set_member_sync_hooks: the channels this bridge has rooms for,
        # and a way to ask for some of them to be lined up with their members
        # again. For a platform whose membership changes arrive per guild
        # rather than per channel (Discord), which must not act on channels
        # nobody bridged.
        self._bridged_channels: Callable[[], Collection[str]] | None = None
        self._request_member_sync: Callable[[list[str]], None] | None = None
        # Set by set_interaction_handler. Called when someone operates a control
        # on a message this bridge posted. Left unset on a platform with no such
        # controls, and on an adapter running without a bridge core behind it.
        self._on_interaction: Callable[[InboundInteraction], Awaitable[None]] | None = (
            None
        )
        # Set by set_activity_resolver. Asked what turn is being shown in the
        # message at (channel, reference), for a platform that offers a reader
        # the activity behind a status rather than printing it. None is the
        # answer for a message this bridge is not showing a turn in, which
        # includes every message once the session or the bridge is gone.
        self._resolve_activity: (
            Callable[[str, str], Awaitable[ActivitySnapshot | None]] | None
        ) = None
        # Set by set_channel_migration_handler. Called with (old_id, new_id)
        # when the platform reissues a channel's id.
        self._on_channel_migrated: Callable[[str, str], Awaitable[None]] | None = None
        # Set by set_channel_rename_handler. Called with (channel_id, old_name,
        # new_name) when the platform reports a change to a channel (the two
        # names are the same when it was not a rename).
        self._on_channel_named: Callable[[str, str, str], Awaitable[None]] | None = None
        # Set by set_channel_type_handler. Called with (channel_id, type) when
        # the adapter learns a channel's type from the platform.
        self._on_channel_type_learned: (
            Callable[[str, ChannelType], Awaitable[None]] | None
        ) = None
        # Set by set_agent_presentation_resolver. Returns the agent's stored
        # presentation, or None for a name that is not an agent. Left unset an
        # adapter still works — every agent renders under its identifier with
        # the platform default icon — so adapters stay usable without a bridge
        # core wired up behind them.
        self._resolve_agent_presentation: (
            Callable[[str], Awaitable[AgentPresentation | None]] | None
        ) = None
        self._reported_missing_resolver = False
        # Inbound attachment size ceiling, set by the lifecycle service from
        # config.agent_media_max_bytes. Adapters check a platform-reported file
        # size against this before downloading so an oversize file is rejected
        # loudly instead of being pulled down and discarded.
        self._max_attachment_bytes = 20 * 1024 * 1024
        # Set by `set_webhook_url` for an adapter that receives webhooks.
        self.webhook_url: str | None = None
        # Set by the lifecycle service from config.third_party_avatars_enabled.
        # Off until then, so an adapter whose wiring was missed shows platform
        # default icons, which someone notices, rather than quietly sending
        # names to avatar services an operator has turned off.
        self._third_party_avatars = False
        # Set by the lifecycle (`set_holder_relay`): hands a request to the
        # process that holds the bridge, for work only the holder does.
        self._relay_to_holder: Callable[[dict[str, str]], None] | None = None
        # Set by the lifecycle (`set_gateway_public_url`).
        self._gateway_public_url: str | None = None

    def set_max_attachment_bytes(self, max_bytes: int) -> None:
        self._max_attachment_bytes = max_bytes

    def set_listening(self, listening: bool) -> None:
        """Whether this process holds the bridge and listens to the platform
        for it, or runs it quietly. Before `start`; an adapter that cannot
        keep quiet ignores it (`keeps_quiet_unless_listening`)."""
        self._listening = listening

    def set_holder_relay(self, relay: Callable[[dict[str, str]], None]) -> None:
        """How a quiet copy hands the process holding the bridge a piece of
        work only the holder does, which reached this process instead: a
        webhook arrives at whichever process the load balancer picks. The
        holder receives it in `receive_relayed`."""
        self._relay_to_holder = relay

    def _hand_to_holder(self, request: dict[str, str]) -> None:
        """Hand `request` to the process holding the bridge. Nobody may hold
        it right now; the next holder catches up as it takes the bridge over,
        as it does for anything that happened while nobody held it."""
        if self._relay_to_holder is None:
            logger.warning(
                "No way to reach the process holding this bridge; dropping %r",
                request,
            )
            return
        self._relay_to_holder(request)

    async def receive_relayed(self, request: Mapping[str, str]) -> None:
        """Do a piece of work a quiet copy in another process handed here
        (`_hand_to_holder`), as this process holds the bridge. Nothing hands
        work to an adapter that does not override this."""
        logger.warning("Ignoring a relayed request this bridge has no use for")

    def set_third_party_avatars(self, enabled: bool) -> None:
        """Whether this adapter may hand platforms an icon drawn by an outside
        avatar service (`agent_icon.is_third_party_avatar`)."""
        self._third_party_avatars = enabled

    def set_gateway_public_url(self, gateway_public_url: str | None) -> None:
        """The server's public address (`GATEWAY_PUBLIC_URL`), which a link to
        a Switch Console page is rewritten to on a platform that cannot open
        `switchdash://`. None where the server has none, and those links are
        then named in words (`rewrite_console_links`)."""
        self._gateway_public_url = gateway_public_url

    @classmethod
    def describe(cls, key: str) -> MessagingPlatform:
        """What this adapter declares about its platform, registered as `key`."""
        display_name = getattr(cls, "display_name", None)
        if not isinstance(display_name, str) or not display_name.strip():
            raise ValueError(
                f"{cls.__name__} declares no display_name. Every adapter names "
                "its platform the way a person would "
                '(e.g. display_name = "Microsoft Teams").'
            )
        return MessagingPlatform(
            key=key,
            display_name=display_name,
            docs_slug=cls.docs_slug,
            icon_svg=cls.icon_svg(),
        )

    @classmethod
    def icon_svg(cls) -> str | None:
        """The logo shipped beside this adapter's module, or None if it has none."""
        module = sys.modules.get(cls.__module__)
        module_file = getattr(module, "__file__", None)
        if module_file is None:
            return None
        path = Path(module_file).parent / cls.icon_file
        if not path.is_file():
            return None
        return path.read_text(encoding="utf-8")

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        """Name why this platform's own SDK failed, or None to leave it to Switch.

        The lifecycle asks this first when a bridge fails, so the knowledge of
        what this platform's exceptions mean lives with the adapter that raises
        them. Answer only for exceptions of this platform's SDK; return None
        for anything else, and the shared classifier decides —
        `BridgeCredentialError` is `auth_failed`, a transport failure is
        `network`, `BridgeOperationError` is `platform_error`.

        An adapter that raises only `BridgeCredentialError` and
        `BridgeOperationError` for platform refusals needs no override.
        """
        return None

    @classmethod
    def classify_refusal(cls, exc: BaseException) -> RefusalKind:
        """How this platform refused a send: see `RefusalKind`.

        The session activity publisher drops a "permanent" refusal at once,
        gives a "bounded" one a few attempts, and retries a "transient" one for
        as long as it takes. An adapter that cannot tell its platform's errors
        apart answers "transient", which keeps every failure retried.
        """
        return "transient"

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        """Fill in values the operator should not have to supply, at create time.

        Called once, when a bridge is registered — never on start, so a value
        minted here is persisted and stable for the life of the bridge. An
        adapter that generates key material must do it here rather than in a
        model default, or every restart would mint a fresh one and quietly
        invalidate whatever the last one signed or encrypted.

        Async because generating key material is CPU-bound and this runs on
        the event loop that carries every live client in switch-core.
        """
        return connection_config

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """Name the platform workspace this bridge connects, if it has one.

        One workspace is connected at most once on an instance, across every
        tenant: two bridges into it would each deliver its events to a
        different tenant, and the hosted install path already holds a
        workspace to one tenant. Registration refuses a second claim.

        Quoted verbatim in that refusal, so it must not embed credential
        material. Return None for a platform with no such notion.
        """
        return None

    @classmethod
    def held_with(cls, connection_config: dict[str, object]) -> tuple[str, str] | None:
        """Other owned work this bridge must be held beside, as (kind, key) in
        `ownership.py`, or None for a bridge placed on its own.

        For a bridge whose platform events reach it in-process from something
        else that runs once per deployment, such as Discord's one shared
        Gateway connection: held anywhere else, it would never hear them.
        """
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        """The URLs in this config that Switch itself connects to.

        Checked against the deployment's `OutboundPolicy` before the bridge is
        stored, when its config is edited and each time it starts, so a config
        cannot point Switch at an internal address. Not the platform's own API
        hosts, and not URLs only handed to the platform or put in links.
        """
        return []

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        """Name a host resource this bridge needs to itself, if any.

        Two bridges returning the same string cannot coexist in one process.
        Returning None — the default — means a bridge of this type can be run
        alongside any number of its own kind, which is true of every adapter
        that only dials out.

        The returned string is quoted verbatim in the refusal shown to whoever
        registers the second bridge, so it must not embed credential material.

        The point is to refuse the second one at registration, with a sentence
        saying what clashed. Without it the collision surfaces as whatever the
        underlying resource does when contended, which for a TCP port is a bind
        error inside a background task, minutes later and nowhere near the
        operator who caused it.
        """
        return None

    @classmethod
    def editable_config_keys(
        cls, connection_config: Mapping[str, object]
    ) -> frozenset[str] | None:
        """Which connection settings a workspace admin may change, or None for all.

        None — the default — leaves every setting editable, which is right for a
        bridge on the organisation's own app: its settings are theirs. A bridge
        on an app the deployment owns may hold settings that decide where the
        deployment's credential is pointed, and an adapter names here the few
        that are safe to change; an edit to any other is refused.
        """
        return None

    @classmethod
    def channel_creation_blocker(
        cls, connection_config: Mapping[str, object]
    ) -> str | None:
        """Why a connection with this config cannot create a channel yet,
        though the platform can and an admin allows it; None when nothing is
        missing.

        None — the default — for a platform whose new channels need nothing
        from the connection. Asked of the stored config, so every process
        answers alike, before anyone tries.
        """
        return None

    @classmethod
    def link_code_instructions(
        cls, code: str, connection_config: Mapping[str, object]
    ) -> str:
        """How to post a link code from a chat account here, in Markdown
        (CHOO-3881).

        Per-platform because Switch does not hear every message everywhere:
        some platforms deliver a channel message only when it mentions the
        bot, or deliver no message text at all, and the instruction must name
        a way that actually reaches Switch. A class method because Console asks
        while showing the code, with or without a running adapter.
        """
        return f"Post `!link-account {code}` from that account in any channel Switch is in."

    @classmethod
    def unlinkable_account_reason(cls, external_user_id: str) -> str | None:
        """Why this account cannot be linked to anyone, or None if it can.

        For the platform's stand-in accounts, which several real people post
        as. Linking one would recognise all of them as the same Switch user.
        """
        return None

    async def account_unlinkable_reason(self, external_user_id: str) -> str | None:
        """Why this account cannot be linked to anyone, asking the platform
        where the id alone cannot tell, or None if it can be.

        A bot or an integration's account is one whoever runs it posts as, so
        linking it would recognise all of them as one Switch user. Some
        platforms say so in the id (`unlinkable_account_reason`); others only
        when asked. Raise `LookupError` when the platform has no such account,
        and `RuntimeError` when it cannot be asked.
        """
        return self.unlinkable_account_reason(external_user_id)

    async def account_id_for_session(self, token: str) -> str:
        """The platform id of the account a session token belongs to.

        Proves control of an account without posting from it, for the bundled
        deployment's setup, which provisions both the account and its Switch
        user before any channel has an agent to hear a code. Raise
        `NotImplementedError` where the platform has no such check.
        """
        raise NotImplementedError(
            f"{self.display_name} cannot confirm an account from a session token"
        )

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Prove the credentials work, before the bridge is persisted.

        Raise :class:`BridgeCredentialError` with a message fit for an operator
        to read. Adapters start in a background task whose exceptions are logged
        and swallowed, so without this a wrong password looks like success and
        surfaces hours later as an unrelated-looking failure.

        The default accepts anything: an adapter that cannot check cheaply
        should not pretend to.
        """
        return None

    @abstractmethod
    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    async def withdraw(self) -> None:
        """Let go of what this bridge holds on the platform, because it is being
        removed for good.

        Called once, while the bridge is still running, just before it is
        stopped for the last time — never on a restart, which is what `stop`
        alone is for. Most adapters hold nothing on the platform that outlives
        them and have nothing to do; one that registered something there (a
        subscription that keeps delivering, an app installed into a team) undoes
        it here, so the platform stops sending traffic nobody will read.

        Best effort: a removal is what someone asked for, and it goes ahead
        whatever this manages. Raise to say what was left behind; the caller
        logs it.
        """
        return None

    async def dispatch_event(
        self, *, envelope_type: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Handle one event that arrived over the public webhook.

        Returns the body to answer with for an event the platform waits on in
        the response itself (`InboundWebhook.answers_inline`), and None for
        every other — which is every event on a platform that acknowledges
        first and handles after.

        Concrete on the base and raising, rather than abstract, because
        receiving events over HTTP is a property of a platform and of which app
        a bridge's token came from — most adapters dial out and are handed
        their events on a connection they opened, and have nothing to override
        here.

        Raising rather than returning quietly matters: the caller is a route
        that has already proved the request genuine and resolved which bridge
        it belongs to, so reaching an adapter that cannot take it means a
        workspace's traffic is being delivered nowhere. Silence there is the
        failure that reads as "the platform has gone quiet".
        """
        raise WebhookDeliveryUnsupported(
            f"{type(self).__name__} does not receive events over HTTP, so the "
            "event posted for this bridge cannot be delivered. A bridge reached "
            "this way was installed as a distributed app, or its adapter sets "
            "`receives_webhooks`; this one is neither."
        )

    async def verify_webhook(self, request: WebhookRequest) -> None:
        """Prove a request to this bridge's own webhook address is the platform's.

        For an adapter that sets `receives_webhooks`. Check the request against
        this connection's own secret — a signature header over `request.body`,
        a token in the query — and raise `WebhookAuthenticityError` if it does
        not prove itself. Nothing reads the request before this passes: it is a
        stranger's bytes until then, so do not log it either.

        Async because some platforms prove a request with a token whose keys
        have to be fetched (a signed JWT). Called inside the request the
        platform is waiting on, so keep it fast.
        """
        raise WebhookDeliveryUnsupported(
            f"{type(self).__name__} does not receive events on a webhook address "
            "of its own."
        )

    def parse_webhook(self, request: WebhookRequest) -> InboundWebhook:
        """Read a verified request into the event `dispatch_event` will be handed.

        Called only after `verify_webhook` passed. Raise `WebhookPayloadError`
        for a body this adapter cannot read. Set `handshake` instead of an event
        for a request that is the platform checking the address is ours (a
        challenge to echo back): it is answered with that text and nothing is
        dispatched. Set `external_event_id` to the platform's id for the
        delivery wherever it has one — that is what makes a retried delivery
        recognisable, so it is handled once. Set `answers_inline` False: a
        connection's own webhook address acknowledges first and handles after,
        and refuses an event that expects its answer in the response.

        Pure: no I/O. The platform is waiting for this request to be answered,
        and the work belongs in `dispatch_event`, which runs after it has been.
        """
        raise WebhookDeliveryUnsupported(
            f"{type(self).__name__} does not receive events on a webhook address "
            "of its own."
        )

    @abstractmethod
    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post a message to the external channel.

        thread_root_id, when set, is the external platform's identifier for the
        thread root (e.g. Mattermost root_id) — the message should be posted as
        a reply within that thread. Adapters whose platform does not support
        threads ignore it.

        room_wide_mention is set when `content` came from
        `render_room_wide_mention`, for a platform that has to permit a
        channel-wide mention on the request as well as write it in the text
        (Discord's `allowed_mentions`). Everywhere else the text alone does it.
        """
        ...

    async def send_ui_message(
        self,
        channel_id: str,
        sender_name: str,
        spec: UISpec,
        fallback_text: str,
        thread_root_id: str | None,
        *,
        room_wide_mention: bool,
    ) -> str | None:
        """Post an agent's message that carries a card (`ui_spec`), drawn
        natively where the platform can. `fallback_text` is what
        `send_message` would have posted; a platform with no card rendering
        posts just that, which is the default.

        Raise `CardRejectedError` when the card was refused before anything
        was posted; the caller then posts `fallback_text` alone. Any other
        exception is handled as a send that may have landed, and is never
        followed by the text.
        """
        return await self.send_message(
            channel_id,
            sender_name,
            fallback_text,
            thread_root_id=thread_root_id,
            room_wide_mention=room_wide_mention,
        )

    async def settle_card_press(
        self,
        interaction: InboundInteraction,
        label: str,
        *,
        author: str,
        spec: UISpec,
        body: str,
    ) -> None:
        """Show on the card that its button `label` was pressed and the press
        delivered, so it is not pressed again. `author`, `spec` and `body` are
        the card as its room message holds it, to redraw it from. Only a
        platform that draws card buttons has anything to do."""
        return None

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        """Post a first-class admin/system message to the external channel,
        rendered in the platform's native way as the bridge's own identity (not
        on behalf of any agent) — e.g. a heads-up that a tagged agent isn't in
        the room, or a command result.

        `message_type` is the `AdminMessageType` value (or None) so an adapter
        can special-case rendering per platform; adapters that don't simply
        render the default `content`. The default implementation posts via
        `send_message` under the bridge display name; adapters whose platform
        has a distinct bot identity should override to use it.

        **`content` is Switch Markdown, and this method renders it.** Unlike
        `send_message`, whose caller translates, every caller here passes an
        unrendered body — the notices in `collaboration_core`, the adapters' own
        notices, and the relayed admin events alike. An override must therefore
        run `translate_outbound` itself. Splitting that responsibility between
        callers is what once sent a body through the conversion twice, and the
        second pass escapes the markup the first one produced.

        `drawn` is content this adapter drew, in the platform's own spelling,
        to go under the notice — a card's fallback text, where the notice is
        about that card. It is appended after the conversion and never through
        it. Written into `content` instead it would be converted as if it were
        Markdown, and a reader is shown the platform's own tags as prose: the
        very failure the paragraph above describes, arriving from the other
        side. An override joins the two with `_admin_body`."""
        return await self.send_message(
            channel_id,
            self._bridge_display_name(),
            self._admin_body(self.translate_outbound(content), drawn),
            thread_root_id,
        )

    def _admin_body(self, rendered: str, drawn: str | None) -> str:
        """A rendered notice, and under it whatever the adapter already drew."""
        return rendered if drawn is None else f"{rendered}\n{drawn}"

    def _bridge_display_name(self) -> str:
        return "Switch"

    def is_placeholder_username(self, username: str) -> bool:
        """Whether a stored name for a person is really one of this platform's
        opaque ids, recorded because nothing better was available at the time.

        Switch files a person under the name it first sees, and some platforms
        do not always supply one — Teams omits it from a 1:1 chat activity. The
        id then becomes that person's name everywhere: their client,
        the title of any room auto-created for them, and every agent reply that
        addresses them. Fixing the resolution stops it happening to the next
        person and does nothing for the ones already recorded, so an adapter
        that can recognise its own ids says so here and the name is repaired
        the next time they speak.

        Default False: on a platform whose handles are handles, there is
        nothing to recognise and nothing to repair.
        """
        return False

    def render_app_mention(self, token: str) -> str:
        """Render a mention of the Switch app itself, given the platform's own
        handle for it.

        Mention syntax is per-platform and the caller is not: this is used by a
        notice in shared bridge code, which for a long time emitted Slack's
        ``<@id>`` form everywhere. Slack renders that as the app's name; Teams
        prints it verbatim, so a user was told they had tagged
        ``<@28:11111111-…>``. Override wherever that form is not what the
        platform reads.
        """
        return f"<@{token}>"

    def slash_invite_hint(self) -> str | None:
        """How to run `invite-agent` as a native slash command here, if at all.

        The `/` form is per-platform: Slack declares its commands in the app
        manifest, Discord registers them per guild, and Telegram and Teams
        accept `/` as an ordinary message prefix, while Mattermost has nothing —
        so the no-agents notice must not advertise a `/` form on a bridge that
        has none to offer.
        The invocation differs too, since Slack and Telegram take a free-text
        tail where Discord names each argument as its own field, so each adapter
        spells out its own.

        Returns the body of the bullet; the caller owns the list formatting.
        None means this platform has no slash commands.
        """
        return None

    async def send_attachment(
        self,
        channel_id: str,
        sender_name: str,
        filename: str,
        mimetype: str,
        data: bytes,
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Relay a file attachment to the external channel as `sender_name`,
        returning the platform message ref (like send_message).

        Platforms with a file API override this to upload the bytes natively,
        for any mimetype. This default is the disclosed degradation for adapters
        without native support: a text message that names the attachment instead
        of silently dropping it.
        """
        note = f"_sent an attachment that couldn't be relayed: {filename}_"
        body = f"{caption}\n{note}" if caption else note
        return await self.send_message(
            channel_id, sender_name, self.translate_outbound(body), thread_root_id
        )

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Relay several files as a SINGLE post on the external platform.

        Adapters whose platform can attach multiple files to one message
        override this. The default posts them one at a time — correct, but the
        files land as separate messages rather than one.
        """
        message_ref: str | None = None
        for index, file in enumerate(files):
            ref = await self.send_attachment(
                channel_id,
                sender_name,
                file.filename,
                file.mimetype,
                file.data,
                caption=caption if index == 0 else None,
                thread_root_id=thread_root_id,
            )
            if index == 0:
                message_ref = ref
        return message_ref

    @abstractmethod
    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None: ...

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a turn's activity or a request's card, in whatever form this
        platform draws it.

        This base has no card or activity renderer of its own, so it falls
        back to `rich_fallback_text`. Override to draw a real one — the way
        `SlackAdapter` does, choosing its own renderer by `content`'s type —
        and this is never called.

        Raises `RichContentFailed` on any failure — whether the platform
        raised (Teams' `send_message` does, on any non-2xx status) or merely
        returned `None` (Slack's does, on a caught `SlackApiError`). Unlike
        `send_message`, whose other callers already handle a `None` ref, this
        is a new seam and raises on both shapes of failure instead: a caller
        here cannot forget to check what it did not ask to be told.
        """
        text = self.rich_fallback_text(content)
        try:
            ref = await self.send_message(channel_id, agent_name, text, thread_root_id)
        except Exception as error:
            raise RichContentFailed(
                f"{self.platform_name} could not send the message in channel "
                f"{channel_id}: {error}",
                text=text,
            ) from error
        if ref is None:
            raise RichContentFailed(
                f"{self.platform_name} did not accept the message in channel "
                f"{channel_id}.",
                text=text,
            )
        return ref

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw what `post_rich` posted, in place.

        Falls back the same way `post_rich` does. Most adapters'
        `update_message` swallows its own errors by design, for the
        runtime-status paths that depend on that — but not all of them, so this
        catches broadly rather than trusting the convention: whichever it does,
        a caller of *this* wrapper sees `RichContentFailed` or nothing.

        That is the default, not the port's whole contract. An adapter with its
        own failure policy overrides this, and the overrides deliberately let a
        throttle and an unknown outcome through unwrapped, because a caller has
        to be able to tell "refused" from "come back to this". What the port
        does promise is that a *refusal* arrives as `RichContentFailed`, never
        as a platform client's own exception.

        `agent_name` is the same name `post_rich` was given, and is here for
        the platform that writes it into the body: one bot identity means the
        name is part of what was drawn, so a redraw that did not know it would
        quietly rewrite the message as somebody else. Passing it on every call
        keeps that out of an in-memory map that a restart empties.

        `thread_root_id` is the same thread `post_rich` was given, for the same
        reason. On most platforms a message id is an address on its own and
        this is ignored; on Teams an edit is addressed to the *conversation*,
        and for a reply inside a channel post that conversation is named by the
        thread rather than by the message. Passing it keeps the one durable
        answer flowing from the journal or the card row, instead of a
        process-local map that a restart turns into a guess.
        """
        text = self.rich_fallback_text(content)
        try:
            await self.update_message(channel_id, message_ref, text)
        except Exception as error:
            raise RichContentFailed(
                f"{self.platform_name} could not update the message in "
                f"channel {channel_id}: {error}",
                text=text,
            ) from error

    def notice_address(self, message_ref: str, thread_root_id: str | None) -> str:
        """Where a notice *about* a publication has to be said.

        Beside the publication, so the people who can see the stale card are
        the people who read the correction: the thread it went into where there
        was one, and otherwise the publication itself, which is then the root
        of its own conversation.

        Not the publication's id where a thread exists — on a platform that
        addresses a reply by its conversation rather than by the message, a
        publication that is itself a reply names no conversation, and a notice
        nobody can see is worse than the stale card it is about. An adapter
        whose own reference carries a confirmed conversation overrides this to
        prefer it: a rebuilt address is the weaker of the two.
        """
        return thread_root_id or message_ref

    def rich_fallback_text(self, content: RichContent) -> str:
        """The neutral text form of `content`, for `post_rich` / `update_rich`'s
        base and for any adapter that wants the same fallback rather than its
        own.

        A turn falls back to `turn_summary` — the last thing the agent said,
        and the turn's own state. A request falls back to `request_summary`:
        the question, its numbered options and the typed-answer grammar for
        this particular form, in whichever state the request is in. Neither
        is the compact presentation a platform publishing SDK sessions wants
        (`turn_status` is), which is why an adapter that does publish them
        overrides this rather than inheriting it.

        The card's own extras go with it. `unavailable_reason` is the notice
        that replaces the instruction on a card that cannot be answered where
        it is showing, and dropping it here would leave the reader an
        instruction that is about to be refused. `responder_external_id` is
        not passed on: it is a platform id, and an adapter that can turn one
        into a name renders the card itself.

        The result is ready to send as-is — `post_rich` and `update_rich` do
        not run it through `translate_outbound` again. `_rich_escape` already
        does, so the budget these renderers cut to is measured on the string
        that actually reaches the wire rather than the one before that last
        transform, which can expand it (Telegram's turns one `&` into five
        characters). The turn's own state line skips both passes rather than
        being measured through them: it is a handful of fixed words, never
        host text and never Switch Markdown, so translating it is assumed to
        be a no-op — the same assumption that already excuses it from escaping.
        """
        escape = self._rich_escape
        if isinstance(content, TurnActivity):
            return turn_summary(
                content.items,
                content.turn,
                escape=escape,
                limit=self.rich_fallback_limit(),
            )
        return request_summary(
            content.request,
            content.reference,
            escape=escape,
            limit=self.rich_fallback_limit(),
            markup=self.rich_markup(),
            unavailable_reason=content.unavailable_reason,
        )

    def rich_markup(self) -> Markup:
        """How this platform spells emphasis, a copyable literal and a link.

        Markdown by default, which is what every platform reaching the neutral
        renderer today parses. A platform whose message body is something else
        — Telegram's is HTML — overrides this rather than carrying a renderer
        of its own, so the budget and faithfulness logic stays in one copy.
        """
        return MARKDOWN

    def _rich_escape(self, label: str) -> str:
        """`rich_fallback_text`'s host text, neutralised and then rendered.

        Composed so the one function `turn_summary` / `request_summary` cut
        their budget against is the same pipeline `post_rich` / `update_rich`
        actually sends: `escape_label_for_body` first, because that is what
        keeps a display name or an assistant's words from forging markup;
        `translate_outbound` after, because that is what turns Switch
        Markdown into this platform's own and is the last thing to touch the
        string before it goes on the wire.
        """
        return self.translate_outbound(self.escape_label_for_body(label))

    def rich_fallback_limit(self) -> int:
        """How many characters `rich_fallback_text` may spend on one message.

        2000 by default — Discord's own limit, the tightest of the platforms
        without a card renderer of their own today. A conservative
        placeholder rather than a value read from each platform's real API
        contract; override once a platform's actual limit is known.
        """
        return 2000

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        """Search for a publication already on the platform, by its marker.

        `recover` calls this when a post's outcome is uncertain, so it can
        bind the reservation to what is actually there instead of risking a
        duplicate. `None` means either nothing was found or, as here, that
        this platform has no way to look — a publication recovers only where
        an adapter can search for one.

        `token` is the marker the adapter was given to carry, and is what a
        platform with somewhere to hide one matches on. `handle` is the
        request's own name, the one printed in the card for people to type
        back, and it is here for the platform that has nowhere to hide a
        marker at all: on Discord a webhook message carries no metadata, so
        the visible handle is the only durable thing that distinguishes one
        card from another. It is `None` for an activity publication, which
        has no handle and so cannot be recovered that way.
        """
        return None

    @abstractmethod
    async def delete_message(self, channel_id: str, message_ref: str) -> None: ...

    async def remove_publication(self, channel_id: str, message_ref: str) -> None:
        """Take back a card this bridge published, or say why it is still there.

        Returning is the claim that nothing of the card remains at that
        address — including the case where it had already gone, which is the
        same fact arrived at differently and is logged rather than raised.
        That second case is what lets a deletion whose response was lost be
        settled by simply asking again. `RichContentThrottled` where the
        platform named a wait, `RemovalFailed` for anything else.

        Not reached unless the adapter also sets `removes_answered_cards`,
        which is why this refuses rather than quietly doing nothing: a
        platform brought into the removal flow without an implementation
        should stop, not report success for a card still on the screen.
        """
        raise RemovalFailed(
            f"{type(self).__name__} cannot prove a published message was removed."
        )

    @abstractmethod
    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None: ...

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        mark: ActivityMark,
        on: bool,
        force: bool = False,
    ) -> None:
        """Update a platform work indicator when the adapter supports one.

        `agent_name` is which agent is working, and it is required rather than
        optional because a platform where each agent posts as its own bot
        cannot add or remove a reaction without knowing whose it is. A
        platform with one shared bot ignores it — there is one reaction
        between every agent there — but a caller that could not supply it
        would be a caller that cannot serve the per-agent platforms at all.

        `mark` says which indicator, and the two are independent: a prompt can
        be queued and not yet worked on, and the same message can carry another
        turn's working mark at the same time. An adapter that declares no
        `supports_queue_reaction` is never asked for the queued one.
        """

    def activity_closes_in(self, message_ref: str) -> float | None:
        """Seconds until the platform closes this message to further streaming
        on its own, or None where it never will.

        Closing it rewrites what it shows (Slack marks the steps still running
        as failed), so a redraw is owed just after, whatever the clock says.
        Asked once, as the message is posted.
        """
        return None

    def rich_updates_held_for(self) -> float:
        """Seconds before this adapter will try another edit to rich content.

        Nonzero while it is holding edits back after a rate limit. Asked before
        work that can wait, such as redrawing a running turn's clock, so that
        work is not queued only to be refused. Only an adapter that
        `redraws_for_elapsed_time` is asked.
        """
        return 0.0

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Signal once, where the work was asked for, that the agent has begun.

        A platform's own ephemeral "typing" affordance, which expires by itself
        and so is a nudge rather than a state to switch off. Called once as a
        turn opens and never on a redraw: repeated, it would claim the agent
        was typing for as long as the turn ran.

        `thread_root_id` is where the *asking* happened, which is not
        necessarily where the status went — someone who wrote at the channel
        root is watching the root, not a thread they have not opened yet. None
        means the channel root.

        Best effort by nature. Nothing is waiting on it and the posted status
        carries the state from here on, so an adapter that cannot send one
        does nothing and says nothing.
        """

    def unnotified_notice(self) -> str:
        """Why an attention post named nobody, for a platform that says so.

        The reader is told this reached no one and what to do so the next one
        does, rather than being left to assume the person who can act has
        already seen it.
        """
        return (
            "Nobody here is linked to this agent's owner, so this notified no one. "
            f"Link your {self.platform_name} account in Switch Console to be notified."
        )

    @classmethod
    def channel_name_for(cls, room_name: str) -> str:
        """The channel name `create_channel` derives from a room's name, before
        any suffix added because the name was taken. The platform's own form of
        the name, as a rename reports it. A platform that takes the room's name
        as it is leaves this alone."""
        return room_name

    @abstractmethod
    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        """Provision a channel on the platform and return its id and the name
        the platform gave it.

        ``owner_external_id`` is the platform account of the person the room is
        for, passed only for a private channel on a platform that
        `private_channel_needs_owner`; other platforms ignore it.

        When the platform *refuses* — a permission not consented, a name it
        will not take — raise :class:`BridgeOperationError` carrying what the
        platform said. Room creation turns that into a 502 quoting it, so the
        operator who asked for the room learns why it failed; anything else
        becomes an opaque 500 and the explanation stays in the log. Raise
        :class:`ChannelCreationUnsupported` instead when declining without
        asking the platform at all.
        """
        ...

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        """Provision a 1:1 DM-style channel between a single agent and a single
        external user, invite that user, and return the external channel id.

        Used for outbound-created DM rooms (`channel_type="direct"`). Platforms
        where DMs can only be initiated by the user — and so cannot be created
        from Switch — raise instead of pretending to succeed."""
        raise ChannelCreationUnsupported(
            f"{self.platform_name} cannot create DM channels — on this platform "
            "DMs are initiated by the user from the messaging client"
        )

    @property
    def platform_name(self) -> str:
        """The platform as a person would name it, for messages that reach a
        user. The class name stands in only for an adapter that was never
        registered, which declares no `display_name`."""
        declared = getattr(type(self), "display_name", None)
        return declared or type(self).__name__.removesuffix("Adapter")

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Search the platform's own user directory (CHOO-2137).

        Lets someone claim their platform identity before Switch has ever seen
        them speak — `ExternalUser` rows are only created on first message, so
        without this a freshly connected workspace offers nobody to pick from.

        Platforms with no searchable directory raise instead of returning an
        empty list, so the caller can say "you must post once first" rather
        than showing an empty picker that looks broken.
        """
        raise NotImplementedError(
            f"{self.platform_name} has no searchable user directory, so this "
            "lists only people who have written in a chat connected to Switch. "
            "If you are not listed, send a message in a connected group, then "
            "search again"
        )

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        """Native deeplink that opens this channel in the platform's desktop
        app (Switch Console → messaging app direction), or None when the platform
        has no such scheme or the link cannot be built.

        Each platform owns its link format here — Slack builds a ``slack://``
        URL from the workspace id, Mattermost a ``mattermost://`` URL from the
        server + team + channel name."""
        return None

    async def home_deeplink(self) -> str | None:
        """Link that opens this bridge's *workspace* — the Slack workspace, the
        Discord guild, the Mattermost team — rather than one channel within it.
        None when the platform has no such link or it cannot be built.

        The bridge-level counterpart to :meth:`channel_deeplink`, for offering
        "open the messaging app" next to the bridge itself. Built from the
        connection config, which never leaves the server; only the resulting
        URL is exposed."""
        return None

    async def install_links(self) -> list[BridgeInstallLink]:
        """One-click links that add this bridge's app to a chat, if the
        platform has them.

        Empty by default: on most platforms installation is an app-directory or
        OAuth flow the operator runs elsewhere, and inventing a link for it
        would be a link to nowhere. An adapter overrides this only when the
        platform accepts a URL that selects the chat and works on every client
        of that platform."""
        return []

    @property
    def places_app_in_teams(self) -> bool:
        """Whether Switch chooses which of the platform's teams its app is in.

        True only for a bridge on an app the deployment owns and can add to,
        and remove from, the organisation's teams itself (the distributed
        Teams app). Everywhere else the app is added on the platform by
        whoever owns it, and the dashboard offers nothing to choose.
        """
        return False

    async def check_config_edit(self, connection_config: Mapping[str, object]) -> None:
        """Raise `ConfigEditRefused` for an edit only the platform can tell is wrong.

        Asked of the running bridge before an edit of its settings is stored,
        with the settings as they would be after it. For what validating the
        config cannot know by itself — whether a team it names is one the app
        is in, say. Nothing, by default.
        """
        return None

    async def attention(self) -> str | None:
        """What a workspace admin has to do for this bridge to keep working.

        Something only the platform's side can fix — an approval withdrawn, an
        app blocked by the organisation's admin — found while the bridge runs,
        in plain words fit to show on the connection. None while nothing is
        known to be wrong, which is the default.
        """
        return None

    async def install_note(self) -> str | None:
        """What the links do not cover, in the platform's own terms.

        Rendered under :meth:`install_links` in the operator dashboard. Some
        kinds of chat cannot be reached by a link at all, and the operator is
        better told where to go instead than left to conclude a button is
        missing. Markdown-free plain text; None when there is nothing to add."""
        return None

    async def require_bindable_channel(self, channel_id: str) -> None:
        """Refuse a channel id someone asked to bind a room to, unless it is
        this bridge's own.

        Asked before a room is bound to an existing channel by id, when a room
        is created or moved, and never for a channel the platform delivered to
        this bridge. The id is the caller's, and binding decides where the
        room's messages are posted.

        Nothing to refuse by default: a bridge whose credential is its own can
        reach only what that credential reaches. A bridge on a connection
        shared between organisations can reach every organisation's channels,
        so being able to see one says nothing about whose it is, and it has to
        say here which are its own. Raises `ChannelNotBindable`.
        """
        return None

    async def check_channel_usable(self, channel_id: str) -> None:
        """Refuse an existing channel a room cannot use, before it is bound.

        Asked whenever a room is bound to a channel named by id. Raise
        `ChannelNotUsable` with the platform's reason when the channel does not
        exist or the Switch app is not in it, so the person who typed the id
        learns what to fix instead of a server error. Nothing to check by
        default.
        """
        return None

    def can_own_channel(self, external_user_id: str) -> bool:
        """Whether this platform account can be named a private channel's
        owner. Asked only where `private_channel_needs_owner`; a platform
        that knows some of its ids cannot be used (Teams, where only a
        directory id can) says so here."""
        return True

    def channel_ids_refused(self) -> str | None:
        """Why this bridge binds no existing channel by id at all, or None.

        For a bridge whose chats reach it only one way, so the dashboard can
        say so where a room is created rather than offer a choice that fails.
        Plain text, and the one wording: a bridge that answers here refuses
        with it too.
        """
        return None

    @abstractmethod
    async def get_channel_type(self, channel_id: str) -> ChannelType: ...

    @abstractmethod
    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None: ...

    @abstractmethod
    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """Add the given people to a channel; return the ids that could not be.

        ``user_names`` and ``user_external_ids`` are positionally paired.

        A person who cannot be added is a poor reason to fail the whole
        operation — the caller is usually creating a room, and abandoning it
        over one guest account or one missing platform permission leaves a
        half-provisioned room behind and tells the operator nothing. Nor should
        it pass silently, which reports a room that quietly lacks the people
        asked for. So: continue, and hand back who was left out for the caller
        to disclose.
        """
        ...

    async def remove_users_from_channel(
        self, channel_id: str, user_external_ids: list[str]
    ) -> list[str]:
        """Take the given people out of a channel; return the ids that could
        not be.

        The base cannot remove anyone and says so for every id: a platform
        whose bot may not take people out (Telegram, which cannot add them
        either) keeps it. As with adding, one refusal does not stop the rest.
        """
        return list(user_external_ids)

    async def list_channel_members(
        self, channel_id: str, *, known_people: Collection[str] = ()
    ) -> ChannelMembers | None:
        """Who is in a channel, for lining its room up with it, or None on a
        platform that cannot list a channel's members (Telegram).

        People only: bots, the app itself and Switch's agents are left out.
        A listing cut short says so (`complete` False) rather than passing
        for the whole channel, as the caller removes whoever is missing from
        a complete one.

        `known_people` are platform ids Switch already files as people on
        this bridge: an adapter that has to ask the platform about each
        member may skip them, and list them with an empty name.
        """
        return None

    async def members_gone(
        self, channel_id: str, external_user_ids: Collection[str]
    ) -> set[str] | None:
        """Of these people, the ones the platform says are no longer in the
        channel, asked one by one: for a platform that cannot list a
        channel's members (Telegram) but can say whether one person is in it.
        None where the platform cannot answer either. Someone it would not
        answer about is not counted as gone."""
        return None

    def can_list_channel_members(
        self, channel_id: str, channel_type: str | None
    ) -> bool:
        """Whether `list_channel_members` can give this channel's whole member
        list, so its room counts everyone in the channel and not only those
        who have posted. Asked before a room is made private, where anyone
        the room does not count would lose sight of it, for many rooms at
        once: so it calls no platform, and decides from what this process
        knows and the room's recorded `channel_type`. The base cannot list
        anyone (Telegram)."""
        return False

    @abstractmethod
    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        """Give the agent its platform handle, or bring an existing one in
        line with it. Idempotent."""

    @abstractmethod
    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        """Retire the agent's platform handle. Raises when the platform could
        not be told, so the caller can say the clean-up is outstanding."""

    async def check_agent_identity_name(self, agent_id: str, new_name: str) -> None:
        """Raise `AgentIdentityConflict` if this platform has something other
        than agent ``agent_id`` holding the handle ``new_name`` would need.

        Asked before a rename is written, so a clash refuses the rename instead
        of leaving the agent renamed in Switch and stranded on the platform.
        Default: nothing to check."""
        return None

    async def rename_agent_identity(self, old_name: str, agent: AgentIdentity) -> None:
        """Move the agent's platform handle from ``old_name`` to ``agent.name``.

        Default: retire the old handle and provision a new one. Adapters that
        can rename their platform object in place override this, so whatever
        hangs off it (membership, history) carries over."""
        await self.remove_agent_identity(replace(agent, name=old_name))
        await self.create_agent_identity(agent)

    async def update_agent_identity(self, agent: AgentIdentity) -> None:
        """The agent's display name or description changed. Default: nothing,
        for platforms whose handle carries neither."""
        return None

    async def sync_agent_identities(
        self, agents: Sequence[AgentIdentity]
    ) -> list[tuple[str, BaseException]]:
        """Bring every agent's handle in line, at bridge start.

        Returns the agents that failed, by name, with what went wrong, rather
        than stopping at the first. Adapters that can tell their own handles
        apart from everything else on the platform override this to also
        retire handles left behind by agents that no longer exist."""
        failures: list[tuple[str, BaseException]] = []
        for agent in agents:
            try:
                await self.create_agent_identity(agent)
            except Exception as exc:
                failures.append((agent.name, exc))
        return failures

    @abstractmethod
    async def get_channel_agent_names(self, channel_id: str) -> list[str]: ...

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """Retire a deleted room's channel as far as this platform allows.

        Called when a person deletes the room, never when a connection is
        removed — by then the bot may have lost its access. Returns what
        happened, matching `channel_on_delete` when it works. A refusal from
        the platform comes back as `RetireOutcome.failed` carrying what the
        platform said rather than being raised: the room is deleted either
        way, and the person is told the channel needs cleaning up by hand.

        The base leaves the channel where it is.
        """
        return RetireOutcome(outcome="kept")

    @final
    def translate_outbound(self, content: str) -> str:
        """Render a Switch body in this platform's markup, unable to page.

        Final so that no adapter can forget the defusal: a platform renders in
        `_render_outbound`, and nothing a body says can then page a channel.
        Only `render_room_wide_mention` does that, for a message the server
        marked.

        A Markdown link to a Switch Console page is rewritten first, on a
        platform that cannot open `switchdash://` (`rewrite_console_links`),
        so the platform renders an https link like any other.
        """
        if not self.renders_custom_url_schemes:
            content = rewrite_console_links(content, self._gateway_public_url)
        return self.defuse_mass_mentions(self._render_outbound(content))

    @abstractmethod
    def _render_outbound(self, content: str) -> str:
        """Render a Switch body in this platform's markup."""

    def defuse_mass_mentions(self, text: str) -> str:
        """Break every channel-wide mention in text on its way to the platform.

        Safe by default: the words — `@everyone`, `@channel`, `@here`, `@all`
        — are defused everywhere, code and URLs included, which is what a
        platform that pages from plain text (Mattermost) needs. A platform
        whose text cannot page on its own overrides this to leave code, URLs
        and addresses exact, and one with a syntax of its own for the same
        thing (Slack's `<!channel>`) escapes that too.
        """
        return defuse_mass_mention_words(text)

    def render_room_wide_mention(self, body: str) -> str:
        """The platform text of a message the server marked as room-wide.

        The body opens with the `@everyone` the server wrote. That token is
        taken off before translation, so a person on the platform who happens
        to be called `everyone` is not the one it resolves to, and the
        platform's own channel-wide mention goes in its place after
        translation, so the defusal the rest of the body gets cannot break it.
        """
        rest = self.translate_outbound(strip_room_wide_target(body))
        opening = self.channel_mention or defuse_mass_mention_words(
            f"@{ROOM_WIDE_TARGET}"
        )
        return f"{opening} {rest}" if rest else opening

    @property
    def room_wide_mention_notifies(self) -> bool:
        """Whether a room-wide mention reaches every member here."""
        return self.channel_mention is not None or self.every_message_notifies_members

    @abstractmethod
    def translate_inbound(self, raw_message: str) -> str: ...

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        """Supply known ``username -> external user id`` pairs for this bridge.

        Called on startup with every external user on the bridge, and again as
        new ones are provisioned. Platforms that address people by an opaque id
        (Slack's ``<@U…>``) need the mapping to render an outbound ``@name`` as
        a real mention; without it the name goes out as plain text and the
        person is never notified. Default is a no-op, since platforms that
        mention by handle (Mattermost) need no mapping at all."""
        return None

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """(Re)establish any server-side message capture for the given
        ``(channel_id, channel_type)`` pairs.

        Called on bridge startup with the bridge's known channels. Default is a
        no-op; adapters that rely on expiring server-side subscriptions (Teams,
        via Microsoft Graph) override this so channel capture self-heals after a
        restart or a notification-URL change (e.g. a rotated tunnel), without the
        bot having to be re-added to each channel."""
        return None

    async def refresh_channel_types(self, channel_ids: list[str]) -> None:
        """Re-read each channel's type from the platform and report it through
        the channel-type handler. Called at bridge startup. Default is a no-op;
        only Teams saves types it could not verify."""
        return None

    def set_outbound_policy(self, policy: OutboundPolicy) -> None:
        """Install the policy for anything this adapter fetches from a URL a
        tenant or agent chose. Set by the lifecycle before the adapter starts."""
        self._outbound_policy = policy

    @property
    def outbound_policy(self) -> OutboundPolicy:
        policy: OutboundPolicy | None = getattr(self, "_outbound_policy", None)
        if policy is None:
            raise RuntimeError(
                f"{type(self).__name__} fetched a URL before its outbound policy "
                "was set"
            )
        return policy

    def set_service_url_persister(
        self, persist: Callable[[str], Awaitable[None]]
    ) -> None:
        """Install a callback the adapter uses to persist an outbound endpoint
        it learns from inbound traffic, so outbound survives a restart.

        Default is a no-op; adapters whose outbound endpoint is only discovered
        from inbound activities (Teams, whose Bot Connector ``serviceUrl`` is
        carried on inbound activities) override this to persist it."""
        return None

    def set_bridge_id(self, bridge_id: str) -> None:
        """Tell the adapter the id of the bridge it serves.

        Default is a no-op. Slack overrides it to mark the user groups it
        creates as this bridge's, so clean-up never touches a group another
        Switch installation made in the same workspace.
        """
        return None

    def set_tenant_id(self, tenant_id: str) -> None:
        """Tell the adapter which tenant its bridge belongs to.

        Default is a no-op: an adapter's state is its own bridge's and needs
        no tenant. Slack overrides it, because it shares one structure across
        every Slack bridge in the process and has to keep tenants apart in it.
        """
        return None

    def set_session_factory(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Install a database session factory for adapters that access shared database stores
        (such as cross-pod event deduplication receipts). Default is a no-op."""
        return None

    def set_channel_team_persister(
        self, persist: Callable[[str, str], Awaitable[None]]
    ) -> None:
        """Install a callback the adapter uses to persist which container a
        channel belongs to, when that is learned from inbound traffic rather
        than configured.

        Default is a no-op; Teams overrides it because a Graph message
        subscription is created against `teams/{team}/channels/{channel}`, and
        the team arrives only on an inbound activity. Losing it on restart
        silently kills capture in every channel outside the configured team."""
        return None

    def set_default_team_writer(
        self, write: Callable[[str | None, str | None], Awaitable[bool]]
    ) -> None:
        """Install a callback the adapter uses to change the container new
        channels go in as it joins and leaves containers: `write(expected,
        team_id)` stores `team_id` (None to clear it) only if the stored one is
        still `expected`, and answers whether it did, so an admin's choice made
        meanwhile is kept.

        Default is a no-op; Teams overrides it because a connection on the
        distributed app is approved before Switch is in any team, so it has
        no default team until it joins one, and keeps none it has left."""
        return None

    def set_callback_endpoint(self, endpoint: CallbackEndpoint) -> None:
        """Hand the adapter its own place on the shared callback listener.

        Default is a no-op, and the right answer for every adapter that only
        dials out: nothing has to reach Switch for it to work, so it never asks
        to be served and the listener never binds. Mattermost overrides it,
        because a button press there is delivered to a URL.

        The endpoint arrives already bound to this bridge. An adapter is built
        from its connection config alone and is never told which bridge it is,
        which is what stops it addressing another bridge's callbacks even by
        mistake."""
        return None

    def set_webhook_url(self, url: str | None) -> None:
        """Hand a `receives_webhooks` adapter the public address its platform
        should deliver this connection's events to, before it starts.

        For a platform whose address is registered through its API rather than
        pasted into a settings page (Telegram's `setWebhook`): the adapter
        registers it in `start`. None where the deployment has no
        `MESSAGING_PUBLIC_URL`; an adapter that has to register its address
        should then fail to start with a `BridgeOperationError` saying so,
        since no event could ever reach it. Called only for adapters that set
        `receives_webhooks`; the default stores it on `self.webhook_url`.
        """
        self.webhook_url = url

    def set_channel_migration_handler(
        self, handler: Callable[[str, str], Awaitable[None]]
    ) -> None:
        """Install the callback an adapter calls when the platform reissues a
        channel's id, so the room bound to the old one follows it.

        Stored for every adapter and used by those whose platform does this:
        Telegram reissues a chat's id when a basic group becomes a supergroup.
        The symptom without it is one-way traffic — sends still arrive, because
        the platform forwards them, while nothing inbound matches a room again."""
        self._on_channel_migrated = handler

    def set_channel_rename_handler(
        self, handler: Callable[[str, str, str], Awaitable[None]]
    ) -> None:
        """Install the callback an adapter calls with a channel's name when the
        platform reports a change to it, so the room linked to it can follow.
        Called with an empty old name when the platform did not say, and with
        both names the same when the bridge is only reporting what it sees."""
        self._on_channel_named = handler

    def set_channel_type_handler(
        self, handler: Callable[[str, ChannelType], Awaitable[None]]
    ) -> None:
        """Install the callback an adapter calls when it learns a channel's
        type from the platform, so rooms saved with a different one follow."""
        self._on_channel_type_learned = handler

    def set_interaction_handler(
        self, handler: Callable[[InboundInteraction], Awaitable[None]]
    ) -> None:
        """Install the callback for a control on a posted message being operated.

        A setter rather than another argument to `start` because only the
        platforms with interactive message controls ever call it, and an adapter
        that never does needs no change to go on working."""
        self._on_interaction = handler

    def set_user_left_handler(
        self, handler: Callable[[InboundUserLeave], Awaitable[None]]
    ) -> None:
        """Install the callback for a person leaving a bridged channel.

        A setter rather than another argument to `start`, as for
        interactions: a platform that never reports departures needs no
        change to go on working."""
        self._on_user_left = handler

    def set_member_sync_hooks(
        self,
        *,
        bridged_channels: Callable[[], Collection[str]],
        request_sync: Callable[[list[str]], None],
    ) -> None:
        """Install the bridge core's view of which channels have rooms, and
        its way to line channels' rooms up with their members again.

        A setter for the same reason as `set_user_left_handler`: only a
        platform whose membership changes arrive per server rather than per
        channel (Discord) needs them."""
        self._bridged_channels = bridged_channels
        self._request_member_sync = request_sync

    def _bridged_channel_ids(self) -> set[str]:
        """The channels this bridge has rooms for, or none when unknown."""
        if self._bridged_channels is None:
            return set()
        return set(self._bridged_channels())

    def _resync_members(self, channel_ids: list[str]) -> None:
        """Ask the bridge core to line these channels' rooms up again."""
        if self._request_member_sync is not None and channel_ids:
            self._request_member_sync(channel_ids)

    async def _user_left(self, leave: InboundUserLeave) -> None:
        """Hand a departure to the bridge core, if one is listening."""
        if self._on_user_left is not None:
            await self._on_user_left(leave)

    def set_activity_resolver(
        self, resolver: Callable[[str, str], Awaitable[ActivitySnapshot | None]]
    ) -> None:
        """Install the read-back for the turn behind a status message.

        Separate from the interaction handler because the two answer different
        questions. That one carries an answer inwards and is told nothing
        back; this one is a read, made because somebody is waiting on the
        platform for what it returns, and the platform is holding an
        acknowledgement open until it does."""
        self._resolve_activity = resolver

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        """Whether `message_ref` is the first thing said under `root_ref`.

        Asked when someone answers a request card with a word that names no
        request — a bare "yes". That only counts as an answer while nothing
        else has been said under the card, because once a thread has a
        conversation in it a "yes" is as likely to be about the conversation.

        Read from the platform each time rather than tracked here: two replies
        arriving at once would both look like the first to anything counting
        locally, and each would decide the request.

        False is the answer whenever a platform cannot tell, and this base is a
        platform that cannot. Refusing costs someone the retype of a handle;
        accepting decides a permission from a word that was about something
        else. Only reachable on a platform that posts request cards.

        An implementation must not raise. This is asked on the inbound path of
        every message, ahead of the relay, so an exception out of it is not a
        refused answer but a message the room never sees."""
        logger.warning(
            "Cannot tell whether %s is the first reply under %s in %s, so it "
            "does not answer the card there. %s posts request cards without a "
            "way to read a thread back.",
            message_ref,
            root_ref,
            channel_id,
            self.platform_name,
        )
        return False

    async def answer_command(self, command: InboundCommand, text: str) -> None:
        """Answer a command the bridge handles itself, without a room
        (`chat_account_links.ACCOUNT_COMMANDS`).

        `text` is Switch Markdown. It goes to the sender alone the way
        `notify_privately` reaches them, and otherwise into the channel the
        command came from, threaded under it, as the bridge. A direct
        conversation is private already; a group DM is not. A platform with a
        private reply to the command itself, carried in `command.reply_ref`,
        overrides this to use it first.
        """
        if (
            self.private_notice_delivery != "in_channel"
            and command.channel_type != "direct"
        ):
            try:
                await self.notify_privately(
                    channel_id=command.channel_id,
                    channel_name=command.channel_name,
                    user_id=command.sender_id,
                    content=text,
                    thread_root_id=command.root_id,
                )
                return
            except PrivateNoticeRefused as refused:
                logger.warning(
                    "%s would not let the bot reach %s privately (%s): "
                    "answering %s in channel %s instead",
                    self.platform_name,
                    command.sender_name,
                    refused,
                    command.command,
                    command.channel_id,
                )
            except Exception:
                logger.warning(
                    "Could not answer %s privately on %s: answering in channel "
                    "%s instead, where everyone in it sees it",
                    command.command,
                    self.platform_name,
                    command.channel_id,
                    exc_info=True,
                )
        await self.admin_message(
            command.channel_id,
            text,
            command.root_id or command.message_ref,
        )

    def direct_prompt_unavailable(self) -> str | None:
        """Why this bridge can't send anyone a direct prompt right now, in words
        for the Switch user, or None when it can.

        Asked before an account's prompt allowance is spent, so a platform that
        could never send one is not counted as having messaged anyone. A refusal
        about one person (they have not started the bot, their DMs are closed)
        is `send_direct_prompt`'s to raise. This base can't send one at all.
        """
        return (
            f"Switch can't send direct messages on {self.display_name}, so use "
            "the code instead."
        )

    async def send_direct_prompt(
        self, external_user_id: str, prompt: DirectPrompt
    ) -> str:
        """Message `external_user_id` directly with `prompt`, and return the
        message's ref in the form a press on it carries back
        (`InboundInteraction.message_ref`).

        Each button carries `prompt.token` and its position the way this
        platform's card buttons carry theirs, so a press arrives on the
        ordinary interaction path.

        Raises `DirectMessageUnavailable`, saying why for the Switch user, when
        this platform cannot reach the person directly. This base is such a
        platform.
        """
        raise DirectMessageUnavailable(
            f"Switch can't send direct messages on {self.display_name}, so use "
            "the code instead."
        )

    def direct_prompt_link(self, message_ref: str) -> str | None:
        """A web link that opens the conversation holding a prompt sent by
        `send_direct_prompt`, for Switch Console to offer beside the number to
        tap, so nobody has to go looking for the message. None where the
        platform has no such link.
        """
        return None

    async def settle_direct_prompt(self, message_ref: str, text: str) -> None:
        """Replace a prompt sent by `send_direct_prompt` with `text` (Switch
        Markdown) and no buttons, once it has been answered.

        Best effort, and must not raise: the answer has already been recorded,
        and a message still showing buttons only invites a press that will be
        told so.
        """
        logger.warning(
            "%s cannot replace the direct prompt %s. It was answered: %s",
            self.display_name,
            message_ref,
            text,
        )

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        """Tell one person that the answer they gave a request card did not land.

        Privately, where the platform has a private reply: only they need to
        know, and a channel post saying so puts the failure in front of
        everyone who was not answering.

        This base is a platform that has none, so it says it in the card's
        thread instead. Everyone reading that thread sees a notice addressed to
        somebody else, which costs less than the alternative it replaced:
        silence, and one person waiting on a card that is never going to move.

        `text` is plain words, and `actor_name` is the display name of whoever
        answered — needed only where the notice is not private, so that a
        thread reading it can tell whose answer failed. Both are neutralised
        with `escape_label_for_body`, which is the per-platform rule for
        untrusted text going into a body: a refusal quotes back what the person
        typed, and the reason for one quotes what the host called an option.

        Nothing is said without a thread to say it in. A press carries none,
        and the channel root is a wider audience than the card's thread — but
        the controls that produce a press are inert on every platform that
        reaches this base, so what that branch really guards is a platform
        gaining buttons before it gains a private reply.

        An implementation must not raise. This runs on the inbound path of
        every message, ahead of the relay, so an exception out of it is not an
        unreported refusal but a message the room never sees."""
        if thread_ref is None:
            logger.warning(
                "Cannot tell %s in %s that their answer did not land: %s has no "
                "way to say something to one person, and there is no thread to "
                "say it in instead. The notice was: %s",
                actor_ref,
                channel_id,
                self.platform_name,
                text,
            )
            return
        notice = (
            f"{self.escape_label_for_body(actor_name)}: "
            f"{self.escape_label_for_body(text)}"
        )
        try:
            await self.admin_message(channel_id, notice, thread_ref)
        except Exception as e:
            # Broad because this runs on the inbound path of every message: a
            # notice that cannot be posted must not cost the room the message
            # that triggered it.
            logger.warning(
                "Could not tell %s in %s that their answer did not land: %s. "
                "The notice was: %s",
                actor_ref,
                channel_id,
                e,
                text,
            )

    async def notify_privately(
        self,
        *,
        channel_id: str,
        channel_name: str | None,
        user_id: str,
        content: str,
        thread_root_id: str | None,
    ) -> None:
        """Say `content` to `user_id` alone, about a message they posted in
        `channel_id`, the way `private_notice_delivery` declares.

        `content` is Switch Markdown, rendered here as `admin_message` renders
        its body. `thread_root_id` is where the message sits, for a notice
        shown in the channel; `channel_name` names the channel in a notice
        that arrives somewhere else, so the reader can tell which message it
        is about.

        Raises when the notice cannot be delivered privately, so the caller
        can post it in the channel instead and say so: `PrivateNoticeRefused`
        when the platform refuses to reach this person, which is expected,
        anything else when it failed. A long `content` is split as
        `admin_message` splits it, so its length never costs the private
        route. The base has no private
        route and is never called for one: `private_notice_delivery` is
        `in_channel` here."""
        raise NotImplementedError(
            f"{self.platform_name} has no way to say something to one person privately"
        )

    def set_agent_presentation_resolver(
        self, resolver: Callable[[str], Awaitable[AgentPresentation | None]]
    ) -> None:
        """Install the lookup for how an agent is presented — its label and its
        icon — returning None for a name that is not an agent at all.

        The bridge core supplies this because the adapter has no database of
        its own. One resolver rather than one per field because a send needs
        both at once and they come off the same row: two would be two round
        trips for one message. Resolution happens per send rather than being
        cached, so a renamed or re-iconed agent reads correctly on its next
        message instead of at the next restart."""
        self._resolve_agent_presentation = resolver

    def adapt_icon_url(self, icon_url: str) -> str:
        """Turn the icon URL chosen for a sender into the one this platform
        should be handed.

        Pure and synchronous so it composes with a single lookup: an override
        adjusts the URL, it does not go looking for one."""
        return icon_url

    def escape_label_for_body(self, label: str) -> str:
        """Neutralise a label's markup before it goes into message text.

        A display name is presentation text an agent's owner chooses, and an
        adapter inlines it into a body. Two constructs are near universal
        across chat platforms and are the ones a name can use to claim
        something it is not:

        - `@…` addresses somebody. Whether the platform resolves `@channel`,
          `@here`, a person or one of our own agent handles, the label gets to
          notify people the message was never aimed at. A zero-width space
          after every `@` leaves the sigil legible and the resolution dead.
        - `[text](url)` renders an anchor whose destination the label chose
          and whose visible text hides it. The zero-width space goes after the
          `]`, breaking the `](` adjacency every Markdown dialect requires —
          after the `[` it lands inside the visible text and the link still
          matches.

        Defused rather than escaped, because the escape has to survive as far
        as whatever renders it: on most platforms nothing of ours resolves
        these, so there is no matcher here to defeat, only the platform's own
        rendering. A zero-width space is also inert in every escaping pipeline
        it may pass through afterwards, so it cannot compound with one.

        Safe by default and specialised by override: the failure mode of the
        other order is silent, since a platform whose adapter forgets this
        renders a forged name correctly and says nothing. An override adds its
        platform's own rule on top and calls up to this one — Teams its `<at>`
        tags, Slack and Discord their markup escaping. None of them replaces
        it, and the `@` rule is why: a platform's escaper defends against the
        label carrying that platform's syntax, but Switch's own outbound
        mention pass runs over the finished body and turns a plain `@handle`
        into a real mention, needing no syntax from the label at all.

        Not covered anywhere: emphasis, where a label's `*` or `_` can
        unbalance the run around it. That is cosmetic, and the line held here
        is that forged markup is closed while broken formatting is not worth
        an escape that would show up in every ordinary name."""
        return defuse_label_markup(label)

    async def agent_rendering(self, agent_name: str) -> AgentRendering:
        """Everything a send needs to present an agent, from ONE lookup.

        The paired accessor, for the common case of a post that carries both a
        name and an avatar. The single-field accessors below are for callers
        that need one of them alone — an unescaped label is not among them:
        :attr:`AgentRendering.field_label` is reachable only alongside the
        escaped one, so choosing it is a choice."""
        # An agent with no icon wears the face its name generates; a name the
        # resolver says is no agent keeps a lettered badge, so a person relayed
        # from elsewhere is never drawn as an agent. The name is the sending
        # actor's own (an agent's is its identifier, never a room alias), so a
        # miss is a sender that is not an agent rather than an agent the lookup
        # failed to recognise.
        #
        # Without a resolver nothing can say who is who. The senders an adapter
        # draws are overwhelmingly agents, so it draws them as agents rather
        # than turning every agent into a person. The bridge core installs one
        # before the adapter starts, so a running bridge without it is a wiring
        # fault, and said so once.
        #
        # The face and the badge are both drawn by outside services that see
        # the name. With third-party avatars off neither is built, and a stored
        # icon on one of those services is withheld too, so the sender goes out
        # with no icon and the platform draws its own default.
        if self._resolve_agent_presentation is None:
            if not self._reported_missing_resolver:
                self._reported_missing_resolver = True
                logger.warning(
                    "%s has no agent presentation resolver: every sender is "
                    "drawn as an agent under its identifier, people included",
                    type(self).__name__,
                )
            label = agent_name
            icon_url = self._generated_icon(agent_name)
        else:
            found = await self._resolve_agent_presentation(agent_name)
            label = (found.display_name if found else None) or agent_name
            if found is None:
                icon_url = (
                    initials_icon_url(agent_name) if self._third_party_avatars else None
                )
            elif found.icon_url is None:
                icon_url = self._generated_icon(agent_name)
            elif not self._third_party_avatars and is_third_party_avatar(
                found.icon_url
            ):
                icon_url = None
            else:
                icon_url = found.icon_url
        return AgentRendering(
            field_label=label,
            body_label=self.escape_label_for_body(label),
            icon_url=None if icon_url is None else self.adapt_icon_url(icon_url),
        )

    def _generated_icon(self, agent_name: str) -> str | None:
        return generated_icon_url(agent_name) if self._third_party_avatars else None

    async def agent_icon_url(self, agent_name: str) -> str | None:
        """The icon URL to render for an agent on this platform.

        Adapters call this wherever they need a per-message avatar: the agent's
        own icon when it has one, otherwise this platform's existing default.
        None when third-party avatars are off and the icon would have come from
        an outside avatar service: the generated face or lettered badge, or a
        stored icon on one of those services, whoever chose it. The platform
        then draws its own default."""
        return (await self.agent_rendering(agent_name)).icon_url

    async def agent_label_for_body(self, agent_name: str) -> str:
        """The label to inline into message text, escaped for this platform.

        A display name is free text — punctuation is the point of it — so
        inlining it raw lets a name break the surrounding markup or forge
        markup of its own. Every caller that builds a body string must use
        this, or :attr:`AgentRendering.body_label`."""
        return (await self.agent_rendering(agent_name)).body_label
