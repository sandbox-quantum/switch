from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable

from switch_core.bridges.collaboration.models import (
    ChannelType,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)


class CollaborationAdapter(ABC):
    def __init__(self) -> None:
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        self._on_agent_joined: Callable[[InboundAgentJoin], Awaitable[None]] | None = (
            None
        )
        self._on_user_joined: Callable[[InboundUserJoin], Awaitable[None]] | None = None
        self._on_app_joined: Callable[[InboundAppJoin], Awaitable[None]] | None = None

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

        Platforms with a file API override this to upload the bytes natively.
        This default is the disclosed degradation for adapters without native
        support: a text message that names the attachment instead of silently
        dropping it.
        """
        note = f"_sent an attachment that couldn't be relayed: {filename}_"
        body = f"{caption}\n{note}" if caption else note
        return await self.send_message(
            channel_id, sender_name, self.translate_outbound(body), thread_root_id
        )

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
        """Surface a switchdash-managed agent's runtime state on the channel.

        How a state is rendered is the adapter's choice — this default uses the
        typing indicator for ``working``. Slack and Mattermost override this to
        show a persistent status message they remove (Slack) or edit to a
        terminal marker (Mattermost, whose delete leaves a tombstone).

        ``thread_root_id``, when set, is the external thread the triggering
        message belonged to; the state surfaces in that thread.

        ``deeplink_url``, when set, is an https link (served by the gateway) that
        opens the agent's session in the switchdash desktop app; adapters that
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

    @staticmethod
    def _deeplink_suffix(deeplink_url: str | None) -> str:
        """A trailing ``(Open in SwitchDash)`` link to the session, or empty.

        Appended inline in parentheses after the status text. Rendered through
        ``translate_outbound`` along with the rest of the body, so it converts
        to each platform's link format."""
        if not deeplink_url:
            return ""
        return f" ([Open in SwitchDash]({deeplink_url}))"

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
        app (switchdash → messaging app direction), or None when the platform
        has no such scheme or the link cannot be built.

        Each platform owns its link format here — Slack builds a ``slack://``
        URL from the workspace id, Mattermost a ``mattermost://`` URL from the
        server + team + channel name."""
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
