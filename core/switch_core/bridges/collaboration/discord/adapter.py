from __future__ import annotations

import asyncio
import logging
import re
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any

import discord

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.models import (
    Attachment,
    BridgeConnectionConfig,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)

# Webhook minted by the bridge in each channel it posts to; agents share it
# via per-message username/avatar overrides.
_WEBHOOK_NAME = "Switch Bridge"

_READY_TIMEOUT = 30.0


class DiscordConnectionConfig(BridgeConnectionConfig):
    bot_token: str
    guild_id: str


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

    def __init__(self, *, config: DiscordConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._guild_id = int(config.guild_id)
        self._client: discord.Client | None = None
        self._connect_task: asyncio.Task[None] | None = None
        self._bot_user_id: int = 0
        # channel id -> webhook the bridge posts through in that channel.
        self._webhooks: dict[int, discord.Webhook] = {}
        # Ids of webhooks the bridge has minted/adopted, for echo dropping.
        self._webhook_ids: set[int] = set()
        self._seen_ids: OrderedDict[int, None] = OrderedDict()
        self._seen_ids_max = 1000
        # Discord user id ↔ username caches, for mention translation both ways.
        self._user_names: dict[int, str] = {}
        self._username_to_id: dict[str, int] = {}
        # (channel_id, agent_name) -> message ref of the agent's live "working
        # on it…" runtime-state message, so it can be deleted when the agent
        # stops working. Webhook messages delete cleanly on Discord, so a
        # persistent message is preferable to the one-shot typing indicator.
        self._working_msg: dict[tuple[str, str], str] = {}
        # (channel_id, agent_name) -> refs of the live "needs your input" pings,
        # kept so they can be removed when the turn ends. The working indicator
        # stays up alongside these — the agent is mid-turn, just paused.
        self._input_pings: dict[tuple[str, str], list[str]] = {}

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
        self._webhooks.clear()
        logger.info("Discord adapter stopped")

    def _require_client(self) -> discord.Client:
        if self._client is None:
            raise RuntimeError("Discord client not connected")
        return self._client

    # ── Agent icon ───────────────────────────────────────────────────────────

    @staticmethod
    def _get_agent_icon(agent_name: str) -> str:
        name = agent_name.replace("_", "+")
        return f"https://ui-avatars.com/api/?name={name}&background=random&size=128"

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
            try:
                msg = await target.send(
                    f"**{sender_name}**: {content}", suppress_embeds=True
                )
                return f"{msg.channel.id}:{msg.id}"
            except discord.HTTPException:
                logger.exception("Failed to send Discord DM in %s", channel_id)
                return None

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
            kwargs: dict[str, Any] = {}
            if thread is not None:
                kwargs["thread"] = thread
            sent: Any = await webhook.send(
                content=content,
                username=sender_name,
                avatar_url=self._get_agent_icon(sender_name),
                suppress_embeds=True,
                wait=True,
                **kwargs,
            )
            return f"{sent.channel.id}:{sent.id}"
        except discord.HTTPException as e:
            logger.error(
                "Failed to send message to Discord channel %s: %s", channel_id, e
            )
            return None

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str | None:
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
            msg = await target.send(content, suppress_embeds=True)
            return f"{msg.channel.id}:{msg.id}"
        except (discord.HTTPException, RuntimeError) as e:
            logger.error(
                "Failed to post admin message to Discord channel %s: %s",
                channel_id,
                e,
            )
            return None

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

    # ── Runtime state ────────────────────────────────────────────────────────

    async def apply_runtime_state(
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
        """Render runtime state as persistent, truly-deletable status messages.

        Discord deletes webhook messages cleanly (no tombstone), so — like
        Slack — the "working on it…" indicator and any "needs your input"
        pings are posted while relevant and deleted when the turn ends. The
        working indicator stays up through `awaiting-input` (the agent is
        mid-turn, just paused) and the pings are removed alongside it when
        the turn goes idle or resumes to `working`. When the agent was
        addressed in a thread, messages surface in that thread.
        """
        key = (channel_id, agent_name)
        if state == "working":
            await self._clear_input_pings(channel_id, agent_name)
            # Posted under the agent's own name/icon, so the body just states
            # the activity — no need to repeat the agent name in the text.
            body = self._working_body(detail, deeplink_url)
            existing = self._working_msg.get(key)
            if existing is not None:
                await self.update_message(channel_id, existing, body)
                return
            ref = await self.send_message(channel_id, agent_name, body, thread_root_id)
            if ref is not None:
                self._working_msg[key] = ref
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
        ref = self._working_msg.pop((channel_id, agent_name), None)
        if ref is not None:
            await self.delete_message(channel_id, ref)

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
    ) -> None:
        channel = await self._get_channel(int(channel_id))
        if self._channel_type_of(channel) != "channel_private":
            # Public guild channels are visible to every member — there is no
            # per-channel membership to grant.
            return
        guild = channel.guild
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

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None:
        pass

    async def remove_agent_identity(self, agent_name: str) -> None:
        pass

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Translation ──────────────────────────────────────────────────────────

    def translate_outbound(self, content: str) -> str:
        # Discord renders markdown natively (bold, code, headers, masked
        # links), so only @username mentions need rewriting to real Discord
        # mentions for users we have resolved. Agents and unknown names stay
        # plain text.
        def _replace(match: re.Match[str]) -> str:
            user_id = self._username_to_id.get(match.group(1))
            return f"<@{user_id}>" if user_id else match.group(0)

        return re.sub(r"@([a-z0-9][a-z0-9._-]*)", _replace, content)

    def translate_inbound(self, raw_message: str) -> str:
        def _replace_user(match: re.Match[str]) -> str:
            name = self._user_names.get(int(match.group(1)))
            return f"@{name}" if name else match.group(0)

        def _replace_channel(match: re.Match[str]) -> str:
            channel = (
                self._client.get_channel(int(match.group(1))) if self._client else None
            )
            name = getattr(channel, "name", None)
            return f"#{name}" if name else match.group(0)

        message = re.sub(r"<@!?(\d+)>", _replace_user, raw_message)
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
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=str(author.id),
                    sender_name=username,
                    command=parts[0].lstrip("!"),
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return

        if self._on_message is None:
            return

        attachments = await self._fetch_image_attachments(
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
                self_mention_token=str(self._bot_user_id) if self_mention else None,
            )
        )

    # ── Attachments ──────────────────────────────────────────────────────────

    async def _fetch_image_attachments(self, files: list[Any]) -> list[Attachment]:
        """Download image attachments from a Discord message.

        Non-image files are skipped (images-only for now, mirroring Slack and
        Mattermost). A single file that fails to download is logged and
        skipped rather than dropping the whole message.
        """
        attachments: list[Attachment] = []
        for file in files:
            mimetype = str(getattr(file, "content_type", "") or "")
            if not mimetype.startswith("image/"):
                logger.debug(
                    "Skipping non-image Discord attachment %s (%s)",
                    getattr(file, "id", "?"),
                    mimetype or "unknown",
                )
                continue
            filename = str(getattr(file, "filename", "") or "image")
            try:
                data = await file.read()
            except Exception:
                logger.exception("Failed to download Discord attachment %s", filename)
                continue
            attachments.append(
                Attachment(filename=filename, mimetype=mimetype, data=data)
            )
        return attachments

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
        cached = self._webhooks.get(channel_id)
        if cached is not None:
            return cached

        channel = await self._get_channel(channel_id)
        webhook: discord.Webhook | None = None
        for existing in await channel.webhooks():
            if existing.name == _WEBHOOK_NAME and existing.token:
                webhook = existing
                break
        if webhook is None:
            webhook = await channel.create_webhook(name=_WEBHOOK_NAME)

        self._webhooks[channel_id] = webhook
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
