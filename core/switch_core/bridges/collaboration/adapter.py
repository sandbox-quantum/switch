from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace

from switch_core.bridges.collaboration.models import (
    BridgeInstallLink,
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LiveRuntimeIndicator:
    """The runtime status message currently posted for one agent in one channel.

    ``body`` and ``thread_root_id`` are retained so the indicator can be
    reposted verbatim, in the same thread, when it is moved to follow newer
    traffic — a move has no access to the ``detail``/``deeplink_url`` the body
    was originally rendered from.
    """

    message_ref: str
    body: str
    thread_root_id: str | None


class CollaborationAdapter(ABC):
    def __init__(self) -> None:
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        self._on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]] | None = (
            None
        )
        self._on_user_joined: Callable[[InboundUserJoin], Awaitable[None]] | None = None
        self._on_app_joined: Callable[[InboundAppJoin], Awaitable[None]] | None = None
        # Set by set_channel_migration_handler. Called with (old_id, new_id)
        # when the platform reissues a channel's id.
        self._on_channel_migrated: Callable[[str, str], Awaitable[None]] | None = None
        # Inbound attachment size ceiling, set by the lifecycle service from
        # config.agent_media_max_bytes. Adapters check a platform-reported file
        # size against this before downloading so an oversize file is rejected
        # loudly instead of being pulled down and discarded.
        self._max_attachment_bytes = 20 * 1024 * 1024
        # (channel_id, agent_name) -> the agent's live "working on it…" runtime
        # indicator, and the operator pings posted alongside it. Adapters that
        # render runtime state as a persistent message maintain these; the
        # typing-indicator default leaves them empty.
        self._working_msg: dict[tuple[str, str], LiveRuntimeIndicator] = {}
        self._input_pings: dict[tuple[str, str], list[str]] = {}
        # One lock per (channel_id, agent_name). Every mutation of the entries
        # above happens under it — see _runtime_lock.
        self._runtime_locks: dict[tuple[str, str], asyncio.Lock] = {}

    def set_max_attachment_bytes(self, max_bytes: int) -> None:
        self._max_attachment_bytes = max_bytes

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

    @abstractmethod
    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Post a message to the external channel.

        thread_root_id, when set, is the external platform's identifier for the
        thread root (e.g. Mattermost root_id) — the message should be posted as
        a reply within that thread. Adapters whose platform does not support
        threads ignore it.
        """
        ...

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
    ) -> str | None:
        """Post a first-class admin/system message to the external channel,
        rendered in the platform's native way as the bridge's own identity (not
        on behalf of any agent) — e.g. a heads-up that a tagged agent isn't in
        the room, or a command result.

        `message_type` is the `AdminMessageType` value (or None) so an adapter
        can special-case rendering per platform; adapters that don't simply
        render the default `content`. The default implementation posts via
        `send_message` under the bridge display name; adapters whose platform
        has a distinct bot identity should override to use it."""
        return await self.send_message(
            channel_id, self._bridge_display_name(), content, thread_root_id
        )

    def _bridge_display_name(self) -> str:
        return "Switch"

    def slash_invite_hint(self) -> str | None:
        """How to run `invite-agent` as a native slash command here, if at all.

        Native slash commands are per-platform: Slack declares them in its app
        manifest, Discord registers them per guild and Telegram publishes a bot
        command menu, while Mattermost and Teams have none — so the no-agents
        notice must not advertise a `/` form on a bridge that has none to offer.
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

    @abstractmethod
    async def delete_message(self, channel_id: str, message_ref: str) -> None: ...

    @abstractmethod
    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None: ...

    def _runtime_lock(self, channel_id: str, agent_name: str) -> asyncio.Lock:
        """The lock serialising runtime-indicator work for one agent in one
        channel.

        The indicator is mutated from two independent places — the periodic
        activity refresh and a reposition triggered by new traffic — and each
        reads the tracked message, awaits a platform call, then writes it back.
        Left to interleave, the later write restores a superseded message ref:
        the entry then names a message that has just been deleted while the one
        actually on screen is referenced by nothing, so the end-of-turn clear
        cannot remove it and it stays in the channel for good.
        """
        return self._runtime_locks.setdefault((channel_id, agent_name), asyncio.Lock())

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
        """Serialise against any other runtime-indicator work for this agent,
        then apply the state. Adapters override ``_apply_runtime_state``."""
        async with self._runtime_lock(channel_id, agent_name):
            await self._apply_runtime_state(
                channel_id,
                agent_name,
                state,
                notify_user=notify_user,
                thread_root_id=thread_root_id,
                deeplink_url=deeplink_url,
                detail=detail,
            )

    async def reposition_runtime_state(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Serialise against any other runtime-indicator work for this agent,
        then move the indicator. Adapters override
        ``_reposition_runtime_state``."""
        async with self._runtime_lock(channel_id, agent_name):
            await self._reposition_runtime_state(channel_id, agent_name, thread_root_id)

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
        """Surface a Switch Console-managed agent's runtime state on the channel.

        How a state is rendered is the adapter's choice — this default uses the
        typing indicator for ``working``. Slack and Mattermost override this to
        show a persistent status message they remove (Slack) or edit to a
        terminal marker (Mattermost, whose delete leaves a tombstone).

        ``thread_root_id``, when set, is the external thread the triggering
        message belonged to; the state surfaces in that thread.

        ``deeplink_url``, when set, is an https link (served by the gateway) that
        opens the agent's session in the Switch Console desktop app; adapters that
        post a visible status message append it so a reader can jump there.

        - ``working`` → typing on.
        - ``awaiting-input`` → keep the working/typing indicator (the agent is
          mid-turn, paused for input) and ping the configured operator.
        - ``idle`` (where ``completed`` collapses) → typing off.
        """
        if state == "working":
            await self.send_typing(channel_id, agent_name, True)
        elif state == "awaiting-input":
            await self.send_typing(channel_id, agent_name, True)
            await self._ping_operator(
                channel_id, agent_name, notify_user, thread_root_id, deeplink_url
            )
        else:
            await self.send_typing(channel_id, agent_name, False)

    def agents_with_live_runtime_state(self, channel_id: str) -> list[str]:
        """Agents with a runtime indicator currently posted in this channel.

        Cheap and synchronous so a caller can skip the work of deciding whether
        a message warrants a move when there is nothing to move."""
        return [
            agent_name
            for (posted_channel, agent_name) in self._working_msg
            if posted_channel == channel_id
        ]

    async def _reposition_runtime_state(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """Move the agent's live runtime indicator to follow the latest message.

        Called when a message the agent is party to has just crossed the bridge,
        so the indicator no longer sits below the conversation it belongs to.
        The replacement is posted *before* the original is removed: the
        indicator is therefore never briefly absent, and a failed repost leaves
        the original in place rather than clearing it.

        ``thread_root_id`` is the thread that message belonged to, and is where
        the indicator lands — so it follows the agent between threads (and back
        out to the channel root) rather than being stranded in whichever thread
        the turn happened to start in.

        Runs under the agent's runtime lock, so the tracked indicator cannot be
        cleared or refreshed part-way through.

        Adapters that render runtime state as a typing indicator have nothing
        positional to move, so the default does nothing.
        """
        key = (channel_id, agent_name)
        live = self._working_msg.get(key)
        if live is None:
            return

        ref = await self.send_message(channel_id, agent_name, live.body, thread_root_id)
        if ref is None:
            logger.warning(
                "Could not repost the runtime indicator for %s in %s; leaving it "
                "at its current position",
                agent_name,
                channel_id,
            )
            return

        self._working_msg[key] = replace(
            live, message_ref=ref, thread_root_id=thread_root_id
        )
        await self._remove_runtime_indicator(channel_id, live.message_ref)

    async def _remove_runtime_indicator(
        self, channel_id: str, message_ref: str
    ) -> None:
        """Delete a superseded runtime indicator.

        Separate from ``delete_message`` so an adapter whose delete raises can
        keep a failed cleanup from tearing down the turn — the worst case is a
        duplicate indicator, which is visible, rather than a broken turn."""
        await self.delete_message(channel_id, message_ref)

    @staticmethod
    def _deeplink_suffix(deeplink_url: str | None) -> str:
        """A trailing ``(Open in Switch Console)`` link to the session, or empty.

        Appended inline in parentheses after the status text. Rendered through
        ``translate_outbound`` along with the rest of the body, so it converts
        to each platform's link format."""
        if not deeplink_url:
            return ""
        return f" ([Open in Switch Console]({deeplink_url}))"

    def _working_body(self, detail: str | None, deeplink_url: str | None) -> str:
        """The "working on it…" status text, rendered for this platform.

        Uses the connector-supplied `detail` (e.g. "Editing foo.py") as the live
        activity line when present, falling back to the generic phrase. The
        deeplink is appended as a trailing link either way."""
        activity = detail.strip() if detail and detail.strip() else "_Working on it…_"
        return self.translate_outbound(
            f"⚙️ {activity}" + self._deeplink_suffix(deeplink_url)
        )

    async def _ping_operator(
        self,
        channel_id: str,
        agent_name: str,
        notify_user: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None = None,
    ) -> str | None:
        """Post a message nudging the operator that the agent needs input.

        Returns the posted message ref so callers that can remove it (Slack,
        Mattermost) track it for cleanup when the turn ends."""
        mention = f"@{notify_user} " if notify_user else ""
        body = self.translate_outbound(
            f"{mention}**{agent_name}** needs your input."
            + self._deeplink_suffix(deeplink_url)
        )
        return await self.send_message(channel_id, agent_name, body, thread_root_id)

    @abstractmethod
    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str: ...

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
        raise NotImplementedError(
            f"{type(self).__name__} cannot create DM channels — on this platform "
            "DMs are initiated by the user from the messaging client"
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

    async def install_note(self) -> str | None:
        """What the links do not cover, in the platform's own terms.

        Rendered under :meth:`install_links` in the operator dashboard. Some
        kinds of chat cannot be reached by a link at all, and the operator is
        better told where to go instead than left to conclude a button is
        missing. Markdown-free plain text; None when there is nothing to add."""
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
    ) -> None: ...

    @abstractmethod
    async def create_agent_identity(
        self, agent_name: str, agent_description: str
    ) -> None: ...

    @abstractmethod
    async def remove_agent_identity(self, agent_name: str) -> None: ...

    @abstractmethod
    async def get_channel_agent_names(self, channel_id: str) -> list[str]: ...

    @abstractmethod
    def translate_outbound(self, content: str) -> str: ...

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

    def set_service_url_persister(
        self, persist: Callable[[str], Awaitable[None]]
    ) -> None:
        """Install a callback the adapter uses to persist an outbound endpoint
        it learns from inbound traffic, so outbound survives a restart.

        Default is a no-op; adapters whose outbound endpoint is only discovered
        from inbound activities (Teams, whose Bot Connector ``serviceUrl`` is
        carried on inbound activities) override this to persist it."""
        return None

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
