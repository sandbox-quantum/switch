from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, ClassVar

import httpx
import requests as sync_requests
from mattermostdriver import Driver
from mattermostdriver.exceptions import (
    ContentTooLarge,
    FeatureDisabled,
    InvalidOrMissingParameters,
    MethodNotAllowed,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
)

from switch_core.agent_icon import default_icon_url
from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivitySnapshot,
    CollaborationAdapter,
    RemovalFailed,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.ingress import (
    CallbackEndpoint,
    CallbackRefused,
)
from switch_core.bridges.collaboration.mattermost.callback import (
    MAX_BUTTON_LABEL,
    ActivityPress,
    InterruptPress,
    activity_action,
    answer_actions,
    interrupt_action,
    read_press,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    ChannelType,
    DirectoryUser,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_QUEUED_NOTE,
    Drawn,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    ACTIVITY_AUDIENCE_UNKNOWN,
    ACTIVITY_FAILED,
    ACTIVITY_GONE,
    ACTIVITY_NOT_A_MEMBER,
    activity_log,
    render_request,
    turn_status,
)
from switch_core.sessions.contract import TURN_ENDED

logger = logging.getLogger(__name__)

# Ceiling on a bot icon Switch downloads before re-uploading it to Mattermost.
# Generously above any real avatar; it exists so a hostile or broken URL cannot
# stream unbounded data into memory.
_MAX_BOT_ICON_BYTES = 5 * 1024 * 1024

# Mattermost channel types a bot can be *added* to: open and private channels.
# Membership of a DM ("D") or group DM ("G") is a property of the conversation
# existing rather than of anyone joining, so Mattermost raises no `user_added`
# for them and they must not be adopted from a membership sweep either — a DM
# becomes a room when someone actually writes in it.
_JOINABLE_MM_CHANNEL_TYPES = frozenset({"O", "P"})

# Emoji marking the message an agent is currently working on.
_REACTION: dict[ActivityMark, str] = {
    "working": "eyes",
    "queued": "hourglass_flowing_sand",
}

# The post property carrying a publication's recovery marker. Props are part of
# the post but not part of what anyone reads, which is exactly what this needs
# to be: a marker in the message body would be visible clutter, and a marker
# held only on this side is lost the moment a post's response is — which is the
# one case it exists for. `patch_post` leaves props it is not given alone, so
# editing the status in place cannot drop it.
_PUBLICATION_PROP = "switch_publication"

# Where a post's buttons live. Mattermost carries interactive actions inside a
# message attachment in the post's props, and keeps each action's `integration`
# — the callback URL and its context — server-side, never serialising it to a
# client.
_ATTACHMENTS_PROP = "attachments"

# How far before the recorded reservation time to start looking for a post that
# may or may not exist. Covers ordinary clock skew between Switch and the
# Mattermost server without widening the search into unrelated history.
_RECOVERY_SKEW_MS = 60_000

# Mattermost's own default `MaxPostSize`. Servers can raise it to 16383, and a
# message cut to fit the default is a message that fits everywhere.
_MAX_POST = 4000

# The values of `TeamSettings.TeammateNameDisplay` under which Mattermost puts
# a bot's display name in the post header. Under any other value — including
# the server default, "username" — the display name is stored and never shown.
_NAME_DISPLAY_SHOWS_LABEL = frozenset({"full_name", "nickname_full_name"})

# The errors that mean Mattermost read the request and refused it. `mattermostdriver`
# maps these statuses to named exceptions; every one of them says the post does
# not exist and sending it again unchanged would be refused again.
#
# Everything else — a timeout, a dropped connection, a 5xx — leaves it unknown
# whether the post is on the server with only its response lost, and that is a
# different answer entirely: see `_as_rich_failure`.
_DEFINITE_REFUSALS = (
    InvalidOrMissingParameters,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
    MethodNotAllowed,
    ContentTooLarge,
    FeatureDisabled,
)

# How long to wait after a rate limit that names no interval of its own.
# Matches the Slack adapter's fallback, for the same reason: long enough not to
# walk straight back into the limit, short enough that a live turn still moves.
_THROTTLE_FALLBACK_SECONDS = 30.0


def _throttle_delay(error: Exception) -> float | None:
    """Seconds Mattermost asked us to wait, or None if it did not ask.

    `mattermostdriver` has no exception for 429, so the underlying
    `requests.HTTPError` arrives with its response still attached — which is
    what carries the interval.
    """
    response = getattr(error, "response", None)
    if response is None or getattr(response, "status_code", None) != 429:
        return None
    headers = getattr(response, "headers", None) or {}
    try:
        return max(0.0, float(headers.get("Retry-After", "")))
    except (TypeError, ValueError):
        return _THROTTLE_FALLBACK_SECONDS


def _as_rich_failure(
    error: Exception, *, description: str, text: str
) -> RichContentFailed | None:
    """What a publication should make of a Mattermost error, or nothing.

    `None` means the outcome is unknown and the caller must let the error
    propagate: a post whose response was lost may be sitting in the channel,
    and `RichContentFailed` would have the caller drop its reservation and
    post a second copy of something a reader is meant to see once. The
    reservation survives instead, and `find_request_card` settles it.

    Only a server that understood the request and refused it becomes
    `RichContentFailed`, and only one asking us to slow down becomes
    `RichContentThrottled`.
    """
    retry_after = _throttle_delay(error)
    if retry_after is not None:
        return RichContentThrottled(retry_after=retry_after, text=text)
    if isinstance(error, _DEFINITE_REFUSALS):
        return RichContentFailed(f"{description}: {error}", text=text)
    return None


@dataclass(frozen=True)
class _Rendered:
    """A card drawn for Mattermost, and the same card drawn for anywhere else.

    `text` and `actions` go together on the post: where buttons carry the
    options the body stops listing them, so neither half is complete alone.
    `plain` is the drawing that needs no buttons, and it is what a failure is
    reported with — a payload the caller forwards as an ordinary message,
    which would otherwise ask for a choice it had stopped printing.
    """

    text: str
    actions: list[dict[str, Any]]
    plain: str


class MattermostConnectionConfig(BridgeConnectionConfig):
    url: str
    admin_user: str
    admin_password: str
    team_name: str
    # User-facing base URL of the Mattermost server, when it differs from `url`
    # (which is the internal URL Switch connects to — e.g. a private/tailnet
    # address). Used for the channel deeplink so the link works in the user's
    # desktop client. Falls back to `url` when unset.
    public_url: str | None = None
    # Human account to add to every channel this bridge creates. A bundled
    # Mattermost has exactly one human, and a room created by an agent names no
    # users — without this they would never be a member of a private channel and
    # could not read the room at all. Unset for bridges where membership is
    # managed on the platform.
    default_member: str | None = None
    # Verify the Mattermost server's TLS certificate. Defaults to True so admin
    # credentials and bot tokens are never sent over an unverified https
    # connection. Set False only for a self-signed internal CA you trust.
    verify_tls: bool = True
    # Base URL (scheme + host, no path) the *Mattermost server* reaches
    # Switch's callback listener on, for the button presses Mattermost delivers
    # by HTTP. Not `url` reversed and not `gateway_public_url`: this is a
    # separate port from the agent API, and the route between the two servers
    # is frequently nothing like the route a browser takes — a container alias
    # on a shared network, or an ingress hostname that only exists inside the
    # cluster. Unset means Switch has no address to give Mattermost, so cards
    # carry no buttons and stay answerable by typing.
    callback_base_url: str | None = None


# A refusal being collected for the person who pressed, if a press is what we
# are in the middle of. Mattermost has one chance to say something privately —
# the `ephemeral_text` on the response to the callback — so a notice raised
# while the answer is being judged has to be caught here and carried back out
# rather than posted where the channel would read it.
_PRESS_NOTICE: ContextVar[list[str] | None] = ContextVar(
    "switch_mattermost_press_notice", default=None
)


def _ephemeral(text: str) -> dict[str, Any]:
    """A callback reply Mattermost shows to the presser and to nobody else.

    `skip_slack_parsing` because what is in here is already Mattermost
    markdown, written by the neutral renderer. Without it the server runs the
    text through its Slack-to-Mattermost conversion first, which is a second
    pass of markup rules over something that has already been marked up — and
    the one case where that is visibly wrong is a log line whose emphasis comes
    back doubled.
    """
    return {"ephemeral_text": text, "skip_slack_parsing": True}


class MattermostAdapter(CollaborationAdapter):
    publishes_sdk_sessions: ClassVar[bool] = True

    #: A problem somebody has to act on still gets its own reply, so it
    #: notifies rather than arriving as a silent edit to a status the reader
    #: has already scrolled past. One per turn, cleared when it clears.
    separate_attention_slot: ClassVar[bool] = True

    #: A Mattermost thread notifies only the people named in it, so the agent's
    #: owner leads — they are who can open Console and act — and an attention
    #: post with nobody to name says as much. This is the legacy ping's policy,
    #: carried over: it is the one that reaches the person who can do something.
    notifies_only_by_mention: ClassVar[bool] = True

    #: The status is the turn's one post, not a line beside it, so the clock
    #: advancing is not on its own worth rewriting what a reader is reading.
    #: Elapsed time goes out with the next real change and with the ending.
    redraws_for_elapsed_time: ClassVar[bool] = False

    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True

    #: Each agent posts and reacts as its own bot here, so two agents working
    #: on one message leave two independent 👀 and each is claimed and removed
    #: on its own.
    activity_reactions_per_agent: ClassVar[bool] = True

    #: `find_request_card` reads the channel's recent posts back, so a card
    #: whose send was never acknowledged can be bound to what is actually
    #: there instead of being disclosed as lost.
    recovers_uncertain_posts: ClassVar[bool] = True

    #: Every publication carries its token in a post prop, which is exact and
    #: invisible, so a status is as findable as a card despite printing no
    #: handle of its own.
    carries_publication_marker: ClassVar[bool] = True

    #: An answered card is edited down to its outcome rather than taken back.
    #: The bridge could delete it — it connects as a system admin, so it may
    #: remove any post in the team — but Mattermost is alone in leaving a
    #: "(message deleted)" placeholder behind one removed while a client has
    #: the channel open. A settled card reads better than that tombstone and
    #: keeps the channel a record of what was asked and what was decided.
    removes_answered_cards: ClassVar[bool] = False

    def __init__(self, *, config: MattermostConnectionConfig) -> None:
        super().__init__()
        self._config = config

        self._admin_driver: Driver | None = None
        self._team_id: str = ""
        self._admin_user_id: str = ""

        self._agent_bots: dict[str, dict[str, str]] = {}
        self._bot_drivers: dict[str, Driver] = {}
        self._bot_id_to_username: dict[str, str] = {}
        self._bridge_bot_ids: set[str] = set()

        # Dedicated bot that posts admin/system messages (distinct from the
        # admin *user* and from per-agent bots). It can't join a 1:1 DM, so in
        # DM channels admin_message falls back to the agent's own bot.
        self._admin_bot_driver: Driver | None = None
        self._admin_bot_id: str | None = None

        self._seen_post_ids: OrderedDict[str, None] = OrderedDict()
        self._seen_post_ids_max = 1000
        self._seen_lock = threading.Lock()

        # (agent_name, post_id) currently carrying the working reaction. A
        # reaction belongs to the bot that added it, so two agents on the same
        # post are two independent marks.
        self._marked: set[tuple[str, str, ActivityMark]] = set()

        # Mattermost user id -> username, because a mention is written with the
        # handle and Switch stores the id. Stable for the life of a user, so a
        # hit here saves a round trip on every redraw that carries a mention.
        self._usernames: OrderedDict[str, str] = OrderedDict()
        self._usernames_max = 1000

        # post id -> the buttons last written onto it. A status post is redrawn
        # on every tool call and its buttons change at most twice in a turn, so
        # a redraw compares against this and leaves the props alone when there
        # is nothing to say — patching them means reading the post back first,
        # which is a round trip this bridge's hottest path cannot afford. A
        # post missing from here is treated as changed, so a restart costs one
        # read per post rather than leaving a dead control on it.
        self._post_actions: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
        self._post_actions_max = 1000

        self._main_loop: asyncio.AbstractEventLoop | None = None

        # channel id -> channel name (URL slug), for building channel deeplinks.
        self._channel_name_cache: dict[str, str] = {}

        # The server's `TeamSettings.TeammateNameDisplay`, read once per run:
        # it decides whether a bot's display name is rendered anywhere, and
        # under the default ("username") it never is. None once a read has been
        # attempted and could not answer.
        self._name_display_setting: str | None = None
        self._name_display_read = False
        self._name_display_warned = False

        # This bridge's place on the shared callback listener, installed by the
        # lifecycle service before start. None when the adapter is running
        # without one behind it, which is how most of the tests build it.
        self._callback: CallbackEndpoint | None = None

    def set_callback_endpoint(self, endpoint: CallbackEndpoint) -> None:
        self._callback = endpoint

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(
        self,
        on_message: Callable[[InboundMessage], Awaitable[None]],
        on_command: Callable[[InboundCommand], Awaitable[None]],
        on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]],
        on_user_joined: Callable[[InboundUserJoin], Awaitable[None]],
        on_app_joined: Callable[[InboundAppJoin], Awaitable[None]],
    ) -> None:
        self._on_message = on_message
        self._on_command = on_command
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        # Mattermost mints a per-agent bot, so agent joins are detected directly
        # in _handle_user_added; the app-join hook is unused here.
        self._on_app_joined = on_app_joined
        self._main_loop = asyncio.get_event_loop()

        self._admin_driver = self._create_driver(
            login_id=self._config.admin_user,
            password=self._config.admin_password,
        )
        await self._main_loop.run_in_executor(None, self._admin_driver.login)

        me = await self._main_loop.run_in_executor(
            None, self._admin_driver.users.get_user, "me"
        )
        self._admin_user_id = me["id"]

        team = await self._main_loop.run_in_executor(
            None, self._admin_driver.teams.get_team_by_name, self._config.team_name
        )
        self._team_id = team["id"]

        await self._ensure_admin_bot()

        await self._start_callbacks()

        logger.info(
            "Mattermost adapter connected to %s as %s",
            self._config.url,
            self._config.admin_user,
        )

    async def stop(self) -> None:
        self._admin_driver = None
        self._bot_drivers.clear()
        logger.info("Mattermost adapter stopped")

    # ── Callbacks ────────────────────────────────────────────────────────────

    @property
    def callback_url(self) -> str | None:
        """Where this bridge's presses should be delivered, or None if nowhere.

        None when either half is missing: an operator who has not said how the
        Mattermost server reaches Switch, or an adapter running without a
        listener behind it. A caller building a button asks this first — there
        is no button to draw without an address on it.
        """
        base = self._config.callback_base_url
        if not base or self._callback is None:
            return None
        return f"{base.rstrip('/')}{self._callback.path}"

    async def _start_callbacks(self) -> None:
        """Take presses for this bridge, or say once why there will be none.

        A request card is answerable by typing whether or not it carries a
        button, so no callback address is a reduced service rather than a
        failure to start. It is said out loud because it is otherwise
        invisible: cards keep arriving and simply never have anything to press.
        """
        if self._callback is None:
            return
        url = self.callback_url
        if url is None:
            logger.warning(
                "Mattermost cards on %s will carry no buttons: this bridge has "
                "no callback_base_url, so there is no address to give the "
                "Mattermost server for a press. Requests stay answerable by "
                "typing.",
                self._config.url,
            )
            return
        await self._callback.serve(self._handle_callback)
        logger.info(
            "Mattermost presses for %s will be taken at %s", self._config.url, url
        )

    async def _handle_callback(self, body: dict[str, Any]) -> dict[str, Any]:
        """Someone pressed a button on a card this bridge posted.

        Who pressed comes from the body, which the Mattermost server fills in
        and the button cannot. What the button carried is the card and the
        option, signed with this bridge's key so that a body assembled by
        anything but Mattermost — the route is reachable by whoever can reach
        the port — does not read as a press at all.

        Which card comes from the signed token rather than from the post the
        press arrived on, and is resolved against the stored record. That is
        what makes a press work after a restart: nothing about the card is held
        in memory between posting it and answering it.

        Nothing here dedupes. The same press twice is the same option, by the
        same person, against the same revision, which the shared layer derives
        one command id from — so the second is the first rather than a second
        answer.

        The reply is the one chance to say something to the presser alone:
        Mattermost shows `ephemeral_text` to them and nobody else. A refusal
        raised while the answer is being judged reaches `tell_actor`, which
        leaves it here rather than posting it where the channel would read it.

        Three kinds of button arrive here. An answer to a request card and a
        press on a turn's stop control both go inwards as interactions and are
        judged by the shared layer; a request to see a turn's tool calls is a
        read, answered in the reply itself and going no further than the person
        who asked.

        The stop control's action id is rebuilt on the way in rather than read
        off the wire. Mattermost allows letters and digits in an id, and the id
        the shared layer routes on is neither — so what identifies the press is
        the shape of the context it carried, which is signed.
        """
        if self._callback is None:
            raise CallbackRefused("This bridge takes no callbacks.", status=404)
        press = read_press(self._callback.key, body)
        if press is None:
            raise CallbackRefused("Not a press this bridge will act on.", status=401)
        if isinstance(press, ActivityPress):
            return await self._show_activity(press)
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch card in Mattermost channel %s has nowhere "
                "to go: this bridge handles no interactions, so the card should "
                "not have been drawn with buttons.",
                press.channel_id,
            )
            raise CallbackRefused("This bridge handles no presses.", status=404)

        name = await self._username_for(press.user_id)
        if name is None:
            # Refused rather than attributed to the raw id: the id is what the
            # answer is judged against, but the name is what a puppet is
            # created under, and inventing one from an id makes a person who
            # cannot be looked up into a permanent participant named after a
            # lookup failure.
            logger.error(
                "A press in Mattermost channel %s is from a user this bridge "
                "cannot resolve to a handle, so it is not acted on.",
                press.channel_id,
            )
            raise CallbackRefused("Switch could not identify you.", status=500)

        if isinstance(press, InterruptPress):
            action_id, value = INTERRUPT_ACTION, press.turn_id
        else:
            action_id, value = position_action(press.position), press.token

        notices: list[str] = []
        held = _PRESS_NOTICE.set(notices)
        try:
            await self._on_interaction(
                InboundInteraction(
                    channel_id=press.channel_id,
                    sender_id=press.user_id,
                    sender_name=name,
                    action_id=action_id,
                    value=value,
                    message_ref=press.post_id,
                )
            )
        finally:
            _PRESS_NOTICE.reset(held)

        if notices:
            return _ephemeral(notices[0])
        return {}

    async def _show_activity(self, press: ActivityPress) -> dict[str, Any]:
        """Put a turn's tool calls in front of the one person who asked.

        The reply is the whole of the answer. Mattermost shows `ephemeral_text`
        to the presser and nobody else, the channel's history gains nothing,
        and a second reader pressing the same button gets a read of their own.
        It is also why there is no Refresh here: the log is drawn when the
        press arrives, so pressing again is the refresh, and nothing on the
        screen can be older than the press that put it there.

        Two separate questions, both asked. Whether this bridge published that
        turn into that channel is `_resolve_activity`'s, answered against the
        record. Whether this reader may see the channel is Mattermost's, asked
        on every press — a press establishes that the server accepted it, which
        is not a statement about what the presser may read now.

        Every way it can fail says something, and says which thing. A button
        that answers with nothing reads as the press having been dropped, and
        the reader would go on pressing it; a button that answers "gone" when
        this end simply cannot reach the log retires a turn that is still
        running, which the reader cannot come back from.
        """
        resolve = self._resolve_activity
        if resolve is None:
            logger.warning(
                "A Mattermost activity view was pressed on post %s, but this "
                "bridge has nothing to read the log with, so it is refused.",
                press.post_id,
            )
            return _ephemeral(ACTIVITY_FAILED)
        refusal = await self._reads_channel(press.channel_id, press.user_id)
        if refusal is not None:
            return _ephemeral(refusal)
        try:
            snapshot = await resolve(press.channel_id, press.post_id)
        except Exception:
            logger.exception(
                "Reading the activity behind post %s in Mattermost channel %s "
                "failed, so the reader is told rather than left waiting.",
                press.post_id,
                press.channel_id,
            )
            return _ephemeral(ACTIVITY_FAILED)
        if snapshot is None:
            return _ephemeral(ACTIVITY_GONE)
        return _ephemeral(self._activity_text(snapshot))

    async def _reads_channel(self, channel_id: str, user_id: str) -> str | None:
        """Why this person may not see the channel's activity, or None if they may.

        Membership, because that is the audience Mattermost actually holds, and
        it holds it the same way for an open channel, a private one and a
        direct message. It is narrower than readability on an open channel,
        where any member of the team may read without having joined; a reader
        in that position is refused and told so, which is the side to be wrong
        on for a disclosure this message does not already make. That is also
        why the refusal says they are not in the channel rather than that they
        cannot read it — membership is the fact this establishes, and
        readability is not.

        A lookup that cannot answer refuses too. "Mattermost did not say" is
        not "yes", and an audience that cannot be established is one nothing
        should be disclosed to. It is a different sentence, though: a reader
        told they cannot read something goes and asks to be let in, and this
        one has nothing to ask for.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.warning(
                "Cannot establish who is in Mattermost channel %s: the bridge "
                "is not connected, so no activity is shown.",
                channel_id,
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        try:
            member = await loop.run_in_executor(
                None, driver.channels.get_channel_member, channel_id, user_id
            )
        except ResourceNotFound:
            # An answer rather than a failure: Mattermost says "not a member"
            # with a 404.
            return ACTIVITY_NOT_A_MEMBER
        except NotEnoughPermissions as error:
            # A channel this bridge may not inspect is one whose audience it
            # cannot vouch for — which says nothing about the reader.
            logger.warning(
                "Mattermost will not let this bridge see who is in channel %s "
                "(%s), so no activity is shown.",
                channel_id,
                error,
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        except Exception as error:
            logger.warning(
                "Mattermost would not say whether user %s is in channel %s "
                "(%s), so no activity is shown.",
                user_id,
                channel_id,
                error,
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        if bool(member) and member.get("user_id") == user_id:
            return None
        return ACTIVITY_NOT_A_MEMBER

    def _activity_text(self, snapshot: ActivitySnapshot) -> str:
        """The tool calls, and the time the read behind them was taken.

        Stamped because an ephemeral reply stays on the screen until the reader
        dismisses it or reloads, and one left open for twenty minutes is not
        wrong but is not current either. An absolute time rather than a
        relative one: Mattermost renders no clock of its own in a message, so a
        "moments ago" written here would still say that an hour later.
        """
        stamp = f"_Read at {snapshot.read_at.astimezone(UTC):%H:%M:%S} UTC_"
        body = activity_log(
            snapshot.items,
            snapshot.turn,
            escape=self._rich_escape,
            limit=max(1, self.rich_fallback_limit() - len(stamp) - 1),
            markup=self.rich_markup(),
            elapsed_seconds=snapshot.elapsed_seconds,
            session_url=snapshot.session_url,
            heading=True,
        )
        return f"{body}\n{stamp}"

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        """Tell one person their answer did not land, where they can see it.

        A press is answered in the reply to the press itself, which Mattermost
        shows to that person alone: the channel is told nothing, and it reaches
        them without the bot needing to be able to open a DM.

        A typed answer has no press to reply to, so it falls back to the base:
        said in the card's own thread, where everyone reading it sees a notice
        addressed to someone else. That is the platform's limit rather than a
        choice — nothing but a callback gives a bot a private reply here.
        """
        notices = _PRESS_NOTICE.get()
        if notices is not None:
            notices.append(text)
            return
        await super().tell_actor(channel_id, actor_ref, actor_name, thread_ref, text)

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        bot_driver = self._bot_drivers.get(sender_name)
        if not bot_driver:
            logger.error("No Mattermost driver found for sender '%s'", sender_name)
            if not self._admin_driver:
                return None
            bot_driver = self._admin_driver
        return await self._create_post(bot_driver, channel_id, content, thread_root_id)

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        """Post an admin/system message natively on Mattermost.

        In a normal channel it goes out as the dedicated Switch Admin bot. A
        1:1 DM channel cannot admit a third bot, so there it falls back to the
        agent bot that owns the DM, lightly marked so it reads as a system
        notice rather than the agent's own voice.

        Renders its own body: every caller passes Switch Markdown, so the
        conversion belongs here rather than at each of them — one of them
        forgetting is how a notice reached a channel with its markup showing.
        """
        content = self._admin_body(self.translate_outbound(content), drawn)
        loop = self._main_loop
        if loop is None:
            logger.error("Cannot post admin message: event loop not initialized")
            return None

        channel_type = await self.get_channel_type(channel_id)
        if channel_type == "direct":
            agent_names = await self.get_channel_agent_names(channel_id)
            driver = self._bot_drivers.get(agent_names[0]) if agent_names else None
            if driver is None:
                driver = self._admin_driver
            if driver is None:
                logger.error("No driver to post admin message in DM %s", channel_id)
                return None
            return await self._create_post(
                driver, channel_id, f"_Switch:_ {content}", thread_root_id
            )

        driver = self._admin_bot_driver
        if driver is None:
            logger.warning(
                "Switch Admin bot not provisioned; posting admin message as "
                "admin user in %s",
                channel_id,
            )
            driver = self._admin_driver
        else:
            await self._ensure_admin_bot_in_channel(channel_id)
        if driver is None:
            return None
        return await self._create_post(driver, channel_id, content, thread_root_id)

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
        """Upload the file with the agent's own bot and attach it to a post —
        full identity and threading parity with text messages."""
        loop = self._main_loop
        if loop is None:
            logger.error("Cannot send attachment: event loop not initialized")
            return None
        driver = self._bot_drivers.get(sender_name)
        if not driver:
            logger.error("No Mattermost driver found for sender '%s'", sender_name)
            if not self._admin_driver:
                return None
            driver = self._admin_driver

        def _upload() -> list[str]:
            result = driver.files.upload_file(
                channel_id,
                files={"files": (filename, io.BytesIO(data), mimetype)},
            )
            return [info["id"] for info in result.get("file_infos", [])]

        try:
            file_ids = await loop.run_in_executor(None, _upload)
        except Exception as e:
            logger.error(
                "Failed to upload attachment '%s' to Mattermost channel %s: %s",
                filename,
                channel_id,
                e,
            )
            file_ids = []
        if not file_ids:
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )

        post: dict[str, object] = {
            "channel_id": channel_id,
            "message": self.translate_outbound(caption) if caption else "",
            "file_ids": file_ids,
        }
        if thread_root_id is not None:
            post["root_id"] = thread_root_id
        try:
            result = await loop.run_in_executor(None, driver.posts.create_post, post)
            post_id: str = result.get("id", "")
            return post_id or None
        except Exception as e:
            logger.error(
                "Failed to post attachment '%s' to Mattermost channel %s: %s",
                filename,
                channel_id,
                e,
            )
            return None

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Upload several files and attach them all to ONE post — Mattermost
        posts natively carry a list of file ids."""
        if not files:
            return None
        if len(files) == 1:
            file = files[0]
            return await self.send_attachment(
                channel_id,
                sender_name,
                file.filename,
                file.mimetype,
                file.data,
                caption,
                thread_root_id,
            )
        loop = self._main_loop
        if loop is None:
            logger.error("Cannot send attachments: event loop not initialized")
            return None
        driver = self._bot_drivers.get(sender_name)
        if not driver:
            logger.error("No Mattermost driver found for sender '%s'", sender_name)
            if not self._admin_driver:
                return None
            driver = self._admin_driver

        def _upload_all() -> list[str]:
            ids: list[str] = []
            for file in files:
                result = driver.files.upload_file(
                    channel_id,
                    files={
                        "files": (file.filename, io.BytesIO(file.data), file.mimetype)
                    },
                )
                ids.extend(info["id"] for info in result.get("file_infos", []))
            return ids

        try:
            file_ids = await loop.run_in_executor(None, _upload_all)
        except Exception as e:
            logger.error(
                "Failed to upload %d attachments to Mattermost channel %s: %s",
                len(files),
                channel_id,
                e,
            )
            file_ids = []
        if not file_ids:
            return await super().send_attachments(
                channel_id, sender_name, files, caption, thread_root_id
            )

        post: dict[str, object] = {
            "channel_id": channel_id,
            "message": self.translate_outbound(caption) if caption else "",
            "file_ids": file_ids,
        }
        if thread_root_id is not None:
            post["root_id"] = thread_root_id
        try:
            result = await loop.run_in_executor(None, driver.posts.create_post, post)
            post_id: str = result.get("id", "")
            return post_id or None
        except Exception as e:
            logger.error(
                "Failed to post %d attachments to Mattermost channel %s: %s",
                len(files),
                channel_id,
                e,
            )
            return None

    async def _create_post(
        self,
        driver: Driver,
        channel_id: str,
        content: str,
        thread_root_id: str | None,
        props: dict[str, Any] | None = None,
    ) -> str | None:
        try:
            return await self._post_or_raise(
                driver, channel_id, content, thread_root_id, props
            )
        except Exception as e:
            logger.error("Failed to send Mattermost message to %s: %s", channel_id, e)
            return None

    async def _post_or_raise(
        self,
        driver: Driver,
        channel_id: str,
        content: str,
        thread_root_id: str | None,
        props: dict[str, Any] | None,
    ) -> str:
        """Create a post and hand back its id, or raise saying why not.

        `_create_post` is the swallowing wrapper for callers whose failure is
        cosmetic. A publication's is not: the exception carries what Mattermost
        actually said, which is the difference between a caller that can retry
        sensibly and one that only knows it got `None`.
        """
        loop = self._main_loop
        if loop is None:
            raise RuntimeError("Mattermost is not connected.")
        post: dict[str, Any] = {"channel_id": channel_id, "message": content}
        if thread_root_id is not None:
            post["root_id"] = thread_root_id
        if props:
            post["props"] = props
        result = await loop.run_in_executor(None, driver.posts.create_post, post)
        post_id: str = result.get("id", "")
        if not post_id:
            raise RuntimeError("Mattermost accepted the post but returned no id.")
        return post_id

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        if not self._admin_driver or not self._main_loop:
            logger.error("Cannot update message: Mattermost client not connected")
            return

        try:
            await self._main_loop.run_in_executor(
                None,
                self._admin_driver.posts.patch_post,
                message_ref,
                {"message": new_content},
            )
        except Exception as e:
            logger.error("Failed to update Mattermost post %s: %s", message_ref, e)

    # ── SDK session publication ──────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        return _MAX_POST

    def rich_fallback_text(self, content: RichContent) -> str:
        """What a publication says, with nothing that needed looking up.

        The renderers are the same ones `post_rich` uses; what is missing is
        the mention and the responder's handle, both of which come from an id
        Switch holds and a call to Mattermost to turn it into a name. This is
        the string that goes in a `RichContentFailed`, where a failed lookup
        on top of a failed post would say nothing useful anyway.

        Drawn without controls because nothing carries them here. A card that
        dropped an option from its body on the promise of a button, and then
        went out as the text of a failure, would ask for a choice it had
        stopped printing.
        """
        return self._draw(content, mention=None, responder=None, controls=False).text

    def _draw(
        self,
        content: RichContent,
        *,
        mention: str | None,
        responder: str | None,
        controls: bool,
    ) -> Drawn:
        escape = self._rich_escape
        limit = self.rich_fallback_limit()
        markup = self.rich_markup()
        if isinstance(content, TurnActivity):
            # Charged to the same budget as the status it follows: a post that
            # just fits, plus a line saying it reached nobody, is a post
            # Mattermost refuses. The note under a queued turn's stop control
            # is charged the same way, and for the same reason.
            lines = []
            if self._offers_interrupt(content) and content.turn.status == "queued":
                lines.append(INTERRUPT_QUEUED_NOTE)
            if content.notify_unreachable:
                lines.append(self.unnotified_notice())
            tail = "".join(f"\n{line}" for line in lines)
            return Drawn(
                text=turn_status(
                    content.items,
                    content.turn,
                    escape=escape,
                    limit=max(1, limit - len(tail)),
                    markup=markup,
                    elapsed_seconds=content.elapsed_seconds,
                    session_url=content.session_url,
                    mention=mention,
                    error_summary=content.error_summary,
                    tool_detail=True,
                )
                + tail,
                answerable=False,
            )
        # The handle goes on its own line rather than in front of the heading:
        # a card is a block, and a handle wedged before "**Permission needed**"
        # reads as part of the heading. It is charged to the same budget, or a
        # form that just fits becomes a post Mattermost refuses. So is the
        # notice below it, which is the same admission the turn status makes:
        # a request nobody was named in is a request nobody was asked.
        lead = f"{mention}\n" if mention else ""
        tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
        drawn = render_request(
            content.request,
            content.reference,
            escape=escape,
            limit=max(1, limit - len(lead) - len(tail)),
            markup=markup,
            responder=responder,
            unavailable_reason=content.unavailable_reason,
            control_label_limit=MAX_BUTTON_LABEL if controls else None,
        )
        return replace(drawn, text=f"{lead}{drawn.text}{tail}")

    def _button_address(self) -> tuple[str, str] | None:
        """Where a press goes and what signs it, or None if this bridge takes none.

        All three have to hold and they are settled at different moments: an
        address the Mattermost server can reach, a place on the shared listener
        for a press to arrive at, and something to route it to once it has.

        A question about offering a button, and only that. Taking one off asks
        the post instead: a deployment that has withdrawn its callback address
        is exactly the one whose old buttons most need removing, and it is the
        one this answers None for.
        """
        url = self.callback_url
        endpoint = self._callback
        if url is None or endpoint is None or self._on_interaction is None:
            return None
        return url, endpoint.key

    def _offers_interrupt(self, content: RichContent) -> bool:
        """Whether this post gets a control that stops the agent's current work.

        Three things, each removing it on its own: something running to stop,
        named by the caller when the message was drawn; this message's own turn
        still unfinished, so that scrolling back to yesterday's turn does not
        offer a control over today's work; and somewhere for a press to go.

        Asked before the text is drawn as well as when the buttons are built,
        because a queued turn's control needs a line saying what it stops and
        that line is part of the post's body.
        """
        return (
            isinstance(content, TurnActivity)
            and content.interrupt_turn_id is not None
            and content.turn.status not in TURN_ENDED
            and self._button_address() is not None
        )

    def _controls(
        self, channel_id: str, content: RichContent, drawn: Drawn
    ) -> list[dict[str, Any]]:
        """A post's buttons: a card's options, or a turn's way into its log.

        Nothing at all is an ordinary answer: a settled card has no options
        left, a bridge with no callback address has nowhere for a press to go,
        and a card that cannot be answered where it is showing says so — a live
        control under that sentence invites the refusal the sentence just
        explained. Because every redraw builds this again, the buttons come off
        a card at the moment it stops being pressable, without anything having
        to remember that it once had them.

        A turn's status earns the button into its log whatever state it is in,
        the attention slot included. The log is read when the press arrives
        rather than drawn into the post, so a running turn's is as current as
        an ended turn's and neither goes stale on the channel — and a message
        saying somebody has to act is the one a reader most needs to be able
        to ask what happened from.

        The stop control beside it is the one button here that does go stale,
        because what it offers depends on there being work to stop. It comes
        and goes over a turn's life, which is why a redraw has to be able to
        rewrite a status post's buttons at all.

        Whether the drawing earned the option buttons comes from `drawn` rather
        than from reading the request a second time. A body cut short of the
        difference between two options is one a reader cannot decide from, and
        only the renderer that cut it knows that. A press would still resolve
        against the stored record and settle the request, so the whole of the
        protection is not offering the button.
        """
        address = self._button_address()
        if address is None:
            return []
        url, key = address
        if isinstance(content, TurnActivity):
            actions = []
            if self._resolve_activity is not None:
                actions.append(activity_action(key, url, channel_id))
            turn_id = content.interrupt_turn_id
            if turn_id is not None and self._offers_interrupt(content):
                actions.append(interrupt_action(key, url, channel_id, turn_id))
            return actions
        if not isinstance(content, RequestCard) or not drawn.answerable:
            return []
        controls = offered_controls(content.request)
        if not controls:
            return []
        return answer_actions(key, url, content.reference.token, controls)

    async def _render_rich(self, channel_id: str, content: RichContent) -> _Rendered:
        mention = await self._mention(content.notify_external_id)
        responder = (
            await self._mention(content.responder_external_id)
            if isinstance(content, RequestCard)
            else None
        )
        controls = (
            isinstance(content, RequestCard) and self._button_address() is not None
        )
        drawn = self._draw(
            content, mention=mention, responder=responder, controls=controls
        )
        actions = self._controls(channel_id, content, drawn)
        if not controls:
            return _Rendered(text=drawn.text, actions=actions, plain=drawn.text)
        # The body drops an option only where a button carries it, so wherever
        # buttons were possible the card is also drawn as if none were. That
        # second drawing is what a failure is reported with, and it is what
        # goes on the post itself when the card turned out to earn no controls
        # — which is not known until it has been drawn, because a form too big
        # to show faithfully is discovered by drawing it.
        plain = self._draw(
            content, mention=mention, responder=responder, controls=False
        ).text
        return _Rendered(
            text=drawn.text if actions else plain, actions=actions, plain=plain
        )

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a turn's status or a request's form as the agent's own bot.

        The recovery marker rides along in the post's props rather than in
        anything a reader sees, so a post whose response was lost can be found
        again by `find_request_card` instead of being sent twice.

        Raises on every failure, unlike `send_message`, which reports one by
        returning `None`: a publication that silently did not happen is a
        reservation that never gets retried and a turn the channel never sees.
        What it raises is the point — `RichContentFailed` is the caller's
        licence to discard the reservation, so it is reserved for a refusal
        Mattermost actually gave. A send whose outcome nobody knows raises the
        transport's own error and keeps the reservation.
        """
        rendered = await self._render_rich(channel_id, content)
        driver = self._bot_drivers.get(agent_name)
        if driver is None:
            raise RichContentFailed(
                f"No Mattermost bot for agent {agent_name!r}, so its activity "
                f"cannot be posted in channel {channel_id}.",
                text=rendered.plain,
            )
        token = (
            content.publication_token
            if isinstance(content, TurnActivity)
            else content.reference.token
        )
        props: dict[str, Any] = {}
        if token:
            props[_PUBLICATION_PROP] = token
        if rendered.actions:
            props[_ATTACHMENTS_PROP] = [{"actions": rendered.actions}]
        try:
            ref = await self._post_or_raise(
                driver, channel_id, rendered.text, thread_root_id, props or None
            )
        except Exception as error:
            failure = _as_rich_failure(
                error,
                description=f"Mattermost refused the post in channel {channel_id}",
                text=rendered.plain,
            )
            if failure is None:
                raise
            raise failure from error
        self._remember_actions(ref, rendered.actions)
        return ref

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a publication in place, and say so when it did not happen.

        Not `update_message`: that one logs and returns, which is right for the
        legacy status line nobody is waiting on and wrong here. A card that
        failed to redraw is still showing a settled request as open, and the
        caller has a reply to post about it — but only if it is told.

        Edited as the agent's own bot where there is one. Mattermost keeps the
        original author through a patch either way, so the fallback to the
        admin driver changes who a reader sees the post from not at all; what
        it changes is the permission the edit is made with, and an agent bot
        editing its own post is the narrower of the two.

        Says "did not happen" only where Mattermost refused the edit. An edit
        whose outcome is unknown may well have landed, and reporting it as a
        refusal buys a fallback reply about a card that is already correct.

        A post's buttons are carried in its props, so the props are part of the
        edit — which is what takes them off a card the moment it stops being
        answerable, and off a status post the moment its turn ends. Part of
        every card's edit, not just the edits of a bridge that could put a
        button on: a deployment that has since dropped its callback address can
        offer no new button and has old ones still inviting a press at a route
        that has gone.

        A status post's props are rewritten only when its buttons have actually
        changed, which over a turn is at most twice. Writing props means reading
        the post back first, and a status post is redrawn on every tool call —
        the round trip belongs on the edit that has something to say, not on the
        hundred that are redrawing the same two buttons under new text.
        """
        # A post notifies; an edit does not. Repeating the mention on every
        # redraw would be a handle in the channel that never resolves to
        # anything new for the person it names.
        rendered = await self._render_rich(
            channel_id, replace(content, notify_external_id=None)
        )
        driver = self._bot_drivers.get(agent_name) or self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            raise RichContentFailed(
                "Mattermost is not connected, so the post could not be updated.",
                text=rendered.plain,
            )
        try:
            patch: dict[str, Any] = {"message": rendered.text}
            if isinstance(content, RequestCard) or self._actions_changed(
                message_ref, rendered.actions
            ):
                patch["props"] = await self._props_with_actions(
                    driver, loop, message_ref, rendered.actions
                )
            await loop.run_in_executor(
                None, driver.posts.patch_post, message_ref, patch
            )
        except Exception as error:
            failure = _as_rich_failure(
                error,
                description=(
                    f"Mattermost refused the edit to post {message_ref} in "
                    f"channel {channel_id}"
                ),
                text=rendered.plain,
            )
            if failure is None:
                raise
            raise failure from error
        self._remember_actions(message_ref, rendered.actions)

    def _actions_changed(self, message_ref: str, actions: list[dict[str, Any]]) -> bool:
        """Whether this post's buttons need rewriting, or already say this.

        A post nothing is remembered about counts as changed. Its buttons are
        unknown rather than known to be right, and the two cases this arises in
        both want the write: a bridge that has restarted since the post was
        made, and one whose memory of it has aged out under a thousand newer
        posts. The cost is one read-back per post once, against leaving a
        control on screen that no longer matches the turn behind it.

        Compared by value, which works because a button is derived entirely
        from what it is for — the same turn in the same state signs to the same
        context every time, so equality here means the post already carries
        exactly these buttons.
        """
        return self._post_actions.get(message_ref) != actions

    def _remember_actions(
        self, message_ref: str, actions: list[dict[str, Any]]
    ) -> None:
        self._post_actions.pop(message_ref, None)
        self._post_actions[message_ref] = actions
        while len(self._post_actions) > self._post_actions_max:
            self._post_actions.popitem(last=False)

    async def _props_with_actions(
        self,
        driver: Driver,
        loop: asyncio.AbstractEventLoop,
        message_ref: str,
        actions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """The post's props as they should be, with its buttons set to `actions`.

        Read back first rather than written fresh. A patch replaces a post's
        props wholesale, and some of what is on them was put there by the
        Mattermost server when the post was made — the marker saying it came
        from a bot among them. Sending only the props Switch knows about would
        strip those off the card as a side effect of taking a button off it.

        No actions means the key goes, which is how a settled card loses its
        buttons: an empty list would leave an attachment on the post with
        nothing in it.
        """
        post = await loop.run_in_executor(None, driver.posts.get_post, message_ref)
        props = dict(post.get("props") or {})
        if actions:
            props[_ATTACHMENTS_PROP] = [{"actions": actions}]
        else:
            props.pop(_ATTACHMENTS_PROP, None)
        return props

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        """Look for a publication this bridge may already have posted.

        Asked when a post's outcome is unknown — the request timed out, or the
        process died between sending and recording the id. The answer decides
        between binding the reservation to what is there and posting a second
        copy of a card somebody is meant to answer exactly once, so a lookup
        that cannot be trusted must come back as "not found" rather than as a
        guess: `None` keeps the reservation and asks again.

        Matched on the props marker and on the post's author, because a token
        quoted back in somebody's message must not be mistaken for the post
        that carries it. `handle` is unused for the same reason it is on
        Slack: the props marker is exact, and invisible to a reader.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.warning(
                "Cannot look for the publication marked %s in channel %s: "
                "Mattermost is not connected.",
                token,
                channel_id,
            )
            return None
        since = max(0, int(created_at.timestamp() * 1000) - _RECOVERY_SKEW_MS)

        def _read() -> dict[str, Any]:
            if thread_root_id:
                return dict(driver.posts.get_thread(thread_root_id))
            return dict(
                driver.posts.get_posts_for_channel(channel_id, params={"since": since})
            )

        try:
            page = await loop.run_in_executor(None, _read)
        except Exception as e:
            logger.warning(
                "Could not read %s looking for the publication marked %s: %s.",
                f"thread {thread_root_id}"
                if thread_root_id
                else f"channel {channel_id}",
                token,
                e,
            )
            return None
        for post in (page.get("posts") or {}).values():
            if post.get("user_id") not in self._bridge_bot_ids:
                continue
            if (post.get("props") or {}).get(_PUBLICATION_PROP) != token:
                continue
            found = str(post.get("id") or "")
            if found:
                return found
        return None

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        """Whether this message is the first thing said under a thread root.

        Mattermost's websocket event names the root but not the position in the
        thread, so the thread itself is the only place the answer is. Ordered
        here on `create_at` rather than trusted from the API's own `order`: a
        bare "yes" deciding a permission is not worth resting on a field whose
        direction is not part of the contract.

        Never raises. This is on the inbound path of every message, ahead of
        the relay, so an exception out of it is not a refused answer but a
        message the room never sees.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.warning(
                "Cannot read the thread under %s in %s: Mattermost is not "
                "connected. Treating %s as not the first reply.",
                root_ref,
                channel_id,
                message_ref,
            )
            return False
        try:
            thread = await loop.run_in_executor(None, driver.posts.get_thread, root_ref)
        except Exception as e:
            logger.warning(
                "Could not read the thread under %s in %s: %s. Treating %s as "
                "not the first reply.",
                root_ref,
                channel_id,
                e,
                message_ref,
            )
            return False
        replies = sorted(
            (
                post
                for post in (thread.get("posts") or {}).values()
                if post.get("id") != root_ref and not post.get("delete_at")
            ),
            key=lambda post: (post.get("create_at") or 0, str(post.get("id") or "")),
        )
        return bool(replies) and replies[0].get("id") == message_ref

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
        """Put this agent's mark on the message, or take it off.

        Per agent, because the reaction belongs to the bot that added it:
        two agents on one message are two marks, and one finishing leaves the
        other's alone. `force` is the durable publisher reconciling after a
        restart, when this process's record of what is already there is empty
        and wrong rather than empty and right.

        Raises when the mark did not happen, including when there is no bot to
        make it with. The publisher retries on that and records completion
        only once the channel actually shows what it says it shows.
        """
        await self._react_or_raise(
            agent_name, message_ref, mark=mark, on=on, force=force
        )

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """The one-shot typing nudge, at the place the agent was asked.

        What the legacy runtime path sent as a turn opened, kept for the SDK
        one: Mattermost expires it after a few seconds, so it costs the channel
        nothing and it is the only signal that arrives before the first post.
        """
        await self._post_typing(channel_id, agent_name, thread_root_id)

    async def _mention(self, external_user_id: str | None) -> str | None:
        """`@handle` for a Mattermost user id, or None if it cannot be resolved.

        None rather than the raw id: an id printed where a handle belongs
        notifies nobody and reads as noise, and the message it decorates is
        worth sending without it.
        """
        if not external_user_id:
            return None
        username = await self._username_for(external_user_id)
        return f"@{username}" if username else None

    async def _username_for(self, external_user_id: str) -> str | None:
        """The handle behind a Mattermost user id, or None if it cannot be read.

        Cached because a handle is stable for the life of an account, so a hit
        saves a round trip on every redraw carrying a mention and on every
        press.
        """
        username = self._usernames.get(external_user_id)
        if username is not None:
            return username
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            return None
        try:
            user = await loop.run_in_executor(
                None, driver.users.get_user, external_user_id
            )
        except Exception as e:
            logger.warning(
                "Could not resolve Mattermost user %s to a handle: %s",
                external_user_id,
                e,
            )
            return None
        username = str(user.get("username") or "")
        if not username:
            return None
        self._usernames[external_user_id] = username
        while len(self._usernames) > self._usernames_max:
            self._usernames.popitem(last=False)
        return username

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        if not self._admin_driver or not self._main_loop:
            logger.error("Cannot delete message: Mattermost client not connected")
            return

        try:
            await self._main_loop.run_in_executor(
                None, self._admin_driver.posts.delete_post, message_ref
            )
        except Exception as e:
            logger.error("Failed to delete Mattermost post %s: %s", message_ref, e)

    async def remove_publication(self, channel_id: str, message_ref: str) -> None:
        """Take an answered card out of the channel, or say why it is still there.

        Deleted as the admin, which is the account that may delete a post it
        did not write — the card was posted by the agent's bot, and nothing in
        the reference says which agent that was. `update_rich` can prefer the
        narrower bot because it is handed the agent's name; this is not.

        Told the post does not exist, this returns: the id came from Mattermost
        when it accepted the card, so nothing remains at it, which is what the
        caller asked for.

        Not `delete_message`, which logs and returns either way. A caller
        writing down that a card is gone must not be told success where none
        was established.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            raise RemovalFailed("Mattermost is not connected.")
        if not message_ref.strip():
            # A blank id is a DELETE against the collection rather than a post.
            raise RemovalFailed("No Mattermost post id to delete.")

        try:
            await loop.run_in_executor(None, driver.posts.delete_post, message_ref)
        except ResourceNotFound as error:
            # Worth a line because the innocent reading — a deletion whose
            # acknowledgement we lost, or one done by hand — is not the only one.
            logger.warning(
                "Mattermost card %s was already gone when it was taken back: %s",
                message_ref,
                error,
            )
        except Exception as error:
            raise self._removal_failure(error, message_ref, channel_id) from error

    @staticmethod
    def _removal_failure(
        error: Exception, message_ref: str, channel_id: str
    ) -> Exception:
        """What a failed deletion should be reported as.

        Only a wait survives as itself. Everything else — a refusal, a server
        error, a request that never came back — becomes `RemovalFailed`,
        because the caller does the same thing with all three: keep the settled
        card, record nothing, and ask again later. The uncertainty an uncertain
        *send* has to preserve does not arise here, since asking again about a
        deletion that did land is answered with "not found".
        """
        retry_after = _throttle_delay(error)
        if retry_after is not None:
            return RichContentThrottled(retry_after=retry_after, text="")
        return RemovalFailed(
            f"Mattermost would not delete post {message_ref} in channel "
            f"{channel_id}: {error}"
        )

    # ── Typing ───────────────────────────────────────────────────────────────

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        logger.debug("Mattermost set typing: %s", is_typing)
        if not is_typing:
            return
        await self._post_typing(channel_id, sender_name, None)

    async def _post_typing(
        self, channel_id: str, sender_name: str, thread_root_id: str | None
    ) -> None:
        """Tell Mattermost the agent's bot is typing, in a thread when given one.

        Mattermost expires the indicator on its own after a few seconds, so
        this is a one-shot nudge rather than something to switch off. Without
        `parent_id` it only ever shows at the channel root, which is the wrong
        place when the agent is answering inside a thread.
        """
        bot_info = self._agent_bots.get(sender_name)
        if not bot_info:
            logger.warning("No bot info found for sender name %s", sender_name)
            return

        bot_driver = self._bot_drivers.get(sender_name)
        loop = self._main_loop
        if not bot_driver or not loop:
            logger.warning("No bot driver found for sender name %s", sender_name)
            return

        body: dict[str, str] = {"channel_id": channel_id}
        if thread_root_id is not None:
            body["parent_id"] = thread_root_id

        try:
            await loop.run_in_executor(
                None,
                bot_driver.client.make_request,
                "post",
                f"/users/{bot_info['user_id']}/typing",
                body,
            )
        except Exception as e:
            logger.debug("Failed to send MM typing for %s: %s", sender_name, e)

    # ── The eyes on the message being worked on ──────────────────────────────

    async def _react_or_raise(
        self,
        agent_name: str,
        post_id: str,
        *,
        mark: ActivityMark,
        on: bool,
        force: bool,
    ) -> None:
        """Put 👀 on the post an agent is working on, and take it off after.

        Added by the agent's own bot rather than the bridge account, so the
        reaction says *which* agent picked the message up and two agents on one
        message read as two. This is the progress signal that always works:
        unlike the status post it needs no thread, and unlike the typing
        indicator it does not expire.

        `self._marked` is this process's memory of what it has already done,
        and a restart empties it while the reactions stay in the channel.
        `force` is for the caller that knows better from the journal: skipping
        the call because the set is empty would strand a 👀 on a turn that
        ended while the bridge was down. It is remembered per reaction: a
        queued prompt that starts running loses the hourglass and keeps the
        eyes, so one cannot answer for the other.

        A failure leaves that memory alone, so the next attempt is a real
        attempt rather than one the record talks out of trying. Removing a
        reaction Mattermost says is not there is the exception: the channel is
        already in the state being asked for, and there is nothing to retry.
        """
        key = (agent_name, post_id, mark)
        if not force and on == (key in self._marked):
            return

        bot_info = self._agent_bots.get(agent_name)
        driver = self._bot_drivers.get(agent_name)
        loop = self._main_loop
        if not bot_info or driver is None or loop is None:
            raise RuntimeError(f"no connected bot for {agent_name!r}")
        user_id = bot_info["user_id"]

        if on:
            await loop.run_in_executor(
                None,
                driver.reactions.create_reaction,
                {
                    "user_id": user_id,
                    "post_id": post_id,
                    "emoji_name": _REACTION[mark],
                },
            )
            self._marked.add(key)
            return
        try:
            await loop.run_in_executor(
                None,
                driver.reactions.delete_reaction,
                user_id,
                post_id,
                _REACTION[mark],
            )
        except ResourceNotFound:
            pass
        self._marked.discard(key)

    # ── Channel creation ──────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Cannot create channel: Mattermost client not connected")

        loop = self._main_loop

        if channel_type in ("group", "direct"):
            raise ValueError(
                f"Cannot create {channel_type} channels — they are initiated from the messaging platform"
            )

        mm_type = "P" if channel_type == "channel_private" else "O"
        channel_name = re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")[:64]
        channel_id: str | None = None

        try:
            channel = await loop.run_in_executor(
                None,
                self._admin_driver.channels.create_channel,
                {
                    "team_id": self._team_id,
                    "name": channel_name,
                    "display_name": name,
                    "type": mm_type,
                    "purpose": topic,
                },
            )
            channel_id = channel["id"]
        except Exception as e:
            logger.debug(
                "Channel name '%s' taken, retrying with suffix: %s", channel_name, e
            )

        if channel_id is None:
            unique_name = f"{channel_name[:55]}-{uuid.uuid4().hex[:8]}"
            channel = await loop.run_in_executor(
                None,
                self._admin_driver.channels.create_channel,
                {
                    "team_id": self._team_id,
                    "name": unique_name,
                    "display_name": name,
                    "type": mm_type,
                    "purpose": topic,
                },
            )
            channel_id = channel["id"]

        await self._add_default_member(channel_id)
        return channel_id

    async def _add_default_member(self, channel_id: str) -> None:
        """Add the deployment's human account to a channel we just created.

        Public channels would let them join by navigating, but private ones
        would not — and a room created by an agent names no users, so nothing
        else would ever add them. Best-effort and loudly logged: the channel and
        room already exist by this point, so failing here should not undo them,
        but it does mean a human cannot see the room.
        """
        member = self._config.default_member
        if not member:
            return
        try:
            await self.add_users_to_channel(channel_id, [member], [])
        except Exception:
            logger.exception(
                "Failed to add default member '%s' to Mattermost channel %s — "
                "the room exists but no human is in its channel",
                member,
                channel_id,
            )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Mattermost client not connected")
        channel = await self._main_loop.run_in_executor(
            None, self._admin_driver.channels.get_channel, channel_id
        )
        return self._to_channel_type(channel.get("type", ""))

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        """`mattermost://<host>/<team>/channels/<name>` — opens the channel in
        the Mattermost desktop app. Mattermost channel URLs key off the channel
        *name* (slug), not its id, so resolve the name (cached) from the id."""
        if not external_channel_id or not self._admin_driver or not self._main_loop:
            return None
        name = self._channel_name_cache.get(external_channel_id)
        if name is None:
            try:
                channel = await self._main_loop.run_in_executor(
                    None, self._admin_driver.channels.get_channel, external_channel_id
                )
            except Exception:
                logger.warning(
                    "Failed to resolve Mattermost channel name for %s",
                    external_channel_id,
                )
                return None
            name = str(channel.get("name", ""))
            if not name:
                return None
            self._channel_name_cache[external_channel_id] = name
        # Prefer the public URL so the link resolves in the user's client; the
        # internal `url` may be a private/tailnet address they can't reach.
        base_url = self._config.public_url or self._config.url
        host = re.sub(r"^https?://", "", base_url).rstrip("/")
        return f"mattermost://{host}/{self._config.team_name}/channels/{name}"

    async def home_deeplink(self) -> str | None:
        """`mattermost://<host>/<team>` — the team's home in the desktop app.

        Uses `public_url` when set, for the same reason `channel_deeplink`
        does: `url` may be an address only Switch can reach. For the bundled
        deployment neither is reachable from a user's machine (`url` is the
        in-compose `http://mattermost:8065` and `public_url` is unset), so a
        client that knows where it published Mattermost should prefer its own
        origin over this."""
        base_url = self._config.public_url or self._config.url
        if not base_url or not self._config.team_name:
            return None
        host = re.sub(r"^https?://", "", base_url).rstrip("/")
        return f"mattermost://{host}/{self._config.team_name}"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError(
                "Cannot add agents to channel: Mattermost client not connected"
            )

        logger.debug("Inviting agents %s to channel %s", agent_names, channel_id)
        loop = self._main_loop
        for agent_name in agent_names:
            bot_info = self._agent_bots.get(agent_name)
            if not bot_info:
                logger.warning(
                    "No Mattermost bot for agent '%s', cannot add to channel",
                    agent_name,
                )
                continue
            try:
                await loop.run_in_executor(
                    None,
                    self._admin_driver.channels.add_user,
                    channel_id,
                    {"user_id": bot_info["user_id"]},
                )
            except Exception as e:
                logger.warning(
                    "Failed to add agent '%s' to channel %s: %s",
                    agent_name,
                    channel_id,
                    e,
                )

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError(
                "Cannot add users to channel: Mattermost client not connected"
            )

        loop = self._main_loop
        failed: list[str] = []
        # Mattermost resolves people by username and ignores the ids, and one
        # internal caller (the default-member add) has only a name to give — so
        # walk the names and reach for a paired id only if one was supplied.
        for index, username in enumerate(user_names):
            external_id = (
                user_external_ids[index] if index < len(user_external_ids) else username
            )
            try:
                user = await loop.run_in_executor(
                    None, self._admin_driver.users.get_user_by_username, username
                )
                await loop.run_in_executor(
                    None,
                    self._admin_driver.channels.add_user,
                    channel_id,
                    {"user_id": user["id"]},
                )
            except Exception:
                logger.exception(
                    "Failed to add user '%s' to Mattermost channel %s",
                    username,
                    channel_id,
                )
                failed.append(external_id)
        return failed

    async def get_external_user_id(self, username: str) -> str | None:
        """Resolve a platform username to its current user id, or None if the
        user does not exist. Used by the homeserver cutover to rebind a puppet's
        ``external_user_id`` when Mattermost has been rebuilt and ids changed."""
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Mattermost client not connected")
        try:
            user = await self._main_loop.run_in_executor(
                None, self._admin_driver.users.get_user_by_username, username
            )
            return str(user["id"])
        except Exception:
            return None

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError(
                f"Cannot create agent identity '{agent_name}': adapter not started"
            )
        if agent_name in self._agent_bots:
            return

        loop = self._main_loop

        # The username is the routing handle — the mention, the member-list key
        # and the key this adapter adopts a bot back by — so it stays the
        # identifier. Only the bot's own display name carries the label.
        label = (await self.agent_rendering(agent_name)).field_label
        if label != agent_name:
            self._warn_once_if_display_names_are_hidden()

        existing = await self._find_existing_bot(agent_name)
        if existing:
            bot_id: str = str(existing["user_id"])
            if existing.get("display_name") != label:
                try:
                    self._mm_api("put", f"/bots/{bot_id}", {"display_name": label})
                except Exception as e:
                    logger.exception(
                        "Failed to update the display name of Mattermost bot %s: %s",
                        agent_name,
                        e,
                    )
        else:
            try:
                bot = self._mm_api(
                    "post",
                    "/bots",
                    {
                        "username": agent_name,
                        "display_name": label,
                        "description": f"Switch agent: {agent_description}",
                    },
                )
                bot_id = str(bot["user_id"])
            except Exception as e:
                logger.exception(
                    "Failed to create Mattermost bot %s: %s", agent_name, e
                )
                return

        try:
            token_resp = self._mm_api(
                "post",
                f"/users/{bot_id}/tokens",
                {"description": f"Switch bridge token for {agent_name}"},
            )
            token: str = str(token_resp["token"])
        except Exception as e:
            logger.exception("Failed to create token for bot %s: %s", agent_name, e)
            return

        self._agent_bots[agent_name] = {
            "bot_id": bot_id,
            "user_id": bot_id,
            "token": token,
            "username": agent_name,
        }
        self._bridge_bot_ids.add(bot_id)
        self._bot_id_to_username[bot_id] = agent_name

        await self._set_bot_icon(bot_id, agent_name)

        bot_driver = self._create_driver(token=token)
        await loop.run_in_executor(None, bot_driver.login)
        self._bot_drivers[agent_name] = bot_driver

        try:
            await loop.run_in_executor(
                None,
                self._admin_driver.teams.add_user_to_team,
                self._team_id,
                {"team_id": self._team_id, "user_id": bot_id},
            )
        except Exception:
            pass

        def _run_ws(driver: Driver = bot_driver, name: str = agent_name) -> None:
            async def _handler(event_data: str) -> None:
                await self._ws_handler(event_data, name)

            time.sleep(1)
            backoff = 2
            while True:
                try:
                    ws_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(ws_loop)
                    ws_loop.run_until_complete(driver.init_websocket(_handler))
                except Exception as e:
                    logger.debug(
                        "WebSocket for %s disconnected: %s, retrying in %ds",
                        name,
                        e,
                        backoff,
                    )
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 30)
                else:
                    backoff = 2

        ws_thread = threading.Thread(
            target=_run_ws, daemon=True, name=f"mm-ws-{agent_name}"
        )
        ws_thread.start()

        await self._bridge_channels_already_joined(agent_name, bot_id)

        logger.info("Created Mattermost bot identity: %s", agent_name)

    async def _bridge_channels_already_joined(
        self, agent_name: str, bot_id: str
    ) -> None:
        """Bridge the channels this bot is a member of but was never seen joining.

        A bot cannot witness its own joins: its websocket opens only after it has
        been added to the team, by which point Mattermost has already put it in
        the team's default channels. Those joins are therefore noticed only if
        some *other* agent's socket happens to be listening, which means the
        first agent on an instance bridges nothing at all and a later one drags
        the backlog in with it. Ask Mattermost outright instead of waiting to
        overhear it.

        Also runs for every known agent on startup, so a channel joined while the
        bridge was down is picked up rather than waiting for the next message in
        it.
        """
        loop = self._main_loop
        if self._on_agent_joined is None or self._admin_driver is None or loop is None:
            return
        try:
            channels = await loop.run_in_executor(
                None,
                self._admin_driver.channels.get_channels_for_user,
                bot_id,
                self._team_id,
            )
        except Exception:
            logger.exception(
                "Could not list Mattermost channels for agent %s", agent_name
            )
            return

        for channel in channels or []:
            channel_id = str(channel.get("id", ""))
            mm_type = str(channel.get("type", ""))
            if not channel_id or mm_type not in _JOINABLE_MM_CHANNEL_TYPES:
                continue
            try:
                await self._on_agent_joined(
                    InboundAgentJoin(
                        channel_id=channel_id,
                        channel_type=self._to_channel_type(mm_type),
                        agent_name=agent_name,
                        channel_name=str(channel.get("display_name", "")) or None,
                    )
                )
            except Exception:
                # One channel that cannot be bridged is not a reason to abandon
                # the rest, nor to fail the agent's registration.
                logger.exception(
                    "Could not bridge Mattermost channel %s for agent %s",
                    channel_id,
                    agent_name,
                )

    async def _ensure_admin_bot(self) -> None:
        """Provision the dedicated Switch Admin bot used to post admin/system
        messages in regular channels. Idempotent — reuses an existing bot."""
        loop = self._main_loop
        if loop is None or self._admin_driver is None:
            return
        username = "switch-admin"
        existing = await self._find_existing_bot(username)
        if existing:
            bot_id = str(existing["user_id"])
        else:
            try:
                bot = self._mm_api(
                    "post",
                    "/bots",
                    {
                        "username": username,
                        "display_name": "Switch",
                        "description": "Switch system / admin notices",
                    },
                )
                bot_id = str(bot["user_id"])
            except Exception:
                logger.exception("Failed to create Switch Admin bot")
                return
        try:
            token_resp = self._mm_api(
                "post",
                f"/users/{bot_id}/tokens",
                {"description": "Switch admin bot token"},
            )
            token = str(token_resp["token"])
        except Exception:
            logger.exception("Failed to create token for Switch Admin bot")
            return

        self._admin_bot_id = bot_id
        self._bridge_bot_ids.add(bot_id)

        driver = self._create_driver(token=token)
        await loop.run_in_executor(None, driver.login)
        self._admin_bot_driver = driver

        try:
            await loop.run_in_executor(
                None,
                self._admin_driver.teams.add_user_to_team,
                self._team_id,
                {"team_id": self._team_id, "user_id": bot_id},
            )
        except Exception:
            pass

        logger.info("Created Switch Admin bot identity")

    async def _ensure_admin_bot_in_channel(self, channel_id: str) -> None:
        """Add the Switch Admin bot to a channel so it can post there. A bot
        must be a member to post; this is idempotent (a re-add is a no-op)."""
        if (
            self._admin_bot_id is None
            or self._admin_driver is None
            or self._main_loop is None
        ):
            return
        try:
            await self._main_loop.run_in_executor(
                None,
                self._admin_driver.channels.add_user,
                channel_id,
                {"user_id": self._admin_bot_id},
            )
        except Exception:
            # Already a member, or a transient error — the post attempt that
            # follows will surface a real failure.
            pass

    async def remove_agent_identity(self, agent_name: str) -> None:
        self._agent_bots.pop(agent_name, None)
        self._bot_drivers.pop(agent_name, None)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Cannot resolve channel agents: adapter not started")

        members = await self._main_loop.run_in_executor(
            None, self._admin_driver.channels.get_channel_members, channel_id
        )
        agent_names = []
        for member in members:
            member_id = member.get("user_id", "")
            bot_name = self._bot_id_to_username.get(member_id)
            if bot_name:
                agent_names.append(bot_name)
        return agent_names

    def _read_name_display_setting(self) -> str | None:
        """`TeamSettings.TeammateNameDisplay`, read at most once per run.

        None when the read could not answer — the server config is readable
        only by a system admin, and an agent's bot is worth having either
        way, so the caller reports the blind spot instead of failing on it."""
        if self._name_display_read:
            return self._name_display_setting
        self._name_display_read = True
        try:
            config = self._mm_api("get", "/config")
            setting = (config.get("TeamSettings") or {}).get("TeammateNameDisplay")
        except Exception as e:
            logger.warning(
                "Could not read the Mattermost server config (%s), so whether "
                "agent display names are rendered on this server is unknown",
                e,
            )
            return None
        if not isinstance(setting, str):
            logger.warning(
                "The Mattermost server config carries no "
                "TeamSettings.TeammateNameDisplay, so whether agent display "
                "names are rendered on this server is unknown"
            )
            return None
        self._name_display_setting = setting
        return setting

    def _warn_once_if_display_names_are_hidden(self) -> None:
        """Say so when this server will store an agent's display name and show
        nobody. Mattermost renders a bot under its username unless the server
        is told otherwise, so a display name Switch sets can be invisible with
        nothing about the write itself failing."""
        if self._name_display_warned:
            return
        setting = self._read_name_display_setting()
        if setting is None or setting in _NAME_DISPLAY_SHOWS_LABEL:
            return
        self._name_display_warned = True
        logger.warning(
            "Mattermost TeamSettings.TeammateNameDisplay is '%s', so agent "
            "display names will not appear in the post header on this server — "
            "set it to 'full_name' or 'nickname_full_name' to render them",
            setting,
        )

    # ── Bot icons ────────────────────────────────────────────────────────────

    def default_agent_icon(self, agent_name: str) -> str:
        # Mattermost uploads the image itself rather than passing a link on, so
        # the response has to be a PNG it can accept.
        return default_icon_url(agent_name, image_format="png")

    async def _set_bot_icon(self, bot_id: str, agent_name: str) -> None:
        if not self._admin_driver or not self._main_loop:
            logger.error("[BOT-ICON] skipping %s: no driver or loop", agent_name)
            return
        driver = self._admin_driver
        try:
            url = await self.agent_icon_url(agent_name)
            logger.debug("[BOT-ICON] fetching avatar for %s", agent_name)
            # This is the one place Switch dereferences an agent's icon URL
            # rather than handing it to a platform, so the fetch is bounded:
            # redirects off (a permitted host could otherwise bounce us to an
            # internal one, which validation at write time cannot foresee) and
            # a size ceiling so a hostile response cannot be read unbounded.
            async with httpx.AsyncClient(follow_redirects=False) as client:
                resp = await client.get(url, timeout=10.0)
                resp.raise_for_status()
                image_bytes = resp.content
            if len(image_bytes) > _MAX_BOT_ICON_BYTES:
                logger.error(
                    "[BOT-ICON] icon for %s is %d bytes, over the %d limit — "
                    "leaving the current icon in place",
                    agent_name,
                    len(image_bytes),
                    _MAX_BOT_ICON_BYTES,
                )
                return
            logger.debug(
                "[BOT-ICON] fetched %d bytes for %s", len(image_bytes), agent_name
            )

            def _upload(data: bytes = image_bytes) -> None:
                base_url = driver.client.url
                token = driver.client.token
                upload_url = f"{base_url}/users/{bot_id}/image"
                r = sync_requests.post(
                    upload_url,
                    headers={"Authorization": f"Bearer {token}"},
                    files={"image": ("icon.png", data, "image/png")},
                )
                if not r.ok:
                    logger.error(
                        "[BOT-ICON] upload failed for %s: %s %s",
                        bot_id,
                        r.status_code,
                        r.text[:200],
                    )
                r.raise_for_status()

            await self._main_loop.run_in_executor(None, _upload)
            logger.debug(
                "[BOT-ICON] uploaded icon for %s (bot_id=%s)", agent_name, bot_id
            )
        except Exception:
            logger.exception("[BOT-ICON] failed to set icon for %s", agent_name)

    # ── Translation ──────────────────────────────────────────────────────────

    def translate_outbound(self, content: str) -> str:
        return re.sub(
            r"@(\w+):\S+",
            r"@\1",
            content,
        )

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message

    # ── WebSocket handling ───────────────────────────────────────────────────

    async def _ws_handler(self, event_data: str, agent_name: str) -> None:
        try:
            event = json.loads(event_data)
        except (json.JSONDecodeError, TypeError):
            return

        event_type = event.get("event")

        if event_type == "user_added":
            await self._handle_user_added(event)
            return

        if event_type != "posted":
            return

        data = event.get("data", {})
        post_str = data.get("post")
        if not post_str:
            return

        try:
            post = json.loads(post_str)
        except (json.JSONDecodeError, TypeError):
            return

        user_id = post.get("user_id", "")
        post_type = post.get("type", "")
        if post_type:
            return

        if user_id in self._bridge_bot_ids or user_id == self._admin_user_id:
            return

        post_id = post.get("id", "")
        with self._seen_lock:
            if post_id in self._seen_post_ids:
                return
            self._seen_post_ids[post_id] = None
            if len(self._seen_post_ids) > self._seen_post_ids_max:
                self._seen_post_ids.popitem(last=False)

        channel_id = post.get("channel_id", "")
        message = post.get("message", "")
        # Mattermost sets root_id to the thread root for replies, "" otherwise.
        root_id = post.get("root_id", "") or None
        mm_channel_type = data.get("channel_type", "")
        channel_name = str(data.get("channel_display_name", "")) or None

        loop = self._main_loop
        if loop is None or self._admin_driver is None:
            raise RuntimeError("Cannot handle posted event: adapter not started")

        ws_loop = asyncio.get_event_loop()
        try:
            user = await ws_loop.run_in_executor(
                None, self._admin_driver.users.get_user, user_id
            )
            username: str = user.get("username", user_id)
        except Exception:
            logger.exception("Failed to resolve Mattermost user %s", user_id)
            username = user_id

        channel_type = self._to_channel_type(mm_channel_type)
        stripped = message.strip()

        logger.debug(
            "[MM-INBOUND] post_id=%s channel=%s user=%s msg=%s",
            post_id,
            channel_id,
            username,
            message[:80],
        )

        if stripped.startswith("!") and self._on_command:
            parts = stripped.split(None, 1)
            command = parts[0].lstrip("!")
            args = parts[1].strip() if len(parts) > 1 else ""
            coro = self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=user_id,
                    sender_name=username,
                    command=command,
                    args=args,
                    message_ref=post_id or None,
                    root_id=root_id,
                    agent_name=agent_name,
                    channel_name=channel_name,
                )
            )
            self._dispatch(coro, loop)  # type: ignore[arg-type]
            return

        if self._on_message:
            attachments, attachment_failures = await self._fetch_attachments(
                post.get("file_ids", []), ws_loop
            )
            inbound = InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=user_id,
                sender_name=username,
                content=message,
                message_ref=post_id,
                root_id=root_id,
                agent_name=agent_name,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=attachment_failures,
            )
            coro = self._on_message(inbound)
            self._dispatch(coro, loop)  # type: ignore[arg-type]

    async def _fetch_attachments(
        self, file_ids: list[str], loop: asyncio.AbstractEventLoop
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Download every attachment for a post's file ids, whatever the type.

        Metadata and bytes are fetched via the admin driver off the websocket
        loop. Returns the downloaded attachments and, separately, the ones that
        could not be relayed (oversize, download failure) so the bridge can
        disclose them in the room rather than dropping them silently.
        """
        if not file_ids or self._admin_driver is None:
            return [], []

        driver = self._admin_driver
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for file_id in file_ids:
            filename = file_id
            try:
                meta = await loop.run_in_executor(
                    None, driver.files.get_file_metadata, file_id
                )
                mimetype = str(meta.get("mime_type", "")) or "application/octet-stream"
                filename = str(meta.get("name", file_id))
                size = meta.get("size")
                if isinstance(size, int) and size > self._max_attachment_bytes:
                    logger.warning(
                        "[MM-INBOUND] attachment %s is %d bytes, over the %d cap",
                        filename,
                        size,
                        self._max_attachment_bytes,
                    )
                    failures.append(
                        AttachmentFailure(
                            filename=filename,
                            reason=f"{size} bytes exceeds the {self._max_attachment_bytes} byte limit",
                        )
                    )
                    continue
                resp = await loop.run_in_executor(None, driver.files.get_file, file_id)
                data: bytes = resp.content
            except Exception as exc:
                logger.exception(
                    "[MM-INBOUND] failed to download attachment %s", file_id
                )
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"download failed: {exc}"
                    )
                )
                continue
            if len(data) > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"{len(data)} bytes exceeds the {self._max_attachment_bytes} byte limit",
                    )
                )
                continue
            attachments.append(
                Attachment(filename=filename, mimetype=mimetype, data=data)
            )
        return attachments, failures

    async def _handle_user_added(self, event: dict[str, Any]) -> None:
        data: dict[str, Any] = event.get("data", {})
        user_id = str(data.get("user_id", ""))
        if not user_id:
            return

        broadcast: dict[str, Any] = event.get("broadcast", {})
        channel_id = str(broadcast.get("channel_id", ""))
        if not channel_id:
            logger.error("user_added event missing channel_id (user=%s)", user_id)
            return

        loop = self._main_loop
        if loop is None or self._admin_driver is None:
            raise RuntimeError("Cannot handle user_added: adapter not started")

        ws_loop = asyncio.get_event_loop()
        channel = await ws_loop.run_in_executor(
            None, self._admin_driver.channels.get_channel, channel_id
        )
        channel_type = self._to_channel_type(channel.get("type", ""))
        channel_name = str(channel.get("display_name", "")) or None

        agent_name = self._bot_id_to_username.get(user_id)
        if agent_name:
            if not self._on_agent_joined:
                logger.error("No on agent joined available for bridge")
                return
            coro = self._on_agent_joined(
                InboundAgentJoin(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    agent_name=agent_name,
                    channel_name=channel_name,
                )
            )
            self._dispatch(coro, loop)  # type: ignore[arg-type]
            return

        if user_id == self._admin_user_id:
            return

        if not self._on_user_joined:
            return

        try:
            user = await ws_loop.run_in_executor(
                None, self._admin_driver.users.get_user, user_id
            )
            username: str = user.get("username", user_id)
        except Exception:
            logger.exception("Failed to resolve Mattermost user %s", user_id)
            return

        coro = self._on_user_joined(
            InboundUserJoin(
                channel_id=channel_id,
                channel_type=channel_type,
                external_user_id=user_id,
                external_username=username,
                channel_name=channel_name,
            )
        )
        self._dispatch(coro, loop)  # type: ignore[arg-type]

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Find team members via Mattermost's own user search.

        Scoped to the bridge's team, and bots are dropped — a bot is not a
        person who can own an agent.
        """
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Mattermost adapter is not started")

        term = query.strip()
        if not term:
            return []

        driver = self._admin_driver
        try:
            found = await self._main_loop.run_in_executor(
                None,
                driver.users.search_users,
                {"term": term, "team_id": self._team_id, "allow_inactive": False},
            )
        except Exception as e:
            raise RuntimeError(f"Mattermost user directory lookup failed: {e}") from e

        results: list[DirectoryUser] = []
        for user in found or []:
            if user.get("is_bot"):
                continue
            username = user.get("username", "") or ""
            first = user.get("first_name", "") or ""
            last = user.get("last_name", "") or ""
            full_name = " ".join(part for part in (first, last) if part)
            results.append(
                DirectoryUser(
                    external_user_id=str(user.get("id")),
                    username=username,
                    display_name=(user.get("nickname") or full_name or username),
                    email=user.get("email") or None,
                )
            )
        results.sort(key=lambda u: u.display_name.lower())
        return results

    @staticmethod
    def _to_channel_type(mm_type: str) -> ChannelType:
        if mm_type == "D":
            return "direct"
        if mm_type == "G":
            return "group"
        if mm_type == "P":
            return "channel_private"
        return "channel_public"

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _dispatch(self, coro: Any, loop: asyncio.AbstractEventLoop) -> None:
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        future.add_done_callback(self._on_dispatch_done)

    @staticmethod
    def _on_dispatch_done(future: Any) -> None:
        exc = future.exception()
        if exc is not None:
            logger.error("Dispatched coroutine failed: %s", exc, exc_info=exc)

    def _create_driver(
        self,
        login_id: str | None = None,
        password: str | None = None,
        token: str | None = None,
    ) -> Driver:
        url = self._config.url.rstrip("/")
        scheme = "https" if url.startswith("https") else "http"
        host = re.sub(r"^https?://", "", url)
        port = 443 if scheme == "https" else 8065

        if ":" in host:
            host, port_str = host.rsplit(":", 1)
            port = int(port_str)

        opts: dict[str, object] = {
            "url": host,
            "scheme": scheme,
            "port": port,
            "verify": self._config.verify_tls,
        }
        if token:
            opts["token"] = token
        elif login_id and password:
            opts["login_id"] = login_id
            opts["password"] = password

        return Driver(opts)

    def _mm_api(
        self, method: str, endpoint: str, data: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        if self._admin_driver is None:
            raise RuntimeError("Admin driver not initialized")
        try:
            resp = self._admin_driver.client.make_request(
                method, endpoint, options=data
            )
        except NoAccessTokenProvided:
            logger.warning("Mattermost session expired, re-authenticating")
            self._admin_driver.login()
            resp = self._admin_driver.client.make_request(
                method, endpoint, options=data
            )
        return resp.json()  # type: ignore[no-any-return]

    async def _find_existing_bot(self, username: str) -> dict[str, Any] | None:
        page = 0
        per_page = 200
        while True:
            result = self._mm_api(
                "get",
                f"/bots?include_deleted=true&page={page}&per_page={per_page}",
            )
            bots: list[dict[str, Any]] = result  # type: ignore[assignment]
            for bot in bots:
                if bot.get("username") == username:
                    if bot.get("delete_at", 0) > 0:
                        self._mm_api("post", f"/bots/{bot['user_id']}/enable")
                    return bot
            if len(bots) < per_page:
                break
            page += 1
        return None
