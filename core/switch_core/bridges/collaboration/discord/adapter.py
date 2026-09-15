from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

import discord
from discord import app_commands
from pydantic import Field

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME
from switch_core.bridges.agent.commands import Command as InRoomCommand
from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
    CollaborationAdapter,
    LiveRuntimeIndicator,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
)
from switch_core.bridges.collaboration.discord.chunking import (
    MAX_MESSAGE,
    chunk_message,
)
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
    InboundMessage,
    InboundUserJoin,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    request_summary,
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

_READY_TIMEOUT = 30.0

# Put on the message an agent is working on for as long as its turn lasts.
_WORKING_REACTION = "👀"

# Discord's error code for "Maximum number of guild roles reached" (250).
_MAX_GUILD_ROLES_CODE = 30005

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


def _turn_has_ended(content: RichContent) -> bool:
    """Whether this publication is a turn with nothing left to happen in it.

    A request card is never one, whatever state its turn is in: the card is the
    record of a decision and outlives the turn that asked for it.
    """
    return isinstance(content, TurnActivity) and content.turn.status in TURN_ENDED


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
    bot_token: str
    guild_id: str
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

    # One status per turn, holding its own tool counts. A second message would
    # be a second notification for everyone in the thread, and the thread is
    # already where the detail is allowed to live.
    separate_activity_log: ClassVar[bool] = False

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

    # Every agent posts through one bot application, so there is one 👀 between
    # them: the first turn to want it adds it and the last to finish removes it.
    activity_reactions_per_agent: ClassVar[bool] = False

    # Both paths would draw the same turn. The legacy renderer below is
    # retained, not reachable — removing it is its own task.
    renders_legacy_runtime_state: ClassVar[bool] = False

    # `find_request_card` reads a channel's history back and matches a card by
    # the handle printed on it, so an unacknowledged send can still be bound to
    # the message it produced.
    recovers_uncertain_posts: ClassVar[bool] = True

    def __init__(self, *, config: DiscordConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._guild_id = int(config.guild_id)
        self._client: discord.Client | None = None
        self._tree: app_commands.CommandTree[Any] | None = None
        self._connect_task: asyncio.Task[None] | None = None
        self._bot_user_id: int = 0
        # (channel id, webhook name) -> webhook the bridge posts through there.
        self._webhooks: dict[tuple[int, str], discord.Webhook] = {}
        # Ids of webhooks the bridge has minted/adopted, for echo dropping.
        self._webhook_ids: set[int] = set()
        self._seen_ids: OrderedDict[int, None] = OrderedDict()
        self._seen_ids_max = 1000
        # Discord user id ↔ username caches, for mention translation both ways.
        self._user_names: dict[int, str] = {}
        self._username_to_id: dict[str, int] = {}
        # Webhook messages delete cleanly on Discord, so runtime state renders
        # as a persistent message (see the base class's _working_msg) rather
        # than the one-shot typing indicator.
        # Message refs currently carrying the "being worked on" reaction, and
        # per agent the set it has marked — a turn ends once but may have
        # marked several messages.
        self._eyes: set[str] = set()
        self._agent_eyes: dict[tuple[str, str], set[str]] = {}
        # Publications this adapter has taken down at the end of a turn, so a
        # later redraw of one is recognised as finished rather than reported as
        # a message Discord has lost.
        self._rich_retired: OrderedDict[str, None] = OrderedDict()
        self._rich_retired_max = 1000
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

        intents = discord.Intents.none()
        intents.guilds = True
        intents.guild_messages = True
        intents.dm_messages = True
        intents.message_content = True
        intents.members = True

        client = discord.Client(intents=intents)
        client.event(self._make_on_message())
        self._tree = app_commands.CommandTree(client)
        guild = discord.Object(id=self._guild_id)
        for app_command in build_app_commands(self._handle_slash_command):
            # Bound to the guild, not global — see _sync_slash_commands. Adding
            # them globally here would leave the guild-scoped sync below with an
            # empty payload, registering nothing at all.
            self._tree.add_command(app_command, guild=guild)
        self._client = client

        await client.login(self._config.bot_token)
        self._connect_task = asyncio.create_task(
            client.connect(), name=f"discord-gateway-{self._config.guild_id}"
        )
        ready = asyncio.ensure_future(client.wait_until_ready())
        done, _ = await asyncio.wait(
            {ready, self._connect_task},
            timeout=_READY_TIMEOUT,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if self._connect_task in done:
            ready.cancel()
            exc = self._connect_task.exception()
            raise RuntimeError("Discord gateway connection failed") from exc
        if ready not in done:
            ready.cancel()
            await self.stop()
            raise RuntimeError(f"Discord gateway not ready after {_READY_TIMEOUT:.0f}s")

        assert client.user is not None
        self._bot_user_id = client.user.id
        logger.info(
            "Discord adapter connected as %s (guild %s)",
            client.user,
            self._config.guild_id,
        )
        await self._sync_slash_commands()

    async def _sync_slash_commands(self) -> None:
        """Publish the in-room command set as guild-scoped application commands.

        Guild-scoped rather than global, because the adapter is single-guild by
        construction (`DiscordConnectionConfig.guild_id` is required and every
        lookup is scoped to it). Guild commands also apply immediately, where
        global ones propagate for up to an hour, and global registration is
        per-application — so on an instance running several Discord bridges it
        would leak each bridge's commands into the others' guilds, where they
        could only fail. Syncing is a bulk overwrite, so re-running it on every
        start reconciles renames and removals rather than accumulating them.

        Any sync failure is logged and left non-fatal — hence the broad catch:
        the bridge still works over `!`-commands and messages, and dropping the
        whole bridge over a missing `applications.commands` scope is a worse
        outcome than running without the slash surface. The degradation is
        visible in the logs rather than silent.
        """
        if self._tree is None:
            return
        try:
            synced = await self._tree.sync(guild=discord.Object(id=self._guild_id))
        except Exception:
            logger.exception(
                "Failed to sync Discord slash commands for guild %s — the bridge "
                "will run without them (check the bot's applications.commands scope)",
                self._config.guild_id,
            )
            return
        logger.info(
            "Synced %d Discord slash commands to guild %s",
            len(synced),
            self._config.guild_id,
        )

    def _make_on_message(
        self,
    ) -> Callable[[discord.Message], Coroutine[Any, Any, None]]:
        # client.event registers by function __name__, so hand it a closure
        # named exactly like the gateway event.
        async def on_message(message: discord.Message) -> None:
            try:
                await self._handle_message(message)
            except Exception:
                logger.exception("Failed to handle inbound Discord message")

        return on_message

    async def stop(self) -> None:
        if self._client:
            try:
                await self._client.close()
            except Exception:
                pass
        task = self._connect_task
        self._connect_task = None
        if task:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._client = None
        self._tree = None
        self._webhooks.clear()
        logger.info("Discord adapter stopped")

    def _require_client(self) -> discord.Client:
        if self._client is None:
            raise RuntimeError("Discord client not connected")
        return self._client

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
            self.translate_outbound(content),
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
        """
        return self._draw(content, mention=None, responder=None, prefix="")

    def _draw(
        self,
        content: RichContent,
        *,
        mention: str | None,
        responder: str | None,
        prefix: str,
    ) -> str:
        escape = self._rich_escape
        limit = max(1, self.rich_fallback_limit() - len(prefix))
        markup = self.rich_markup()
        if isinstance(content, TurnActivity):
            # Charged to the same budget as the status it follows: a message
            # that just fits, plus a line saying it reached nobody, is a
            # message Discord refuses.
            tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
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
                )
                + tail
            )
            return f"{prefix}{body}"
        # The mention goes on its own line rather than in front of the heading:
        # a card is a block, and a handle wedged before "**Permission needed**"
        # reads as part of the heading.
        lead = f"{mention}\n" if mention else ""
        tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
        body = request_summary(
            content.request,
            content.reference,
            escape=escape,
            limit=max(1, limit - len(lead) - len(tail)),
            markup=markup,
            responder=responder,
            unavailable_reason=content.unavailable_reason,
        )
        return f"{prefix}{lead}{body}{tail}"

    def _render_rich(self, content: RichContent, *, prefix: str) -> str:
        """Draw `content` for one place on Discord.

        `prefix` is the inlined agent name a DM needs and a guild channel does
        not: a webhook message carries its sender's name and face, and a bot
        post in a DM carries the bot's, so there the name goes in the body the
        way `send_message` puts it there, charged to the same 2,000 characters
        as everything else.
        """
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
        )

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

        A thread that cannot be resolved is where the two kinds of content part
        company, but only in the one case where nothing is given away by it.
        Where the turn began at the channel root and the reply thread has not
        been made yet, the channel root is the origin: everyone who could read
        the question there can read it there still, so a card is posted there
        rather than not at all, while progress is suppressed because the
        channel narrating every turn is the noise this presentation exists to
        avoid.

        Where a thread already exists and Discord will not let us into it, both
        are refused. That thread may be private, and a request carries the
        agent's question and its options — posting it to the parent would hand
        the contents of a conversation to people who were not in it. A question
        nobody can see is bad; a question the wrong people can see is worse,
        and unlike the first it cannot be undone.
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
        text = self._render_rich(content, prefix=prefix)
        if lobby:
            try:
                sent = await target.send(
                    text,
                    suppress_embeds=True,
                    allowed_mentions=_NO_MASS_MENTIONS,
                )
            except Exception as error:
                raise self._rich_failure(
                    error, f"Discord refused the post in DM {channel_id}", text
                ) from error
            return f"{sent.channel.id}:{sent.id}"

        thread: Any = None
        if thread_root_id:
            thread = await self._publication_thread(
                int(channel_id), thread_root_id, content, text
            )

        try:
            webhook = await self._publication_webhook(int(channel_id))
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
            sent = await _WebhookIdentity(agent.field_label, agent_name).send(
                webhook, payload
            )
        except Exception as error:
            raise self._rich_failure(
                error, f"Discord refused the post in channel {channel_id}", text
            ) from error
        return f"{sent.channel.id}:{sent.id}"

    async def _publication_thread(
        self, channel_id: int, thread_root_id: str, content: RichContent, text: str
    ) -> Any:
        """The thread this publication goes in, or `None` to use its origin.

        `None` is returned in exactly one situation: no thread exists under the
        root message yet and one could not be made. The turn was addressed at
        the channel root, so the root is where it came from and where its
        readers already are — a card posted there reaches the same people who
        asked, which is why this is a fallback and not a disclosure.

        Every other failure raises. A thread that exists and will not open may
        be private, and the difference between "in a thread" and "in the
        channel" is then the difference between a conversation and an audience.
        Progress raises too even in the first case: nobody asked the channel to
        be told what a turn is doing, and the agent's reply is coming to it
        anyway.
        """
        existing = await self._reachable_thread(channel_id, thread_root_id, text)
        if existing is not None:
            return existing
        try:
            return await self._ensure_thread(channel_id, thread_root_id)
        except Exception as error:
            # The create may have been refused because the thread is already
            # there — the one failure that means the opposite of what it looks
            # like. Ask again before treating the root as this turn's origin.
            settled = await self._reachable_thread(channel_id, thread_root_id, text)
            if settled is not None:
                return settled
            if isinstance(content, TurnActivity):
                raise RichContentFailed(
                    f"Discord has no thread under {thread_root_id} in channel "
                    f"{channel_id} to show this turn's progress in, and the "
                    f"channel root is not a substitute for one: {error}",
                    text=text,
                ) from error
            logger.warning(
                "Could not open a Discord thread under %s in channel %s (%s); "
                "posting the request where it was asked, at the channel root.",
                thread_root_id,
                channel_id,
                error,
            )
            return None

    async def _reachable_thread(
        self, channel_id: int, thread_root_id: str, text: str
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
                text=text,
            ) from error

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
    ) -> None:
        """Redraw a publication in place — or take it down, where it has served
        its purpose and staying would just be clutter.

        A turn that has ended leaves nothing behind outside a thread. At the
        channel root and in a DM the status was only ever the thing saying work
        was happening, and Discord deletes it cleanly, so it goes the way the
        legacy indicator went. Inside a thread it stays: a thread is the record
        of one exchange, and the outcome, the time it took and the link to the
        session belong in it. A request card is never taken down anywhere — it
        is the record of a decision, and it says on its face what became of it.

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
        if message_ref in self._rich_retired:
            return

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
        # A post notifies; an edit does not. Repeating the mention on every
        # redraw would be a handle in the channel that never reaches anybody
        # it has not already reached.
        text = self._render_rich(
            replace(content, notify_external_id=None), prefix=prefix
        )
        if self._is_flat(channel_id, message_ref) and _turn_has_ended(content):
            await self._retire_rich(channel_id, message_ref, text, lobby=lobby)
            return
        await self._edit_rich(channel_id, message_ref, text, lobby=lobby)

    def _is_flat(self, channel_id: str, message_ref: str) -> bool:
        """Whether a publication is sitting in the channel rather than a thread.

        A Discord thread is a channel of its own, so the location half of the
        ref differs from the channel the turn belongs to exactly when the post
        went into a thread.
        """
        location_id, _ = self._parse_message_ref(message_ref)
        return location_id == channel_id

    async def _retire_rich(
        self, channel_id: str, message_ref: str, text: str, *, lobby: bool
    ) -> None:
        location_id, message_id = self._parse_message_ref(message_ref)
        try:
            if lobby:
                target = await self._get_channel(int(location_id or channel_id))
                await target.get_partial_message(int(message_id)).delete()
            else:
                webhook = await self._publication_webhook(int(channel_id))
                await webhook.delete_message(int(message_id))
        except discord.NotFound:
            pass
        except Exception as error:
            failure = _as_rich_failure(
                error,
                description=(
                    f"Discord refused to remove the finished status {message_ref} "
                    f"in channel {channel_id}"
                ),
                text=text,
            )
            if failure is None:
                raise
            # Visibly degraded rather than quietly wrong: the status cannot be
            # taken down, so it is left saying what actually happened instead
            # of saying the turn is still running.
            logger.warning(
                "Could not remove the finished Discord status %s in channel %s "
                "(%s); leaving its final state in the channel instead.",
                message_ref,
                channel_id,
                error,
            )
            await self._edit_rich(channel_id, message_ref, text, lobby=lobby)
            return
        self._retire_ref(message_ref)

    async def _edit_rich(
        self, channel_id: str, message_ref: str, text: str, *, lobby: bool
    ) -> None:
        location_id, message_id = self._parse_message_ref(message_ref)
        try:
            if lobby:
                target = await self._get_channel(int(location_id or channel_id))
                message = await target.fetch_message(int(message_id))
                await message.edit(content=text, allowed_mentions=_NO_MASS_MENTIONS)
                return
            kwargs: dict[str, Any] = {}
            if location_id and location_id != channel_id:
                kwargs["thread"] = discord.Object(id=int(location_id))
            webhook = await self._publication_webhook(int(channel_id))
            await webhook.edit_message(
                int(message_id),
                content=text,
                allowed_mentions=_NO_MASS_MENTIONS,
                **kwargs,
            )
        except Exception as error:
            raise self._rich_failure(
                error,
                f"Discord refused the edit to {message_ref} in channel {channel_id}",
                text,
            ) from error

    def _rich_failure(self, error: Exception, description: str, text: str) -> Exception:
        """The exception to raise for `error`: Discord's refusal, or its own.

        Raising the original back is what keeps an uncertain send's reservation
        alive, so this returns rather than raises — the caller writes
        `raise ... from error` and the chain stays intact either way.
        """
        return _as_rich_failure(error, description=description, text=text) or error

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
        client = self._client
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
            return self._bot_user_id or None
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
        if thread_id is None or self._client is None:
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
        working: bool,
        force: bool = False,
    ) -> None:
        """Put 👀 on the message being worked on, or take it off.

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
                "Cannot mark %s as being worked on: not a Discord message reference.",
                message_ref,
            )
            return
        if not force and working == (message_ref in self._eyes):
            return
        await self._react(message_ref, working=working)

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
            if thread_id is not None and self._client is not None:
                target = self._client.get_channel(thread_id)
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

    def _retire_ref(self, message_ref: str) -> None:
        self._rich_retired[message_ref] = None
        self._rich_retired.move_to_end(message_ref)
        while len(self._rich_retired) > self._rich_retired_max:
            self._rich_retired.popitem(last=False)

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
        trigger_thread_root_id: str | None = None,
        anchor_message_ref: str | None = None,
    ) -> None:
        """Render runtime state as persistent, truly-deletable status messages.

        Discord deletes webhook messages cleanly (no tombstone), so — like
        Slack — the "working on it…" indicator and any "needs your input"
        pings are posted while relevant and deleted when the turn ends. The
        working indicator stays up through `awaiting-input` (the agent is
        mid-turn, just paused) and the pings are removed alongside it when
        the turn goes idle or resumes to `working`. When the agent was
        addressed in a thread, messages surface in that thread.

        Alongside them the message the agent is answering carries 👀 for as long
        as the turn lasts. The status sits where the conversation is, so the
        reaction is the only thing that says *which* message is being handled —
        and it needs nothing from Discord but a permission, so it is there at
        the channel root as well as inside a thread.
        """
        # Marked before the branching below, because the working branch returns
        # early when it only has to refresh the message in place.
        await self._track_turn(channel_id, anchor_message_ref, agent_name, state=state)

        key = (channel_id, agent_name)
        if state == "working":
            await self._clear_input_pings(channel_id, agent_name)
            # Posted under the agent's own name/icon, so the body just states
            # the activity — no need to repeat the agent name in the text.
            body = self._working_body(detail, deeplink_url)
            existing = self._working_msg.get(key)
            if existing is not None:
                await self.update_message(channel_id, existing.message_ref, body)
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
                channel_id,
                agent_name,
                mention_handle,
                thread_root_id,
                deeplink_url,
                detail,
            )
            if ref is not None:
                self._input_pings.setdefault(key, []).append(ref)
        else:
            await self._clear_working(channel_id, agent_name)
            await self._clear_input_pings(channel_id, agent_name)

    async def _track_turn(
        self,
        channel_id: str,
        anchor_message_ref: str | None,
        agent_name: str,
        *,
        state: str,
    ) -> None:
        """Mark every message this agent is working on, and unmark them together.

        An agent asked two things at once works on both, and each message gets
        its own 👀 — but the turn ends **once**, naming only the message it last
        touched. Clearing just that one leaves the first marked as being worked
        on for good, so they are remembered per agent and cleared together.
        """
        akey = (channel_id, agent_name)
        if state in ("working", "awaiting-input"):
            if anchor_message_ref is None:
                return
            self._agent_eyes.setdefault(akey, set()).add(anchor_message_ref)
            await self._mark_being_read(anchor_message_ref, working=True)
            return

        for ref in sorted(self._agent_eyes.pop(akey, set())):
            await self._mark_being_read(ref, working=False)

    async def _mark_being_read(self, message_ref: str, *, working: bool) -> None:
        """Put 👀 on the message an agent is working on, and take it off after.

        Needs only the Add Reactions permission, and works at the channel root
        as well as inside a thread — so it is the progress signal that is always
        available. A guild that has not granted the permission gets one warning
        and no reaction, rather than a mark that is not there.

        This path has no durable record, so it answers the refused-removal
        question from `self._eyes` — which is sound only because it will not
        attempt a removal at all unless this process put the mark there. The
        reaction is then known to be outstanding, and is reported as such.
        """
        _, message_id = self._parse_message_ref(message_ref)
        if not message_id or self._client is None:
            return
        if working == (message_ref in self._eyes):
            return

        try:
            await self._react(message_ref, working=working)
        except ActivityMarkRefused as refusal:
            if working:
                logger.warning("%s", refusal)
            else:
                logger.error(
                    "%s The mark this process put there is still on the message.",
                    refusal,
                )
        except (discord.HTTPException, ValueError) as e:
            logger.warning(
                "Could not %s the working reaction on Discord message %s: %s",
                "add" if working else "remove",
                message_ref,
                e,
            )

    async def _react(self, message_ref: str, *, working: bool) -> None:
        """Add or remove 👀, letting through whatever another attempt might fix.

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
        try:
            channel = await self._get_channel(int(location_id))
            message = channel.get_partial_message(int(message_id))
            if working:
                await message.add_reaction(_WORKING_REACTION)
                self._eyes.add(message_ref)
            else:
                await message.remove_reaction(_WORKING_REACTION, client.user)
                self._eyes.discard(message_ref)
        except discord.NotFound:
            # The message (or the reaction) is gone; the end state is what was
            # wanted either way.
            self._eyes.discard(message_ref)
        except discord.Forbidden as error:
            if working:
                raise ActivityMarkRefused(
                    f"Discord refused the working reaction on {message_ref} — the "
                    f"bot is missing the Add Reactions permission here. Turns still "
                    f"show their status message; only the mark on the message being "
                    f"answered is missing. Re-invite the bot with the permissions "
                    f"in DISCORD_SETUP.md."
                ) from error
            raise ActivityMarkRefused(
                f"Discord refused to take the working reaction off {message_ref}. "
                f"Removing our own reaction needs no permission of its own, so this "
                f"is the bot's access to the channel rather than the reaction: check "
                f"it can still see {message_ref}."
            ) from error

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
        return self._client.get_guild(self._guild_id) if self._client else None

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
          `translate_outbound` runs over the finished body after the label is
          inlined and resolves any handle it holds an id for into a real
          `<@id>` or `<@&role>`. The base class's `@` rule is what closes that,
          which is why this builds on it rather than replacing it.
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
            channel = (
                self._client.get_channel(int(match.group(1))) if self._client else None
            )
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
        guild = getattr(message, "guild", None)
        if guild is not None and guild.id != self._guild_id:
            return

        author = message.author
        # Drop only our own posts (loop prevention): the bot itself and the
        # bridge's webhooks. Third-party bots/webhooks are still bridged.
        if author.id == self._bot_user_id:
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
            bool(self._bot_user_id)
            and re.search(rf"<@!?{self._bot_user_id}>", content) is not None
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
                self_mention_token=str(self._bot_user_id) if self_mention else None,
            )
        )

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
            webhook = await channel.create_webhook(name=name)

        self._webhooks[(channel_id, name)] = webhook
        self._webhook_ids.add(webhook.id)
        return webhook

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
