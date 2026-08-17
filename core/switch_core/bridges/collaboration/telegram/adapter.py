from __future__ import annotations

import hashlib
import html
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import replace
from typing import Any, ClassVar, NamedTuple

from telegram import (
    BotCommand,
    ForceReply,
    InputMediaDocument,
    InputMediaPhoto,
    LinkPreviewOptions,
    ReplyParameters,
    Update,
)
from telegram.constants import ChatAction, ChatType, ParseMode
from telegram.error import BadRequest, Conflict, TelegramError
from telegram.ext import Application, ApplicationBuilder, TypeHandler

from switch_core.bridges.agent.commands import COMMANDS, COMMANDS_BY_NAME, CommandArg
from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    LiveRuntimeIndicator,
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
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.telegram.chunking import (
    MAX_MESSAGE,
    chunk_message,
)

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

_ALLOWED_UPDATES = ["message", "channel_post", "my_chat_member"]

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


class _ChatVisibility(NamedTuple):
    """What the bridge can see in one chat, and how certain that is.

    ``status`` is ``"full"``, ``"mention_only"`` or ``"unknown"``.
    ``via_admin`` is True only when it was settled by the bot's administrator
    status *in this chat*, which is the one conclusive answer — see
    ``_chat_visibility``.
    """

    status: str
    via_admin: bool


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
        # The bot can delete its own messages, so runtime state renders as a
        # persistent message (the base class's _working_msg) rather than the
        # one-shot typing action.

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
        body = self._attribute(sender_name, content)
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
        attributed = self._attribute(
            sender_name, self.translate_outbound(caption or "")
        )
        caption_text, overflow_ref = await self._split_caption(
            channel_id, attributed, thread_root_id
        )

        bot = self._require_bot()
        kwargs = self._reply_kwargs(thread_root_id)
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

        attributed = self._attribute(
            sender_name, self.translate_outbound(caption or "")
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
                **self._reply_kwargs(thread_root_id),
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
            channel_id, self.translate_outbound(content), thread_root_id
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

    # ── Runtime state ────────────────────────────────────────────────────────

    async def _apply_runtime_state(
        self,
        channel_id: str,
        agent_name: str,
        state: str,
        *,
        mention_handle: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None = None,
        detail: str | None = None,
    ) -> None:
        """Render runtime state as persistent, deletable status messages.

        A Telegram bot deletes its own messages cleanly (no tombstone), so — like
        Slack and Discord — the "working on it…" indicator and any "needs your
        input" pings are posted while relevant and removed when the turn ends.
        The working indicator stays up through `awaiting-input` (the agent is
        mid-turn, just paused) and the pings go with it when the turn ends or
        resumes.
        """
        key = (channel_id, agent_name)
        if state == "working":
            await self._clear_input_pings(channel_id, agent_name)
            body = self._working_body(detail, deeplink_url)
            existing = self._working_msg.get(key)
            if existing is not None:
                await self.update_message(
                    channel_id,
                    existing.message_ref,
                    self._attribute(agent_name, body),
                )
                self._working_msg[key] = replace(existing, body=body)
                return
            ref = await self.send_message(channel_id, agent_name, body, thread_root_id)
            if ref is not None:
                self._working_msg[key] = LiveRuntimeIndicator(
                    message_ref=ref,
                    body=body,
                    thread_root_id=thread_root_id,
                    started_at=time.monotonic(),
                )
        elif state == "awaiting-input":
            ref = await self._ping_operator(
                channel_id, agent_name, mention_handle, thread_root_id, deeplink_url
            )
            if ref is not None:
                self._input_pings.setdefault(key, []).append(ref)
        else:
            await self._clear_working(channel_id, agent_name)
            await self._clear_input_pings(channel_id, agent_name)

    async def _clear_working(self, channel_id: str, agent_name: str) -> None:
        live = self._working_msg.pop((channel_id, agent_name), None)
        if live is not None:
            await self.delete_message(channel_id, live.message_ref)

    async def _clear_input_pings(self, channel_id: str, agent_name: str) -> None:
        refs = self._input_pings.pop((channel_id, agent_name), [])
        for ref in refs:
            await self.delete_message(channel_id, ref)

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
        rather than costing the caller its button."""
        if self._bot is None:
            return None
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
        return str(username) if username else None

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
    ) -> None:
        # The Bot API has no call that adds a member to a chat — a person joins
        # from a Telegram client or an invite link. Say so rather than reporting
        # a membership change that never happened.
        if not user_names:
            return
        logger.warning(
            "Cannot add %s to Telegram chat %s — the Bot API cannot add members; "
            "they must join from a Telegram client or an invite link",
            ", ".join(user_names),
            channel_id,
        )

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

        message = getattr(update, "message", None) or getattr(
            update, "channel_post", None
        )
        if message is not None:
            await self._handle_message(message)

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
        for field in ("message", "channel_post", "my_chat_member"):
            payload = getattr(update, field, None)
            if payload is None:
                continue
            chat = getattr(payload, "chat", None)
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

        Derived from the name rather than configured, so it needs no state and
        no migration and cannot disagree between two bridges. `blake2b` and not
        `hash()`: the built-in is salted per process, so it would hand the same
        agent a different colour after every restart.

        Deliberately not a provider logo. The server only distinguishes
        `claude-code` from `codex`, and Switch Console registers every other
        provider — Gemini, Cursor, the rest — as `claude-code`; a logo drawn
        from that would confidently label most agents wrongly.
        """
        digest = hashlib.blake2b(sender_name.encode("utf-8"), digest_size=8).digest()
        return _AGENT_MARKERS[digest[0] % len(_AGENT_MARKERS)]

    @classmethod
    def _attribute(cls, sender_name: str, content: str) -> str:
        """Put the agent's mark and name at the head of the body.

        This is the whole of Telegram's per-message identity: one bot posts for
        every agent, so without the name a reader cannot tell them apart."""
        name = (
            f"{cls._agent_marker(sender_name)} "
            f"<b>{html.escape(sender_name, quote=False)}</b>"
        )
        if not content:
            return name
        return f"{name}\n{content}" if "\n" in content else f"{name}: {content}"

    @staticmethod
    def _reply_kwargs(thread_root_id: str | None) -> dict[str, Any]:
        """Anchor a post to its thread root.

        `allow_sending_without_reply` matters: a root that has since been
        deleted would otherwise fail the whole send, and a reply landing at the
        chat root is much better than no message at all."""
        if not thread_root_id:
            return {}
        try:
            root = int(thread_root_id)
        except ValueError:
            logger.error("Ignoring unparseable Telegram thread root %s", thread_root_id)
            return {}
        return {
            "reply_parameters": ReplyParameters(
                message_id=root, allow_sending_without_reply=True
            )
        }

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
        first_ref: str | None = None
        for index, chunk in enumerate(chunk_message(body)):
            kwargs = self._reply_kwargs(thread_root_id) if index == 0 else {}
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
