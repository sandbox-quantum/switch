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
from dataclasses import replace
from typing import Any

import httpx
import requests as sync_requests
from mattermostdriver import Driver
from mattermostdriver.exceptions import NoAccessTokenProvided

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


class MattermostAdapter(CollaborationAdapter):
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

        self._main_loop: asyncio.AbstractEventLoop | None = None

        # channel id -> channel name (URL slug), for building channel deeplinks.
        self._channel_name_cache: dict[str, str] = {}

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

        logger.info(
            "Mattermost adapter connected to %s as %s",
            self._config.url,
            self._config.admin_user,
        )

    async def stop(self) -> None:
        self._admin_driver = None
        self._bot_drivers.clear()
        logger.info("Mattermost adapter stopped")

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
    ) -> str | None:
        """Post an admin/system message natively on Mattermost.

        In a normal channel it goes out as the dedicated Switch Admin bot. A
        1:1 DM channel cannot admit a third bot, so there it falls back to the
        agent bot that owns the DM, lightly marked so it reads as a system
        notice rather than the agent's own voice."""
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
    ) -> str | None:
        loop = self._main_loop
        if loop is None:
            logger.error("Cannot send message: event loop not initialized")
            return None
        post: dict[str, str] = {"channel_id": channel_id, "message": content}
        if thread_root_id is not None:
            post["root_id"] = thread_root_id
        try:
            result = await loop.run_in_executor(None, driver.posts.create_post, post)
            post_id: str = result.get("id", "")
            return post_id or None
        except Exception as e:
            logger.error("Failed to send Mattermost message to %s: %s", channel_id, e)
            return None

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

    # ── Typing ───────────────────────────────────────────────────────────────

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        logger.debug("Mattermost set typing: %s", is_typing)
        if not is_typing:
            return

        bot_info = self._agent_bots.get(sender_name)
        if not bot_info:
            logger.warning("No bot info found for sender name %s", sender_name)
            return

        bot_driver = self._bot_drivers.get(sender_name)
        loop = self._main_loop
        if not bot_driver or not loop:
            logger.warning("No bot driver found for sender name %s", sender_name)
            return

        try:
            await loop.run_in_executor(
                None,
                bot_driver.client.make_request,
                "post",
                f"/users/{bot_info['user_id']}/typing",
                {"channel_id": channel_id},
            )
        except Exception as e:
            logger.debug("Failed to send MM typing for %s: %s", sender_name, e)

    # ── Runtime state ──────────────────────────────────────────────────────────

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
        """Surface runtime state as a posted message that is **never deleted**.

        Mattermost's web client replaces any message deleted while it is on
        screen with a "(message deleted)" placeholder, and only drops that on
        reload. It does so however the message was removed — a permanent delete
        looks the same to it as a soft one — so a status line that appears and
        vanishes each turn leaves a trail of placeholders behind it. There is no
        server setting that turns this off. The only way not to provoke it is
        not to delete: every status message here is retired by editing it in
        place.

        - ``working`` → post "working on it…" as the agent (in-thread when the
          trigger was threaded); it stays up across intermediate replies and
          through ``awaiting-input``.
        - ``idle`` (where ``completed`` collapses) → edit the working message
          into a "done" marker, and resolve any pings the same way.
        - ``awaiting-input`` → leave the working message up; post a separate
          operator ping (tracked for resolution when the turn ends).
        """
        key = (channel_id, agent_name)
        if state == "working":
            # Resuming work means the requested input was provided — remove the
            # now-resolved pings, then ensure the working indicator is up.
            await self._clear_input_pings(channel_id, agent_name)
            body = self._working_body(detail, deeplink_url)
            existing = self._working_msg.get(key)
            if existing is not None:
                # Refresh the live message in place with the latest activity.
                await self._patch_post_as(agent_name, existing.message_ref, body)
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
                channel_id, agent_name, notify_user, thread_root_id, deeplink_url
            )
            if ref is not None:
                self._input_pings.setdefault(key, []).append(ref)
        else:
            await self._dispose_working(channel_id, agent_name)
            await self._clear_input_pings(channel_id, agent_name)

    async def _clear_input_pings(self, channel_id: str, agent_name: str) -> None:
        """Resolve the tracked operator pings when the turn ends.

        Edited rather than removed, for the same reason as the working message:
        a delete would leave a placeholder in every client that had the ping on
        screen — which, for a ping, is precisely the people it was aimed at."""
        for post_id in self._input_pings.pop((channel_id, agent_name), []):
            await self._patch_post_as(
                agent_name, post_id, self.translate_outbound("✓ Input received")
            )

    async def _reposition_runtime_state(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Leave the indicator where it was first posted.

        Moving it means removing it from where it is, and any removal shows as
        "(message deleted)" to everyone currently looking at the channel — once
        per move, so an active conversation accumulates them fastest. The
        indicator is pinned to the point the turn began instead: less precise
        about where the agent is up to, but it costs the reader nothing.
        """
        return

    async def _dispose_working(self, channel_id: str, agent_name: str) -> None:
        """Retire the live "working on it…" message when the turn ends.

        Edited into a terminal marker rather than removed — see
        ``_apply_runtime_state`` for why nothing here is ever deleted. Kept to
        the bare fact that the turn finished and how long it took: this line
        stays in the channel for good, so it earns its place by being small.
        The session link belongs on the live indicator, where it is still
        actionable, not on the record of a turn that is over."""
        live = self._working_msg.pop((channel_id, agent_name), None)
        if live is None:
            return
        elapsed = _format_elapsed(time.monotonic() - live.started_at)
        await self._patch_post_as(
            agent_name,
            live.message_ref,
            self.translate_outbound(f"✓ Done · {elapsed}"),
        )

    async def _patch_post_as(self, agent_name: str, post_id: str, content: str) -> None:
        driver = self._bot_drivers.get(agent_name) or self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.error("Cannot edit runtime-state post: Mattermost not connected")
            return
        try:
            await loop.run_in_executor(
                None, driver.posts.patch_post, post_id, {"message": content}
            )
        except Exception as e:
            logger.error(
                "Failed to edit Mattermost runtime-state post %s: %s", post_id, e
            )

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
    ) -> None:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError(
                "Cannot add users to channel: Mattermost client not connected"
            )

        loop = self._main_loop
        for username in user_names:
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

        existing = await self._find_existing_bot(agent_name)
        if existing:
            bot_id: str = str(existing["user_id"])
        else:
            try:
                bot = self._mm_api(
                    "post",
                    "/bots",
                    {
                        "username": agent_name,
                        "display_name": agent_name,
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

        logger.info("Created Mattermost bot identity: %s", agent_name)

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

    # ── Bot icons ────────────────────────────────────────────────────────────

    async def _set_bot_icon(self, bot_id: str, agent_name: str) -> None:
        if not self._admin_driver or not self._main_loop:
            logger.error("[BOT-ICON] skipping %s: no driver or loop", agent_name)
            return
        driver = self._admin_driver
        try:
            url = f"https://ui-avatars.com/api/?name={agent_name}&background=random&size=128&format=png"
            logger.debug("[BOT-ICON] fetching avatar for %s", agent_name)
            async with httpx.AsyncClient() as client:
                resp = await client.get(url)
                resp.raise_for_status()
                image_bytes = resp.content
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
            "verify": False,
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
        try:
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
        except Exception:
            pass
        return None


def _format_elapsed(seconds: float) -> str:
    """How long a turn took, for the marker its status line becomes.

    Rounded to whole seconds and written the way a reader skims it — "8s",
    "2m14s", "1h03m" — rather than as a precise duration nobody reads. Sub-
    second turns report "0s" instead of an empty string.
    """
    total = max(0, int(seconds))
    if total < 60:
        return f"{total}s"
    minutes, secs = divmod(total, 60)
    if minutes < 60:
        return f"{minutes}m{secs:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"
