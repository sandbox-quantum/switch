from __future__ import annotations

import hashlib
import io
import logging
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar, Literal

import discord
from pydantic import Field, model_validator
from pydantic.json_schema import SkipJsonSchema

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME
from switch_core.bridges.agent.commands import Command as InRoomCommand
from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    ActivitySnapshot,
    CollaborationAdapter,
    RemovalFailed,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    ThreadUnavailable,
    TurnActivity,
)
from switch_core.bridges.collaboration.discord.chunking import (
    MAX_MESSAGE,
    chunk_message,
)
from switch_core.bridges.collaboration.discord.connection import DiscordConnection
from switch_core.bridges.collaboration.discord.slash import (
    SlashArgError,
    build_app_commands,
    reassemble_args,
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
)
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
    INTERRUPT_QUEUED_NOTE,
    Control,
    Drawn,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    ACTIVITY_AUDIENCE_UNKNOWN,
    ACTIVITY_FAILED,
    ACTIVITY_GONE,
    ACTIVITY_NOT_A_MEMBER,
    ACTIVITY_UNREADABLE,
    activity_log,
    render_request,
    turn_status,
)
from switch_core.sessions.contract import TURN_ENDED

logger = logging.getLogger(__name__)

# Webhook minted by the bridge in each channel it posts to; agents share it
# via per-message username/avatar overrides.
_WEBHOOK_NAME = "Switch Bridge"

# A second webhook in the same channels, carrying session publications and
# nothing else, so that one of ours can be told apart from an agent's own words
# when the only record left to read is the channel history.
_PUBLICATION_WEBHOOK_NAME = "Switch Sessions"

# Put on the message an agent is working on for as long as its turn lasts.
_REACTION: dict[ActivityMark, str] = {"working": "👀", "queued": "⏳"}

# Discord's error code for "Maximum number of guild roles reached" (250).
_MAX_GUILD_ROLES_CODE = 30005

# "Unknown Message". The only 404 that is about the message rather than about
# what was asked to act on it — a webhook route answers 10015 "Unknown Webhook"
# with the same status, and reading that as a card that is gone retires a card
# still on the screen.
_UNKNOWN_MESSAGE_CODE = 10008

# "Unknown Member". The 404 that is about the person asked after, as against
# 10004 "Unknown Guild" and 10003 "Unknown Channel" on the same routes and with
# the same status. Only this one says a reader is not in a conversation; the
# other two say the conversation could not be found, which is the bot's problem
# and not the reader's.
_UNKNOWN_MEMBER_CODE = 10007

# Applied to the bot posts that inline an agent's name into the body — the DM
# path, which has no webhook identity to carry it. Escaping the text is not
# enough on its own: Discord decides who a message pings from the raw content
# it receives, so `@everyone` in a name is refused here rather than in markup.
# Only the mass mentions are withheld; a user or role the agent deliberately
# mentioned still resolves.
_NO_MASS_MENTIONS = discord.AllowedMentions(everyone=False)

# Inserted after the `<` of anything that looks like a Discord entity. Discord
# has no escape for `<`, so the syntax is broken rather than escaped — the same
# technique discord.py uses on `@`.
_ZERO_WIDTH_SPACE = "\u200b"

# How far before a reservation's own timestamp a recovery search starts, and
# how far back it is willing to read. The allowance covers the gap between
# Switch writing the reservation and Discord stamping the message it is looking
# for; the limit stops a busy channel turning one lookup into a history crawl.
_RECOVERY_SKEW = timedelta(seconds=30)

# What a press hands back, and what it may cost. Discord allows 100 characters
# in a component's id and 80 on its label; the label's budget is what is left
# once the option's number and its separator are in front of it.
_CUSTOM_ID_PREFIX = "sw"
_MAX_CUSTOM_ID = 100
_MAX_BUTTON_LABEL = 76

# Five buttons to a row and five rows to a message. A card with more options
# than that gets none of them rather than some.
_MAX_BUTTONS = 25

# The notice a press is owed, collected while the press is being handled.
#
# A refusal is raised deep inside the shared inbound path, which knows the
# person and the reason and nothing about Discord; the only private way to tell
# them is a follow-up on the press itself, addressed by a token that belongs to
# the press rather than to the person. A context variable is what joins the
# two: `tell_actor` leaves the notice here and the press carries it, so nothing
# has to be looked up by actor — two people pressing at once are two tasks with
# a context each, and the same person pressing twice is two presses rather than
# one notice overwriting another.
_PRESS_NOTICE: ContextVar[list[str] | None] = ContextVar(
    "switch_discord_press_notice", default=None
)


# The three buttons that are about a turn rather than about a card, and the one
# thing each of them has to say to be recognised on the way back.
#
# `View activity` sits on the status message and says only what kind of press it
# is: which turn it is about is the message it arrived on, which Discord fills
# in and a client cannot write. `Refresh` sits on a private copy that no journal
# has a row for, so it carries the address of the public message it was opened
# from — a locator, resolved and re-authorised from scratch on every press,
# never taken as evidence of anything.
#
# `Stop current work` is the one that does carry an identifier, because the
# message cannot supply it: a queued turn's status offers to stop the turn in
# front of it rather than itself, and a message nothing has redrawn since names
# the turn its reader can still see rather than whatever is running by the time
# they press.
_ACTIVITY_PREFIX = "swact"
_ACTIVITY_VIEW_ID = f"{_ACTIVITY_PREFIX}:v"
_ACTIVITY_REFRESH_ID = f"{_ACTIVITY_PREFIX}:r"
_INTERRUPT_PREFIX = "swstop"
_ACTIVITY_LABEL = "View activity"
_REFRESH_LABEL = "Refresh"
_CONSOLE_LABEL = "Open in Switch Console"


def _custom_id(token: str, position: int) -> str:
    return f"{_CUSTOM_ID_PREFIX}:{token}:{position}"


def _interrupt_id(turn_id: str) -> str:
    return f"{_INTERRUPT_PREFIX}:{turn_id}"


def _refresh_id(ref: str) -> str:
    return f"{_ACTIVITY_REFRESH_ID}:{ref}"


def _parse_refresh_id(custom_id: str) -> str | None:
    """The public status message a refresh is about, or None if it is not one.

    Read as strictly as `_parse_custom_id`, and trusted no further: what comes
    back is an address, and every check the first view passed is made again
    against it. A reference to a message showing nothing, or to one this reader
    may not read, answers exactly as it would have on the way in.
    """
    parts = custom_id.split(":", 2)
    if len(parts) != 3:
        return None
    prefix, kind, ref = parts
    if prefix != _ACTIVITY_PREFIX or kind != "r" or not ref:
        return None
    return ref


def _conversation_in(ref: str) -> int | None:
    """The channel or thread half of a `<location>:<message>` address.

    Which conversation a reference names, rather than which message in it: the
    message is the journal's business, and where it is showing is what decides
    whether the reader in front of us is entitled to any of it. Refuses
    anything that is not a pair of Discord ids, because this one is read off a
    press rather than out of our own records.
    """
    location, _, message = ref.partition(":")
    if not location.isdigit() or not message.isdigit():
        return None
    return int(location)


def _parse_custom_id(custom_id: str) -> tuple[str, int] | None:
    """The card and the option a press names, or None if it is not ours.

    Read as strictly as it is written. Discord hands back whatever was put in
    the button and nothing else, so neither half is trusted past its shape: the
    token is resolved against the stored card and the position against the form
    that card was drawn from.
    """
    parts = custom_id.split(":")
    if len(parts) != 3 or parts[0] != _CUSTOM_ID_PREFIX:
        return None
    token, digits = parts[1], parts[2]
    if not token or not digits.isascii() or not digits.isdecimal():
        return None
    position = int(digits)
    return (token, position) if position > 0 else None


def _parse_interrupt_id(custom_id: str) -> str | None:
    """The turn a stop press names, or None if the press is not one.

    Split once, so a turn id a provider chose to put a colon in comes back
    whole. What comes back is a claim and is treated as one: the session it
    stops is the one behind the message the press arrived on, and this only
    says which of that session's turns the button was drawn against.
    """
    prefix, separator, turn_id = custom_id.partition(":")
    if prefix != _INTERRUPT_PREFIX or not separator or not turn_id:
        return None
    return turn_id


def _press_action(custom_id: str) -> tuple[str, str] | None:
    """The Switch action a press carries and what it names, or None if not ours.

    Two buttons arrive here and they name different things — a card's option
    names the card, a stop names the turn — but they leave by the same door,
    because what happens next is the same for both: acknowledge inside
    Discord's three seconds, then hand the press to the shared inbound path and
    tell the presser alone whatever comes back.
    """
    turn_id = _parse_interrupt_id(custom_id)
    if turn_id is not None:
        return INTERRUPT_ACTION, turn_id
    press = _parse_custom_id(custom_id)
    if press is None:
        return None
    token, position = press
    return position_action(position), token


def _button_label(control: Control) -> str:
    """What the button says: the option's number, and as much of it as fits.

    Numbered because the body numbers it. A card is answerable by typing
    whether or not it has buttons, and a reader looking at "2" in the text and
    "Decline" on a button should not have to work out that they are the same
    thing.
    """
    label = control.label.strip() or f"Option {control.position}"
    if len(label) > _MAX_BUTTON_LABEL:
        label = label[: _MAX_BUTTON_LABEL - 1].rstrip() + "…"
    return f"{control.position}. {label}"


_RECOVERY_LIMIT = 100

# Waited when Discord says it is rate limiting but does not say for how long.
# Its buckets are short, so this is a floor that keeps the caller's backoff in
# the right order of magnitude rather than a figure Discord commits to.
_THROTTLE_FALLBACK = 5.0


def _throttle_delay(error: discord.HTTPException) -> float:
    """How long a 429 asks us to wait, from wherever Discord put the number.

    `RateLimited` carries it as a float. An `HTTPException` does not: the
    library parses the 429 body down to its `message` and drops the rest, so
    the header is what is left. Falls back to a constant rather than to zero —
    retrying a throttle immediately is how a throttle becomes a ban.
    """
    response = getattr(error, "response", None)
    raw = getattr(response, "headers", {}).get("Retry-After") if response else None
    try:
        return float(raw) if raw is not None else _THROTTLE_FALLBACK
    except (TypeError, ValueError):
        return _THROTTLE_FALLBACK


def _as_rich_failure(
    error: Exception, *, description: str, text: str
) -> RichContentFailed | None:
    """Discord's answer, or no answer at all.

    `None` means the send may or may not have happened, and the caller must
    keep its reservation: `RichContentFailed` is a licence to discard one and
    try again, which on a request card is a licence to ask the same question
    twice.

    A 4xx is Discord refusing, and Discord refusing is an answer. A 5xx is not:
    discord.py has already retried it several times by then, and each of those
    attempts may have been the one that landed before the response was lost.
    Neither is a timeout or a dropped connection, which arrive as
    `aiohttp` and `asyncio` errors rather than as anything Discord said.

    A 429 is an answer, but not that one. It arrives two ways — as
    `RateLimited` when the library declines to sleep through it, and as a plain
    `HTTPException` when the webhook transport has exhausted its own retries or
    when the response is missing the header the library needs to classify it —
    and both mean wait, not stop. Reading only the first shape turned a
    throttle into a refusal and threw away the delay Discord had just supplied.
    """
    if isinstance(error, discord.RateLimited):
        return RichContentThrottled(retry_after=error.retry_after, text=text)
    if isinstance(error, discord.HTTPException) and error.status == 429:
        return RichContentThrottled(retry_after=_throttle_delay(error), text=text)
    if isinstance(error, discord.DiscordServerError):
        return None
    if isinstance(error, discord.HTTPException | ValueError):
        return RichContentFailed(f"{description}: {error}", text=text)
    return None


class _WebhookIdentity:
    """Keep one accepted identity across chunks and attachment retries."""

    def __init__(self, label: str, identifier: str) -> None:
        self._label = label
        self._identifier = identifier
        self._fallback = (
            identifier
            if self._valid_name(identifier)
            else f"Switch agent {hashlib.sha256(identifier.encode()).hexdigest()[:12]}"
        )
        self._refused = not self._valid_name(label)
        if self._refused:
            logger.warning(
                "Discord cannot use display name %r for agent %r; posting as %r instead",
                label[:160],
                identifier[:160],
                self._fallback,
            )

    @staticmethod
    def _valid_name(name: str) -> bool:
        return (
            1 <= len(name) <= 80
            and bool(name.strip())
            and not re.search(r"discord|clyde", name, re.IGNORECASE)
        )

    def _fallback_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._fallback == self._identifier:
            return payload
        if "embed" in payload or "embeds" in payload:
            raise ValueError(
                "Webhook identity disclosure requires a payload without embeds"
            )
        disclosure = discord.Embed()
        disclosure.set_footer(
            text=f"Agent: {self._identifier[:512]} — Discord requires a different sender name."
        )
        return {
            **payload,
            "embeds": [disclosure],
            "suppress_embeds": False,
        }

    async def send(self, webhook: discord.Webhook, payload: dict[str, Any]) -> Any:
        """Post `payload`, which must survive being sent twice."""
        return await self.send_rebuilding(webhook, lambda: payload)

    async def send_rebuilding(
        self, webhook: discord.Webhook, build_payload: Callable[[], dict[str, Any]]
    ) -> Any:
        """Post a payload rebuilt for each attempt.

        For the attachment path alone: an attempt reads the `discord.File` it
        was handed, so a retry that reused it would upload nothing."""
        if self._refused:
            return await webhook.send(
                username=self._fallback, **self._fallback_payload(build_payload())
            )
        try:
            return await webhook.send(username=self._label, **build_payload())
        except discord.HTTPException as e:
            if e.status != 400 or self._label == self._fallback:
                raise
            self._refused = True
            logger.warning(
                "Discord refused the display name %r as a webhook username (%s); "
                "posting as %r instead",
                self._label[:160],
                e,
                self._fallback,
            )
            return await webhook.send(
                username=self._fallback, **self._fallback_payload(build_payload())
            )


class DiscordConnectionConfig(BridgeConnectionConfig):
    #: Optional because it depends on `event_delivery`, which the validator
    #: below enforces: the self-registered bridge opens its own connection and
    #: needs a token; the distributed bridge routes through the one shared
    #: connection and carries none — its token is deployment config.
    bot_token: str | None = None
    guild_id: str
    #: How this bridge's events reach it, and which is decided by which Discord
    #: app the install came from rather than by an operator's preference.
    #:
    #: `own_connection` is the self-registered app: Switch opens a Gateway
    #: connection scoped to this guild with the token above. `shared` is the
    #: distributed app: the bridge opens nothing and registers its guild with
    #: the one deployment-level connection instead, so it holds no token.
    #:
    #: Hidden from the registration form because it is not a question the
    #: operator filling that form can be asked: reaching the form means the
    #: self-registered app, and the shared value is written by the install flow.
    event_delivery: SkipJsonSchema[Literal["own_connection", "shared"]] = (
        "own_connection"
    )
    # Both registration forms build themselves from this schema, so what is
    # written here is the only explanation an operator gets next to the
    # checkbox.
    agent_roles: bool = Field(
        default=True,
        title="Agent name autocomplete",
        description=(
            "Give each agent a mentionable Discord role so its name completes "
            "when you type @. Needs Manage Roles."
        ),
    )

    @model_validator(mode="after")
    def _token_matches_delivery(self) -> DiscordConnectionConfig:
        """Refuse the two half-states that look configured and cannot work.

        An own-connection bridge with no bot token opens no Gateway connection,
        so it would receive nothing — the silent failure the token is there to
        prevent. A shared bridge carrying a token is the opposite mistake: a
        credential for a connection this bridge does not own, read as evidence
        that it does.
        """
        if self.event_delivery == "own_connection" and not self.bot_token:
            raise ValueError(
                "bot_token is required: without it Switch opens no Gateway "
                "connection and this bridge would receive no Discord events."
            )
        if self.event_delivery == "shared" and self.bot_token:
            raise ValueError(
                "bot_token must be empty for a shared-connection bridge; the "
                "distributed Discord app's token is deployment config, not "
                "this install's."
            )
        return self


class DiscordAdapter(CollaborationAdapter):
    """Discord collaboration bridge adapter.

    Single-bot identity model like Slack: all agents post through one bot
    application, differentiated per message via channel webhooks (Discord
    webhooks accept a per-message username and avatar_url). Inbound events
    arrive over a Gateway WebSocket session scoped to the configured guild
    (an outbound connection — no public ingress needed); outbound goes
    through the REST API.

    Rooms are provisioned lazily: Discord has no "app invited to channel"
    signal (the bot sees every channel its permissions allow), so a channel's
    Switch room is created by the bridge core on the first bridged message
    rather than eagerly for the whole guild.
    """

    # Discord linkifies only http(s), so the `switchdash://` deeplink needs the
    # https redirect (`GATEWAY_PUBLIC_URL`) to be clickable here.
    renders_custom_url_schemes: ClassVar[bool] = False

    publishes_sdk_sessions: ClassVar[bool] = True

    # A problem somebody has to act on gets its own reply, because the status
    # it would otherwise be an edit to is a message they have already read.
    separate_attention_slot: ClassVar[bool] = True

    # Discord subscribes you to a thread you started, were mentioned in, or
    # have spoken in — and to nothing else. The person who asked from the
    # channel root is in none of those, so a reply that names nobody reaches
    # nobody.
    notifies_only_by_mention: ClassVar[bool] = True

    # The status is the turn's one post, so the clock rides along with the next
    # real change rather than rewriting a message somebody is reading. See the
    # matching choice on Mattermost.
    redraws_for_elapsed_time: ClassVar[bool] = False

    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True

    # Every agent posts through one bot application, so there is one 👀 between
    # them: the first turn to want it adds it and the last to finish removes it.
    activity_reactions_per_agent: ClassVar[bool] = False

    # `find_request_card` reads a channel's history back and matches a card by
    # the handle printed on it, so an unacknowledged send can still be bound to
    # the message it produced.
    recovers_uncertain_posts: ClassVar[bool] = True

    # Left False: a webhook message carries no metadata this bridge can set,
    # so the handle a card prints is the only thing a search has to match on.
    # A card is therefore recoverable and a turn's activity, which prints no
    # handle, is not — see `find_request_card`. Not a property of Discord: a
    # marker carried some other way would make this True.
    carries_publication_marker: ClassVar[bool] = False

    #: A webhook may delete the messages it sent, and the publication webhook
    #: sent every card, so no Manage Messages permission is involved and none
    #: is in the documented install. A DM card is the bot's own message, which
    #: it may always delete.
    removes_answered_cards: ClassVar[bool] = True

    def __init__(self, *, config: DiscordConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._guild_id = int(config.guild_id)
        # The Gateway socket lives on the connection, not the adapter: the
        # socket is per bot token and the adapter is per guild. Intents are
        # built here and handed over, so the socket owner does not decide them.
        #
        # A self-registered bridge owns its connection, built now from its
        # token. A distributed (shared-delivery) bridge owns none: it is inert
        # until it is attached to the one deployment-level connection, which is
        # not built yet — so `_connection` stays None and every outbound path
        # fails loud through `_require_connection` rather than pretending.
        self._connection: DiscordConnection | None = None
        if config.event_delivery == "own_connection":
            assert config.bot_token is not None  # guaranteed by the validator
            self._connection = DiscordConnection(
                bot_token=config.bot_token,
                intents=self._build_intents(),
                command_guild_id=self._guild_id,
            )
        # (channel id, webhook name) -> webhook the bridge posts through there.
        self._webhooks: dict[tuple[int, str], discord.Webhook] = {}
        # Ids of webhooks the bridge has minted/adopted, for echo dropping.
        self._webhook_ids: set[int] = set()
        # Of those, the ones this application created — the only ones Discord
        # will let carry buttons. See `_application_owns`.
        self._owned_webhooks: set[int] = set()
        self._seen_ids: OrderedDict[int, None] = OrderedDict()
        self._seen_ids_max = 1000
        # Discord user id ↔ username caches, for mention translation both ways.
        self._user_names: dict[int, str] = {}
        self._username_to_id: dict[str, int] = {}
        # Message refs currently carrying an activity reaction. One bot serves
        # every agent here, so a mark belongs to the application rather than to
        # whichever agent asked for it.
        self._marked: set[tuple[str, ActivityMark]] = set()
        # Set once Discord has told us it will not host agent roles, so the
        # bridge stops asking and says so only once.
        self._agent_roles_off_reason: str | None = None
        # Folded agent name -> the guild role that agent is mentioned by, for
        # the roles this bridge has minted or adopted. Only these are rendered
        # as role pills on the way out: a role carries no metadata on Discord,
        # so anything wider would risk turning a passing "@moderators" into a
        # real ping of somebody's real role.
        self._agent_role_ids: dict[str, int] = {}

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
        # Single-bot identity model: agents share the one Discord bot via
        # per-message webhook username/avatar override, so there is no
        # per-agent join to detect. Channel joins have no Discord signal
        # either (visibility is permission-based), so rooms are created
        # lazily on first message and the join callbacks stay unused.
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        if self._config.event_delivery == "shared":
            # Inert: a shared-delivery bridge opens no connection of its own and
            # is not yet attached to the shared one. It exists as a bridge — its
            # rooms, the operator's list, moderation — but neither sends nor
            # receives until the shared Gateway connection is built and hands it
            # its guild. The callbacks are kept for that moment.
            logger.info(
                "Discord bridge for guild %s registered inert (shared delivery); "
                "awaiting the shared Gateway connection",
                self._config.guild_id,
            )
            return

        # One guild, one handler; the DM handler is the same adapter so direct
        # messages still reach it. The connection routes each message by guild
        # id, which for a single-guild bridge is exactly the old filter.
        conn = self._require_connection()
        conn.register_message_handler(self._guild_id, self._handle_message)
        conn.set_dm_handler(self._handle_message)
        conn.set_interaction_handler(self._make_on_interaction())
        await conn.connect(
            commands=build_app_commands(self._handle_slash_command),
        )
        logger.info(
            "Discord adapter connected as %s (guild %s)",
            conn.client.user,
            self._config.guild_id,
        )

    @staticmethod
    def _build_intents() -> discord.Intents:
        intents = discord.Intents.none()
        intents.guilds = True
        intents.guild_messages = True
        intents.dm_messages = True
        intents.message_content = True
        intents.members = True
        return intents

    def _make_on_interaction(
        self,
    ) -> Callable[[discord.Interaction], Coroutine[Any, Any, None]]:
        async def on_interaction(interaction: discord.Interaction) -> None:
            try:
                await self._handle_interaction(interaction)
            except Exception:
                logger.exception("Failed to handle a press on a Discord card")

        return on_interaction

    async def stop(self) -> None:
        # A shared-delivery bridge has no connection of its own to close;
        # stopping it is just dropping its per-guild state.
        if self._connection is not None:
            await self._connection.close()
        self._webhooks.clear()
        self._owned_webhooks.clear()
        logger.info("Discord adapter stopped")

    def ensure_shared_connection(self, connection: DiscordConnection) -> None:
        """Attach the shared Gateway connection the first time this bridge is used.

        A shared-delivery bridge is built inert (no connection of its own); the
        deployment-level Gateway client injects its connection here so the
        adapter's inbound handling and its outbound posting both run against it.
        Idempotent and set-once: an own-connection bridge already has one and is
        left alone, and repeated calls after the first are no-ops.
        """
        if self._connection is None:
            self._connection = connection

    async def dispatch_inbound(self, message: discord.Message) -> None:
        """Handle one inbound Gateway message the shared client routed here.

        The shared connection resolves a guild to this bridge and calls this;
        the self-registered connection calls the same handler directly. Kept a
        thin public entry so the shared client does not reach into the adapter.
        """
        await self._handle_message(message)

    async def dispatch_slash(
        self,
        interaction: discord.Interaction,
        command: InRoomCommand,
        values: dict[str, Any],
    ) -> None:
        """Handle one slash invocation the shared client routed here by guild.

        The self-registered connection reaches the same handler through the
        command tree it owns; the shared connection registers commands globally
        and routes each invocation to the bridge its guild resolves to.
        """
        await self._handle_slash_command(interaction, command, values)

    def _require_connection(self) -> DiscordConnection:
        """The bridge's Gateway connection, or a loud error if it has none.

        A shared-delivery bridge is inert until it is attached to the shared
        connection; reaching an outbound path before that is a bug, and this
        surfaces it rather than letting the call no-op or crash obscurely.
        """
        if self._connection is None:
            raise RuntimeError(
                "this Discord bridge uses shared delivery and is not attached to "
                "the shared Gateway connection yet"
            )
        return self._connection

    def _require_client(self) -> discord.Client:
        return self._require_connection().client

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        try:
            target = await self._get_channel(int(channel_id))
        except Exception:
            logger.exception("Cannot resolve Discord channel %s", channel_id)
            return None

        if self._channel_type_of(target) == "lobby":
            # DM channels have no webhooks, so no per-message identity — fall
            # back to a bot post with the agent name inlined.
            label = await self.agent_label_for_body(sender_name)
            return await self._send_chunked(
                f"**{label}**: {content}",
                lambda part: target.send(
                    part,
                    suppress_embeds=True,
                    allowed_mentions=_NO_MASS_MENTIONS,
                ),
                where=f"DM {channel_id}",
            )

        thread: Any = None
        if thread_root_id:
            try:
                thread = await self._ensure_thread(int(channel_id), thread_root_id)
            except Exception:
                logger.exception(
                    "Failed to resolve Discord thread for root %s — posting at channel root",
                    thread_root_id,
                )

        try:
            webhook = await self._get_webhook(int(channel_id))
        except discord.HTTPException as e:
            logger.error(
                "Failed to resolve webhook for Discord channel %s: %s", channel_id, e
            )
            return None

        kwargs: dict[str, Any] = {}
        if thread is not None:
            kwargs["thread"] = thread
        # Resolved once here rather than inside the send callback: that callback
        # is synchronous, and a chunked message would otherwise re-resolve per
        # chunk and could split one message across two different avatars.
        agent = await self.agent_rendering(sender_name)
        identity = _WebhookIdentity(agent.field_label, sender_name)
        return await self._send_chunked(
            content,
            lambda part: identity.send(
                webhook,
                {
                    "content": part,
                    "avatar_url": agent.icon_url,
                    "suppress_embeds": True,
                    "wait": True,
                    **kwargs,
                },
            ),
            where=f"channel {channel_id}",
        )

    async def _send_chunked(
        self,
        content: str,
        send: Callable[[str], Awaitable[Any]],
        *,
        where: str,
    ) -> str | None:
        """Post `content` as however many messages Discord's 2,000-char cap needs.

        Returns the ref of the FIRST message. That is the one the bridge maps
        the Matrix event to, so a reply threads under the start of what was
        said rather than its tail, and a thread created from it opens where the
        message begins.

        A part failing mid-sequence leaves the message *visibly* truncated
        rather than silently so: what was posted stays, and a short notice says
        the rest did not make it.
        """
        chunks = chunk_message(content)
        first_ref: str | None = None

        for index, chunk in enumerate(chunks):
            try:
                sent = await send(chunk)
            except discord.HTTPException as e:
                logger.error(
                    "Failed to send part %d of %d to Discord %s: %s",
                    index + 1,
                    len(chunks),
                    where,
                    e,
                )
                await self._note_truncation(send, index, len(chunks))
                return first_ref
            if first_ref is None:
                first_ref = f"{sent.channel.id}:{sent.id}"

        return first_ref

    @staticmethod
    async def _note_truncation(
        send: Callable[[str], Awaitable[Any]], delivered: int, total: int
    ) -> None:
        try:
            await send(
                f"⚠️ Only {delivered} of {total} parts of this message could be "
                "delivered — the rest was rejected by Discord."
            )
        except discord.HTTPException:
            logger.exception("Failed to post Discord truncation notice")

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
        """Relay a file into a Discord channel under the agent's identity.

        Unlike Slack/Mattermost, a Discord webhook post carries both a
        per-message username/avatar override AND a file, so the attachment
        renders under the agent's name and icon exactly like a normal message
        (with the image preview intact — embeds are not suppressed). DM
        ("lobby") channels have no webhook, so the file posts as the bot with
        the agent name inlined, mirroring send_message. Falls back to the base
        text notice on failure so the attachment is never silently dropped.
        """
        try:
            target = await self._get_channel(int(channel_id))
        except Exception:
            logger.exception("Cannot resolve Discord channel %s", channel_id)
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )

        body = self.translate_outbound(caption) if caption else ""

        if self._channel_type_of(target) == "lobby":
            label = await self.agent_label_for_body(sender_name)
            content = f"**{label}**: {body}" if body else f"**{label}**"
            try:
                msg = await target.send(
                    content,
                    file=discord.File(io.BytesIO(data), filename=filename),
                    allowed_mentions=_NO_MASS_MENTIONS,
                )
                return f"{msg.channel.id}:{msg.id}"
            except discord.HTTPException:
                logger.exception(
                    "Failed to send Discord DM attachment in %s", channel_id
                )
                return await super().send_attachment(
                    channel_id,
                    sender_name,
                    filename,
                    mimetype,
                    data,
                    caption,
                    thread_root_id,
                )

        thread: Any = None
        if thread_root_id:
            try:
                thread = await self._ensure_thread(int(channel_id), thread_root_id)
            except Exception:
                logger.exception(
                    "Failed to resolve Discord thread for root %s — posting attachment at channel root",
                    thread_root_id,
                )

        try:
            webhook = await self._get_webhook(int(channel_id))
            kwargs: dict[str, Any] = {}
            if thread is not None:
                kwargs["thread"] = thread
            agent = await self.agent_rendering(sender_name)
            identity = _WebhookIdentity(agent.field_label, sender_name)
            sent: Any = await identity.send_rebuilding(
                webhook,
                lambda: {
                    "content": body,
                    "avatar_url": agent.icon_url,
                    "file": discord.File(io.BytesIO(data), filename=filename),
                    "wait": True,
                    **kwargs,
                },
            )
            return f"{sent.channel.id}:{sent.id}"
        except discord.HTTPException as e:
            logger.error(
                "Failed to send attachment '%s' to Discord channel %s: %s",
                filename,
                channel_id,
                e,
            )
            return await super().send_attachment(
                channel_id,
                sender_name,
                filename,
                mimetype,
                data,
                caption,
                thread_root_id,
            )

    def slash_invite_hint(self) -> str:
        # Discord declares each argument as its own named field, so the option
        # name is part of the invocation. Read from the registry the commands
        # are registered from, so a renamed argument cannot leave this stale.
        option = COMMANDS_BY_NAME["invite-agent"].args_spec[0].name
        return f"`/invite-agent {option}:agent-name` — the Discord slash command"

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        # Renders its own body: every caller of `admin_message` passes Switch
        # Markdown, so the conversion belongs here rather than at each of
        # them — one of them forgetting is how a notice reached a chat with
        # its markup showing.
        # Admin/system messages post as the bot application itself — no
        # webhook username override — so they read as the platform speaking,
        # not an agent.
        try:
            target = await self._get_channel(int(channel_id))
            if thread_root_id:
                try:
                    target = await self._ensure_thread(int(channel_id), thread_root_id)
                except Exception:
                    logger.exception(
                        "Failed to resolve Discord thread for admin message — posting at channel root"
                    )
        except (discord.HTTPException, RuntimeError) as e:
            logger.error(
                "Failed to post admin message to Discord channel %s: %s",
                channel_id,
                e,
            )
            return None

        return await self._send_chunked(
            self._admin_body(self.translate_outbound(content), drawn),
            lambda part: target.send(part, suppress_embeds=True),
            where=f"channel {channel_id}",
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        location_id, message_id = self._parse_message_ref(message_ref)
        if not message_id:
            logger.error("Cannot update message: invalid message ref %s", message_ref)
            return

        kwargs: dict[str, Any] = {}
        if location_id and location_id != channel_id:
            kwargs["thread"] = discord.Object(id=int(location_id))
        try:
            webhook = await self._get_webhook(int(channel_id))
            await webhook.edit_message(int(message_id), content=new_content, **kwargs)
            return
        except discord.NotFound:
            pass
        except discord.HTTPException as e:
            logger.error("Failed to update Discord message %s: %s", message_ref, e)
            return

        # Not a message of our webhook — e.g. an admin (bot) post: edit via
        # the bot's own message object instead.
        try:
            target = await self._get_channel(int(location_id or channel_id))
            msg = await target.fetch_message(int(message_id))
            await msg.edit(content=new_content)
        except discord.HTTPException as e:
            logger.error("Failed to update Discord message %s: %s", message_ref, e)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        location_id, message_id = self._parse_message_ref(message_ref)
        if not message_id:
            logger.error("Cannot delete message: invalid message ref %s", message_ref)
            return

        # Agent posts are authored by the channel webhook, not the bot, so the
        # bot may only remove them with Manage Messages. Delete through the
        # webhook that sent it, mirroring update_message, and keep the bot path
        # for messages the bot really did post (admin notices, DM fallbacks).
        kwargs: dict[str, Any] = {}
        if location_id and location_id != channel_id:
            kwargs["thread"] = discord.Object(id=int(location_id))
        try:
            webhook = await self._get_webhook(int(channel_id))
            await webhook.delete_message(int(message_id), **kwargs)
            return
        except discord.NotFound:
            pass
        except discord.HTTPException as e:
            logger.error("Failed to delete Discord message %s: %s", message_ref, e)
            return

        try:
            target = await self._get_channel(int(location_id or channel_id))
            await target.get_partial_message(int(message_id)).delete()
        except discord.HTTPException as e:
            logger.error("Failed to delete Discord message %s: %s", message_ref, e)

    # ── Typing ───────────────────────────────────────────────────────────────

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        if not is_typing:
            # Discord's typing indicator is a one-shot (~10s) trigger with no
            # cancel API; it simply expires.
            return
        try:
            target = await self._get_channel(int(channel_id))
            await target.typing()
        except Exception:
            logger.exception(
                "Failed to trigger typing in Discord channel %s", channel_id
            )

    # ── SDK session publication ──────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        return MAX_MESSAGE

    def rich_fallback_text(self, content: RichContent) -> str:
        """What a publication says with nothing resolved against the guild.

        The same renderers `post_rich` uses, without the mention, the
        responder's handle or the DM name prefix — each of which needs
        something looked up. This is the string that travels in a
        `RichContentFailed`, where the lookups would be decorating a message
        nobody is going to see.

        It is also drawn as if no buttons were possible, and that half is not
        cosmetic. A card whose options are carried by buttons stops listing
        them in its body; the caller forwards a failure's text as an ordinary
        message, which has no buttons under it. Reporting a refusal with the
        drawing that went on the post would ask for a choice it had stopped
        printing.
        """
        return self._draw(
            content,
            mention=None,
            responder=None,
            prefix="",
            controls=False,
            stopping=False,
        ).text

    def _draw(
        self,
        content: RichContent,
        *,
        mention: str | None,
        responder: str | None,
        prefix: str,
        controls: bool,
        stopping: bool,
    ) -> Drawn:
        escape = self._rich_escape
        limit = max(1, self.rich_fallback_limit() - len(prefix))
        markup = self.rich_markup()
        if isinstance(content, TurnActivity):
            # Charged to the same budget as the status it follows: a message
            # that just fits, plus a line saying it reached nobody, is a
            # message Discord refuses. The note under a queued turn's stop
            # control is charged the same way, and for the same reason.
            lines = []
            if stopping and content.turn.status == "queued":
                lines.append(INTERRUPT_QUEUED_NOTE)
            if content.notify_unreachable:
                lines.append(self.unnotified_notice())
            tail = "".join(f"\n{line}" for line in lines)
            body = (
                turn_status(
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
                + tail
            )
            return Drawn(text=f"{prefix}{body}", answerable=False)
        # The mention goes on its own line rather than in front of the heading:
        # a card is a block, and a handle wedged before "**Permission needed**"
        # reads as part of the heading.
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
            control_label_limit=_MAX_BUTTON_LABEL if controls else None,
        )
        return replace(drawn, text=f"{prefix}{lead}{drawn.text}{tail}")

    def _render_rich(
        self, content: RichContent, *, prefix: str, controls: bool
    ) -> tuple[str, discord.ui.View | None]:
        """Draw `content` for one place on Discord, with the buttons it earns.

        `prefix` is the inlined agent name a DM needs and a guild channel does
        not: a webhook message carries its sender's name and face, and a bot
        post in a DM carries the bot's, so there the name goes in the body the
        way `send_message` puts it there, charged to the same 2,000 characters
        as everything else.

        `controls` is whether buttons are possible where this is going at all —
        false for a channel whose publication webhook this application does not
        own, since Discord drops components from one it does not. Whether this
        particular drawing gets any is decided below.
        """
        responder = (
            self._mention(content.responder_external_id)
            if isinstance(content, RequestCard)
            else None
        )
        offered = self._offered(content) if controls else []
        stopping = self._interrupt_turn(content) if controls else None
        drawn = self._draw(
            content,
            mention=self._mention(content.notify_external_id),
            responder=responder,
            prefix=prefix,
            controls=bool(offered),
            stopping=stopping is not None,
        )
        return drawn.text, self._controls(
            content, drawn, offered, stopping, controls=controls
        )

    def _offered(self, content: RichContent) -> list[Control]:
        """The options this card would put on buttons, before it is drawn.

        Asked first because the answer changes the body: an option a button
        says in full is one the body stops repeating, and a card with no
        buttons has to print them all. A card with more options than Discord's
        five-by-five grid holds gets none of them rather than the first
        twenty-five, since a reader offered some of the choices would take the
        absence of the rest for the whole list.
        """
        if not isinstance(content, RequestCard) or self._on_interaction is None:
            return []
        offered = offered_controls(content.request)
        if len(offered) > _MAX_BUTTONS:
            logger.warning(
                "Request %s offers %d options, more than the %d Discord will "
                "show as buttons, so its card is answerable by typing only.",
                content.request.request_id,
                len(offered),
                _MAX_BUTTONS,
            )
            return []
        return offered

    def _interrupt_turn(self, content: RichContent) -> str | None:
        """The turn a stop control on this drawing would end, or None for none.

        Three things have to be true. There has to be something to stop, which
        the publication decides and puts in the content — one value for the
        whole session, so a queued turn's message offers to stop the running
        turn in front of it. The turn this message is about has to be unfinished,
        because a status kept as the record of a turn that ended is not a place
        to offer stopping anything. And a press has to have somewhere to land.

        The last check is the length, and it is the reason this returns the id
        rather than a flag: Discord allows a hundred characters in a component
        id, a provider chooses how long its turn ids are, and a button whose
        press Discord would refuse to carry is worse than no button, because
        `!interrupt` is still there and a reader who can see a control does not
        type one.
        """
        if not isinstance(content, TurnActivity) or self._on_interaction is None:
            return None
        turn_id = content.interrupt_turn_id
        if turn_id is None or content.turn.status in TURN_ENDED:
            return None
        written = len(_interrupt_id(turn_id))
        if written > _MAX_CUSTOM_ID:
            logger.warning(
                "Not offering the stop control on Discord for turn %s: its "
                "press would carry %d characters and Discord allows %d. The "
                "typed command still stops it.",
                turn_id[:64],
                written,
                _MAX_CUSTOM_ID,
            )
            return None
        return turn_id

    def _controls(
        self,
        content: RichContent,
        drawn: Drawn,
        offered: list[Control],
        stopping: str | None,
        *,
        controls: bool,
    ) -> discord.ui.View | None:
        """The card's options as buttons, or nothing where a press cannot land.

        Nothing at all is the ordinary answer: a status has no options, a
        settled card has none left, and a card that cannot be answered where it
        is showing says so — a live control under that sentence is an
        invitation to the refusal it just explained. Since every redraw builds
        this again, the buttons come off a card at the moment it stops being
        pressable, without anything having to remember that it once had them.

        Whether the drawing earned them comes from `drawn`, not from reading
        the request a second time. A long detail or a clipped option leaves a
        body the reader cannot decide from, and only the renderer that cut it
        knows that. A press would still resolve against the saved form and
        settle the request — so the whole of the protection is not offering the
        button.

        A truncated *label* is not that case. `_MAX_BUTTON_LABEL` is what the
        renderer was given too, so an option the button says in full is one the
        body left to it and an option the button had to cut is one the body
        kept whole.

        The view is stopped before it is returned. Nothing here waits on
        discord.py's own dispatch — a press arrives as a gateway interaction
        and is resolved against the stored card, which is what makes it survive
        a restart — and an unstopped view is filed in the client's view store
        for the life of the process, one per card ever posted.
        """
        if isinstance(content, TurnActivity):
            return self._activity_control(content, stopping) if controls else None
        if not isinstance(content, RequestCard) or not offered or not drawn.answerable:
            return None
        view = discord.ui.View(timeout=None)
        for control in offered:
            custom_id = _custom_id(content.reference.token, control.position)
            if len(custom_id) > _MAX_CUSTOM_ID:
                raise RichContentFailed(
                    f"Cannot put a button on request {content.request.request_id} "
                    f"in Discord: its press would carry {len(custom_id)} "
                    f"characters and Discord allows {_MAX_CUSTOM_ID}.",
                    text=self.rich_fallback_text(content),
                )
            view.add_item(
                discord.ui.Button(
                    label=_button_label(control),
                    custom_id=custom_id,
                    style=discord.ButtonStyle.secondary,
                )
            )
        view.stop()
        return view

    def _activity_control(
        self, content: TurnActivity, stopping: str | None
    ) -> discord.ui.View | None:
        """What a status message offers: the way into its tool log, and the
        way to end what it is describing.

        Discord's status is three lines: where the turn got to, what it is
        doing, and how the calls went. Slack posts the calls themselves into
        the channel beside it; here they are a press away and private to
        whoever presses, which is a placement decision rather than an access
        one — the same list, read by one person instead of by a channel.

        The two are offered on their own terms, because they are answered by
        different halves of the bridge and either half can be missing. Reading
        the log needs a publisher that knows which turn a message is showing;
        stopping needs an inbound path a press can be handed to. An adapter
        running without one of them — a demo, a test, a bridge whose sessions
        are not published — would be drawing a button onto a question nobody
        can answer.

        The attention slot gets both. It is one sentence saying somebody has to
        act, drawn from no items of its own, and the first thing a reader of it
        wants is what the session was doing when it went wrong — so it is the
        message that needs the log most, not the one to keep it off. Stop is
        there for the reason it is anywhere: a session that needs attention is
        often a session somebody wants to stop, and the control's presence is
        settled across platforms by whether there is a turn to end rather than
        by what each one puts beside it.

        Every redraw builds this again, so the buttons come off at the moment
        they stop being pressable and the stop control re-points itself when a
        queued turn becomes the running one, without anything having to
        remember what the message last carried.
        """
        view = discord.ui.View(timeout=None)
        if self._resolve_activity is not None:
            view.add_item(
                discord.ui.Button(
                    label=_ACTIVITY_LABEL,
                    custom_id=_ACTIVITY_VIEW_ID,
                    style=discord.ButtonStyle.secondary,
                )
            )
        if stopping is not None:
            view.add_item(
                discord.ui.Button(
                    label=INTERRUPT_LABEL,
                    custom_id=_interrupt_id(stopping),
                    style=discord.ButtonStyle.danger,
                )
            )
        view.stop()
        return view if view.children else None

    def _mention(self, external_user_id: str | None) -> str | None:
        """`<@id>` for a Discord user id, or None where there is nothing to name.

        No lookup, unlike the platforms whose mention syntax needs a handle:
        Discord resolves the id itself at render time, so this costs no call
        and cannot fail for a user this process has never seen.
        """
        if not external_user_id:
            return None
        try:
            return f"<@{int(external_user_id)}>"
        except ValueError:
            logger.warning(
                "Cannot mention %r on Discord: it is not a user id.",
                external_user_id[:64],
            )
            return None

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a turn's status or a request's card, as the agent itself.

        Raises on every failure, unlike `send_message`, which reports one by
        returning `None`: a publication that silently did not happen is a
        reservation nothing retries and a turn the channel never sees. What it
        raises is the point — `RichContentFailed` is the caller's licence to
        discard the reservation and try again, so it is reserved for a refusal
        Discord actually gave. A send whose outcome nobody knows raises the
        transport's own error and keeps the reservation.

        A `thread_root_id` is where the content belongs, and this never
        substitutes the parent channel for it. Where no thread exists and none
        can be made, `ThreadUnavailable` says so and the caller decides: the
        channel root is the same audience as a turn addressed to the channel
        root, and a different one from a thread that has been deleted, and
        nothing Discord can be asked distinguishes the two.

        Where a thread exists and Discord will not let us into it, that is
        refused outright. The thread may be private, and a request carries the
        agent's question and its options — posting it to the parent would hand
        the contents of a conversation to people who were not in it. A question
        nobody can see is bad; a question the wrong people can see is worse,
        and unlike the first it cannot be undone.

        Pass `thread_root_id=None` to post at the channel root deliberately.
        """
        fallback = self.rich_fallback_text(content)
        try:
            target = await self._get_channel(int(channel_id))
        except Exception as error:
            raise self._rich_failure(
                error,
                f"Discord could not resolve channel {channel_id}",
                fallback,
            ) from error

        lobby = self._channel_type_of(target) == "lobby"
        prefix = f"**{await self.agent_label_for_body(agent_name)}**: " if lobby else ""
        if lobby:
            # A DM card is the bot's own message, and a bot may always put
            # components on one — there is no webhook here to own or not own.
            text, view = self._render_rich(content, prefix=prefix, controls=True)
            kwargs: dict[str, Any] = {} if view is None else {"view": view}
            try:
                sent = await target.send(
                    text,
                    suppress_embeds=True,
                    allowed_mentions=_NO_MASS_MENTIONS,
                    **kwargs,
                )
            except Exception as error:
                raise self._rich_failure(
                    error, f"Discord refused the post in DM {channel_id}", fallback
                ) from error
            return f"{sent.channel.id}:{sent.id}"

        try:
            webhook = await self._publication_webhook(int(channel_id))
        except Exception as error:
            raise self._rich_failure(
                error,
                f"Discord could not resolve the publication webhook for channel "
                f"{channel_id}",
                fallback,
            ) from error
        text, view = self._render_rich(
            content, prefix=prefix, controls=self._offers_buttons(int(channel_id))
        )

        thread: Any = None
        if thread_root_id:
            thread = await self._publication_thread(
                int(channel_id), thread_root_id, fallback
            )

        try:
            agent = await self.agent_rendering(agent_name)
            payload: dict[str, Any] = {
                "content": text,
                "avatar_url": agent.icon_url,
                "suppress_embeds": True,
                "allowed_mentions": _NO_MASS_MENTIONS,
                "wait": True,
            }
            if thread is not None:
                payload["thread"] = thread
            if view is not None:
                payload["view"] = view
            sent = await _WebhookIdentity(agent.field_label, agent_name).send(
                webhook, payload
            )
        except Exception as error:
            raise self._rich_failure(
                error, f"Discord refused the post in channel {channel_id}", fallback
            ) from error
        return f"{sent.channel.id}:{sent.id}"

    async def _publication_thread(
        self, channel_id: int, thread_root_id: str, fallback: str
    ) -> Any:
        """The thread this publication goes in. Never the channel instead.

        `ThreadUnavailable` when no thread exists under the root message and
        one could not be made, which reads the same from here whether the
        thread was never created or was created privately and deleted. Only the
        caller can tell those apart, from where the command was addressed, and
        only the caller may decide that the parent channel will do.

        Every other failure raises as itself. A thread that exists and will not
        open may be private, and the difference between "in a thread" and "in
        the channel" is then the difference between a conversation and an
        audience.
        """
        existing = await self._reachable_thread(channel_id, thread_root_id, fallback)
        if existing is not None:
            return existing
        try:
            return await self._ensure_thread(channel_id, thread_root_id)
        except Exception as error:
            # The create may have been refused because the thread is already
            # there — the one failure that means the opposite of what it looks
            # like. Ask again before reporting that there is none.
            settled = await self._reachable_thread(channel_id, thread_root_id, fallback)
            if settled is not None:
                return settled
            raise ThreadUnavailable(
                f"Discord has no thread under {thread_root_id} in channel "
                f"{channel_id} and would not make one: {error}",
                text=fallback,
            ) from error

    async def _reachable_thread(
        self, channel_id: int, thread_root_id: str, fallback: str
    ) -> Any:
        """The thread already hanging from this message, if there is one.

        `None` means Discord said there is none: a message with no thread under
        it answers a channel fetch with "unknown channel", because a Discord
        thread is a channel whose id is the message's own. Anything else it
        says is not that answer, and is refused rather than read as absence —
        "there is no thread here" and "this thread is not yours" must not be
        confused, because the first invites posting in the channel instead and
        the second is how a private conversation becomes a public one.

        Refusing is safe for the caller's reservation in a way a failed send is
        not: nothing has been posted at this point, so there is no message
        anywhere that a retry could duplicate.
        """
        thread_id = self._thread_channel_id(thread_root_id)
        if thread_id is None:
            return None
        client = self._require_client()
        cached = client.get_channel(thread_id)
        if cached is not None:
            return cached
        try:
            return await client.fetch_channel(thread_id)
        except discord.NotFound:
            return None
        except Exception as error:
            raise RichContentFailed(
                f"Discord will not say what is under {thread_root_id} in channel "
                f"{channel_id}, so this publication has nowhere it is known to "
                f"belong. The channel is not a substitute: a thread this bridge "
                f"cannot open may be one the channel cannot read either. {error}",
                text=fallback,
            ) from error

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a publication in place, including the last time.

        A status is never taken down. A turn that has ended is edited to its
        final state and stays where it was published — in a thread, at the
        channel root or in a DM alike — as the record that the turn ran, how
        long it took and where to open it. Deleting it at the channel root left
        a reader scrolling back with none of that. An answered request card is
        the one thing that does come down, through `remove_publication`: it
        offers buttons nobody may press again, and what it decided is in the
        session rather than in the card.

        Not `update_message`, which logs and returns. That is right for a
        status line nobody is waiting on and wrong here: a card that failed to
        redraw is still showing a settled request as open, and the caller has a
        reply to post about that — but only if it is told.

        `agent_name` is what a DM redraw writes back into the body. A webhook
        message keeps its sender through an edit because Discord keeps it; a DM
        has no webhook, so the name is part of the message and an edit that
        forgot it would publish the turn as the bot.
        """
        _, message_id = self._parse_message_ref(message_ref)
        if not message_id:
            raise RichContentFailed(
                f"Cannot redraw Discord publication {message_ref!r}: it is not a "
                "location:message reference.",
                text=self.rich_fallback_text(content),
            )
        try:
            target = await self._get_channel(int(channel_id))
        except Exception as error:
            raise self._rich_failure(
                error,
                f"Discord could not resolve channel {channel_id}",
                self.rich_fallback_text(content),
            ) from error

        lobby = self._channel_type_of(target) == "lobby"
        prefix = f"**{await self.agent_label_for_body(agent_name)}**: " if lobby else ""
        if lobby:
            controls = True
        else:
            try:
                await self._publication_webhook(int(channel_id))
            except Exception as error:
                raise self._rich_failure(
                    error,
                    f"Discord could not resolve the publication webhook for "
                    f"channel {channel_id}",
                    self.rich_fallback_text(content),
                ) from error
            controls = self._offers_buttons(int(channel_id))
        # A post notifies; an edit does not. Repeating the mention on every
        # redraw would be a handle in the channel that never reaches anybody
        # it has not already reached.
        text, view = self._render_rich(
            replace(content, notify_external_id=None), prefix=prefix, controls=controls
        )
        await self._edit_rich(
            channel_id,
            message_ref,
            text,
            view,
            lobby=lobby,
            fallback=self.rich_fallback_text(content),
        )

    async def _edit_rich(
        self,
        channel_id: str,
        message_ref: str,
        text: str,
        view: discord.ui.View | None,
        *,
        lobby: bool,
        fallback: str,
    ) -> None:
        """Redraw a publication, including the buttons it does or does not keep.

        `view` is passed on every edit rather than only when there is one,
        because leaving it out leaves the components alone: a settled card
        would keep the buttons it was posted with and go on inviting a press
        that can no longer land. `None` is what takes them off.

        `fallback` is what a refused edit is reported with, in place of `text`:
        the drawing that was going on the message assumes the buttons beside
        it, and a failure notice carries none.
        """
        location_id, message_id = self._parse_message_ref(message_ref)
        try:
            if lobby:
                target = await self._get_channel(int(location_id or channel_id))
                message = await target.fetch_message(int(message_id))
                await message.edit(
                    content=text, view=view, allowed_mentions=_NO_MASS_MENTIONS
                )
                return
            kwargs: dict[str, Any] = {}
            if location_id and location_id != channel_id:
                kwargs["thread"] = discord.Object(id=int(location_id))
            webhook = await self._publication_webhook(int(channel_id))
            await webhook.edit_message(
                int(message_id),
                content=text,
                view=view,
                allowed_mentions=_NO_MASS_MENTIONS,
                **kwargs,
            )
        except Exception as error:
            raise self._rich_failure(
                error,
                f"Discord refused the edit to {message_ref} in channel {channel_id}",
                fallback,
            ) from error

    def _rich_failure(self, error: Exception, description: str, text: str) -> Exception:
        """The exception to raise for `error`: Discord's refusal, or its own.

        Raising the original back is what keeps an uncertain send's reservation
        alive, so this returns rather than raises — the caller writes
        `raise ... from error` and the chain stays intact either way.
        """
        return _as_rich_failure(error, description=description, text=text) or error

    @staticmethod
    def _removal_failure(error: Exception, description: str) -> Exception:
        """What a failed deletion should be reported as.

        Only a wait survives as itself. Everything else — a refusal, a server
        error, a request that never came back — becomes `RemovalFailed`,
        because the caller does the same thing with all three: keep the settled
        card, record nothing, and ask again later. The uncertainty an
        uncertain *send* has to preserve does not arise here, since asking
        again about a deletion that did land is answered with "already gone".
        """
        classified = _as_rich_failure(error, description=description, text="")
        if isinstance(classified, RichContentThrottled):
            return classified
        return RemovalFailed(f"{description}: {error}")

    async def remove_publication(self, channel_id: str, message_ref: str) -> None:
        """Take an answered card out of the channel, or say why it is still there.

        Only the message being absent is success, and only the routes that
        answer about the message may establish it. Finding the channel, and
        finding the webhook that posted the card, are both steps before the
        deletion; a 404 from either is about the step, not about the card.
        """
        if self._require_connection().client_or_none is None:
            raise RemovalFailed("Discord client not connected.")

        location_id, message_id = self._parse_message_ref(message_ref)
        if not location_id.isdigit() or not message_id.isdigit():
            raise RemovalFailed(
                f"Not a Discord location:message reference: {message_ref}."
            )

        description = f"Discord would not delete {message_ref} in channel {channel_id}"
        try:
            target = await self._get_channel(int(channel_id))
            lobby = self._channel_type_of(target) == "lobby"
        except Exception as error:
            raise self._removal_failure(error, description) from error

        if lobby:
            await self._remove_own_message(
                int(location_id), int(message_id), message_ref, description
            )
            return

        try:
            # The publication webhook, not the agents' one: a webhook may
            # delete only what it sent, and this is what sent the card. A
            # webhook that cannot be resolved is not a card that is gone, so
            # this is outside the deletion's own error handling.
            webhook = await self._publication_webhook(int(channel_id))
        except Exception as error:
            raise self._removal_failure(error, description) from error

        kwargs: dict[str, Any] = {}
        if location_id != channel_id:
            kwargs["thread"] = discord.Object(id=int(location_id))
        try:
            await webhook.delete_message(int(message_id), **kwargs)
        except discord.NotFound as error:
            if error.code != _UNKNOWN_MESSAGE_CODE:
                # "Unknown Webhook", most often: this webhook is not there any
                # more, which is a fact about the webhook and none about the
                # card.
                raise self._removal_failure(error, description) from error
            await self._confirm_card_gone(
                int(location_id), int(message_id), message_ref, error
            )
        except Exception as error:
            raise self._removal_failure(error, description) from error

    async def _remove_own_message(
        self, location_id: int, message_id: int, message_ref: str, description: str
    ) -> None:
        """Delete a DM card, which the bot posted as itself.

        No webhook is involved, so the deletion goes through the channel — the
        route that answers about the message — and a 404 from it is the card's
        absence and nothing else.
        """
        try:
            location = await self._get_channel(location_id)
        except Exception as error:
            raise self._removal_failure(error, description) from error
        try:
            await location.get_partial_message(message_id).delete()
        except discord.NotFound as error:
            self._say_already_gone(message_ref, error)
        except Exception as error:
            raise self._removal_failure(error, description) from error

    async def _confirm_card_gone(
        self, location_id: int, message_id: int, message_ref: str, error: Exception
    ) -> None:
        """Ask the channel whether the card is really gone.

        A webhook answers "Unknown Message" for a message that is not there
        *and* for one it did not send, and it cannot tell them apart. That
        second reading is not hypothetical: the publication webhook is looked
        up by name and created when no match is found, so a webhook deleted in
        the channel's settings is replaced by one that never sent any of the
        cards already posted. Taking its 404 at face value would retire every
        one of them while they stayed on the screen.

        The channel route answers about the message, so it is the one that can
        settle it.

        Classified like any other failed removal, so a channel read that is
        throttled still arrives as a wait. Discord rate-limits per route, and
        this route is reached only after the webhook route has already
        answered: a 429 here is the likeliest one on the whole path, and the
        delay it carries is the only thing that makes the retry useful.
        """
        try:
            location = await self._get_channel(location_id)
            await location.fetch_message(message_id)
        except discord.NotFound:
            self._say_already_gone(message_ref, error)
            return
        except Exception as failure:
            raise self._removal_failure(
                failure,
                f"Discord said the webhook does not know message {message_ref}, "
                f"and reading the channel to find out whether the card is still "
                f"there did not work either",
            ) from failure
        raise RemovalFailed(
            f"Discord card {message_ref} is still in the channel: the "
            f"publication webhook did not send it and so cannot delete it."
        )

    @staticmethod
    def _say_already_gone(message_ref: str, error: Exception) -> None:
        # Nothing at the address, which is what was asked for. Worth a line
        # because the innocent reading — someone deleted the card by hand, or
        # an acknowledgement we never saw was real — is not the only one.
        logger.warning(
            "Discord card %s was already gone when it was taken back: %s",
            message_ref,
            error,
        )

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        """Look for a card this bridge may already have posted.

        Asked when a post's outcome is unknown — the request timed out, or the
        process died between sending and recording the id. The answer decides
        between binding the reservation to what is there and asking the same
        question twice, so a lookup that cannot be trusted comes back as
        `None`: the reservation survives and the question is asked again later.

        Two things have to hold, and neither is enough alone. The message must
        have been posted by the publication webhook, which nothing but a status
        or a card is ever sent through, so an agent's own words can never be
        mistaken for one however closely they read like it — a reply beginning
        "I can explain the request `R7` syntax" arrives on the webhook agents
        speak through, and is not a candidate here at all. And it must carry a
        card's heading line for this handle, which is what picks this card out
        from the other publications beside it.

        The heading is looked for line by line rather than at the top, because
        the top of a card is the mention that notifies whoever asked, and in a
        DM it is the agent's name as well.

        A DM has no webhooks, so there the bot is the author and the heading
        test is carrying the weight on its own. See `_is_publication`.

        `handle` is `None` for a turn's activity, which prints no handle and so
        cannot be found this way. That publication stays unconfirmed rather
        than being posted twice — see the warning below, and D14.
        """
        if handle is None:
            logger.warning(
                "Cannot look for the Discord publication marked %s in channel %s: "
                "a webhook message carries no metadata here, so only a request "
                "card, which prints its own handle, can be recognised again. This "
                "turn's status stays unconfirmed rather than being posted twice.",
                token,
                channel_id,
            )
            return None
        client = self._require_connection().client_or_none
        if client is None:
            logger.warning(
                "Cannot look for card %s in Discord channel %s: not connected.",
                handle,
                channel_id,
            )
            return None

        stamped = created_at if created_at.tzinfo else created_at.replace(tzinfo=UTC)
        after = stamped - _RECOVERY_SKEW
        wanted = f"· request `{self._rich_escape(handle)}`"
        for place in await self._recovery_places(channel_id, thread_root_id):
            author = await self._publication_author(place)
            if author is None:
                continue
            try:
                async for message in place.history(
                    after=after, limit=_RECOVERY_LIMIT, oldest_first=True
                ):
                    if not self._is_publication(message, author):
                        continue
                    if self._heads_a_card(message.content or "", wanted):
                        return f"{message.channel.id}:{message.id}"
            except Exception as e:
                logger.warning(
                    "Could not read Discord channel %s looking for card %s: %s.",
                    place.id,
                    handle,
                    e,
                )
        return None

    @staticmethod
    def _heads_a_card(content: str, wanted: str) -> bool:
        """Whether this text carries a card's heading line for one handle.

        A heading is a whole line, bold from its first character and ending in
        the handle it answers to. Requiring both ends of the line means a
        sentence that happens to quote the handle is not enough, and requiring
        a line rather than the start of the message means the mention above it
        does not hide it.
        """
        return any(
            line.startswith("**") and line.endswith(wanted)
            for line in content.split("\n")
        )

    async def _recovery_places(
        self, channel_id: str, thread_root_id: str | None
    ) -> list[Any]:
        """Where a card posted for this channel and thread could have landed.

        Both, in order, because `post_rich` falls back to the channel root when
        a thread cannot be resolved — so a card whose outcome is unknown may be
        in either. The thread is only looked up, never created: creating one
        here would be answering "where is it?" by making a new empty place it
        certainly is not in.
        """
        places: list[Any] = []
        if thread_root_id:
            thread_id = self._thread_channel_id(thread_root_id)
            if thread_id is not None:
                try:
                    places.append(await self._get_channel(thread_id))
                except Exception as e:
                    logger.warning(
                        "Could not open the Discord thread under %s: %s.",
                        thread_root_id,
                        e,
                    )
        try:
            places.append(await self._get_channel(int(channel_id)))
        except Exception as e:
            logger.warning("Could not open Discord channel %s: %s.", channel_id, e)
        return places

    async def _publication_author(self, place: Any) -> int | None:
        """Who a publication in `place` would have been posted by.

        The publication webhook's id in a guild, the bot's own id in a DM,
        where there are no webhooks to have. `None` means the question cannot
        be answered here, and a search that cannot say who wrote a message has
        no business adopting one — better an unbound reservation than a
        reservation bound to somebody else's sentence.

        Resolved rather than read off the cache. After a restart nothing has
        posted to this channel yet, so the cache is empty and every message in
        it would look like a stranger's.
        """
        parent = getattr(place, "parent", None) or place
        if self._channel_type_of(parent) == "lobby":
            return self._require_connection().bot_user_id or None
        try:
            return (await self._publication_webhook(parent.id)).id
        except Exception as e:
            logger.warning(
                "Could not resolve the Discord publication webhook for channel "
                "%s, so nothing there can be told from anybody else's message: "
                "%s.",
                parent.id,
                e,
            )
            return None

    @staticmethod
    def _is_publication(message: Any, author: int) -> bool:
        """Whether this message came from the sender publications come from.

        A guild message says so exactly: `webhook_id` is set by Discord, not by
        anything that wrote the content, and only publications go through that
        webhook. A DM message can only say that the bot sent it — the bot also
        relays the agent's ordinary replies there, so in a DM this narrows the
        field rather than settling it, and the caller's heading-line test is
        what settles it. Recorded in D18 as the weaker of the two.
        """
        webhook_id = getattr(message, "webhook_id", None)
        if webhook_id is not None:
            return bool(webhook_id == author)
        return bool(getattr(getattr(message, "author", None), "id", None) == author)

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        """Whether this message is the first thing said inside a thread.

        A Discord thread is a channel whose id is the id of the message it was
        created from, and the root message itself lives in the parent channel —
        so the thread's first message is the first reply, with nothing to skip
        over. Read from Discord each time rather than counted here: two replies
        arriving at once would both look like the first to anything counting
        locally, and each would decide the request.

        Never raises. This is on the inbound path of every message, ahead of
        the relay, so an exception out of it is not a refused answer but a
        message the room never sees.
        """
        thread_id = self._thread_channel_id(root_ref)
        if thread_id is None or self._require_connection().client_or_none is None:
            logger.warning(
                "Cannot read the Discord thread under %s in %s, so %s does not "
                "answer the card there.",
                root_ref,
                channel_id,
                message_ref,
            )
            return False
        try:
            thread = await self._get_channel(thread_id)
            async for message in thread.history(limit=1, oldest_first=True):
                return f"{message.channel.id}:{message.id}" == message_ref
        except Exception as e:
            logger.warning(
                "Could not read the Discord thread under %s in %s: %s. Treating "
                "%s as not the first reply.",
                root_ref,
                channel_id,
                e,
                message_ref,
            )
        return False

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
        """Put a mark on the message being worked on, or take it off.

        One mark between every agent, because every agent posts through one
        bot application here and a reaction belongs to whoever added it. The
        publisher already counts the turns holding it, so the first to want it
        adds it and the last to finish removes it.

        `force` is the durable publisher reconciling after a restart, when this
        process's record of what is already on the message is empty and wrong
        rather than empty and right.

        Raises where another attempt might work, so the publisher retries and
        records the turn as drawn only once the channel shows what it says it
        shows. A missing permission is not that: it would be retried for the
        life of the turn and refused every time, so it is reported once and
        the turn goes on without the mark.
        """
        _, message_id = self._parse_message_ref(message_ref)
        if not message_id:
            logger.warning(
                "Cannot mark %s: not a Discord message reference.",
                message_ref,
            )
            return
        if not force and on == ((message_ref, mark) in self._marked):
            return
        await self._react(message_ref, mark=mark, on=on)

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """The one-shot typing nudge, where the agent was asked.

        Discord expires it after about ten seconds, so it costs the channel
        nothing and it is the only signal that arrives before the first post.
        Sent into a thread only if that thread already exists: a typing
        indicator is not worth creating a thread for, and one created here
        would be an empty thread on a message somebody may never get a reply in.
        """
        target: Any = None
        if thread_root_id:
            thread_id = self._thread_channel_id(thread_root_id)
            client = self._require_connection().client_or_none
            if thread_id is not None and client is not None:
                target = client.get_channel(thread_id)
        if target is None:
            try:
                target = await self._get_channel(int(channel_id))
            except Exception as e:
                logger.warning(
                    "Could not open Discord channel %s to signal that %s has "
                    "started: %s.",
                    channel_id,
                    agent_name,
                    e,
                )
                return
        try:
            await target.typing()
        except Exception as e:
            logger.warning(
                "Could not signal in Discord channel %s that %s has started: %s.",
                channel_id,
                agent_name,
                e,
            )

    @staticmethod
    def _thread_channel_id(thread_root_ref: str) -> int | None:
        """The id of the thread rooted at this message ref.

        A Discord thread is a channel whose id equals the id of the message it
        was created from, so the ref's message half is the thread's id —
        whether or not the thread has been created yet.
        """
        try:
            return int(thread_root_ref.split(":", 1)[-1])
        except ValueError:
            return None

    async def _react(self, message_ref: str, *, mark: ActivityMark, on: bool) -> None:
        """Add or remove a mark, letting through whatever another attempt might fix.

        Two endings are final rather than worth retrying: the message is gone,
        or this guild will never allow the reaction. Everything else is left to
        raise, so a caller that can try again knows it should.

        A missing permission is final *here* — the same call would be refused
        the same way — so it is raised as `ActivityMarkRefused` rather than
        swallowed. It is not final for the turn: access to a channel can come
        back, and a mark that could not be *removed* is still on the message
        saying an agent is working on something it finished. That is not an
        absence but a false statement, and whether it is outstanding is a
        question about what was put there, which the publisher's durable record
        answers and this method cannot.
        """
        location_id, message_id = self._parse_message_ref(message_ref)
        client = self._require_client()
        key = (message_ref, mark)
        try:
            channel = await self._get_channel(int(location_id))
            message = channel.get_partial_message(int(message_id))
            if on:
                await message.add_reaction(_REACTION[mark])
                self._marked.add(key)
            else:
                await message.remove_reaction(_REACTION[mark], client.user)
                self._marked.discard(key)
        except discord.NotFound:
            # The message (or the reaction) is gone; the end state is what was
            # wanted either way.
            self._marked.discard(key)
        except discord.Forbidden as error:
            if on:
                raise ActivityMarkRefused(
                    f"Discord refused the {mark} reaction on {message_ref} — the "
                    f"bot is missing the Add Reactions permission here. Turns still "
                    f"show their status message; only the mark on the message being "
                    f"answered is missing. Re-invite the bot with the permissions "
                    f"in DISCORD_SETUP.md."
                ) from error
            raise ActivityMarkRefused(
                f"Discord refused to take the {mark} reaction off {message_ref}. "
                f"Removing our own reaction needs no permission of its own, so this "
                f"is the bot's access to the channel rather than the reaction: check "
                f"it can still see {message_ref}."
            ) from error

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        if channel_type in ("group", "direct"):
            raise ValueError(
                f"Cannot create {channel_type} channels — they are initiated from the messaging platform"
            )

        guild = await self._get_guild()
        channel = await guild.create_text_channel(
            name=self._sanitize_channel_name(name),
            topic=topic,
            overwrites=(
                self._private_channel_overwrites(guild)
                if channel_type == "channel_private"
                else {}
            ),
        )
        return str(channel.id)

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Find guild members whose username or nickname starts with `query`.

        Asks Discord to do the matching rather than pulling the member list
        and filtering here, so a large guild costs one request either way.
        Discord matches on a prefix, so this searches by prefix — unlike the
        Slack adapter, which has no server-side search and filters a full
        listing on substrings.

        Discord's bot API never exposes a member's email, so `email` is always
        absent here — which is fine, since claiming an account identifies it
        rather than proving who owns it.
        """
        term = query.strip()
        if not term:
            return []

        guild = await self._get_guild()
        try:
            members = await guild.query_members(query=term, limit=100)
        except (discord.HTTPException, discord.ClientException) as e:
            raise RuntimeError(f"Discord member search failed: {e}") from e
        except TimeoutError as e:
            # A gateway query that never comes back would otherwise hang the
            # request; surfacing it as a bridge failure gets the caller a 502.
            raise RuntimeError("Discord member search timed out") from e

        results = [
            DirectoryUser(
                external_user_id=str(member.id),
                # `member.name` is what the inbound path records as the sender,
                # so a claim made from this list matches messages that arrive.
                username=str(member.name),
                display_name=str(getattr(member, "display_name", None) or member.name),
                email=None,
            )
            for member in members
            if not getattr(member, "bot", False)
        ]
        results.sort(key=lambda u: u.display_name.lower())
        return results

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        # Discord bots can open real DMs, but DM channels have no webhooks —
        # so no per-agent identity — and DM traffic maps to the deprecated
        # "lobby" flow. Mirror Slack instead: a private channel named after
        # the pair, visible only to the bridge and the user.
        guild = await self._get_guild()
        channel = await guild.create_text_channel(
            name=self._sanitize_channel_name(f"dm-{user_name}-{agent_name}"),
            topic=f"Direct conversation between {user_name} and {agent_name}",
            overwrites=self._private_channel_overwrites(guild),
        )
        member = await self._get_member(guild, user_external_id)
        await channel.set_permissions(member, view_channel=True)
        return str(channel.id)

    @staticmethod
    def _sanitize_channel_name(name: str) -> str:
        return re.sub(r"[^a-z0-9_-]", "-", name.lower()).strip("-")[:100]

    @staticmethod
    def _private_channel_overwrites(
        guild: Any,
    ) -> dict[Any, discord.PermissionOverwrite]:
        overwrites: dict[Any, discord.PermissionOverwrite] = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False)
        }
        me = getattr(guild, "me", None)
        if me is not None:
            overwrites[me] = discord.PermissionOverwrite(view_channel=True)
        return overwrites

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        """`https://discord.com/channels/<guild>/<channel>` — Discord's
        canonical channel link; the desktop app claims it. Pure: built from
        the configured guild id, no API call needed."""
        if not external_channel_id:
            return None
        return f"https://discord.com/channels/{self._config.guild_id}/{external_channel_id}"

    async def home_deeplink(self) -> str | None:
        """`https://discord.com/channels/<guild>` — the guild's canonical link,
        which the desktop app claims, same as `channel_deeplink`."""
        if not self._config.guild_id:
            return None
        return f"https://discord.com/channels/{self._config.guild_id}"

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        target = await self._get_channel(int(channel_id))
        return self._channel_type_of(target)

    def _channel_type_of(self, channel: Any) -> ChannelType:
        """Map a Discord channel object to the bridge's ChannelType.

        DMs/group DMs have no guild → lobby (parity with Slack's im/mpim).
        A guild channel is private when @everyone's view_channel is denied
        via permission overwrites. Threads defer to their parent channel.
        """
        guild = getattr(channel, "guild", None)
        if guild is None:
            return "lobby"
        if getattr(channel, "parent_id", None) is not None:
            parent = getattr(channel, "parent", None)
            if parent is None:
                return "channel_public"
            return self._channel_type_of(parent)
        default_role = getattr(guild, "default_role", None)
        if default_role is None:
            return "channel_public"
        overwrite = channel.overwrites_for(default_role)
        if overwrite.view_channel is False:
            return "channel_private"
        return "channel_public"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        pass

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        channel = await self._get_channel(int(channel_id))
        if self._channel_type_of(channel) != "channel_private":
            # Public guild channels are visible to every member — there is no
            # per-channel membership to grant.
            return []
        guild = channel.guild
        failed: list[str] = []
        for user_name, user_id in zip(user_names, user_external_ids):
            try:
                member = await self._get_member(guild, user_id)
                await channel.set_permissions(member, view_channel=True)
            except (discord.HTTPException, ValueError) as e:
                logger.error(
                    "Failed to grant Discord user %s (%s) access to channel %s: %s",
                    user_name,
                    user_id,
                    channel_id,
                    e,
                )
                failed.append(user_id)
        return failed

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None:
        """Give the agent a mentionable guild role so its name completes on `@`.

        Discord only autocompletes things it knows about, and an agent is not a
        Discord member — one bot serves all of them, differentiated per message
        by the webhook override. A role is the one handle a bot can mint that
        still appears in the composer's `@` menu, so each agent gets one. The
        role is left empty and carries no permissions: it exists to be
        completable and to arrive as a structured mention, and mentioning it
        notifies nobody.
        """
        if not self._agent_roles_available():
            return
        if agent_name.casefold() in self._agent_role_ids:
            return

        guild = await self._get_guild()
        # A role whose name is exactly the agent's is taken to be that agent's,
        # so a role made by hand — the only way to use this where the bot may
        # not manage roles — is adopted rather than duplicated. The match has to
        # be exact: a server's own role must never be captured by an agent that
        # happens to be named similarly.
        existing = discord.utils.get(guild.roles, name=agent_name)
        if existing is not None:
            self._agent_role_ids[agent_name.casefold()] = existing.id
            logger.info(
                "Adopted existing Discord role %s for agent %s", existing.id, agent_name
            )
            return

        try:
            role = await guild.create_role(
                name=agent_name,
                mentionable=True,
                hoist=False,
                permissions=discord.Permissions.none(),
                reason="Switch agent name autocomplete",
            )
        except discord.Forbidden:
            self._disable_agent_roles(
                "the bot is missing the Manage Roles permission — re-invite it "
                "with the permissions in DISCORD_SETUP.md."
            )
            return
        except discord.HTTPException as e:
            if e.code != _MAX_GUILD_ROLES_CODE:
                raise
            self._disable_agent_roles(
                "this server has reached Discord's hard limit of 250 roles — "
                "free some, or turn agent name autocomplete off for this bridge."
            )
            return

        self._agent_role_ids[agent_name.casefold()] = role.id
        logger.info("Created Discord role %s for agent %s", role.id, agent_name)

    async def remove_agent_identity(self, agent_name: str) -> None:
        """Delete the agent's role, unless people are wearing it.

        A Discord role carries no metadata, so an agent's role is recognised by
        its name alone. That is fine for mentioning — the worst case is a stale
        pill — but not for deleting: a role that happens to share an agent's
        name may be somebody's real role. One with members is therefore left
        alone and said so, since an agent's own role never has any.
        """
        if not self._agent_roles_available():
            return

        guild = await self._get_guild()
        role_id = self._agent_role_ids.pop(agent_name.casefold(), None)
        role = (
            guild.get_role(role_id)
            if role_id is not None
            else discord.utils.get(guild.roles, name=agent_name)
        )
        if role is None:
            return
        if role.members:
            logger.warning(
                "Left the Discord role %s in place: agent %s is gone but %d "
                "member(s) hold that role, so it is not ours to delete.",
                role.id,
                agent_name,
                len(role.members),
            )
            return

        try:
            await role.delete(reason="Switch agent removed")
        except discord.Forbidden:
            self._disable_agent_roles(
                "the bot is missing the Manage Roles permission — re-invite it "
                "with the permissions in DISCORD_SETUP.md."
            )
            return
        logger.info("Deleted Discord role %s for agent %s", role.id, agent_name)

    # ── Agent roles ──────────────────────────────────────────────────────────

    def _agent_roles_available(self) -> bool:
        return self._config.agent_roles and not self._agent_roles_off_reason

    def _disable_agent_roles(self, reason: str) -> None:
        """Stop attempting agent roles on this bridge, saying why, once.

        The setting is on by default, so a server that simply cannot host them
        is an ordinary situation rather than a misconfiguration — but it must
        not be a silent one, and it must not repeat the complaint for every
        agent on every startup.
        """
        if self._agent_roles_off_reason:
            return
        self._agent_roles_off_reason = reason
        logger.warning(
            "Discord agent roles are unavailable on this server: %s Agent names "
            "will not autocomplete in the Discord composer; agents remain "
            "addressable by typing their name.",
            reason,
        )

    def _guild_from_cache(self) -> Any:
        client = self._require_connection().client_or_none
        return client.get_guild(self._guild_id) if client else None

    def _role_name(self, role_id: int) -> str | None:
        guild = self._guild_from_cache()
        role = guild.get_role(role_id) if guild else None
        return getattr(role, "name", None)

    def _member_name(self, user_id: int) -> str | None:
        guild = self._guild_from_cache()
        member = guild.get_member(user_id) if guild else None
        return getattr(member, "name", None)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Translation ──────────────────────────────────────────────────────────

    def translate_outbound(self, content: str) -> str:
        # Discord renders markdown natively (bold, code, headers, masked
        # links), so only @name mentions need rewriting to real Discord
        # mentions: a resolved user, or an agent that has a role of its own so
        # it reads as the same pill a person would have picked from the `@`
        # menu. Unknown names stay plain text.
        def _replace(match: re.Match[str]) -> str:
            user_id = self._username_to_id.get(match.group(1))
            if user_id:
                return f"<@{user_id}>"
            role_id = self._agent_role_ids.get(match.group(1).casefold())
            return f"<@&{role_id}>" if role_id else match.group(0)

        return re.sub(r"@([a-z0-9][a-z0-9._-]*)", _replace, content)

    def escape_label_for_body(self, label: str) -> str:
        """Defuse Discord's markdown, mentions and `<…>` entity syntax.

        Three things a name can otherwise do to the body it is inlined into:

        - Markdown. `Bo*b` eats the bolding of the prefix it sits in, so
          discord.py's `escape_markdown` backslashes its emphasis characters.
          `ignore_links=False` because a label is a name, not prose: there is
          no URL in it worth keeping legible, and the exemption is a hole.
        - Mass and user mentions. `escape_mentions` breaks `@everyone`,
          `@here` and `<@id>` with a zero-width space after the `@`. It does
          nothing for a plain `@opsbot`, which needs no Discord syntax at all:
          `translate_outbound` resolves any handle it holds an id for into a
          real `<@id>` or `<@&role>`, and `_rich_escape` runs it over escaped
          host text. The base class's `@` rule is what closes that, which is
          why this builds on it rather than replacing it.
        - Everything else Discord resolves from `<…>` — a channel link
          (`<#id>`), a custom emoji (`<:name:id>`), a timestamp (`<t:ts:F>`),
          a slash-command link (`</cmd:id>`). `escape_mentions` covers none of
          these ("this does not include channel mentions") and backslash does
          not escape `<` on Discord, so the syntax is broken instead: a
          zero-width space goes after every `<`. Each of those forms needs its
          sigil immediately after the `<`, so this defuses all of them and
          leaves an ordinary name alone.

        Not covered: a bare URL in a display name still auto-links. Discord
        linkifies one straight out of the raw content and offers no escape for
        it, so a name that is a URL renders as a clickable link. Cosmetic
        rather than a forgery — the link goes where the name says it does."""
        return discord.utils.escape_markdown(
            discord.utils.escape_mentions(
                super()
                .escape_label_for_body(label)
                .replace("<", "<" + _ZERO_WIDTH_SPACE)
            ),
            ignore_links=False,
        )

    def translate_inbound(self, raw_message: str) -> str:
        def _replace_user(match: re.Match[str]) -> str:
            # The cache only knows people who have posted. Someone picked from
            # the `@` menu may not have, so fall back to the guild.
            user_id = int(match.group(1))
            name = self._user_names.get(user_id) or self._member_name(user_id)
            return f"@{name}" if name else match.group(0)

        def _replace_role(match: re.Match[str]) -> str:
            # An agent's role is how its name reaches the composer's `@` menu,
            # so picking it there sends `<@&123>` rather than the typed name.
            # Resolving it back to the role's name is what lets the rest of
            # Switch treat it as an ordinary mention — the addressing layer
            # matches on the name and knows nothing about Discord. A role that
            # is not an agent's still reads better as its name than as markup.
            name = self._role_name(int(match.group(1)))
            return f"@{name}" if name else match.group(0)

        def _replace_channel(match: re.Match[str]) -> str:
            client = self._require_connection().client_or_none
            channel = client.get_channel(int(match.group(1))) if client else None
            name = getattr(channel, "name", None)
            return f"#{name}" if name else match.group(0)

        message = re.sub(r"<@&(\d+)>", _replace_role, raw_message)
        message = re.sub(r"<@!?(\d+)>", _replace_user, message)
        return re.sub(r"<#(\d+)>", _replace_channel, message)

    # ── Gateway event handling ───────────────────────────────────────────────

    # Message types we treat as real posts: plain messages and replies.
    # Everything else (pins, joins, boosts, thread starters, …) is skipped.
    _ALLOWED_MESSAGE_TYPES = frozenset(
        {discord.MessageType.default, discord.MessageType.reply}
    )

    async def _handle_message(self, message: Any) -> None:
        # The connection routes each message here by guild id (or as a DM), so
        # this handler only ever sees its own guild's messages and DMs — the
        # guild filter that used to live here now lives in DiscordConnection.
        author = message.author
        bot_user_id = self._require_connection().bot_user_id
        # Drop only our own posts (loop prevention): the bot itself and the
        # bridge's webhooks. Third-party bots/webhooks are still bridged.
        if author.id == bot_user_id:
            return
        webhook_id = getattr(message, "webhook_id", None)
        if webhook_id and webhook_id in self._webhook_ids:
            return
        if message.type not in self._ALLOWED_MESSAGE_TYPES:
            return

        if message.id in self._seen_ids:
            return
        self._seen_ids[message.id] = None
        if len(self._seen_ids) > self._seen_ids_max:
            self._seen_ids.popitem(last=False)

        channel = message.channel
        # A message inside a thread is bridged into the PARENT channel's room,
        # threaded under the thread's root message (thread id == root message
        # id on Discord).
        parent_id = getattr(channel, "parent_id", None)
        root_id: str | None = None
        if parent_id is not None:
            channel_id = str(parent_id)
            root_id = f"{parent_id}:{channel.id}"
            channel_name = getattr(getattr(channel, "parent", None), "name", None)
        else:
            channel_id = str(channel.id)
            channel_name = getattr(channel, "name", None)

        username = str(author.name)
        self._user_names[author.id] = username
        self._username_to_id[username] = author.id

        content = str(message.content or "")
        channel_type = self._channel_type_of(channel)
        message_ref = f"{channel.id}:{message.id}"

        stripped = content.strip()
        if stripped.startswith("!") and self._on_command:
            parts = stripped.split(None, 1)
            # An ordinary message is translated downstream, but a command
            # branches off before that — and its arguments are exactly where a
            # mention picked from the `@` menu lands, as `<@&123>` markup the
            # dispatcher cannot match a name against.
            args = self.translate_inbound(parts[1].strip()) if len(parts) > 1 else ""
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=str(author.id),
                    sender_name=username,
                    command=parts[0].lstrip("!"),
                    args=args,
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return

        if self._on_message is None:
            return

        attachments, attachment_failures = await self._fetch_attachments(
            getattr(message, "attachments", []) or []
        )
        self_mention = (
            bool(bot_user_id) and re.search(rf"<@!?{bot_user_id}>", content) is not None
        )
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=str(author.id),
                sender_name=username,
                content=content,
                message_ref=message_ref,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=attachment_failures,
                self_mention_token=str(bot_user_id) if self_mention else None,
            )
        )

    # ── Card presses ─────────────────────────────────────────────────────────

    async def _handle_interaction(self, interaction: discord.Interaction) -> None:
        """Someone pressed a button on a card or a status this bridge posted.

        Who pressed comes from the interaction's own `user`, which Discord
        fills in and the payload cannot: the id in the button says which
        request and which option, or which turn to stop, never who. So a press
        replayed from someone else's client is still attributed to whoever
        actually sent it, and the identity check downstream is against a real
        account rather than a claim.

        Which card, and which session a stop reaches, come from the message the
        press arrived on, addressed the same way `post_rich` addressed it when
        it wrote the reference down — thread or channel, then message. That is
        what makes a press work after a restart: nothing is remembered between
        the two, and the button is read against the stored card or the journal
        entry behind the message rather than against a view still in memory.

        The press is acknowledged before any Switch work, because Discord
        allows three seconds and the authority check is not bounded by them.
        The acknowledgement changes nothing on the screen: the card's own
        redraw is what says an answer was taken, and claiming it here would be
        claiming it before the redraw that proves it. A refusal reaches the
        presser through `tell_actor`, which leaves it in `_PRESS_NOTICE` for
        the follow-up below — private to them, so a channel does not watch
        somebody be told no.

        Nothing here dedupes. The same press twice is the same option against
        the same revision, or the same turn named by the same message — which
        the shared layer derives one command id from either way, so the second
        press is the first rather than a second answer.
        """
        if interaction.type is not discord.InteractionType.component:
            return
        if interaction.guild_id is not None and interaction.guild_id != self._guild_id:
            return
        data: dict[str, Any] = dict(interaction.data or {})
        custom_id = str(data.get("custom_id") or "")
        if custom_id.split(":", 1)[0] == _ACTIVITY_PREFIX:
            await self._handle_activity(interaction, custom_id)
            return
        dispatch = _press_action(custom_id)
        if dispatch is None:
            return
        channel = interaction.channel
        message = interaction.message
        if channel is None or message is None:
            logger.warning(
                "A press on a Switch card carried no message to answer against, "
                "so there is nothing to resolve it to."
            )
            return
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch message in Discord channel %s has nowhere "
                "to go: this bridge handles no interactions, so the message "
                "should not have been drawn with buttons.",
                channel.id,
            )
            return

        try:
            await interaction.response.defer()
        except discord.HTTPException:
            logger.exception(
                "Discord would not accept the acknowledgement of a press in "
                "channel %s, so the answer is not attempted: a press that is "
                "not acknowledged in time is one the presser is told failed.",
                channel.id,
            )
            return

        action_id, value = dispatch
        user = interaction.user
        name = str(user.name)
        # A press is a sighting of that account in this channel, and the same
        # thing a message teaches: the name a mention needs, and the id a
        # handle resolves to.
        self._user_names[user.id] = name
        self._username_to_id[name] = user.id

        # A card in a thread belongs to the parent channel's room, exactly as
        # a message in that thread does — and that is the channel the card was
        # recorded against.
        parent_id = getattr(channel, "parent_id", None)
        channel_id = str(parent_id if parent_id is not None else channel.id)

        notices: list[str] = []
        held = _PRESS_NOTICE.set(notices)
        try:
            await self._on_interaction(
                InboundInteraction(
                    channel_id=channel_id,
                    sender_id=str(user.id),
                    sender_name=name,
                    action_id=action_id,
                    value=value,
                    message_ref=f"{channel.id}:{message.id}",
                )
            )
        finally:
            _PRESS_NOTICE.reset(held)
        if notices:
            await self._tell_presser(interaction, notices[0])

    async def _handle_activity(
        self, interaction: discord.Interaction, custom_id: str
    ) -> None:
        """Show one reader the tool calls behind a turn's status message.

        Two presses arrive here and they are answered differently. The one on
        the public status opens a private message that did not exist a moment
        ago, so it defers a new response; the one on that private message
        rewrites it, so it defers the update to the message it is on. Both
        acknowledge before any read, because Discord allows three seconds and
        neither the journal nor the permission check is bounded by them.

        A refresh is refused unless the message it arrived on is itself
        private. That is the guard that matters here: an update answers
        whatever message the component was attached to, so a press carrying
        this id from anywhere else would rewrite a channel's status message
        into its tool log. Read off the message Discord names rather than off
        the id, which is the half a client could have chosen.
        """
        channel = interaction.channel
        message = interaction.message
        if channel is None or message is None:
            return
        refreshing = custom_id != _ACTIVITY_VIEW_ID
        if refreshing:
            ref = _parse_refresh_id(custom_id)
            if ref is None:
                return
            if not message.flags.ephemeral:
                logger.warning(
                    "Refusing a refresh of a Switch activity view that arrived "
                    "on public message %s in channel %s: an update would "
                    "rewrite that message.",
                    message.id,
                    channel.id,
                )
                return
        else:
            ref = f"{channel.id}:{message.id}"

        try:
            if refreshing:
                await interaction.response.defer()
            else:
                await interaction.response.defer(ephemeral=True, thinking=True)
        except discord.HTTPException:
            logger.exception(
                "Discord would not accept the acknowledgement of a press for "
                "activity in channel %s, so nothing is shown: a press that is "
                "not acknowledged in time is one the presser is told failed.",
                channel.id,
            )
            return
        await self._show_activity(interaction, ref)

    async def _show_activity(self, interaction: discord.Interaction, ref: str) -> None:
        """Read the turn behind `ref` and put it in front of this reader alone.

        The reader is authorised against the conversation `ref` names, never
        against the one the press arrived from. Only the initial view has those
        two the same; a refresh carries an address, and an address the presser
        supplied is authorised as though it had been typed — otherwise a
        reference to a private thread, pressed from a public one beside it,
        would be read with the public thread's permissions.

        Made again on every press, not once. A private message stays on the
        screen after the reader has lost the conversation it came from, and a
        refresh is a fresh read rather than the continuation of an older one.

        Everything that can go wrong is said rather than left silent. A button
        that answers with nothing reads as Discord having dropped the press,
        and the reader would go on pressing it.

        Said as what it is, too. Only a reference that names no conversation,
        and a conversation Discord answers 404 for, are gone; a bridge that
        cannot reach the log, or cannot resolve a channel it was given, has a
        problem of its own and the turn is still there. Retiring it in the
        reader's mind is the one answer they cannot come back from.
        """
        resolve = self._resolve_activity
        location_id = _conversation_in(ref)
        if location_id is None:
            await self._privately(interaction, ACTIVITY_GONE, ref)
            return
        if resolve is None:
            logger.warning(
                "A Discord activity view was pressed on message %s, but this "
                "bridge has nothing to read the log with, so it is refused.",
                ref,
            )
            await self._privately(interaction, ACTIVITY_FAILED, ref)
            return
        try:
            location = await self._get_channel(location_id)
        except discord.NotFound:
            await self._privately(interaction, ACTIVITY_GONE, ref)
            return
        except (discord.HTTPException, RuntimeError) as error:
            logger.warning(
                "Discord would not say what channel %s is (%s), so the activity "
                "behind message %s is not shown.",
                location_id,
                error,
                ref,
            )
            await self._privately(interaction, ACTIVITY_FAILED, ref)
            return
        refusal = await self._still_reads(location, interaction.user)
        if refusal is not None:
            await self._privately(interaction, refusal, ref)
            return
        parent_id = getattr(location, "parent_id", None)
        channel_id = str(parent_id if parent_id is not None else location.id)
        try:
            snapshot = await resolve(channel_id, ref)
        except Exception:
            logger.exception(
                "Reading the activity behind message %s in Discord channel %s "
                "failed, so the reader is told rather than left waiting.",
                ref,
                channel_id,
            )
            await self._privately(interaction, ACTIVITY_FAILED, ref)
            return
        if snapshot is None:
            await self._privately(interaction, ACTIVITY_GONE, ref)
            return
        await self._privately(
            interaction,
            self._activity_text(snapshot),
            ref,
            session_url=snapshot.session_url,
        )

    def _activity_text(self, snapshot: ActivitySnapshot) -> str:
        """The tool log, and when it was read.

        The time is Discord's own relative stamp, which the client rewrites as
        it ages: a view left open says "20 minutes ago" without anything here
        having to refresh it, so a reader can tell a stale snapshot from a
        current one before deciding whether to press.
        """
        stamp = f"Read <t:{int(snapshot.read_at.timestamp())}:R>"
        body = activity_log(
            snapshot.items,
            snapshot.turn,
            escape=self._rich_escape,
            limit=max(1, MAX_MESSAGE - len(stamp) - 1),
            markup=self.rich_markup(),
            elapsed_seconds=snapshot.elapsed_seconds,
            session_url=None,
            heading=True,
        )
        return f"{body}\n{stamp}"

    async def _privately(
        self,
        interaction: discord.Interaction,
        text: str,
        ref: str,
        *,
        session_url: str | None = None,
    ) -> None:
        """Answer the press in the private message it has already deferred.

        `edit_original_response` rather than a follow-up, for both kinds of
        press: after the initial view's deferral the original response is the
        empty private message Discord is already showing, and after a
        refresh's it is the private message the button sits on. A follow-up
        would leave the first standing and stack a second copy under it.
        """
        view = discord.ui.View(timeout=None)
        view.add_item(
            discord.ui.Button(
                label=_REFRESH_LABEL,
                custom_id=_refresh_id(ref),
                style=discord.ButtonStyle.secondary,
            )
        )
        if session_url and session_url.startswith(("https://", "http://")):
            view.add_item(
                discord.ui.Button(label=_CONSOLE_LABEL, url=session_url),
            )
        view.stop()
        try:
            await interaction.edit_original_response(content=text, view=view)
        except discord.HTTPException as error:
            logger.warning(
                "Discord would not carry the activity view for message %s (%s).",
                ref,
                error,
            )

    async def _still_reads(self, channel: Any, user: Any) -> str | None:
        """Why this reader may not see the conversation a turn is in, or None.

        A channel outside any guild has no permissions to consult: who may
        read it is exactly who is in it, so that is what is asked. A private
        thread is the case a channel's permissions cannot answer on their own:
        everyone who can see the parent passes that check, and only membership
        of the thread says who is actually in it.

        Refused where the answer cannot be established. A destination this
        cannot ask about is one nothing here can say a reader may see, and the
        reader is told that rather than shown the log on the strength of not
        having been able to check.

        Which refusal is returned is the fact that was actually established. A
        request that failed establishes nothing about the reader at all, and
        telling somebody they cannot read a conversation on the strength of a
        call that never came back is a claim nothing checked. Nor is the status
        enough on its own: a 404 on these routes is about the member, the guild
        or the channel, and only the first is about the reader. It is read for
        which, because "you are not in it" and "the bot cannot find it" are the
        reader's problem and ours respectively.
        """
        guild = getattr(channel, "guild", None)
        if guild is None:
            return self._is_recipient(channel, user)
        permissions_for = getattr(channel, "permissions_for", None)
        if permissions_for is None:
            logger.warning(
                "Cannot establish who may read Discord channel %s, so an "
                "activity view of it is refused.",
                getattr(channel, "id", "?"),
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        member = guild.get_member(user.id)
        if member is None:
            try:
                member = await guild.fetch_member(user.id)
            except discord.NotFound as error:
                if error.code == _UNKNOWN_MEMBER_CODE:
                    return ACTIVITY_NOT_A_MEMBER
                logger.warning(
                    "Discord answered 404 %s for user %s in guild %s, which is "
                    "not an answer about the user, so an activity view of "
                    "channel %s is refused.",
                    error.code,
                    user.id,
                    getattr(guild, "id", "?"),
                    getattr(channel, "id", "?"),
                )
                return ACTIVITY_AUDIENCE_UNKNOWN
            except discord.HTTPException as error:
                logger.warning(
                    "Discord would not say whether user %s is in guild %s (%s), "
                    "so an activity view of channel %s is refused.",
                    user.id,
                    getattr(guild, "id", "?"),
                    error,
                    getattr(channel, "id", "?"),
                )
                return ACTIVITY_AUDIENCE_UNKNOWN
        allowed = permissions_for(member)
        if not (allowed.view_channel and allowed.read_message_history):
            return ACTIVITY_UNREADABLE
        is_private = getattr(channel, "is_private", None)
        if is_private is None or not is_private():
            return None
        if allowed.manage_threads:
            return None
        try:
            await channel.fetch_member(user.id)
        except discord.NotFound as error:
            if error.code == _UNKNOWN_MEMBER_CODE:
                return ACTIVITY_NOT_A_MEMBER
            logger.warning(
                "Discord answered 404 %s for user %s in thread %s, which is not "
                "an answer about the user, so an activity view of it is refused.",
                error.code,
                user.id,
                getattr(channel, "id", "?"),
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        except discord.HTTPException as error:
            logger.warning(
                "Discord would not say whether user %s is in thread %s (%s), so "
                "an activity view of it is refused.",
                user.id,
                getattr(channel, "id", "?"),
                error,
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        return None

    def _is_recipient(self, channel: Any, user: Any) -> str | None:
        """Why this reader is not one of the people a guildless channel is between.

        Asked rather than taken as read. The address that named this channel
        came off a press, and the whole point of checking here is that an
        address is not evidence of anything — a branch that answered "yes"
        because there were no permissions to consult would be the one place
        the check could be steered into.
        """
        recipients = getattr(channel, "recipients", None)
        if recipients is None:
            sole = getattr(channel, "recipient", None)
            recipients = [sole] if sole is not None else None
        if recipients is None:
            logger.warning(
                "Cannot establish who is in Discord channel %s, so an "
                "activity view of it is refused.",
                getattr(channel, "id", "?"),
            )
            return ACTIVITY_AUDIENCE_UNKNOWN
        if any(getattr(person, "id", None) == user.id for person in recipients):
            return None
        return ACTIVITY_NOT_A_MEMBER

    async def _tell_presser(
        self, interaction: discord.Interaction, notice: str
    ) -> None:
        """Say why an answer did not land, to the person who pressed and no one else.

        A refusal from Discord is logged and left. Nothing downstream waits on
        this, and the answer it would have explained has already been decided
        either way.
        """
        try:
            await interaction.followup.send(notice, ephemeral=True)
        except discord.HTTPException as error:
            logger.warning(
                "Discord would not carry the reply to a press (%s). The notice "
                "went unsaid: %s",
                error,
                notice,
            )

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        """Tell one person their answer did not land, where they can see it.

        A press is told in a follow-up to the press itself: visible to them
        alone, which costs the channel nothing and reaches them without the bot
        having to be able to open a DM with them.

        A typed answer has no press to follow up, so it falls back to the base:
        said in the card's own thread, where everyone reading it sees a notice
        addressed to someone else. That is the platform's limit rather than a
        choice — nothing but an interaction gives a bot a private reply in a
        channel.
        """
        notices = _PRESS_NOTICE.get()
        if notices is not None:
            notices.append(text)
            return
        await super().tell_actor(channel_id, actor_ref, actor_name, thread_ref, text)

    # ── Slash commands ───────────────────────────────────────────────────────

    async def _handle_slash_command(
        self,
        interaction: discord.Interaction,
        command: InRoomCommand,
        values: dict[str, Any],
    ) -> None:
        """Translate a native Discord slash command into a Switch in-room command.

        `/reset @agent` maps 1:1 onto `!reset @agent`: the slash name IS the
        in-room command name, and the declared options are reassembled into the
        same positional args string, so the invocation reaches the very same
        dispatcher a typed `!`-command reaches.

        Two Discord constraints set the order of what follows. An interaction
        must be acknowledged within ~3 seconds; and a command's result never
        comes back down this call — the admin client answers with a room message
        that reaches the channel later, outbound. So there is nothing to defer
        *for*: the ack goes out first, before any Switch work, and the message it
        posts doubles as the thread root the result is filed under. That mirrors
        the Slack slash path, which posts the same visible notice because a
        slash invocation is otherwise invisible to the channel.
        """
        # An option is a text field, and Discord offers its `@` autocomplete
        # inside one — so picking the agent from the menu submits the raw
        # `<@&123>` markup rather than the name it renders as. The commands
        # downstream read names, and every other inbound path already goes
        # through this, so a slash argument does too.
        values = {
            name: self.translate_inbound(value) if isinstance(value, str) else value
            for name, value in values.items()
        }
        shown = self._format_invocation(command, values)

        # Reassembly is pure and instant, so it runs before the ack: a bad
        # argument is the invoker's typo, and it reads better as an ephemeral
        # refusal than as a "Running…" notice the channel sees and then watches
        # turn into an error.
        try:
            args = reassemble_args(command.args_spec, values)
        except SlashArgError as e:
            await self._reject_slash(interaction, shown, str(e))
            return

        try:
            await interaction.response.send_message(
                f"⚙️ Running `{shown}` — result will appear in this thread."
            )
        except discord.HTTPException:
            logger.exception("Failed to acknowledge Discord slash command %s", shown)
            return

        try:
            await self._dispatch_slash_command(interaction, command.name, args)
        except Exception as e:
            logger.exception("Failed to dispatch Discord slash command %s", shown)
            await self._report_slash_failure(interaction, shown, e)

    async def _dispatch_slash_command(
        self, interaction: discord.Interaction, command_name: str, args: str
    ) -> None:
        if self._on_command is None:
            raise RuntimeError("Discord adapter is not started")
        channel = interaction.channel
        if channel is None:
            raise RuntimeError("Discord interaction carried no channel")

        # A slash command run inside a thread bridges into the PARENT channel's
        # room and threads under the thread's root, exactly as a typed command
        # in that thread does.
        parent_id = getattr(channel, "parent_id", None)
        if parent_id is not None:
            channel_id = str(parent_id)
            root_id: str | None = f"{parent_id}:{channel.id}"
            channel_name = getattr(getattr(channel, "parent", None), "name", None)
        else:
            channel_id = str(channel.id)
            root_id = None
            channel_name = getattr(channel, "name", None)

        original = await interaction.original_response()
        user = interaction.user
        username = str(user.name)
        self._user_names[user.id] = username
        self._username_to_id[username] = user.id

        await self._on_command(
            InboundCommand(
                channel_id=channel_id,
                channel_type=self._channel_type_of(channel),
                sender_id=str(user.id),
                sender_name=username,
                command=command_name,
                args=args,
                message_ref=f"{original.channel.id}:{original.id}",
                root_id=root_id,
                channel_name=channel_name,
            )
        )

    @staticmethod
    def _format_invocation(command: InRoomCommand, values: dict[str, Any]) -> str:
        """Render the invocation for echoing back, in declared argument order."""
        given = [
            str(values[arg.name]).strip()
            for arg in command.args_spec
            if values.get(arg.name) is not None and str(values[arg.name]).strip()
        ]
        return f"/{command.name}" + (f" {' '.join(given)}" if given else "")

    async def _reject_slash(
        self, interaction: discord.Interaction, shown: str, reason: str
    ) -> None:
        """Refuse an invocation before dispatch, visibly to whoever ran it."""
        try:
            await interaction.response.send_message(
                f"⚠️ Could not run `{shown}` — {reason}", ephemeral=True
            )
        except discord.HTTPException:
            logger.exception("Failed to report bad arguments for %s", shown)

    async def _report_slash_failure(
        self, interaction: discord.Interaction, shown: str, error: Exception
    ) -> None:
        """Rewrite the posted "Running…" notice into a visible failure.

        A slash command that appears to do nothing is worse than one that
        errors; the ack has already gone out by this point, so there is always a
        message sitting in the channel to turn into the error.
        """
        try:
            await interaction.edit_original_response(
                content=f"⚠️ Failed to run `{shown}`: {error}"
            )
        except discord.HTTPException:
            logger.exception("Failed to report failure of %s back to Discord", shown)

    # ── Attachments ──────────────────────────────────────────────────────────

    async def _fetch_attachments(
        self, files: list[Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Download every attachment from a Discord message, whatever the type.

        Returns the downloaded attachments and, separately, the ones that could
        not be relayed (oversize, download failure) so the bridge can disclose
        them in the room rather than dropping them silently.
        """
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for file in files:
            mimetype = (
                str(getattr(file, "content_type", "") or "")
                or "application/octet-stream"
            )
            filename = str(getattr(file, "filename", "") or "file")
            size = getattr(file, "size", None)
            if isinstance(size, int) and size > self._max_attachment_bytes:
                logger.warning(
                    "Discord attachment %s is %d bytes, over the %d cap",
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
            try:
                data = await file.read()
            except Exception as exc:
                logger.exception("Failed to download Discord attachment %s", filename)
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

    # ── Webhooks & channels ──────────────────────────────────────────────────

    async def _get_channel(self, channel_id: int) -> Any:
        client = self._require_client()
        channel = client.get_channel(channel_id)
        if channel is None:
            channel = await client.fetch_channel(channel_id)
        return channel

    async def _get_guild(self) -> Any:
        client = self._require_client()
        guild = client.get_guild(self._guild_id)
        if guild is None:
            guild = await client.fetch_guild(self._guild_id)
        return guild

    @staticmethod
    async def _get_member(guild: Any, user_external_id: str) -> Any:
        member = guild.get_member(int(user_external_id))
        if member is None:
            member = await guild.fetch_member(int(user_external_id))
        return member

    async def _get_webhook(self, channel_id: int) -> discord.Webhook:
        return await self._named_webhook(channel_id, _WEBHOOK_NAME)

    async def _publication_webhook(self, channel_id: int) -> discord.Webhook:
        """The webhook nothing but a session publication is ever sent through.

        A second webhook in the same channel, for one reason: it is the only
        thing about a Discord message that says who wrote it and cannot be
        written by anyone else. Recovery has to find a status or a card again
        after a send whose outcome was lost, and it has nothing but the channel
        history to look in. Sharing the agents' webhook made the sender useless
        as evidence — every relayed reply came from it too, so an agent that
        merely talked about a request looked exactly like the card, and
        adopting one would have redrawn a sentence as a settled question.

        Nobody but this method posts here, so anything found on it is a
        publication. Guilds only: a DM has no webhooks at all.
        """
        return await self._named_webhook(channel_id, _PUBLICATION_WEBHOOK_NAME)

    async def _named_webhook(self, channel_id: int, name: str) -> discord.Webhook:
        cached = self._webhooks.get((channel_id, name))
        if cached is not None:
            return cached

        channel = await self._get_channel(channel_id)
        webhook: discord.Webhook | None = None
        for existing in await channel.webhooks():
            if existing.name == name and existing.token:
                webhook = existing
                break
        if webhook is None:
            # Minted here, so it is this application's by construction.
            webhook = await channel.create_webhook(name=name)
            owned = True
        else:
            owned = self._application_owns(webhook)

        self._webhooks[(channel_id, name)] = webhook
        self._webhook_ids.add(webhook.id)
        if owned:
            self._owned_webhooks.add(webhook.id)
        elif name == _PUBLICATION_WEBHOOK_NAME:
            logger.warning(
                "The %r webhook in Discord channel %s was made by somebody "
                "other than this application, so Discord will not let it carry "
                "buttons: a request card posted there can only be answered by "
                "typing. It is used anyway, because a webhook may only edit and "
                "delete the messages it sent itself and swapping it would strand "
                "every card already posted through it. Deleting it in the "
                "channel's settings lets the bridge mint its own.",
                name,
                channel_id,
            )
        return webhook

    def _application_owns(self, webhook: discord.Webhook) -> bool:
        """Whether Discord will let this webhook carry interactive components.

        Only a webhook an application owns may send them; one a person made in
        the channel's settings has its components dropped on the way out, so a
        card posted through it would arrive with the question and no buttons.
        Finding a webhook by name is no evidence either way — the name is
        whatever it was called.

        Discord names the owner twice over: as `application_id`, which
        discord.py does not carry onto the object, and as the account that
        created it, which it does. For a webhook a bot created those are the
        same application, so the creator is the probe. It is only filled in on
        a webhook read through the channel, which is how this bridge reads
        them; one fetched by its token says nothing about who made it.
        """
        creator = getattr(webhook, "user", None)
        bot_user_id = self._require_connection().bot_user_id
        return creator is not None and bool(bot_user_id and creator.id == bot_user_id)

    def _offers_buttons(self, channel_id: int) -> bool:
        """Whether a card published in this guild channel may have buttons.

        Answered from what `_publication_webhook` already resolved, so this
        stays synchronous and costs nothing: the caller has resolved the
        webhook by the time it draws.
        """
        webhook = self._webhooks.get((channel_id, _PUBLICATION_WEBHOOK_NAME))
        return webhook is not None and webhook.id in self._owned_webhooks

    async def _ensure_thread(self, channel_id: int, thread_root_ref: str) -> Any:
        """Resolve (creating if needed) the Discord thread rooted at the given
        external message ref, for posting a threaded reply.

        On Discord a thread is a channel whose id equals the id of the message
        it was created from, so an existing thread is a straight channel
        lookup. When none exists yet, one is created from the root message.
        """
        _, root_mid = self._parse_message_ref(thread_root_ref)
        root_message_id = int(root_mid if root_mid else thread_root_ref)

        client = self._require_client()
        thread = client.get_channel(root_message_id)
        if thread is not None:
            return thread

        channel = await self._get_channel(channel_id)
        name = "Switch thread"
        root_message = None
        try:
            root_message = await channel.fetch_message(root_message_id)
            root_content = str(root_message.content or "").strip()
            if root_content:
                name = root_content[:60]
        except discord.HTTPException:
            pass

        try:
            if root_message is not None:
                return await root_message.create_thread(name=name)
            return await channel.get_partial_message(root_message_id).create_thread(
                name=name
            )
        except discord.HTTPException:
            # A thread already exists for this message — fetch it by id.
            return await client.fetch_channel(root_message_id)

    # ── Helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _parse_message_ref(message_ref: str) -> tuple[str, str]:
        parts = message_ref.split(":", 1)
        if len(parts) != 2:
            logger.error("Invalid Discord message ref format: %s", message_ref)
            return "", ""
        return parts[0], parts[1]
