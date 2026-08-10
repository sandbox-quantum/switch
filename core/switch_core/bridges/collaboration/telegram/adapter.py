from __future__ import annotations

import html
import logging
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import replace
from typing import Any

from telegram import (
    InputMediaDocument,
    InputMediaPhoto,
    LinkPreviewOptions,
    ReplyParameters,
    Update,
)
from telegram.constants import ChatAction, ChatType, ParseMode
from telegram.error import BadRequest, TelegramError
from telegram.ext import Application, ApplicationBuilder, TypeHandler

from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
    LiveRuntimeIndicator,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)

logger = logging.getLogger(__name__)

# Telegram's hard limits. A message over the text cap is rejected outright, so
# long agent output is split rather than lost; a caption over the caption cap
# is posted as its own message ahead of the file.
_MAX_TEXT_CHARS = 4096
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

# Supergroup and channel ids are the internal id with a -100 prefix; t.me/c/
# links carry the internal id alone.
_SUPERGROUP_PREFIX = "-100"

_NO_PREVIEW = LinkPreviewOptions(is_disabled=True)


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

    The bot must have privacy mode DISABLED in BotFather, otherwise Telegram
    only delivers commands and replies and the bridge sees almost no traffic.

    Chats are adopted, never created: the Bot API gives a bot no way to create a
    group or channel, so ``create_channel`` raises and a chat's Switch room is
    provisioned when the bot is added to it or on its first bridged message.
    """

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
            logger.warning(
                "Configured Telegram bot_username %r does not match the bot's "
                "actual username %r — deeplinks will use the configured value",
                self._bot_username,
                me.username,
            )
        self._warn_if_privacy_mode_hides_traffic(me)
        await app.start()
        if app.updater is None:
            raise RuntimeError("Telegram application was built without an updater")
        await app.updater.start_polling(allowed_updates=_ALLOWED_UPDATES)
        logger.info("Telegram adapter connected as @%s (id %s)", me.username, me.id)

    @staticmethod
    def _warn_if_privacy_mode_hides_traffic(me: Any) -> None:
        """Say so when the bot is configured to see almost nothing.

        BotFather enables privacy mode by default, and a bot in that state
        receives only `/`-prefixed messages, replies to itself and service
        messages — so a bridge starts cleanly, provisions rooms, and then
        appears to ignore the conversation, with nothing anywhere saying why.
        getMe reports the setting, so the degradation is announced at startup
        instead of being left for someone to deduce from an empty channel.
        """
        if getattr(me, "can_read_all_group_messages", False):
            return
        logger.warning(
            "Telegram privacy mode is ENABLED for @%s: the bridge will NOT "
            "receive ordinary group messages, only /commands and replies to "
            "itself. Agents will look unresponsive. Disable it in BotFather "
            "(/setprivacy -> select the bot -> Disable), then remove the bot "
            "from each group and add it back — the setting is only read when "
            "the bot joins.",
            me.username,
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
        return await self._send_text(channel_id, content, thread_root_id)

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
            logger.error("Failed to update Telegram message %s: %s", message_ref, e)
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
        notify_user: str | None,
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
                    message_ref=ref, body=body, thread_root_id=thread_root_id
                )
        elif state == "awaiting-input":
            ref = await self._ping_operator(
                channel_id, agent_name, notify_user, thread_root_id, deeplink_url
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
        raise NotImplementedError(
            "Telegram bots cannot create chats — the Bot API has no such call. "
            f"Create the group or channel for '{name}' in a Telegram client, add "
            f"@{self._bot_username} to it as an administrator, and Switch will "
            "adopt it as a room."
        )

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        """`https://t.me/c/<internal id>` — the canonical link for a supergroup
        or channel, which the Telegram desktop app claims.

        Pure: derived from the chat id, no API call. Basic groups and 1:1 chats
        have no addressable link, so they get none rather than a broken one."""
        if not external_channel_id.startswith(_SUPERGROUP_PREFIX):
            return None
        internal = external_channel_id[len(_SUPERGROUP_PREFIX) :]
        if not internal.isdigit():
            return None
        return f"https://t.me/c/{internal}"

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
    _LINK_RE = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")
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
        # The href is already entity-escaped along with the rest of the body;
        # only the attribute quote still has to be neutralised.
        text = self._LINK_RE.sub(
            lambda m: (
                f'<a href="{m.group(2).replace(chr(34), "&quot;")}">{m.group(1)}</a>'
            ),
            text,
        )
        text = self._BOLD_RE.sub(r"<b>\1</b>", text)
        text = self._STRIKE_RE.sub(r"<s>\1</s>", text)
        text = self._ITALIC_STAR_RE.sub(r"<i>\1</i>", text)
        text = self._ITALIC_USCORE_RE.sub(r"<i>\1</i>", text)
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
        # What Telegram actually delivered. With privacy mode on, the absence
        # of a line here for a message someone can see in the chat is the whole
        # diagnosis, so it is worth being able to turn on.
        logger.debug("Telegram update received: %s", update)
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
        chat's room — Discord has no such signal and has to wait for a message."""
        new_status = getattr(getattr(event, "new_chat_member", None), "status", None)
        if new_status not in ("member", "administrator"):
            return
        chat = getattr(event, "chat", None)
        if chat is None or self._channel_type_of(chat) == "lobby":
            return
        if self._on_app_joined is None:
            return
        await self._on_app_joined(
            InboundAppJoin(
                channel_id=str(chat.id),
                channel_type=self._channel_type_of(chat),
                channel_name=getattr(chat, "title", None),
            )
        )

    async def _handle_message(self, message: Any) -> None:
        chat = message.chat
        chat_id = str(chat.id)
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

        parsed = self._parse_command(content.strip())
        if parsed is not None and self._on_command:
            name, args = parsed
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
        joined = "".join(part for part in parts if part).strip()
        return joined.replace(" ", "") or f"user{getattr(user, 'id', '')}"

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
    def _attribute(sender_name: str, content: str) -> str:
        """Put the agent's name at the head of the body.

        This is the whole of Telegram's per-message identity: one bot posts for
        every agent, so without the name a reader cannot tell them apart."""
        name = f"<b>{html.escape(sender_name, quote=False)}</b>"
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
        return (
            text if len(text) <= _MAX_TEXT_CHARS else text[: _MAX_TEXT_CHARS - 1] + "…"
        )

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
        for index, chunk in enumerate(self._chunk(body)):
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
            if "parse" not in str(e).lower():
                logger.error(
                    "Failed to send message to Telegram chat %s: %s", channel_id, e
                )
                return None
            # Malformed markup would otherwise lose the message entirely; resend
            # it as plain text and say so rather than dropping it.
            logger.warning(
                "Telegram rejected the formatting of a message to chat %s (%s) — "
                "resending it unformatted",
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

    @staticmethod
    def _chunk(body: str) -> list[str]:
        """Break a body into Telegram-sized pieces on the cleanest line break.

        Agent output routinely runs past the 4096-character cap, and Telegram
        rejects an oversize message outright rather than truncating it."""
        if len(body) <= _MAX_TEXT_CHARS:
            return [body]
        chunks: list[str] = []
        remaining = body
        while len(remaining) > _MAX_TEXT_CHARS:
            window = remaining[:_MAX_TEXT_CHARS]
            split = window.rfind("\n")
            if split <= 0:
                split = _MAX_TEXT_CHARS
            chunks.append(remaining[:split].rstrip("\n"))
            remaining = remaining[split:].lstrip("\n")
        if remaining:
            chunks.append(remaining)
        return chunks
