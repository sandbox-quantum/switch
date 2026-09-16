from __future__ import annotations

import hashlib
import html
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
from dataclasses import replace
from typing import Any, ClassVar, NamedTuple

from telegram import (
    BotCommand,
    ForceReply,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaDocument,
    InputMediaPhoto,
    LinkPreviewOptions,
    ReactionTypeEmoji,
    ReplyParameters,
    Update,
)
from telegram.constants import ChatAction, ChatType, ParseMode
from telegram.error import (
    BadRequest,
    ChatMigrated,
    Conflict,
    Forbidden,
    RetryAfter,
    TelegramError,
)
from telegram.ext import Application, ApplicationBuilder, TypeHandler

from switch_core.bridges.agent.commands import COMMANDS, COMMANDS_BY_NAME, CommandArg
from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    CollaborationAdapter,
    RemovalFailed,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeInstallLink,
    ChannelCreationUnsupported,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.session.renderers import (
    Control,
    Drawn,
    Markup,
    offered_controls,
    position_action,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    render_request,
    turn_status,
)
from switch_core.bridges.collaboration.telegram.chunking import (
    MAX_MESSAGE,
    chunk_message,
)
from switch_core.sessions.contract import TURN_ENDED

logger = logging.getLogger(__name__)

# A caption over this is posted as its own message ahead of the file. The
# message-length cap lives in `chunking`, which owns the splitting.
_MAX_CAPTION_CHARS = 1024

# The Bot API refuses to serve a file larger than this, whatever the bridge's
# own ceiling is set to.
_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

# sendMediaGroup takes between two and ten items, all of the same kind.
_MEDIA_GROUP_MIN = 2
_MEDIA_GROUP_MAX = 10

_ALLOWED_UPDATES = ["message", "channel_post", "my_chat_member", "callback_query"]

# What a press on a card's button hands back. Telegram allows 64 bytes for the
# whole of it, so it holds the request token and the option's position on the
# card and nothing else — the prefix is two characters for the same reason.
# Every byte spent here is one the token cannot have.
_CALLBACK_PREFIX = "sw"
_MAX_CALLBACK_BYTES = 64

# A button's label is one line on a phone, and Telegram truncates the middle of
# an over-long one rather than wrapping it. Cut here instead, at the end, where
# the reader can tell something was cut. The renderer is given the same number,
# because an option the button says in full is one the body stops repeating and
# an option the button had to cut is one the body has to keep.
_MAX_BUTTON_LABEL = 48

# Telegram's own limit on the text of a reply to a press.
_MAX_ALERT = 200

# The notice a press is owed, collected while the press is being handled.
#
# A refusal is raised deep inside the shared inbound path, which knows the
# person and the reason and nothing about Telegram; the only private way to
# tell them is a reply to the callback query, and the id for that belongs to
# the press rather than to the person. A context variable is what joins the
# two: `tell_actor` leaves the notice here and the press answers with it, so
# nothing has to be looked up by actor — two people pressing at once are two
# tasks with a context each, and the same person pressing twice is two presses
# rather than one notice overwriting another.
_PRESS_NOTICE: ContextVar[list[str] | None] = ContextVar(
    "switch_telegram_press_notice", default=None
)


def _callback_data(token: str, position: int) -> str:
    return f"{_CALLBACK_PREFIX}:{token}:{position}"


def _parse_callback(data: str) -> tuple[str, int] | None:
    """The request and the control a press names, or None if it is not ours.

    Telegram hands back exactly what was put in the button, so this is read as
    strictly as it is written: a prefix this bridge minted, a token, and a
    count in ASCII digits from one. Neither value is trusted past its shape —
    the token is resolved against the record and the position against the form
    that record holds.
    """
    parts = data.split(":")
    if len(parts) != 3 or parts[0] != _CALLBACK_PREFIX:
        return None
    token, digits = parts[1], parts[2]
    if not token or not digits.isascii() or not digits.isdecimal():
        return None
    position = int(digits)
    return (token, position) if position > 0 else None


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


# Switch's own in-room prefix, plus Telegram's native one.
_COMMAND_PREFIXES = ("!", "/")

# The payload the dashboard's one-click links carry, delivered back to the bot
# as `/start <payload>` once it has been added. It authorises nothing — anyone
# able to add a bot to a chat can do so without it — it only distinguishes an
# install started from Switch from someone adding the bot by hand, which is
# worth saying in the chat and in the logs.
_INSTALL_PAYLOAD = "switch"

# Telegram will only register a command spelled in these characters, and caps a
# description at 256. A name it rejects is left out of the menu rather than
# taking the whole call down.
_TELEGRAM_COMMAND_RE = re.compile(r"[a-z0-9_-]{1,32}")
_MAX_COMMAND_DESCRIPTION = 256

# Supergroup and channel ids are the internal id with a -100 prefix; t.me/c/
# links carry the internal id alone.
_SUPERGROUP_PREFIX = "-100"

_NO_PREVIEW = LinkPreviewOptions(is_disabled=True)

# Marks the message an agent is working on. Telegram only accepts reactions
# from a fixed set, and 👀 is in it — the same one Slack uses, so the signal
# reads the same wherever a room is bridged.
_WORKING_REACTION = "\U0001f440"

# The URL schemes Telegram will actually turn into a link. An `<a>` carrying
# anything else is not rendered as written: the API rejects the message with
# "unsupported URL protocol", or the client keeps the label and drops the link,
# and which of the two you get is not ours to decide. A `switchdash://` deeplink
# is exactly that case, so it is rendered as copyable text instead of an anchor
# that may quietly vanish along with the message around it.
_LINKABLE_SCHEMES = ("http://", "https://", "tg://", "mailto:")

# The palette agent marks are drawn from. Solid colour circles, because they
# stay legible at the size Telegram renders an emoji inline and carry no meaning
# of their own to be misread — a mark says "same speaker as before", nothing
# more. Eight is enough to make neighbouring agents in one chat almost always
# differ without the colours becoming hard to tell apart.
_AGENT_MARKERS = (
    "\U0001f535",
    "\U0001f7e2",
    "\U0001f7e3",
    "\U0001f7e0",
    "\U0001f534",
    "\U0001f7e1",
    "\U0001f7e4",
    "\u26ab",
)


# Waited when Telegram says to slow down without saying for how long. Every
# real 429 carries `retry_after`, so this is only reached when the field is
# missing or unreadable — a floor, not a figure Telegram committed to.
_THROTTLE_FALLBACK = 5.0

# The shortest gap the bridge will leave between two publications in one chat,
# counting sends and edits alike. Telegram's published figures are send limits —
# roughly twenty messages a minute to one group — and say nothing about what an
# edit costs, so this is a self-imposed floor under an unknown, not a quota
# Telegram stated. It is charged to the chat because Telegram's own 429 is:
# every agent publishing there shares one budget, and being paced by Telegram
# costs the conversation rather than only the redraw.
#
# Only intermediate progress is held back. A turn's last state, the attention
# slot and every request card go through immediately, because a reader waiting
# on one of those is waiting on the thing this pacing would delay.
_REDRAW_INTERVAL = 1.5


def _throttle_delay(error: RetryAfter) -> float:
    """How long Telegram's 429 asks us to wait.

    `retry_after` is documented as seconds and arrives as an int, but it is
    read defensively and floored: a zero or a missing value would turn a
    throttle into a tight retry loop, which is how a throttled bot becomes a
    blocked one.
    """
    raw: Any = getattr(error, "retry_after", None)
    try:
        return max(1.0, float(raw))
    except (TypeError, ValueError):
        return _THROTTLE_FALLBACK


def _as_rich_failure(
    error: Exception, *, description: str, text: str
) -> RichContentFailed | None:
    """Telegram's answer, or no answer at all.

    `None` means the call may or may not have landed and the caller must keep
    its reservation: `RichContentFailed` is a licence to discard one and try
    again, which on a request card is a licence to ask the same question twice.

    The order here is load-bearing, and not the order it looks like. In
    python-telegram-bot `BadRequest` is a subclass of `NetworkError`, so a
    `NetworkError` branch written first swallows every rejection Telegram
    actually made and reports a definite refusal as an unknown outcome — the
    reservation would then be held open for a card the API has already refused
    to post, forever. The definite answers are therefore tested first.

    `RetryAfter` is an answer, but not that one: it means wait, and it carries
    the delay to wait for. `Forbidden` (the bot was removed or blocked) and
    `ChatMigrated` (the chat id is no longer the chat) are definite: the call
    did not happen and repeating it unchanged will not make it happen.
    `TimedOut` and the rest of `NetworkError` are the uncertain ones — the
    request may have reached Telegram and the response been lost.
    """
    if isinstance(error, RetryAfter):
        return RichContentThrottled(retry_after=_throttle_delay(error), text=text)
    if isinstance(error, BadRequest | Forbidden | ChatMigrated):
        return RichContentFailed(f"{description}: {error}", text=text)
    return None


class _TelegramMarkup(Markup):
    """The neutral renderer's three marks, spelled as Telegram's HTML subset.

    Telegram's message bodies are sent with `parse_mode=HTML`, so `**bold**`
    would reach a reader as those four characters around the word. What these
    return is finished HTML, inserted into a string whose host text has already
    been escaped by `_rich_escape` — so nothing here escapes again, and nothing
    here is given anything that still needs escaping.
    """

    def bold(self, text: str) -> str:
        return f"<b>{text}</b>"

    def literal(self, escape: Callable[[str], str]) -> Callable[[str], str]:
        """The ordinary escape: `<code>` is still HTML inside.

        Telegram's span reads its content, so an `&` or a `<` in a command
        needs defusing exactly as it would in the body. The Markdown default
        passes text through untouched, which here would break the message
        rather than merely litter it.
        """
        return escape

    def code(self, text: str) -> str:
        return f"<code>{text}</code>"

    def link(self, label: str, url: str) -> str:
        """An anchor, or the address as tap-to-copy text where one would vanish.

        Telegram renders `<a>` only for the schemes it knows, and the neutral
        renderer's one link may be a `switchdash://` deeplink. An anchor
        carrying that is not rendered as written — the API rejects the whole
        message with "unsupported URL protocol", or the client keeps the label
        and silently drops the address — so the degradation is made here and
        made visible: the reader gets the address itself, in a span Telegram
        makes tap-to-copy, instead of a label that goes nowhere.
        """
        if not url.lower().startswith(_LINKABLE_SCHEMES):
            return f"<code>{html.escape(url, quote=False)}</code>"
        return f'<a href="{html.escape(url, quote=True)}">{label}</a>'


TELEGRAM_HTML = _TelegramMarkup()


class _ChatVisibility(NamedTuple):
    """What the bridge can see in one chat, and how certain that is.

    ``status`` is ``"full"``, ``"mention_only"`` or ``"unknown"``.
    ``via_admin`` is True only when it was settled by the bot's administrator
    status *in this chat*, which is the one conclusive answer — see
    ``_chat_visibility``.
    """

    status: str
    via_admin: bool


def _as_int(value: str) -> int | None:
    """The number this names, where it names one."""
    try:
        return int(value)
    except ValueError:
        return None


class _ThreadRoot(NamedTuple):
    """Where in one chat a thread root points.

    The same number means one of two things. A forum topic is addressed with
    ``message_thread_id`` and every message in it carries that id; anywhere
    else Telegram has no thread and the root is a message to reply to. The two
    are not interchangeable — see ``_resolve_root``.
    """

    is_topic: bool
    id: int


class TelegramConnectionConfig(BridgeConnectionConfig):
    bot_token: str
    bot_username: str


class TelegramAdapter(CollaborationAdapter):
    """Telegram collaboration bridge adapter.

    Single-bot identity model. Telegram has no per-message identity override —
    no equivalent of a Discord webhook's username/avatar — so every agent posts
    through the one bot and is distinguished by its name rendered at the head of
    the message. Inbound arrives by long polling (an outbound connection, no
    public ingress); outbound goes through the Bot API.

    The bot has to be able to see the conversation, and Telegram offers two
    routes to that: privacy mode is disabled in BotFather for the bot globally,
    or the bot is an administrator of the chat, which exempts it whatever the
    setting says. Setup takes the first — one setting per bot rather than a
    promotion per group — and the dashboard's install link therefore asks for
    no rights at all; admin is offered only as the repair for a chat the bot
    joined before the setting was changed. A bot that is neither runs
    mention-only — it receives commands, replies to itself and messages that
    tag it, and nothing else — which is disclosed in the chat rather than left
    to be deduced from silence.

    Chats are adopted, never created: the Bot API gives a bot no way to create a
    group or channel, so ``supports_channel_creation`` is False and a chat's
    Switch room is provisioned when the bot is added to it or on its first
    bridged message.
    """

    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False

    publishes_sdk_sessions: ClassVar[bool] = True

    #: One message for the whole of a turn's progress.
    #:
    #: Telegram has no collapsed disclosure inside an ordinary message that a
    #: second post would buy, and it prices edits per chat rather than per
    #: message: a separate log would double the edit rate of every turn and
    #: spend the chat's budget on the half nobody is waiting for. The compact
    #: status already carries the tool counts.
    separate_activity_log: ClassVar[bool] = False

    #: A problem somebody has to act on gets its own message.
    #:
    #: An edit does not notify on Telegram. Folded into the status, a failure
    #: would land as a silent rewrite of a message the reader has already
    #: scrolled past, which is the one case where being told matters most.
    separate_attention_slot: ClassVar[bool] = True

    #: Everyone in a Telegram chat is notified of a new message without being
    #: named, so a mention is an emphasis rather than the only route to a
    #: reader. Naming the asker still happens; it is not what delivery rests on.
    notifies_only_by_mention: ClassVar[bool] = False

    #: The status is the turn's one post, so the seconds ride along with the
    #: next real change rather than rewriting it on a timer. Telegram's edit
    #: limits make that more than a preference: a clock redrawn every few
    #: seconds is a turn spending the chat's whole allowance on itself.
    redraws_for_elapsed_time: ClassVar[bool] = False

    supports_activity_reactions: ClassVar[bool] = True

    #: One bot posts for every agent here, and a reaction belongs to the
    #: account that added it, so there is one mark between them all.
    activity_reactions_per_agent: ClassVar[bool] = False

    # Telegram's is the one disclosure that has been agreed: T2, accepted for
    # this platform on this platform's evidence. It does not travel to another
    # adapter that happens to share the inability to search.
    discloses_unconfirmed_posts: ClassVar[bool] = True

    #: A bot deletes its own messages in a group as an ordinary member, and in
    #: a broadcast channel with the Delete Messages right the install already
    #: asks for. What it cannot do is delete one older than 48 hours, and
    #: Telegram says so plainly enough to tell apart from being ignored — which
    #: is the second half of what this claims. See `remove_publication`.
    removes_answered_cards: ClassVar[bool] = True

    def __init__(self, *, config: TelegramConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._app: Application | None = None  # type: ignore[type-arg]
        self._bot: Any = None
        self._bot_user_id: int = 0
        self._bot_username = config.bot_username.lstrip("@")
        self._seen_ids: OrderedDict[tuple[str, int], None] = OrderedDict()
        self._seen_ids_max = 1000
        # Telegram user id ↔ username caches, for rendering outbound mentions of
        # people who address by numeric id rather than handle.
        self._user_names: dict[int, str] = {}
        self._username_to_id: dict[str, int] = {}
        # chat id -> its public `@name`, or None for a chat that resolved and
        # has none. A deeplink is built once per room on every dashboard read,
        # inside the request's transaction, and getChat is a network round trip
        # — uncached, that is a pool slot held for it per room, per page load.
        self._chat_usernames: dict[str, str | None] = {}
        # Whether BotFather's privacy mode is off for this bot, read from getMe
        # at startup. It is a global setting and says nothing about any one
        # chat, so it is only half of what _chat_visibility decides.
        self._privacy_mode_disabled = False
        # Whether BotFather allows this bot into groups at all, also from
        # getMe. Assumed until the bot answers, which is BotFather's default.
        self._can_join_groups = True
        # chat id -> the visibility last announced in it, so a reconnect or a
        # second join repeats nothing while a real change is always said.
        self._visibility_announced: dict[str, str] = {}
        # (chat id, our prompt's message id) -> the command that prompt is
        # waiting on an argument for. Bounded like _seen_ids: an unanswered
        # prompt is abandoned rather than remembered forever.
        self._awaiting_args: OrderedDict[tuple[str, int], str] = OrderedDict()
        self._awaiting_args_max = 200
        # Messages currently carrying the 👀, as (chat id, message id), so a
        # turn reporting its activity repeatedly reacts once.
        self._reacted: set[tuple[str, str]] = set()
        # chat id -> whether it is a forum. What a thread root means depends on
        # the answer, and nothing in a message ref says which kind it is.
        self._forum_chats: dict[str, bool] = {}
        # When Telegram will next accept an update, from the last 429 it sent.
        # A 429 is charged to the chat, not the message, so one throttled
        # redraw pauses every publication rather than only its own.
        self._rich_update_after = 0.0
        # chat id -> when a publication was last sent or edited in it. Telegram
        # charges its limits to the chat, and several agents publish into one
        # chat, so intermediate progress is paced against the chat's budget
        # rather than each message's own. Bounded like the other caches: an
        # entry is only ever a timestamp to compare against.
        self._rich_drawn_at: OrderedDict[str, float] = OrderedDict()
        self._rich_drawn_at_max = 1000

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
        # Single-bot identity model, so there is no per-agent join to detect.
        # Unlike Discord, Telegram does signal when the bot itself is added to a
        # chat, so app joins and user joins are both wired.
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        app = ApplicationBuilder().token(self._config.bot_token).build()
        app.add_handler(TypeHandler(Update, self._make_on_update()))
        self._app = app
        self._bot = app.bot

        await app.initialize()
        me = await app.bot.get_me()
        self._bot_user_id = me.id
        if me.username and me.username != self._bot_username:
            # The configured value used to win, and every link built from it
            # pointed at whatever account that name resolves to — which is not
            # this bot, and on Telegram is quite possibly somebody else's. The
            # token identifies the bot; the name is a label an operator typed.
            logger.warning(
                "Configured Telegram bot_username %r is not this bot's username "
                "%r — using the one the Bot API reports, so links resolve. Fix "
                "the bridge's configuration: the field wants the @handle, not "
                "the display name",
                self._bot_username,
                me.username,
            )
        if me.username:
            self._bot_username = str(me.username)
        self._privacy_mode_disabled = bool(
            getattr(me, "can_read_all_group_messages", False)
        )
        # A bot with "Allow Groups?" turned off in BotFather cannot be added to
        # one at all, and Telegram answers an add-to-group link by opening a
        # chat with the bot — a link that looks like it did nothing.
        self._can_join_groups = bool(getattr(me, "can_join_groups", True))
        self._report_privacy_mode()
        if not self._can_join_groups:
            logger.warning(
                "Telegram bot @%s has groups disabled in BotFather, so it cannot "
                "be added to one and the 'Add to a Telegram group' link is not "
                "offered. Enable it in BotFather: /mybots -> select the bot -> "
                "Bot Settings -> Allow Groups?",
                self._bot_username,
            )
        await app.start()
        if app.updater is None:
            raise RuntimeError("Telegram application was built without an updater")
        await app.updater.start_polling(
            allowed_updates=_ALLOWED_UPDATES, error_callback=self._on_polling_error
        )
        logger.info("Telegram adapter connected as @%s (id %s)", me.username, me.id)
        await self._publish_command_menu()

    async def _publish_command_menu(self) -> None:
        """Publish the in-room command set so Telegram offers it as you type.

        Telegram only accepts `[a-z0-9_]` in a registered command, so the
        hyphenated names are published in their underscore spelling —
        `/invite_agent` — and `_parse_command` accepts either. Without this the
        commands still work when typed in full, but nothing suggests them, and
        a `/` menu that lists none implies the bot has none.

        A failure here is logged and left non-fatal, as Discord's sync is: the
        bridge is fully usable without the menu, and losing it is a far better
        outcome than refusing to start.
        """
        menu = [
            BotCommand(
                command=command.name.replace("-", "_"),
                description=command.description[:_MAX_COMMAND_DESCRIPTION],
            )
            for command in COMMANDS
            if not command.hidden and _TELEGRAM_COMMAND_RE.fullmatch(command.name)
        ]
        try:
            await self._require_bot().set_my_commands(menu)
        except Exception:
            logger.exception(
                "Could not publish the Telegram command menu — commands still "
                "work when typed, but will not be suggested"
            )
            return
        logger.info("Published %d Telegram commands", len(menu))

    @staticmethod
    def _on_polling_error(error: TelegramError) -> None:
        """Report a polling failure, naming the one that looks like nothing.

        Telegram hands each update to a single getUpdates caller, so a second
        process on the same bot token silently takes a share of the traffic —
        outbound keeps working, inbound goes intermittent or dead, and the only
        evidence is a Conflict the poller would otherwise swallow and retry.
        """
        if isinstance(error, Conflict):
            logger.error(
                "Another process is polling Telegram with this bot token. "
                "Telegram gives each update to only ONE caller, so this bridge "
                "is now missing inbound messages while still able to send. "
                "Stop the other instance — an old deployment still running, a "
                "local run, or a second replica — or give it its own bot. "
                "Telegram said: %s",
                error,
            )
            return
        logger.warning("Telegram polling error: %s", error)

    def _report_privacy_mode(self) -> None:
        """Record what the global privacy setting does and does not settle.

        BotFather enables privacy mode by default, and a bot in that state
        receives only `/`-prefixed messages, replies to itself and messages
        tagging it. That used to be reported here as a fault, but it is not one
        on its own: Telegram exempts a bot that is an administrator of a chat,
        so a bridge whose chats were joined through the dashboard's install
        link sees everything with privacy mode left exactly as BotFather set
        it. Whether any one chat is readable is therefore a per-chat question,
        answered by _chat_visibility as chats are joined and audited.
        """
        if self._privacy_mode_disabled:
            logger.info(
                "Telegram privacy mode is disabled for @%s: the bridge sees all "
                "messages in every chat it is in",
                self._bot_username,
            )
            return
        logger.info(
            "Telegram privacy mode is enabled for @%s (BotFather's default): the "
            "bridge sees the whole conversation only in chats where the bot is an "
            "administrator, and mentions, replies and commands everywhere else. "
            "Each chat is checked as it is joined",
            self._bot_username,
        )

    async def _chat_visibility(self, channel_id: str) -> _ChatVisibility:
        """What the bridge can actually see in one chat.

        ``"full"`` — every message. ``"mention_only"`` — commands, replies to
        the bot and messages tagging it, which is Telegram filtering before the
        update ever reaches us and cannot be worked around in code.
        ``"unknown"`` — the lookup failed, so nothing is claimed either way.

        Two things grant full visibility: the bot is an administrator of this
        chat, or privacy mode is off for the bot globally. A 1:1 chat is always
        fully visible — privacy mode has never applied to private chats.

        ``via_admin`` says which of the two it was, because they are not equally
        certain. Administrator status is read from this chat and is conclusive.
        The global setting is not: Telegram only re-reads it when the bot
        **joins**, so a bot that was already in a chat before privacy mode was
        disabled is still filtered there, and no Bot API call distinguishes
        that from a working one. Callers that can act on the difference say so
        rather than reporting certainty nothing has.
        """
        if self._bot is None:
            return _ChatVisibility("unknown", via_admin=False)
        try:
            chat = await self._bot.get_chat(self._chat_id(channel_id))
        except Exception:
            logger.debug(
                "Could not resolve Telegram chat %s while checking visibility",
                channel_id,
                exc_info=True,
            )
            return _ChatVisibility("unknown", via_admin=False)
        if self._channel_type_of(chat) == "lobby":
            return _ChatVisibility("full", via_admin=False)
        try:
            member = await self._bot.get_chat_member(
                chat_id=self._chat_id(channel_id), user_id=self._bot_user_id
            )
        except Exception:
            logger.debug(
                "Could not read the bot's membership of Telegram chat %s",
                channel_id,
                exc_info=True,
            )
            return _ChatVisibility("unknown", via_admin=False)
        status = str(getattr(member, "status", "") or "")
        if status in ("administrator", "creator"):
            return _ChatVisibility("full", via_admin=True)
        if self._privacy_mode_disabled:
            return _ChatVisibility("full", via_admin=False)
        return _ChatVisibility("mention_only", via_admin=False)

    async def announce_visibility(self, channel_id: str) -> None:
        """Tell a chat what the bridge can see in it, when that changes.

        A mention-only bridge works — agents are addressed by `@name`, which is
        one of the few things Telegram does deliver — but it will not follow a
        conversation nobody tags it in, and the failure is otherwise
        indistinguishable from agents ignoring people. So it is said in the
        chat, where whoever just added the bot is looking, along with the one
        action that fixes it.

        Said again only when the answer actually changes, so promoting the bot
        confirms itself and retracts the warning, and demoting it does not go
        unmentioned — while a reconnect or a second join stays silent.
        """
        visibility = await self._chat_visibility(channel_id)
        if visibility.status == "unknown":
            return
        previous = self._visibility_announced.get(channel_id)
        if previous == visibility.status:
            return
        self._visibility_announced[channel_id] = visibility.status
        if visibility.status == "full":
            logger.info("Telegram chat %s is fully visible to the bridge", channel_id)
            if previous == "mention_only":
                await self.admin_message(
                    channel_id,
                    "✅ **I can see the whole conversation here now.** Agents "
                    "will follow this chat without having to be tagged.",
                )
            return
        logger.warning(
            "Telegram chat %s is mention-only: the bot is not an administrator "
            "there and privacy mode is on, so ordinary messages are never "
            "delivered to the bridge",
            channel_id,
        )
        await self.admin_message(
            channel_id,
            "⚠️ **I can only see messages that tag me here.** Telegram is "
            "filtering this chat before anything reaches me, so agents will "
            f"follow whatever is addressed to `@{self._bot_username}` "
            "or to an agent by name, and nothing else.\n\n"
            "**To fix it everywhere, once:** in @BotFather, "
            "`/mybots` → this bot → Bot Settings → Group Privacy → "
            "**Turn off**. Telegram reads that when I join a chat, so I have "
            "to be removed from this one and added back for it to take here — "
            "but every group you add me to afterwards just works.\n\n"
            "**To fix only this chat, now:** make me an administrator of it. "
            "No particular permission is needed. If Telegram converts the group "
            "to a supergroup when you do, that is expected — the Switch room "
            "follows it.",
        )

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """Audit what the bridge can see in each chat it is already bridging.

        Telegram needs no subscriptions — long polling delivers everything the
        bot is entitled to — but this is the one call that arrives on startup
        holding the bridge's known chats, and a chat can lose visibility
        between runs: the bot is demoted, or privacy mode is turned back on.
        Logged rather than posted, so a restart does not repost a notice in
        every chat.
        """
        for channel_id, channel_type in channels:
            if channel_type == "lobby":
                continue
            visibility = await self._chat_visibility(channel_id)
            if visibility.status == "mention_only":
                logger.warning(
                    "Telegram chat %s is mention-only: the bot is not an "
                    "administrator there and privacy mode is on. Ordinary "
                    "messages in it never reach Switch",
                    channel_id,
                )
            elif visibility.status == "full" and not visibility.via_admin:
                # Taken on trust: Telegram reads the global privacy setting
                # when the bot joins, and nothing in the Bot API reports which
                # value was read for this chat. A bot that was already here
                # before privacy mode was disabled is still being filtered, and
                # this line is the only place that says so.
                logger.info(
                    "Telegram chat %s is assumed fully visible because privacy "
                    "mode is off for the bot; if messages from it never arrive, "
                    "the bot was in the chat before that was changed — remove "
                    "it and add it back, or make it an administrator",
                    channel_id,
                )

    async def install_links(self) -> list[BridgeInstallLink]:
        """The link that adds this bot to a group.

        `?startgroup` opens a chat picker, so adding the bot is one choice and
        one confirmation rather than a documented sequence of clicks. It asks
        for no rights, because the bridge needs none: a bot posts and deletes
        its own messages in a group as an ordinary member.

        **Nothing here uses Telegram's `admin=` parameter, deliberately.** Two
        earlier versions did — adding the bot to a group as an administrator to
        bypass privacy mode, and to a channel because a bot can only be in one
        as an administrator. Both were withdrawn after a client was found that
        ignores the parameter and opens a chat with the bot instead, which is
        indistinguishable from a link that does nothing. A group needs no rights
        anyway, so it loses nothing. A channel cannot be done this way at all,
        so no link is offered for one and the guide gives the by-hand route:
        the channel's Administrators screen, which works on every client.

        The username is the one the Bot API reports, not the configured one —
        a link built from a name that resolves to some other account opens a
        chat with *it* and looks like the link did nothing.

        The link is withheld from a bot BotFather has barred from groups,
        because Telegram answers that by opening a chat with the bot too.
        """
        if not self._bot_username or not self._can_join_groups:
            return []
        return [
            BridgeInstallLink(
                key="group",
                label="Add to a Telegram group",
                description=(
                    "Pick a group and confirm — the bot needs no permissions "
                    "there. Switch creates the room as it lands, and the bot "
                    "says in the chat whether it can see the conversation."
                ),
                url=(
                    f"https://t.me/{self._bot_username}?startgroup={_INSTALL_PAYLOAD}"
                ),
            )
        ]

    async def install_note(self) -> str | None:
        """Where to go for a broadcast channel, which has no link.

        Telegram admits a bot to a channel as an administrator or not at all,
        and the parameter that would grant that in a link is not honoured by
        every Telegram client. So there is nothing to click, and the operator
        is told the route that does work rather than left looking for a button.
        """
        return (
            "Broadcast channels have no link: Telegram only admits a bot to one "
            "as an administrator, and no link does that on every Telegram "
            "client. Add the bot from the channel itself — Administrators → Add "
            "Admin → the bot → Post Messages, Edit Messages, Delete Messages — "
            "and Switch adopts it as a room the moment it lands."
        )

    def _make_on_update(self) -> Callable[[Any, Any], Coroutine[Any, Any, None]]:
        async def on_update(update: Any, _context: Any) -> None:
            try:
                await self._handle_update(update)
            except Exception:
                logger.exception("Failed to handle inbound Telegram update")

        return on_update

    async def stop(self) -> None:
        app = self._app
        self._app = None
        if app is not None:
            for shutdown in (
                app.updater.stop if app.updater else None,
                app.stop,
                app.shutdown,
            ):
                if shutdown is None:
                    continue
                try:
                    await shutdown()
                except Exception:
                    logger.exception("Error while stopping the Telegram adapter")
        self._bot = None
        logger.info("Telegram adapter stopped")

    def _require_bot(self) -> Any:
        if self._bot is None:
            raise RuntimeError("Telegram bot not connected")
        return self._bot

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Post as the bot with the agent's name at the head of the message.

        Telegram offers no per-message identity, so the name is part of the body
        — the same degradation Discord falls back to in DMs, applied everywhere.
        """
        agent = await self.agent_rendering(sender_name)
        body = self._attribute(sender_name, agent.body_label, content)
        return await self._send_text(channel_id, body, thread_root_id)

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
        """Relay one file, as a photo when Telegram will render it inline.

        Images go through sendPhoto so they preview in the timeline; everything
        else goes through sendDocument, which preserves the bytes as uploaded.
        Falls back to the base text notice on failure so a file is never
        silently dropped.
        """
        agent = await self.agent_rendering(sender_name)
        attributed = self._attribute(
            sender_name, agent.body_label, self.translate_outbound(caption or "")
        )
        caption_text, overflow_ref = await self._split_caption(
            channel_id, attributed, thread_root_id
        )

        bot = self._require_bot()
        kwargs = await self._anchor_kwargs(channel_id, thread_root_id)
        try:
            if self._is_photo(mimetype, len(data)):
                sent = await bot.send_photo(
                    chat_id=self._chat_id(channel_id),
                    photo=data,
                    caption=caption_text or None,
                    parse_mode=ParseMode.HTML,
                    **kwargs,
                )
            else:
                sent = await bot.send_document(
                    chat_id=self._chat_id(channel_id),
                    document=data,
                    filename=filename,
                    caption=caption_text or None,
                    parse_mode=ParseMode.HTML,
                    **kwargs,
                )
            return overflow_ref or self._ref(sent)
        except TelegramError as e:
            logger.error(
                "Failed to send attachment '%s' to Telegram chat %s: %s",
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
                # An overflowing caption has already been posted on its own;
                # handing it to the fallback would send it a second time.
                None if overflow_ref else caption,
                thread_root_id,
            )

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Relay several files as one Telegram album.

        sendMediaGroup posts two to ten items as a single message, but will not
        mix photos with documents — so a mixed or out-of-range batch falls back
        to the base one-at-a-time behaviour rather than being rejected.
        """
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

        photos = [self._is_photo(f.mimetype, len(f.data)) for f in files]
        groupable = (
            _MEDIA_GROUP_MIN <= len(files) <= _MEDIA_GROUP_MAX and len(set(photos)) == 1
        )
        if not groupable:
            return await super().send_attachments(
                channel_id, sender_name, files, caption, thread_root_id
            )

        agent = await self.agent_rendering(sender_name)
        attributed = self._attribute(
            sender_name, agent.body_label, self.translate_outbound(caption or "")
        )
        caption_text, overflow_ref = await self._split_caption(
            channel_id, attributed, thread_root_id
        )

        media: list[Any] = []
        for index, file in enumerate(files):
            # Only the first item's caption is shown for the album as a whole.
            item_caption = caption_text or None if index == 0 else None
            if photos[0]:
                media.append(
                    InputMediaPhoto(
                        media=file.data,
                        caption=item_caption,
                        parse_mode=ParseMode.HTML,
                    )
                )
            else:
                media.append(
                    InputMediaDocument(
                        media=file.data,
                        filename=file.filename,
                        caption=item_caption,
                        parse_mode=ParseMode.HTML,
                    )
                )

        bot = self._require_bot()
        try:
            sent = await bot.send_media_group(
                chat_id=self._chat_id(channel_id),
                media=media,
                **await self._anchor_kwargs(channel_id, thread_root_id),
            )
        except TelegramError as e:
            logger.error(
                "Failed to send a %d-file album to Telegram chat %s: %s — "
                "falling back to one message per file",
                len(files),
                channel_id,
                e,
            )
            return await super().send_attachments(
                channel_id,
                sender_name,
                files,
                None if overflow_ref else caption,
                thread_root_id,
            )
        first = sent[0] if sent else None
        return overflow_ref or (self._ref(first) if first is not None else None)

    def slash_invite_hint(self) -> str:
        # Telegram hands a command's whole tail through as message text, so the
        # invocation reads exactly like the `!` form.
        #
        # The underscore spelling leads because it is the only one Telegram
        # itself will offer: a registered command may not contain a hyphen, so
        # `/invite_agent` is what the command menu autocompletes and what the
        # client renders as a tappable command. The hyphenated form is still
        # accepted — `_parse_command` translates it back — and is named so that
        # someone copying it from the docs or from another platform is not left
        # thinking they typed it wrong.
        return (
            "`/invite_agent @agent-name` — the Telegram slash command, as the "
            "menu offers it (`/invite-agent` works too)"
        )

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        # Admin/system notices post unattributed, so they read as the bridge
        # speaking rather than as one of the agents.
        #
        # They arrive as Switch Markdown, like every other body, and have to be
        # converted the same way: everything here goes out with parse_mode HTML,
        # so an unconverted notice reaches the chat with its `**` and backticks
        # showing. Platforms with a Markdown-ish native format got away with
        # skipping this; Telegram does not.
        return await self._send_text(
            channel_id,
            self._admin_body(self.translate_outbound(content), drawn),
            thread_root_id,
        )

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        chat_ref, message_id = self._parse_message_ref(message_ref)
        if not message_id:
            logger.error("Cannot update message: invalid message ref %s", message_ref)
            return
        bot = self._require_bot()
        try:
            await bot.edit_message_text(
                chat_id=self._chat_id(chat_ref or channel_id),
                message_id=int(message_id),
                text=self._clamp(new_content),
                parse_mode=ParseMode.HTML,
                link_preview_options=_NO_PREVIEW,
            )
        except BadRequest as e:
            # An edit that changes nothing is reported as an error; it is not one.
            if "not modified" in str(e).lower():
                return
            # Same disclosed fallback as a send, and for the same reason it is
            # not conditioned on the word "parse": markup Telegram will not
            # accept must not cost the edit entirely, or a status message stays
            # stale for good with nothing on screen saying why.
            logger.warning(
                "Telegram rejected the formatting of an edit to %s (%s) — "
                "resending it unformatted",
                message_ref,
                e,
            )
            try:
                await bot.edit_message_text(
                    chat_id=self._chat_id(chat_ref or channel_id),
                    message_id=int(message_id),
                    text=html.unescape(
                        re.sub(r"<[^>]+>", "", self._clamp(new_content))
                    ),
                    link_preview_options=_NO_PREVIEW,
                )
            except TelegramError as retry_error:
                logger.error(
                    "Failed to update Telegram message %s: %s",
                    message_ref,
                    retry_error,
                )
        except TelegramError as e:
            logger.error("Failed to update Telegram message %s: %s", message_ref, e)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        chat_ref, message_id = self._parse_message_ref(message_ref)
        if not message_id:
            logger.error("Cannot delete message: invalid message ref %s", message_ref)
            return
        bot = self._require_bot()
        try:
            await bot.delete_message(
                chat_id=self._chat_id(chat_ref or channel_id),
                message_id=int(message_id),
            )
        except TelegramError as e:
            logger.error("Failed to delete Telegram message %s: %s", message_ref, e)

    # ── Typing ───────────────────────────────────────────────────────────────

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        if not is_typing:
            # Telegram's chat action is a one-shot (~5s) trigger with no cancel
            # API; it simply expires.
            return
        try:
            bot = self._require_bot()
            await bot.send_chat_action(
                chat_id=self._chat_id(channel_id), action=ChatAction.TYPING
            )
        except Exception:
            logger.exception("Failed to trigger typing in Telegram chat %s", channel_id)

    # ── SDK session publication ──────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        """Telegram's own ceiling for a message body, which is also an edit's.

        The renderers cut to this so the budget is measured on the HTML that
        actually goes on the wire — `_rich_escape` has already run
        `translate_outbound`, and that is what turns one `&` into five
        characters.
        """
        return MAX_MESSAGE

    def rich_markup(self) -> Markup:
        return TELEGRAM_HTML

    def rich_fallback_text(self, content: RichContent) -> str:
        """The drawing `post_rich` sends, minus the agent's name and the buttons.

        Only the text an error carries, so there is nothing here to attribute:
        it is what a caller republishes, logs or shows in the Console when the
        publication did not happen, not something anyone reads under a
        keyboard.

        Which is why it is drawn with `controls=False`. A card that is going to
        carry buttons leaves the options they spell out of its body, and this
        text is for the places that have no buttons — republished on its own, a
        card drawn the other way invites a numbered answer without printing the
        numbers.
        """
        return self._draw(
            content, mention=None, responder=None, prefix="", controls=False
        ).text

    def _draw(
        self,
        content: RichContent,
        *,
        mention: str | None,
        responder: str | None,
        prefix: str,
        controls: bool,
    ) -> Drawn:
        escape = self._rich_escape
        limit = max(1, self.rich_fallback_limit() - len(prefix))
        markup = self.rich_markup()
        if isinstance(content, TurnActivity):
            # Charged to the same budget as the status it follows: a message
            # that just fits, plus a line saying it reached nobody, is a
            # message Telegram refuses — and an edit has no chunking to fall
            # back on.
            tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
            body = turn_status(
                content.items,
                content.turn,
                escape=escape,
                limit=max(1, limit - len(tail)),
                markup=markup,
                elapsed_seconds=content.elapsed_seconds,
                session_url=content.session_url,
                mention=mention,
                error_summary=content.error_summary,
                tool_detail=False,
            )
            return Drawn(text=f"{prefix}{body}{tail}", answerable=False)
        # The mention goes on its own line rather than in front of the heading:
        # a card is a block, and a handle wedged before "Permission needed"
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

    def _controls(
        self, content: RichContent, drawn: Drawn
    ) -> InlineKeyboardMarkup | None:
        """The card's options as buttons, or nothing where a press cannot land.

        One per row. An option's label is a phrase more often than a word, and
        Telegram gives the buttons in a row equal width and truncates what does
        not fit, so a second column would cost the labels rather than save the
        space.

        Nothing at all is the ordinary answer: a status has no options, a
        settled card has none left, and a card that cannot be answered where it
        is showing says so — a live control under that sentence is an
        invitation to the refusal it just explained. Since `update_rich` draws
        the keyboard on every redraw, the controls come off a card at the
        moment it stops being pressable, without anything having to remember
        that it once had them.

        Which of those it is comes from `drawn`, not from reading the request a
        second time. A long detail or a clipped option leaves a body the reader
        cannot decide from, and only the renderer that cut it knows that. A
        press would still resolve against the saved form and settle the
        request — so the whole of the protection is not offering the button.

        A truncated *label* is not that case. The body above it carries the
        option in full, so the reader has what they are agreeing to and the
        button is only the shortest way to say which one.
        """
        if not isinstance(content, RequestCard) or not drawn.answerable:
            return None
        rows: list[list[InlineKeyboardButton]] = []
        for control in offered_controls(content.request):
            data = _callback_data(content.reference.token, control.position)
            if len(data.encode()) > _MAX_CALLBACK_BYTES:
                raise RichContentFailed(
                    f"Cannot put a button on request {content.request.request_id} in "
                    f"Telegram: its press would carry {len(data.encode())} bytes and "
                    f"Telegram allows {_MAX_CALLBACK_BYTES}.",
                    text=self.rich_fallback_text(content),
                )
            rows.append(
                [InlineKeyboardButton(text=_button_label(control), callback_data=data)]
            )
        return InlineKeyboardMarkup(rows) if rows else None

    async def _render_rich(self, content: RichContent, agent_name: str) -> Drawn:
        """Draw `content` as the agent, for one Telegram chat.

        The name is always in the body. Telegram gives a bot no per-message
        identity — no name or avatar override, no webhook equivalent — so one
        bot posts for every agent and the prefix `_attribute` writes is the
        whole of what tells them apart. It is charged to the same message
        budget as the drawing under it.
        """
        agent = await self.agent_rendering(agent_name)
        prefix = (
            f"{self._agent_marker(agent_name)} "
            f"<b>{html.escape(agent.body_label, quote=False)}</b>\n"
        )
        responder = (
            self._mention(content.responder_external_id)
            if isinstance(content, RequestCard)
            else None
        )
        return self._draw(
            content,
            mention=self._mention(content.notify_external_id),
            responder=responder,
            prefix=prefix,
            controls=True,
        )

    def _mention(self, external_user_id: str | None) -> str | None:
        """A real Telegram mention for a user id, or nothing.

        `tg://user?id=N` notifies whether or not the account has a public
        handle, which a bare `@name` does not, so the id is the thing worth
        linking. The anchor still needs text, and the only honest text is the
        name this bridge has actually seen the account use: an account that
        has never spoken here gets no mention rather than a made-up handle
        that names the wrong person or nobody.

        Losing it costs emphasis, not delivery. Telegram notifies everyone in
        a chat of a new message without anyone being named, which is why
        `notifies_only_by_mention` is False here.
        """
        if not external_user_id:
            return None
        try:
            user_id = int(external_user_id)
        except ValueError:
            logger.warning(
                "Cannot mention %r on Telegram: it is not a user id.",
                external_user_id[:64],
            )
            return None
        name = self._user_names.get(user_id)
        if not name:
            logger.debug(
                "No name known for Telegram user %s, so the publication names "
                "nobody. Everyone in the chat is notified of it regardless.",
                user_id,
            )
            return None
        label = html.escape(f"@{name}", quote=False)
        return f'<a href="tg://user?id={user_id}">{label}</a>'

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a turn's status or a request's card, attributed to the agent.

        Raises on every failure, unlike `send_message`, which reports one by
        returning `None`: a publication that silently did not happen is a
        reservation nothing retries and a turn the channel never sees. What it
        raises is the point — `RichContentFailed` is the caller's licence to
        discard the reservation and try again, so it is reserved for a refusal
        Telegram actually gave. A send whose outcome nobody knows raises the
        transport's own error and keeps the reservation.

        No plain-text retry, which `_send_chunk` has and this deliberately does
        not. That retry exists for relayed host text, where losing the markup
        beats losing the message; here the markup is Switch's own and a chat
        that refuses it is a chat where the next redraw will be refused too.
        Reporting the refusal is what lets the publisher fall back once, in one
        place, instead of each platform inventing a degraded card of its own.

        Not chunked either. A publication is edited for the life of a turn, and
        an edit cannot be split, so a drawing that would not fit into one
        message must not be posted across two — the renderers cut to
        `rich_fallback_limit` for exactly that reason and `_clamp` is the
        backstop if something still overruns.
        """
        drawn = await self._render_rich(content, agent_name)
        text = drawn.text
        self._refuse_while_throttled(text)
        self._pace_publication(channel_id, content, text)
        controls = self._controls(content, drawn)
        anchor = await self._publication_anchor(channel_id, thread_root_id, text)
        try:
            sent = await self._require_bot().send_message(
                chat_id=self._chat_id(channel_id),
                text=self._clamp(text),
                parse_mode=ParseMode.HTML,
                link_preview_options=_NO_PREVIEW,
                reply_markup=controls,
                **anchor,
            )
        except Exception as error:
            raise self._rich_failure(
                error,
                f"Telegram refused the post in chat {channel_id}",
                self.rich_fallback_text(content),
            ) from error
        ref = self._ref(sent)
        self._note_publication(channel_id)
        return ref

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a publication in place, including the last time.

        A status is never taken down. It is edited to its final state
        and stays in the chat as the record that the turn ran, how long it
        took, and where to open it — which is what a reader scrolling back
        wants and what a deletion left them without. It is compact for the same
        reason it used to be deleted: a Telegram chat or topic is the
        conversation itself, so the status is a line and its link rather than a
        running commentary on tool calls. An answered request card does come
        down, through `remove_publication` and never through a redraw.

        `agent_name` is what the redraw writes back into the body. The name is
        the message here — one bot posts for every agent — so an edit that did
        not know it would republish this turn as whoever the process last
        happened to remember, or as nobody.

        Not `update_message`, which logs and returns. That is right for a
        status line nobody is waiting on and wrong here: a card that failed to
        redraw is still showing a settled request as open, and the caller has a
        reply to post about that — but only if it is told.
        """
        chat_id, message_id = self._parse_message_ref(message_ref)
        if not message_id:
            raise RichContentFailed(
                f"Cannot redraw Telegram publication {message_ref!r}: it is not a "
                "chat:message reference.",
                text=self.rich_fallback_text(content),
            )
        # A post notifies; an edit does not. Repeating the mention on every
        # redraw would be a handle in the chat that never reaches anybody it
        # has not already reached.
        drawn = await self._render_rich(
            replace(content, notify_external_id=None), agent_name
        )
        self._refuse_while_throttled(drawn.text)
        self._pace_publication(channel_id, content, drawn.text)
        await self._edit_rich(
            channel_id,
            message_ref,
            drawn.text,
            self._controls(content, drawn),
            content=content,
        )

    async def _edit_rich(
        self,
        channel_id: str,
        message_ref: str,
        text: str,
        controls: InlineKeyboardMarkup | None,
        *,
        content: RichContent,
    ) -> None:
        """Rewrite a publication, reporting a refusal rather than logging it.

        `controls` is the whole of what the message offers afterwards, not an
        addition to what it offered before: Telegram replaces the keyboard with
        what an edit carries, so passing none is how a settled card's buttons
        come off.

        `content` is here for the refusal rather than the edit. What a
        `RichContentFailed` carries is redrawn from it without a keyboard,
        because the caller's answer to a refused edit is to republish the card
        as plain text — and `text` is a drawing that left its options to the
        buttons about to go with it.
        """
        chat_id, message_id = self._parse_message_ref(message_ref)
        try:
            await self._require_bot().edit_message_text(
                chat_id=self._chat_id(chat_id or channel_id),
                message_id=int(message_id),
                text=self._clamp(text),
                parse_mode=ParseMode.HTML,
                link_preview_options=_NO_PREVIEW,
                reply_markup=controls,
            )
        except BadRequest as error:
            # The one refusal that means the work is already done: an edit to
            # the text Telegram is already showing.
            if "not modified" in str(error).lower():
                self._note_publication(channel_id)
                return
            raise self._rich_failure(
                error,
                f"Telegram refused the edit to {message_ref} in chat {channel_id}",
                self.rich_fallback_text(content),
            ) from error
        except Exception as error:
            raise self._rich_failure(
                error,
                f"Telegram refused the edit to {message_ref} in chat {channel_id}",
                self.rich_fallback_text(content),
            ) from error
        self._note_publication(channel_id)

    def _rich_failure(self, error: Exception, description: str, text: str) -> Exception:
        """The exception to raise for `error`: Telegram's refusal, or its own.

        Raising the original back is what keeps an uncertain send's reservation
        alive, so this returns rather than raises — the caller writes
        `raise ... from error` and the chain stays intact either way.

        A `RetryAfter` on the way through records when the chat will accept
        anything again. Telegram charges the limit to the chat rather than to
        the message, so one throttled redraw is the whole chat asking for
        quiet, and the next publication in it waits rather than discovering
        the same thing for itself.
        """
        failure = _as_rich_failure(error, description=description, text=text)
        if isinstance(failure, RichContentThrottled):
            self._rich_update_after = time.monotonic() + failure.retry_after
        return failure or error

    async def remove_publication(self, channel_id: str, message_ref: str) -> None:
        """Take an answered card out of the chat, or say why it is still there.

        Telegram's own limit is the interesting case: a bot may delete its own
        message for 48 hours and not after, and it reports the refusal as a
        `BadRequest` saying the message cannot be deleted. That is a real
        failure and is raised as one — the card stays, settled and readable,
        which is the intended fallback. Nothing here shortens the wait, so a
        card left open long enough is one Telegram will not take back.

        Told the message is not there, this returns: the address came from
        Telegram when it accepted the card, so nothing remains at it, which is
        what the caller asked for.

        No thread or topic is named. Telegram's `deleteMessage` takes a chat
        and a message id, and a forum topic is a property of the message
        rather than an address to re-supply.
        """
        if self._bot is None:
            raise RemovalFailed("Telegram bot not connected.")

        chat_ref, message_id = self._parse_message_ref(message_ref)
        if not chat_ref or not message_id.isdigit():
            # The edit path falls back to the channel argument for a missing
            # chat, and this does not. An edit that lands on the wrong message
            # rewrites one of ours or is refused; a deletion is neither
            # reversible nor confined to our own messages, so an address
            # Telegram never issued is not one to complete from context.
            raise RemovalFailed(
                f"Not a Telegram chat:message reference: {message_ref}."
            )

        waiting = f"Waiting for Telegram to allow {message_ref} to be deleted."
        # A 429 is charged to the bot, so a deletion sent into one is a second
        # refusal and a longer wait. The caller is a publisher that can come
        # back; it is told to.
        self._refuse_while_throttled(waiting)

        try:
            await self._bot.delete_message(
                chat_id=self._chat_id(chat_ref),
                message_id=int(message_id),
            )
        except BadRequest as error:
            if "message to delete not found" in str(error).lower():
                # Worth a line: the innocent reading is a deletion whose
                # acknowledgement we lost, or one done by hand, but this is
                # also what Telegram says about an address it never issued.
                logger.warning(
                    "Telegram card %s was already gone when it was taken back.",
                    message_ref,
                )
                return
            raise self._removal_failure(error, message_ref, channel_id) from error
        except Exception as error:
            raise self._removal_failure(error, message_ref, channel_id) from error

    def _removal_failure(
        self, error: Exception, message_ref: str, channel_id: str
    ) -> Exception:
        """What a failed deletion should be reported as.

        Only a wait survives as itself, and it goes through `_rich_failure` so
        the chat's quiet period is recorded for every other publication in it.
        Everything else — a refusal, the 48-hour limit, a request that never
        came back — becomes `RemovalFailed`, because the caller does the same
        thing with all three: keep the settled card, record nothing, and ask
        again later. The uncertainty an uncertain *send* has to preserve does
        not arise here, since asking again about a deletion that did land is
        answered with "not found".
        """
        description = f"Telegram would not delete {message_ref} in chat {channel_id}"
        classified = self._rich_failure(
            error,
            description,
            f"Waiting for Telegram to allow {message_ref} to be deleted.",
        )
        if isinstance(classified, RichContentThrottled):
            return classified
        return RemovalFailed(f"{description}: {error}")

    def _refuse_while_throttled(self, text: str) -> None:
        """Wait out a 429 Telegram has already sent for this bot.

        Raised rather than slept through: the caller is a durable publisher
        that knows what it is holding and can come back, and sleeping here
        would hold up every other chat this bridge serves.
        """
        remaining = self._rich_update_after - time.monotonic()
        if remaining > 0:
            raise RichContentThrottled(retry_after=remaining, text=text)

    def _pace_publication(
        self, channel_id: str, content: RichContent, text: str
    ) -> None:
        """Hold back progress arriving faster than the chat can take it.

        Charged to the chat and not to the message, for both sends and edits.
        Telegram's limits are the chat's, several agents can be working in one
        group at once, and nothing published says what an edit costs — so two
        agents' statuses share one budget the way they share the 429 that
        follows from overspending it.

        Only progress. A turn's final state, the attention slot and every
        request card go through however recently the chat was last written to,
        because a reader waiting on one of those is waiting on precisely the
        thing this would delay — and the publisher retries a throttle, so what
        is held back here is postponed rather than lost.
        """
        if not isinstance(content, TurnActivity):
            return
        if content.turn.status in TURN_ENDED or content.error_summary:
            return
        drawn_at = self._rich_drawn_at.get(channel_id)
        if drawn_at is None:
            return
        remaining = drawn_at + _REDRAW_INTERVAL - time.monotonic()
        if remaining > 0:
            raise RichContentThrottled(retry_after=remaining, text=text)

    def _note_publication(self, channel_id: str) -> None:
        self._rich_drawn_at.pop(channel_id, None)
        self._rich_drawn_at[channel_id] = time.monotonic()
        while len(self._rich_drawn_at) > self._rich_drawn_at_max:
            self._rich_drawn_at.popitem(last=False)

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
        """Put 👀 on the message being worked on, or take it off.

        One mark between every agent, because every agent reacts through the
        one bot account and Telegram has a single reaction per account per
        message. The publisher counts the turns holding it, so the first to
        want it adds it and the last to finish removes it.

        That single reaction is also why `supports_queue_reaction` is false
        here and `mark` is only ever the working one: a second mark could only
        be put on by taking this one off, and a queued prompt saying nothing is
        better than a running one that has stopped saying it is being read.
        Telegram carries the queued state in its status text instead.

        `force` is the durable publisher reconciling after a restart, when this
        process's record of what is already on the message is empty and wrong
        rather than empty and right.

        Raises where another attempt might work, so the publisher retries and
        records the turn as drawn only once the chat shows what it says it
        shows. A chat that will not take the mark at all is not that — reactions
        are switched off there, or the bot may not use them, and it would be
        refused the same way for the life of the turn — so that is raised as
        `ActivityMarkRefused` and the publisher decides what it means.

        It decides, and not this method, because the question a refused
        *removal* asks is whether a mark is still sitting on the message, and
        the answer does not live here. `self._reacted` is this process's memory
        and a restart empties it; empty then means "no idea", not "nothing was
        added". Treating those as the same is how a turn came to be recorded as
        cleaned up with the 👀 still on the message. The durable record knows
        whether an addition was ever refused, so the durable record is asked.
        """
        _, message_id = self._parse_message_ref(message_ref)
        if not message_id:
            logger.warning(
                "Cannot mark %s as being worked on: not a Telegram message reference.",
                message_ref,
            )
            return
        key = (channel_id, message_id)
        if not force and on == (key in self._reacted):
            return
        try:
            await self._require_bot().set_message_reaction(
                chat_id=self._chat_id(channel_id),
                message_id=int(message_id),
                reaction=[ReactionTypeEmoji(_WORKING_REACTION)] if on else [],
            )
        except (BadRequest, Forbidden) as error:
            raise ActivityMarkRefused(
                f"Telegram will not {'add' if on else 'remove'} the working "
                f"reaction on {message_id} in chat {channel_id} ({error})."
            ) from error
        if on:
            self._reacted.add(key)
        else:
            self._reacted.discard(key)

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """The one-shot typing nudge, where the agent was asked.

        Telegram expires it after about five seconds, so it costs the chat
        nothing and it is the only signal that arrives before the first post.
        Best effort by nature: the status carries the state from here on.

        In a forum it goes into the topic the command came from — people
        reading one topic do not see another's — which is the only sense a
        thread root has here. Outside a forum the root is a message to reply
        to and there is nothing to send an action to but the chat, so it is
        not passed on: `message_thread_id` set to a reply target would aim the
        nudge at a topic that is not one. A forum whose topic cannot be
        located gets no nudge at all rather than one in General, and neither
        does one whose chat cannot be read: working out where this belongs is
        part of the best effort, not a precondition of the status that follows.
        """
        try:
            topic = await self._topic_kwargs(channel_id, thread_root_id)
            if topic is None:
                return
            await self._require_bot().send_chat_action(
                chat_id=self._chat_id(channel_id),
                action=ChatAction.TYPING,
                **topic,
            )
        except Exception as error:
            logger.warning(
                "Could not signal in Telegram chat %s that %s has started: %s.",
                channel_id,
                agent_name,
                error,
            )

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        raise ChannelCreationUnsupported(
            "Telegram bots cannot create chats — the Bot API has no such call. "
            f"Create the group for '{name}' in a Telegram client and add "
            f"@{self._bot_username} to it — from the group itself, or with the "
            "'Add to a chat' link on the bridge in the operator dashboard — and "
            "Switch adopts it as a room as the bot lands."
        )

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        """A link that opens this chat in Telegram, or None when it has none.

        A chat with a public username has a real `t.me/<name>` address that
        works anywhere. A private supergroup or channel only has the internal
        form, which needs a message id — bare `t.me/c/<id>` does not reliably
        resolve — and opens only for members. A basic group (one that has never
        been upgraded to a supergroup) has no address at all, so it gets none
        rather than a button that goes nowhere.
        """
        if not external_channel_id:
            return None

        username = await self._chat_username(external_channel_id)
        if username:
            return f"https://t.me/{username}"

        if not external_channel_id.startswith(_SUPERGROUP_PREFIX):
            return None
        internal = external_channel_id[len(_SUPERGROUP_PREFIX) :]
        if not internal.isdigit():
            return None
        return f"https://t.me/c/{internal}/1"

    async def _chat_username(self, channel_id: str) -> str | None:
        """The chat's public `@name`, if it has one.

        Best effort: a failed lookup falls through to the id-derived link
        rather than costing the caller its button, and is not cached — only a
        chat that answered is, so a transient failure does not stick.
        """
        if self._bot is None:
            return None
        if channel_id in self._chat_usernames:
            return self._chat_usernames[channel_id]
        try:
            chat = await self._bot.get_chat(self._chat_id(channel_id))
        except Exception:
            logger.debug(
                "Could not resolve Telegram chat %s while building a deeplink",
                channel_id,
                exc_info=True,
            )
            return None
        username = getattr(chat, "username", None)
        resolved = str(username) if username else None
        self._chat_usernames[channel_id] = resolved
        return resolved

    async def home_deeplink(self) -> str | None:
        """`https://t.me/<bot username>` — the bot's own chat, which is the
        closest thing Telegram has to a workspace. Built from the configured
        username; the token never appears in it."""
        if not self._bot_username:
            return None
        return f"https://t.me/{self._bot_username}"

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        bot = self._require_bot()
        chat = await bot.get_chat(self._chat_id(channel_id))
        return self._channel_type_of(chat)

    def _channel_type_of(self, chat: Any) -> ChannelType:
        """Map a Telegram chat to the bridge's ChannelType.

        1:1 chats with the bot are the lobby, matching Slack's im and Discord's
        DM. A group is public when it has a username (a `t.me/<name>` handle
        anyone can follow) and private otherwise.
        """
        chat_type = getattr(chat, "type", None)
        if chat_type == ChatType.PRIVATE:
            return "lobby"
        if chat_type == ChatType.GROUP:
            # Basic groups are invite-only and cannot have a username.
            return "channel_private"
        if getattr(chat, "username", None):
            return "channel_public"
        return "channel_private"

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
        # The Bot API has no call that adds a member to a chat — a person joins
        # from a Telegram client or an invite link. Say so rather than reporting
        # a membership change that never happened.
        if not user_names:
            return []
        logger.warning(
            "Cannot add %s to Telegram chat %s — the Bot API cannot add members; "
            "they must join from a Telegram client or an invite link",
            ", ".join(user_names),
            channel_id,
        )
        return list(user_external_ids)

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None:
        pass

    async def remove_agent_identity(self, agent_name: str) -> None:
        pass

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Mentions ─────────────────────────────────────────────────────────────

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        """Seed the handle → numeric id map used to render outbound mentions.

        Telegram only notifies a person from a bare `@handle` when they have a
        public username; everyone else has to be addressed by numeric id. Taking
        the mapping up front means a person who has not yet spoken in the chat
        is still mentioned properly, rather than seeing their name as plain text.
        """
        for username, user_id in targets.items():
            if not username or not str(user_id).lstrip("-").isdigit():
                continue
            numeric = int(user_id)
            self._username_to_id[username] = numeric
            self._user_names.setdefault(numeric, username)

    # ── Translation ──────────────────────────────────────────────────────────

    _CODE_BLOCK_RE = re.compile(r"```[A-Za-z0-9_+.-]*\n?(.*?)```", re.DOTALL)
    _INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
    _HEADING_RE = re.compile(r"^ {0,3}#{1,6}[ \t]+(.*)$", re.MULTILINE)
    _BULLET_RE = re.compile(r"^([ \t]*)[-*+][ \t]+", re.MULTILINE)
    # `[` is excluded from the label and `(` from the target deliberately: with
    # them allowed, a run of unmatched `[` makes the engine retry the whole tail
    # from every position, which is quadratic — seconds of blocked event loop on
    # a paste of bracketed log lines, and a denial of service on a hostile one.
    _LINK_RE = re.compile(r"\[([^\[\]\n]*)\]\(([^()\s]*)\)")
    _BOLD_RE = re.compile(r"\*\*([^\n]+?)\*\*")
    _STRIKE_RE = re.compile(r"~~([^\n]+?)~~")
    _ITALIC_STAR_RE = re.compile(r"(?<![\w*])\*([^*\n]+?)\*(?![\w*])")
    _ITALIC_USCORE_RE = re.compile(r"(?<![\w_])_([^_\n]+?)_(?![\w_])")
    _MENTION_RE = re.compile(r"@([A-Za-z0-9][A-Za-z0-9._-]*)")

    def translate_outbound(self, content: str) -> str:
        """Render Switch's Markdown as the HTML subset Telegram accepts.

        Telegram's own MarkdownV2 is not Markdown — it requires escaping a long
        list of ordinary punctuation, and a single stray character makes the API
        reject the whole message. HTML has one escaping rule and a small, stable
        tag set, so the body is converted once here and sent with parse_mode
        HTML. Tables are left alone: Telegram has no table rendering, so they go
        out as the plain text they already are.
        """
        if not content:
            return ""

        # Code spans are extracted before anything else so their contents are
        # never treated as markup, then restored at the end.
        stash: list[str] = []

        def _stash(rendered: str) -> str:
            stash.append(rendered)
            return f"\x00{len(stash) - 1}\x00"

        def _block(match: re.Match[str]) -> str:
            code = html.escape(match.group(1).strip("\n"), quote=False)
            return _stash(f"<pre>{code}</pre>")

        def _inline(match: re.Match[str]) -> str:
            return _stash(f"<code>{html.escape(match.group(1), quote=False)}</code>")

        text = self._CODE_BLOCK_RE.sub(_block, content)
        text = self._INLINE_CODE_RE.sub(_inline, text)

        text = html.escape(text, quote=False)

        text = self._HEADING_RE.sub(r"<b>\1</b>", text)
        text = self._BULLET_RE.sub(r"\1• ", text)
        text = self._BOLD_RE.sub(r"<b>\1</b>", text)
        text = self._STRIKE_RE.sub(r"<s>\1</s>", text)
        text = self._ITALIC_STAR_RE.sub(r"<i>\1</i>", text)
        text = self._ITALIC_USCORE_RE.sub(r"<i>\1</i>", text)

        # Links are rendered after the inline marks — so a formatted label still
        # converts — and stashed like code spans, because the mention pass that
        # follows would otherwise rewrite an `@name` sitting in the label or the
        # target, nesting an anchor inside an anchor. Telegram rejects that, and
        # a rejected caption or edit has no plain-text retry to fall back on.
        def _link(match: re.Match[str]) -> str:
            label, href = match.group(1), match.group(2)
            # Already HTML-escaped by the pass above, so only the quote needs
            # handling here — escaping again would double up the entities.
            if not href.lower().startswith(_LINKABLE_SCHEMES):
                # Disclosed degradation: the address stays in the message as a
                # code span, which Telegram makes tap-to-copy, rather than
                # being swallowed with the anchor.
                shown = _stash(f"<code>{href}</code>")
                return f"{label}: {shown}" if label else shown
            attr = href.replace('"', "&quot;")
            return _stash(f'<a href="{attr}">{label}</a>')

        text = self._LINK_RE.sub(_link, text)
        text = self._MENTION_RE.sub(self._render_mention, text)

        for index, rendered in enumerate(stash):
            text = text.replace(f"\x00{index}\x00", rendered)
        return text

    def _render_mention(self, match: re.Match[str]) -> str:
        """An `@name` we can resolve becomes a real mention; anything else is
        left as written.

        A bare `@handle` is linked by the Telegram client itself when the
        username exists, so leaving an unresolved name alone still works for
        anyone with a public handle — and an agent's name, which is not a
        Telegram user at all, correctly stays plain text."""
        user_id = self._username_to_id.get(match.group(1))
        if user_id is None:
            return match.group(0)
        return f'<a href="tg://user?id={user_id}">{match.group(0)}</a>'

    def translate_inbound(self, raw_message: str) -> str:
        """Telegram delivers plain text with `@handle` mentions already written
        the way Switch expects, so there is nothing to rewrite. Formatting is
        carried out-of-band in message entities, which the bridge does not
        consume."""
        return raw_message

    # ── Update handling ──────────────────────────────────────────────────────

    async def _handle_update(self, update: Any) -> None:
        # That Telegram delivered something, and for which chat. With privacy
        # mode on, the absence of a line here for a message someone can see in
        # the chat is the whole diagnosis — which needs the shape of the update,
        # not its contents, so the body and sender are deliberately left out.
        logger.debug(
            "Telegram update %s received (%s)",
            getattr(update, "update_id", "?"),
            self._update_shape(update),
        )
        chat_member = getattr(update, "my_chat_member", None)
        if chat_member is not None:
            await self._handle_my_chat_member(chat_member)
            return

        callback = getattr(update, "callback_query", None)
        if callback is not None:
            await self._handle_callback_query(callback)
            return

        message = getattr(update, "message", None) or getattr(
            update, "channel_post", None
        )
        if message is not None:
            await self._handle_message(message)

    async def _handle_callback_query(self, query: Any) -> None:
        """Someone pressed a button on a card this bridge posted.

        Who pressed comes from `from_user`, which Telegram fills in and the
        payload cannot: the data in the button says which request and which
        option, never who. So a press replayed from someone else's client is
        still attributed to whoever actually sent it, and the identity check
        downstream is against a real account rather than a claim.

        The press is answered on every path out of here. Until it is, the
        presser's client keeps the button in a loading state and will
        eventually decide for itself that something broke — including on the
        paths where nothing happened, which is what a press on a keyboard this
        bridge did not write is.

        A refusal reaches the presser through `tell_actor`, which leaves it in
        `_PRESS_NOTICE` for the answer below rather than posting it in the
        chat. It is collected in a `finally` so that a handler which raises
        still closes the press: the exception belongs in the log, not on the
        button.

        Nothing here dedupes. Telegram redelivers an update it was not
        acknowledged for, and the same press twice is the same option, by the
        same person, against the same revision — which the shared layer derives
        one command id from, so the second is the first rather than a second
        answer.
        """
        query_id = str(getattr(query, "id", "") or "")
        message = getattr(query, "message", None)
        chat = getattr(message, "chat", None)
        user = getattr(query, "from_user", None)
        press = _parse_callback(str(getattr(query, "data", "") or ""))
        if press is None or chat is None or user is None:
            await self._answer_callback(query_id, None)
            return
        if self._on_interaction is None:
            logger.warning(
                "A press on a Switch card in chat %s has nowhere to go: this "
                "bridge handles no interactions, so the card should not have "
                "been drawn with buttons.",
                getattr(chat, "id", "?"),
            )
            await self._answer_callback(query_id, None)
            return

        token, position = press
        name = self._display_name(user)
        # A press is a sighting of that account in this chat, and the same
        # thing a message teaches: the name a mention needs, and the id a
        # handle resolves to.
        self._user_names[user.id] = name
        self._username_to_id[name] = user.id

        notices: list[str] = []
        held = _PRESS_NOTICE.set(notices)
        try:
            await self._on_interaction(
                InboundInteraction(
                    channel_id=str(chat.id),
                    sender_id=str(user.id),
                    sender_name=name,
                    action_id=position_action(position),
                    value=token,
                    message_ref=self._ref(message),
                )
            )
        finally:
            _PRESS_NOTICE.reset(held)
            await self._answer_callback(query_id, notices[0] if notices else None)

    async def _answer_callback(self, query_id: str, notice: str | None) -> None:
        """Close a press on the presser's own client, and say why if it failed.

        `show_alert` for a notice, because a toast is gone in a moment and what
        is being said is why an answer did not land. Without one this is the
        acknowledgement Telegram requires and nothing more: the card's own
        redraw is what says an answer was taken, and claiming it here would be
        claiming it before the redraw that proves it.

        Plain text, unescaped, because an alert is not markup — the reason
        quotes back what the host called an option, and HTML escaping it would
        put the escapes on the screen.

        A refusal from Telegram is logged and left. The query expires by
        itself, nothing downstream waits on it, and the answer it would have
        acknowledged has already been decided either way.
        """
        if not query_id:
            return
        text = None
        if notice is not None:
            text = (
                notice
                if len(notice) <= _MAX_ALERT
                else notice[: _MAX_ALERT - 1].rstrip() + "…"
            )
        try:
            await self._require_bot().answer_callback_query(
                callback_query_id=query_id, text=text, show_alert=text is not None
            )
        except Exception as error:
            logger.warning(
                "Telegram would not acknowledge a press (%s). The notice, if "
                "there was one, went unsaid: %s",
                error,
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
        """Tell one person their answer did not land, where they can see it.

        A press is told in the reply to the press itself: an alert on their
        client alone, which costs the chat nothing and reaches them whether or
        not they have ever opened a chat with the bot — a bot cannot message
        someone who has not. It is left here for the press to carry rather than
        sent from here, because the id that addresses it belongs to the press.

        A typed answer has no press to reply to, so it falls back to the base:
        said in the card's own thread, where everyone reading it sees a notice
        addressed to someone else. That is the platform's limit rather than a
        choice — Telegram gives a bot no private reply in a group it can use
        unprompted.
        """
        notices = _PRESS_NOTICE.get()
        if notices is not None:
            notices.append(text)
            return
        await super().tell_actor(channel_id, actor_ref, actor_name, thread_ref, text)

    async def _handle_my_chat_member(self, event: Any) -> None:
        """The bot's own membership changed. Being added is Telegram's
        equivalent of Slack's "app added to channel", and is what provisions the
        chat's room — Discord has no such signal and has to wait for a message.

        Promotion and demotion arrive here too, and they change what the bridge
        can see, so this is also where that is re-checked: being promoted is the
        documented way to turn a mention-only chat into a full one, and nothing
        else would ever retract the warning that said so."""
        new_status = getattr(getattr(event, "new_chat_member", None), "status", None)
        if new_status not in ("member", "administrator"):
            return
        chat = getattr(event, "chat", None)
        if chat is None or self._channel_type_of(chat) == "lobby":
            return
        channel_id = str(chat.id)
        if self._on_app_joined is not None:
            await self._on_app_joined(
                InboundAppJoin(
                    channel_id=channel_id,
                    channel_type=self._channel_type_of(chat),
                    channel_name=getattr(chat, "title", None),
                )
            )
        # After provisioning, so the notice cannot arrive before the room it
        # refers to exists.
        await self.announce_visibility(channel_id)

    async def _handle_message(self, message: Any) -> None:
        chat = message.chat
        chat_id = str(chat.id)
        if await self._handle_migration(message, chat_id):
            return
        channel_type = self._channel_type_of(chat)
        channel_name = getattr(chat, "title", None)

        author = getattr(message, "from_user", None)
        if author is not None and author.id == self._bot_user_id:
            return

        key = (chat_id, int(message.message_id))
        if key in self._seen_ids:
            return
        self._seen_ids[key] = None
        if len(self._seen_ids) > self._seen_ids_max:
            self._seen_ids.popitem(last=False)

        new_members = getattr(message, "new_chat_members", None) or []
        if new_members:
            await self._handle_new_members(
                new_members, chat_id, channel_type, channel_name
            )
            return

        if author is None:
            # Channel posts are authored by the channel, not a person; there is
            # no sender to attribute them to.
            return

        username = self._display_name(author)
        self._user_names[author.id] = username
        self._username_to_id[username] = author.id

        content = str(
            getattr(message, "text", None) or getattr(message, "caption", None) or ""
        )
        root_id = self._root_id_of(message)
        message_ref = f"{chat_id}:{message.message_id}"

        if await self._handle_start(content.strip(), chat_id, channel_type):
            return

        # A reply to one of our "what should I use?" prompts carries the
        # argument the command was missing. Resolved before anything else, so
        # the answer is not bridged into the room as an ordinary message.
        answered = self._take_awaited_command(message)
        if answered is not None and self._on_command:
            await self._on_command(
                InboundCommand(
                    channel_id=chat_id,
                    channel_type=channel_type,
                    sender_id=str(author.id),
                    sender_name=username,
                    command=answered,
                    args=content.strip(),
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return

        parsed = self._parse_command(content.strip())
        if parsed is not None and self._on_command:
            name, args = parsed
            if not args and self._missing_argument(name) is not None:
                await self._prompt_for_argument(chat_id, name, message.message_id)
                return
            await self._on_command(
                InboundCommand(
                    channel_id=chat_id,
                    channel_type=channel_type,
                    sender_id=str(author.id),
                    sender_name=username,
                    command=name,
                    args=args,
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return

        if self._on_message is None:
            return

        attachments, attachment_failures = await self._fetch_attachments(message)
        if not content and not attachments and not attachment_failures:
            # A service message — someone left, the title changed, a message was
            # pinned — carries a real sender and no body. Telegram has no such
            # thing as an empty user message, so nothing to bridge means nothing
            # was said. Relaying it puts a blank line in the room.
            logger.debug(
                "Skipping Telegram service message %s in %s",
                message.message_id,
                chat_id,
            )
            return

        await self._on_message(
            InboundMessage(
                channel_id=chat_id,
                channel_type=channel_type,
                sender_id=str(author.id),
                sender_name=username,
                content=content,
                message_ref=message_ref,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=attachment_failures,
                self_mention_token=(
                    self._bot_username
                    if self._bot_username
                    and f"@{self._bot_username}".lower() in content.lower()
                    else None
                ),
            )
        )

    @staticmethod
    def _update_shape(update: Any) -> str:
        """Which kind of update this is and which chat it belongs to.

        Enough to tell whether Telegram is delivering, without putting message
        bodies or sender names into the log — this runs server-side, where the
        desktop app's redaction does not reach."""
        for field in ("message", "channel_post", "my_chat_member", "callback_query"):
            payload = getattr(update, field, None)
            if payload is None:
                continue
            # A press has no chat of its own; the message its button is on has.
            chat = getattr(payload, "chat", None) or getattr(
                getattr(payload, "message", None), "chat", None
            )
            return f"{field} in chat {getattr(chat, 'id', '?')}"
        return "no recognised payload"

    async def _handle_migration(self, message: Any, chat_id: str) -> bool:
        """Follow the chat when Telegram gives it a new id.

        A basic group becomes a supergroup the moment it outgrows one — adding
        members, promoting a bot, enabling history — and Telegram issues it a
        brand new chat id when that happens. The room stays keyed to the old
        one, so inbound stops matching any room while outbound keeps working,
        because Telegram forwards sends addressed to the old id. Nobody can
        read that asymmetry from the outside, so the room is re-pointed at the
        new id here rather than left for an operator to notice and repair.

        Telegram announces the change from both sides — `migrate_to_chat_id` on
        the last message of the old chat, `migrate_from_chat_id` on the first
        of the new one — and either is enough; the second finds the work done.

        Returns True when the message is the migration notice itself and should
        not be bridged.
        """
        migrated_to = getattr(message, "migrate_to_chat_id", None)
        if migrated_to:
            await self._repoint(chat_id, str(migrated_to))
            return True
        migrated_from = getattr(message, "migrate_from_chat_id", None)
        if migrated_from:
            await self._repoint(str(migrated_from), chat_id)
            return True
        return False

    async def _repoint(self, old_id: str, new_id: str) -> None:
        if self._on_channel_migrated is None:
            logger.error(
                "Telegram chat %s has been reissued the id %s and nothing is "
                "installed to follow it. The room is still bound to the old id, "
                "so messages from the chat no longer reach Switch. Re-point the "
                "room's external channel id at %s",
                old_id,
                new_id,
                new_id,
            )
            return
        logger.warning(
            "Telegram chat %s has been upgraded to a supergroup and reissued the "
            "id %s; re-pointing its room",
            old_id,
            new_id,
        )
        # The new chat is a different chat as far as Telegram is concerned, so
        # anything said about the old one no longer holds.
        self._visibility_announced.pop(old_id, None)
        await self._on_channel_migrated(old_id, new_id)

    async def _handle_new_members(
        self,
        members: list[Any],
        chat_id: str,
        channel_type: ChannelType,
        channel_name: str | None,
    ) -> None:
        for member in members:
            if member.id == self._bot_user_id:
                if self._on_app_joined is not None:
                    await self._on_app_joined(
                        InboundAppJoin(
                            channel_id=chat_id,
                            channel_type=channel_type,
                            channel_name=channel_name,
                        )
                    )
                continue
            if self._on_user_joined is None:
                continue
            await self._on_user_joined(
                InboundUserJoin(
                    channel_id=chat_id,
                    channel_type=channel_type,
                    external_user_id=str(member.id),
                    external_username=self._display_name(member),
                    channel_name=channel_name,
                )
            )

    async def _handle_start(
        self, text: str, chat_id: str, channel_type: ChannelType
    ) -> bool:
        """Absorb Telegram's own `/start` handshake, and read its payload.

        Adding a bot through a `?startgroup=<payload>` link makes Telegram send
        the bot `/start@<bot> <payload>` in the chat it was just added to. That
        is the platform greeting the bot, not somebody running a Switch
        command, so it is answered here instead of being dispatched into the
        room as an unknown one. The payload is what distinguishes an install
        begun from the dashboard, which is worth recording; it authorises
        nothing.

        A bare `/start` in a 1:1 chat is left alone — it is how a person opens
        a conversation with the bot, and swallowing it would leave the DM
        unbridged until they typed again.

        Only groups reach this at all. A channel add sends no `/start` — the
        start parameter is group-only — and a channel post has no sender, so it
        is dropped before here; a channel's visibility is announced from the
        membership event instead.

        Returns True when the message was the handshake and must not be
        bridged.
        """
        parsed = self._parse_command(text)
        if parsed is None or parsed[0] != "start":
            return False
        payload = parsed[1]
        if channel_type == "lobby" and payload != _INSTALL_PAYLOAD:
            return False
        if payload == _INSTALL_PAYLOAD:
            logger.info(
                "Telegram chat %s was added from a Switch install link", chat_id
            )
        else:
            logger.debug("Ignoring a bare Telegram /start in chat %s", chat_id)
        await self.announce_visibility(chat_id)
        return True

    @staticmethod
    def _missing_argument(name: str) -> CommandArg | None:
        """The first required argument of `name`, or None if it takes none.

        Telegram's command menu **sends** a command the instant it is tapped —
        there is no way to have the client put it in the composer for the user
        to finish, and no API to say a command takes arguments. So a command
        that needs one always arrives bare from the menu, and answering with
        its usage line is a dead end: the only way out is to type the whole
        thing by hand, which is what the menu was for.
        """
        command = COMMANDS_BY_NAME.get(name)
        if command is None:
            return None
        return next((arg for arg in command.args_spec if arg.required), None)

    async def _prompt_for_argument(
        self, channel_id: str, name: str, replying_to: int
    ) -> None:
        """Ask for the argument a bare command did not carry, and remember that
        we did, so the answer can be run as the command.

        `ForceReply` opens the composer already replying to the prompt, which
        makes answering one tap rather than a retyped command. `selective` aims
        it at the person who ran the command, so a busy group is not forced to
        reply on their behalf. It also survives a mention-only chat: a reply to
        the bot is one of the few things Telegram still delivers there.
        """
        arg = self._missing_argument(name)
        if arg is None:
            return
        body = self.translate_outbound(
            f"`/{name.replace('-', '_')}` needs one more thing — "
            f"{arg.description[0].lower() + arg.description[1:]}.\n\n"
            "Reply to this message with it."
        )
        try:
            sent = await self._require_bot().send_message(
                chat_id=self._chat_id(channel_id),
                text=body,
                parse_mode=ParseMode.HTML,
                link_preview_options=_NO_PREVIEW,
                reply_parameters=ReplyParameters(
                    message_id=replying_to, allow_sending_without_reply=True
                ),
                reply_markup=ForceReply(
                    selective=True, input_field_placeholder=arg.name
                ),
            )
        except TelegramError as e:
            # Falling back to running the command bare would answer with its
            # usage line, which is the dead end this exists to avoid — so say
            # what happened rather than pretending the prompt went out.
            logger.error(
                "Could not ask for the %s argument of /%s in chat %s: %s",
                arg.name,
                name,
                channel_id,
                e,
            )
            return
        self._awaiting_args[(channel_id, int(sent.message_id))] = name
        if len(self._awaiting_args) > self._awaiting_args_max:
            self._awaiting_args.popitem(last=False)

    def _take_awaited_command(self, message: Any) -> str | None:
        """The command this message answers, if it replies to a prompt of ours.

        One shot: a second reply to the same prompt is an ordinary message, so
        a conversation that happens to continue under it is not swallowed as
        repeated command invocations.
        """
        replied = getattr(message, "reply_to_message", None)
        if replied is None:
            return None
        key = (str(message.chat.id), int(replied.message_id))
        return self._awaiting_args.pop(key, None)

    @staticmethod
    def _parse_command(text: str) -> tuple[str, str] | None:
        """Split an in-room command out of a message, or None if it is not one.

        Telegram's native command convention is `/name`: the client renders it
        as a tappable link and offers autocomplete for it, and — with privacy
        mode left enabled — a `/`-prefixed message is the *only* text a bot
        reliably receives in a group. So `/name` is accepted as a first-class
        command alongside Switch's own `!name`, both mapping to the same
        dispatcher, exactly as Slack's native slash commands already do.
        """
        if not text or text[0] not in _COMMAND_PREFIXES:
            return None
        parts = text.split(None, 1)
        # Picked from Telegram's autocomplete in a group, a command arrives
        # addressed to the bot: `/invite-agent@acme_switch_bot`.
        name = parts[0][1:].split("@", 1)[0]
        if not name:
            return None
        # Telegram will not register a command containing a hyphen, so the menu
        # publishes `invite_agent` for `invite-agent`. Only the `/` form needs
        # that translation back — `!` is Switch's own prefix and its names are
        # spelled exactly as the dispatcher knows them, so rewriting there would
        # silently turn a typo into a different command.
        if text[0] == "/" and name not in COMMANDS_BY_NAME:
            name = name.replace("_", "-")
        return name, parts[1].strip() if len(parts) > 1 else ""

    @staticmethod
    def _root_id_of(message: Any) -> str | None:
        """The thread this message belongs to, as an external ref.

        A forum topic gives a stable `message_thread_id` for every message in
        it. Outside forums Telegram has no thread object, only reply chains, so
        the message being replied to stands in as the root — which is what an
        outbound reply is anchored to anyway.
        """
        thread_id = getattr(message, "message_thread_id", None)
        if thread_id:
            return str(thread_id)
        replied = getattr(message, "reply_to_message", None)
        if replied is not None:
            return str(replied.message_id)
        return None

    @staticmethod
    def _display_name(user: Any) -> str:
        """The handle Switch addresses this person by.

        Telegram usernames are optional, so a person without one is identified
        by their display name with spaces removed — it still has to survive being
        written as `@name` in a room.
        """
        username = getattr(user, "username", None)
        if username:
            return str(username)
        parts = [
            str(getattr(user, "first_name", "") or ""),
            str(getattr(user, "last_name", "") or ""),
        ]
        joined = "".join(part for part in parts if part).strip().replace(" ", "")
        # The numeric id is appended, not used only as a fallback: display names
        # are not unique and stripping the spaces makes collisions likelier
        # still ("Ann Marie" and "AnnMarie" both give AnnMarie). Two people
        # sharing a handle would share a room identity, and a mention meant for
        # one would reach whichever spoke last.
        user_id = getattr(user, "id", "")
        return f"{joined}_{user_id}" if joined else f"user{user_id}"

    # ── Attachments ──────────────────────────────────────────────────────────

    async def _fetch_attachments(
        self, message: Any
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Download every file on a Telegram message, whatever the type.

        Returns the downloaded attachments and, separately, the ones that could
        not be relayed (oversize, download failure) so the bridge can disclose
        them in the room rather than dropping them silently.
        """
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        cap = min(self._max_attachment_bytes, _MAX_DOWNLOAD_BYTES)

        for file_id, filename, mimetype, size in self._describe_files(message):
            if isinstance(size, int) and size > cap:
                logger.warning(
                    "Telegram attachment %s is %d bytes, over the %d cap",
                    filename,
                    size,
                    cap,
                )
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"{size} bytes exceeds the {cap} byte limit",
                    )
                )
                continue
            try:
                bot = self._require_bot()
                handle = await bot.get_file(file_id)
                data = bytes(await handle.download_as_bytearray())
            except Exception as exc:
                logger.exception("Failed to download Telegram attachment %s", filename)
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"download failed: {exc}"
                    )
                )
                continue
            if len(data) > cap:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=f"{len(data)} bytes exceeds the {cap} byte limit",
                    )
                )
                continue
            attachments.append(
                Attachment(filename=filename, mimetype=mimetype, data=data)
            )
        return attachments, failures

    @staticmethod
    def _describe_files(message: Any) -> list[tuple[str, str, str, int | None]]:
        """Every downloadable file on a message as
        `(file_id, filename, mimetype, size)`.

        Telegram models each media kind as its own field rather than one
        attachments list, and a photo arrives as a ladder of resized versions of
        which only the last is worth relaying."""
        found: list[tuple[str, str, str, int | None]] = []

        photos = getattr(message, "photo", None) or []
        if photos:
            largest = photos[-1]
            found.append(
                (
                    largest.file_id,
                    f"photo_{largest.file_unique_id}.jpg",
                    "image/jpeg",
                    getattr(largest, "file_size", None),
                )
            )

        document = getattr(message, "document", None)
        if document is not None:
            found.append(
                (
                    document.file_id,
                    str(getattr(document, "file_name", None) or "file"),
                    str(
                        getattr(document, "mime_type", None)
                        or "application/octet-stream"
                    ),
                    getattr(document, "file_size", None),
                )
            )

        for field, fallback_name, fallback_type in (
            ("video", "video.mp4", "video/mp4"),
            ("animation", "animation.mp4", "video/mp4"),
            ("audio", "audio.mp3", "audio/mpeg"),
            ("voice", "voice.ogg", "audio/ogg"),
            ("video_note", "video_note.mp4", "video/mp4"),
        ):
            media = getattr(message, field, None)
            if media is None:
                continue
            found.append(
                (
                    media.file_id,
                    str(getattr(media, "file_name", None) or fallback_name),
                    str(getattr(media, "mime_type", None) or fallback_type),
                    getattr(media, "file_size", None),
                )
            )

        return found

    # ── Helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _chat_id(channel_id: str) -> int | str:
        """Telegram wants a numeric chat id, but accepts an `@name` handle."""
        try:
            return int(channel_id)
        except ValueError:
            return channel_id

    @staticmethod
    def _ref(message: Any) -> str:
        return f"{message.chat.id}:{message.message_id}"

    @staticmethod
    def _parse_message_ref(message_ref: str) -> tuple[str, str]:
        parts = message_ref.split(":", 1)
        if len(parts) != 2:
            logger.error("Invalid Telegram message ref format: %s", message_ref)
            return "", ""
        return parts[0], parts[1]

    @staticmethod
    def _agent_marker(sender_name: str) -> str:
        """A stable coloured mark for one agent.

        Telegram gives a bot no per-message name or avatar, so every agent
        arrives under the same app identity and a bold name was the only thing
        telling them apart — which reads as one speaker once a few of them are
        talking. A mark that is always the same for the same agent gives a
        reader something to recognise at a glance, the way an avatar would.

        Derived from the identifier rather than configured, so it needs no
        state and no migration and cannot disagree between two bridges.
        `blake2b` and not `hash()`: the built-in is salted per process, so it
        would hand the same agent a different colour after every restart.

        Keyed on the identifier and not the display name, which is the change
        this rules out. `display_name` and `icon_url` are both owner-settable,
        so the mark is the only per-speaker signal on a Telegram message that
        an impersonating agent cannot control. Keyed on the label instead, two
        agents sharing a display name would collapse onto one mark and an
        agent's mark would move when it is renamed — losing the
        recognisability the mark exists for.

        Deliberately not a provider logo. The server only distinguishes
        `claude-code` from `codex`, and Switch Console registers every other
        provider — Antigravity, Cursor, the rest — as `claude-code`; a logo drawn
        from that would confidently label most agents wrongly.
        """
        digest = hashlib.blake2b(sender_name.encode("utf-8"), digest_size=8).digest()
        return _AGENT_MARKERS[digest[0] % len(_AGENT_MARKERS)]

    @classmethod
    def _attribute(cls, sender_name: str, label: str, content: str) -> str:
        """Put the agent's mark and name at the head of the body.

        This is the whole of Telegram's per-message identity: one bot posts for
        every agent, so without the name a reader cannot tell them apart.

        Two names, deliberately. `label` is what the reader sees; the mark
        comes from `sender_name`, the identifier, for the reasons
        `_agent_marker` gives.

        `label` is the escaped form — `AgentRendering.body_label`, never
        `field_label`. This prefix is message text, not a name field, and
        Telegram has no name field at all, so the escaped form is the only one
        that may reach here: a bare `@handle` in a display name is linked by
        Telegram out of ordinary message text, with no markup involved, so the
        unescaped form would notify that account from the prefix alone.

        Two escapes, both needed and neither redundant. `escape_label_for_body`
        defuses the markup, and `html.escape` below neutralises the tags; a
        zero-width space is not an entity, so the two never compound. This
        prefix is finished HTML — assembled after `translate_outbound` has
        already run over `content`, and never fed back through it — so
        `html.escape` is the whole of the tag escaping it needs."""
        name = (
            f"{cls._agent_marker(sender_name)} <b>{html.escape(label, quote=False)}</b>"
        )
        if not content:
            return name
        return f"{name}\n{content}" if "\n" in content else f"{name}: {content}"

    async def _is_forum(self, channel_id: str) -> bool:
        """Whether this chat splits into topics.

        The answer decides what a thread root *means* here, so it is read from
        the chat rather than guessed from the ref: an inbound message carries
        `message_thread_id` in a forum and a reply target everywhere else, and
        both arrive as a bare number that says nothing about which it is.

        Cached per chat. A group is converted to a forum rarely and never back
        and forth mid-turn, and the alternative is a getChat on every post.
        A lookup that fails is not cached and not guessed at: it raises, and
        the caller decides whether the post can proceed without an answer.
        """
        known = self._forum_chats.get(channel_id)
        if known is not None:
            return known
        chat = await self._require_bot().get_chat(self._chat_id(channel_id))
        is_forum = bool(getattr(chat, "is_forum", False))
        self._forum_chats[channel_id] = is_forum
        return is_forum

    async def _resolve_root(
        self, channel_id: str, thread_root_id: str
    ) -> _ThreadRoot | None:
        """What a thread root names in this chat, or None if it names nothing.

        A root arrives in either of two spellings, and they do not mean the
        same thing. Inbound records a bare number — the topic in a forum, the
        message replied to everywhere else. The publication seam records this
        platform's own reference to a message, `chat:message`, because that is
        the form the message map stores, and it always names one message. So a
        composite reference is a reply target even in a forum: reading `75` out
        of `-100123:75` and passing it as a topic would aim the post at
        whichever topic happens to hold that number.

        Nothing is returned for a reference this chat cannot address — a number
        that is not one, or a message belonging to another chat, which is a
        confusion of destinations rather than a missing quote. Callers disagree
        about what that should cost, so none of it is settled here.
        """
        chat, separator, message = thread_root_id.partition(":")
        if separator:
            if chat != channel_id:
                return None
            numbered = _as_int(message)
            return None if numbered is None else _ThreadRoot(False, numbered)
        root = _as_int(chat)
        if root is None:
            return None
        return _ThreadRoot(await self._is_forum(channel_id), root)

    async def _anchor_kwargs(
        self, channel_id: str, thread_root_id: str | None
    ) -> dict[str, Any]:
        """Anchor a post where the conversation it belongs to is.

        Sending a topic as a reply target, or the other way about, is not a
        formatting difference: a topic id used as a reply target quotes
        whichever message happens to hold that number, and it lands in the
        General topic the moment the topic's opening message is gone — so a
        card asked for in one topic would be put to the whole group instead.
        Which of the two a root names is `_resolve_root`'s question.

        Outside a forum, a reply target that has since been deleted does not
        stop the send. Detaching there costs the quote, not the audience: it is
        the same chat either way, and a reply nobody can trace back beats no
        message at all.

        Inside one it is the opposite, because a reply target is also the only
        thing naming the topic. Permitting the send without it is permitting it
        into General — in front of the whole group rather than the people in
        the conversation — so the anchor is required and the send fails
        instead. Repeating an optional anchor on each chunk would not have
        prevented that: the permission travels with every copy of it.
        """
        if not thread_root_id:
            return {}
        root = await self._resolve_root(channel_id, thread_root_id)
        if root is None:
            logger.error(
                "Ignoring Telegram thread root %s, which chat %s cannot address.",
                thread_root_id,
                channel_id,
            )
            return {}
        if root.is_topic:
            return {"message_thread_id": root.id}
        return {
            "reply_parameters": ReplyParameters(
                message_id=root.id,
                allow_sending_without_reply=not await self._is_forum(channel_id),
            )
        }

    async def _publication_anchor(
        self, channel_id: str, thread_root_id: str | None, text: str
    ) -> dict[str, Any]:
        """Where a publication goes, with no route that quietly widens it.

        The same two spellings as `_anchor_kwargs`, and the opposite answer to
        an anchor that is not there. A relayed message detaching from a deleted
        reply target costs the quote and keeps the audience, which is the right
        trade for a line of conversation. A publication is not one: a card that
        detaches is the agent's question put to the whole chat rather than to
        the exchange that raised it, and an answer typed at it there binds a
        request those readers never saw. So the send is refused, definitely,
        and the publisher takes the route it keeps for a destination it cannot
        reach — which ends at the Console rather than in the wrong place.

        A root this chat cannot address is the same thing arriving differently:
        the caller asked for somewhere this cannot reach, and posting to the
        chat instead would be answering a question nobody asked.
        """
        if not thread_root_id:
            return {}
        root = await self._resolve_root(channel_id, thread_root_id)
        if root is None:
            raise RichContentFailed(
                f"Cannot publish to Telegram chat {channel_id}: {thread_root_id!r} "
                "is not a topic or a message in it, so there is no conversation "
                "this belongs to.",
                text=text,
            )
        if root.is_topic:
            return {"message_thread_id": root.id}
        return {
            "reply_parameters": ReplyParameters(
                message_id=root.id, allow_sending_without_reply=False
            )
        }

    async def _topic_kwargs(
        self, channel_id: str, thread_root_id: str | None
    ) -> dict[str, Any] | None:
        """The forum topic to signal in, or None to signal nowhere.

        A chat action has no target finer than a topic. Outside a forum there
        are no topics, so the chat is the right and only destination and an
        empty mapping says so.

        Inside one, a root that names a message rather than a topic leaves this
        unable to locate the conversation — and a typing indicator raised in
        General is shown to a whole group who did not ask for it, while the
        people who did see nothing. There is no topic id to be had: the number
        in a message reference is a message, and guessing from it would aim at
        whichever topic happens to hold it. So the nudge is dropped. It is the
        one signal here that is pure best effort, expiring in about five
        seconds, and the status that follows carries the real state.
        """
        if not thread_root_id:
            return {}
        root = await self._resolve_root(channel_id, thread_root_id)
        if root is not None and root.is_topic:
            return {"message_thread_id": root.id}
        if not await self._is_forum(channel_id):
            return {}
        logger.warning(
            "Not signalling in Telegram chat %s: thread root %s does not name a "
            "topic there, and the whole forum is the wrong audience.",
            channel_id,
            thread_root_id,
        )
        return None

    @staticmethod
    def _is_photo(mimetype: str, size: int) -> bool:
        """Whether Telegram will accept this as an inline photo.

        sendPhoto previews in the timeline but re-encodes and caps at 10MB, and
        rejects formats it cannot resize; anything else keeps its bytes intact
        as a document."""
        return mimetype in ("image/jpeg", "image/png", "image/webp") and size <= (
            10 * 1024 * 1024
        )

    @staticmethod
    def _clamp(text: str) -> str:
        """The largest valid prefix of an edit that Telegram will accept.

        An edit cannot be split across messages the way a send can, so an
        over-long one is cut — but cutting the rendered HTML by character count
        lands mid-tag or mid-attribute, which Telegram rejects outright, and an
        edit has nowhere to fall back to. Reusing the chunker's first piece
        keeps the markup balanced."""
        if len(text) <= MAX_MESSAGE:
            return text
        head = chunk_message(text)[0]
        logger.warning(
            "A Telegram edit of %d characters was cut to %d to fit the limit",
            len(text),
            len(head),
        )
        return head

    async def _split_caption(
        self, channel_id: str, caption: str, thread_root_id: str | None
    ) -> tuple[str, str | None]:
        """Fit a caption to Telegram's caption limit.

        A caption longer than the limit is posted as its own message ahead of
        the file and the file goes out bare, rather than the text being cut off.
        Returns the caption to attach and the ref of any message posted first."""
        if len(caption) <= _MAX_CAPTION_CHARS:
            return caption, None
        ref = await self._send_text(channel_id, caption, thread_root_id)
        return "", ref

    async def _send_text(
        self, channel_id: str, body: str, thread_root_id: str | None
    ) -> str | None:
        """Post one body, split across messages if Telegram's cap demands it.

        Returns the ref of the first message so an edit or delete targets the
        head of the run."""
        bot = self._require_bot()
        anchor = await self._anchor_kwargs(channel_id, thread_root_id)
        # In a forum the anchor is what keeps the run together: a chunk without
        # one lands in General, so the tail of a long answer would be read by
        # people who never saw its head. Everywhere else the anchor is a pointer
        # at one message and repeating it quotes that message once per chunk,
        # which is noise rather than a misdelivery — so it goes on the first
        # only. The cost of the forum rule is that same repeated quote when the
        # anchor is a reply rather than a topic, which is the better trade.
        # Repetition alone is not what holds the destination: a reply anchor in
        # a forum is also mandatory, so a target deleted mid-run fails the rest
        # of the send instead of scattering it into General.
        every_chunk = bool(anchor) and await self._is_forum(channel_id)
        first_ref: str | None = None
        for index, chunk in enumerate(chunk_message(body)):
            kwargs = anchor if every_chunk or index == 0 else {}
            sent = await self._send_chunk(bot, channel_id, chunk, kwargs)
            if sent is None:
                return first_ref
            if first_ref is None:
                first_ref = sent
        return first_ref

    async def _send_chunk(
        self, bot: Any, channel_id: str, chunk: str, kwargs: dict[str, Any]
    ) -> str | None:
        try:
            sent = await bot.send_message(
                chat_id=self._chat_id(channel_id),
                text=chunk,
                parse_mode=ParseMode.HTML,
                link_preview_options=_NO_PREVIEW,
                **kwargs,
            )
            return self._ref(sent)
        except BadRequest as e:
            # Any rejection gets the plain-text retry, not only the ones whose
            # text says "parse". Telegram refuses markup under several different
            # messages — an unsupported URL protocol in an anchor is one, and it
            # says nothing about parsing — and matching on the wording meant
            # those lost the whole message to a single log line. Retrying
            # stripped costs one call in the cases that were failing anyway, and
            # a message that arrives unformatted beats one that never arrives.
            logger.warning(
                "Telegram rejected a message to chat %s (%s) — resending it "
                "unformatted",
                channel_id,
                e,
            )
            try:
                sent = await bot.send_message(
                    chat_id=self._chat_id(channel_id),
                    text=html.unescape(re.sub(r"<[^>]+>", "", chunk)),
                    link_preview_options=_NO_PREVIEW,
                    **kwargs,
                )
                return self._ref(sent)
            except TelegramError as retry_error:
                logger.error(
                    "Failed to send message to Telegram chat %s: %s",
                    channel_id,
                    retry_error,
                )
                return None
        except TelegramError as e:
            logger.error(
                "Failed to send message to Telegram chat %s: %s", channel_id, e
            )
            return None
