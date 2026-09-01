from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import ClassVar

from switch_core.agent_icon import default_icon_url
from switch_core.bridges.collaboration.models import (
    BridgeInstallLink,
    ChannelCreationUnsupported,
    ChannelType,
    DirectoryUser,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)

logger = logging.getLogger(__name__)

_ZERO_WIDTH_SPACE = "\u200b"


def format_elapsed(seconds: float) -> str:
    """How long a turn took, for the marker its status line becomes.

    Rounded to whole seconds and written the way a reader skims it — "8s",
    "2m14s", "1h03m" — rather than as a precise duration nobody reads. Sub-
    second turns report "0s" instead of an empty string.

    Lives here rather than beside one adapter because every platform that
    retires a status line by editing it rather than deleting it wants the same
    words on it.
    """
    total = max(0, int(seconds))
    if total < 60:
        return f"{total}s"
    minutes, secs = divmod(total, 60)
    if minutes < 60:
        return f"{minutes}m{secs:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


@dataclass(frozen=True)
class AgentPresentation:
    """The presentation columns of one agent, exactly as they are stored.

    Raw on purpose: ``None`` in either field means the agent was given no value
    for it, and what stands in for a missing value is per-platform — Mattermost
    wants a default icon in a format it can upload, Slack wants one drawn on its
    own background. Deciding that here would take the choice away from the
    adapter that has to live with it.
    """

    display_name: str | None
    icon_url: str | None


@dataclass(frozen=True)
class AgentRendering:
    """How one agent is presented on one send, resolved for this platform.

    The two labels are separate members rather than one because they are not
    interchangeable: ``field_label`` is safe only in a platform field that
    carries a name on its own, and putting it in message text is how a display
    name forges markup. A caller building a body string reaches for the member
    whose name says so.
    """

    field_label: str
    body_label: str
    icon_url: str


@dataclass(frozen=True)
class LiveRuntimeIndicator:
    """The runtime status message currently posted for one agent in one channel.

    ``body`` and ``thread_root_id`` are retained so the indicator can be
    reposted verbatim, in the same thread, when it is moved to follow newer
    traffic — a move has no access to the ``detail``/``deeplink_url`` the body
    was originally rendered from.

    ``started_at`` is a ``time.monotonic()`` reading from when the turn's
    indicator first went up, for adapters that report how long the turn took
    once it ends. Monotonic because it measures an elapsed span, which a clock
    adjustment must not distort.
    """

    message_ref: str
    body: str
    thread_root_id: str | None
    started_at: float


class CollaborationAdapter(ABC):
    #: Whether this platform can create a channel from Switch at all.
    #:
    #: A ceiling, not a preference: an operator may withhold channel creation
    #: from a connection whose platform allows it, but cannot grant it to one
    #: that does not. Declared on the class rather than resolved from a running
    #: bridge so the answer is available before a connection is registered and
    #: while it is stopped — the operator asks "can this platform do it?" at
    #: exactly those moments.
    supports_channel_creation: ClassVar[bool] = True

    #: Whether this platform has a user directory Switch can search.
    #:
    #: False where the only people Switch can name are the ones who have
    #: spoken to it — a Telegram bot cannot enumerate anyone else. That is not
    #: a smaller directory, it is a different question: on a freshly connected
    #: connection of such a type the answer is always "nobody", so asking a
    #: user to pick themselves from it is asking them to pick from an empty
    #: list. Declared on the class for the same reason as
    #: `supports_channel_creation` — the answer is needed before a connection
    #: exists and while one is stopped.
    supports_directory_search: ClassVar[bool] = True

    #: Whether this platform renders a link whose scheme is not http(s).
    #:
    #: False for platforms that linkify only the web schemes. It matters
    #: because the "Open in Switch Console" deeplink is a `switchdash://` URL:
    #: where this is False that link cannot work as written, and the deployment
    #: needs `GATEWAY_PUBLIC_URL` set so Switch can rewrite it to the https
    #: redirect. Declared here so the lifecycle can say so once at startup
    #: instead of each bridge discovering it in its own way.
    renders_custom_url_schemes: ClassVar[bool] = True

    #: Whether a runtime-state report with no thread of its own should anchor
    #: to the message the agent is working on.
    #:
    #: A report only carries a `thread_id` when the agent was addressed inside
    #: an existing thread. Addressed at the conversation root it carries none,
    #: while the agent's reply still opens a thread on the triggering message —
    #: so the status and the answer to it end up in two different places.
    #: Where this is True the anchor the agent reports (the last message it was
    #: actually handed) stands in, putting the status in the thread the reply
    #: will land in.
    #:
    #: Off by default: on a platform that renders a thread as a side panel
    #: rather than inline, moving the status out of the channel hides it, and
    #: that trade is the platform's to make.
    runtime_state_follows_anchor: ClassVar[bool] = False

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
        # Set by set_agent_presentation_resolver. Returns the agent's stored
        # presentation, or None for a name that is not an agent. Left unset an
        # adapter still works — every agent renders under its identifier with
        # the platform default icon — so adapters stay usable without a bridge
        # core wired up behind them.
        self._resolve_agent_presentation: (
            Callable[[str], Awaitable[AgentPresentation | None]] | None
        ) = None
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

    @classmethod
    async def prepare_config(
        cls, connection_config: dict[str, object]
    ) -> dict[str, object]:
        """Fill in values the operator should not have to supply, at create time.

        Called once, when a bridge is registered — never on start, so a value
        minted here is persisted and stable for the life of the bridge. An
        adapter that generates key material must do it here rather than in a
        model default, or every restart would mint a fresh one and quietly
        invalidate whatever the last one signed or encrypted.

        Async because generating key material is CPU-bound and this runs on
        the event loop that carries every live Matrix session.
        """
        return connection_config

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        """Name a host resource this bridge needs to itself, if any.

        Two bridges returning the same string cannot coexist in one process.
        Returning None — the default — means a bridge of this type can be run
        alongside any number of its own kind, which is true of every adapter
        that only dials out.

        The returned string is quoted verbatim in the refusal shown to whoever
        registers the second bridge, so it must not embed credential material.

        The point is to refuse the second one at registration, with a sentence
        saying what clashed. Without it the collision surfaces as whatever the
        underlying resource does when contended, which for a TCP port is a bind
        error inside a background task, minutes later and nowhere near the
        operator who caused it.
        """
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Prove the credentials work, before the bridge is persisted.

        Raise :class:`BridgeCredentialError` with a message fit for an operator
        to read. Adapters start in a background task whose exceptions are logged
        and swallowed, so without this a wrong password looks like success and
        surfaces hours later as an unrelated-looking failure.

        The default accepts anything: an adapter that cannot check cheaply
        should not pretend to.
        """
        return None

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
        has a distinct bot identity should override to use it.

        **`content` is Switch Markdown, and this method renders it.** Unlike
        `send_message`, whose caller translates, every caller here passes an
        unrendered body — the notices in `bridge_core`, the adapters' own
        notices, and the relayed admin events alike. An override must therefore
        run `translate_outbound` itself. Splitting that responsibility between
        callers is what once sent a body through the conversion twice, and the
        second pass escapes the markup the first one produced."""
        return await self.send_message(
            channel_id,
            self._bridge_display_name(),
            self.translate_outbound(content),
            thread_root_id,
        )

    def _bridge_display_name(self) -> str:
        return "Switch"

    def is_placeholder_username(self, username: str) -> bool:
        """Whether a stored name for a person is really one of this platform's
        opaque ids, recorded because nothing better was available at the time.

        Switch files a person under the name it first sees, and some platforms
        do not always supply one — Teams omits it from a 1:1 chat activity. The
        id then becomes that person's name everywhere: their Matrix account,
        the title of any room auto-created for them, and every agent reply that
        addresses them. Fixing the resolution stops it happening to the next
        person and does nothing for the ones already recorded, so an adapter
        that can recognise its own ids says so here and the name is repaired
        the next time they speak.

        Default False: on a platform whose handles are handles, there is
        nothing to recognise and nothing to repair.
        """
        return False

    def render_app_mention(self, token: str) -> str:
        """Render a mention of the Switch app itself, given the platform's own
        handle for it.

        Mention syntax is per-platform and the caller is not: this is used by a
        notice in shared bridge code, which for a long time emitted Slack's
        ``<@id>`` form everywhere. Slack renders that as the app's name; Teams
        prints it verbatim, so a user was told they had tagged
        ``<@28:11111111-…>``. Override wherever that form is not what the
        platform reads.
        """
        return f"<@{token}>"

    def slash_invite_hint(self) -> str | None:
        """How to run `invite-agent` as a native slash command here, if at all.

        The `/` form is per-platform: Slack declares its commands in the app
        manifest, Discord registers them per guild, and Telegram and Teams
        accept `/` as an ordinary message prefix, while Mattermost has nothing —
        so the no-agents notice must not advertise a `/` form on a bridge that
        has none to offer.
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
        mention_handle: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None = None,
        detail: str | None = None,
        trigger_thread_root_id: str | None = None,
        anchor_message_ref: str | None = None,
    ) -> None:
        """Serialise against any other runtime-indicator work for this agent,
        then apply the state. Adapters override ``_apply_runtime_state``."""
        async with self._runtime_lock(channel_id, agent_name):
            await self._apply_runtime_state(
                channel_id,
                agent_name,
                state,
                mention_handle=mention_handle,
                thread_root_id=thread_root_id,
                deeplink_url=deeplink_url,
                detail=detail,
                trigger_thread_root_id=trigger_thread_root_id,
                anchor_message_ref=anchor_message_ref,
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
        mention_handle: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None = None,
        detail: str | None = None,
        trigger_thread_root_id: str | None = None,
        anchor_message_ref: str | None = None,
    ) -> None:
        """Surface a Switch Console-managed agent's runtime state on the channel.

        How a state is rendered is the adapter's choice — this default uses the
        typing indicator for ``working``. Slack and Mattermost override this to
        show a persistent status message they remove (Slack) or edit to a
        terminal marker (Mattermost, whose delete leaves a tombstone).

        ``thread_root_id``, when set, is the external thread the state belongs
        in; the state surfaces there.

        ``trigger_thread_root_id`` is where the triggering message itself sits,
        and is None when it came from the channel root. The two differ on an
        adapter that pins a status to a thread the conversation is not in yet
        (see ``runtime_state_follows_anchor``): the status belongs in the
        thread, but a typing indicator belongs where the person who is waiting
        for it is looking. Defaulted because only an adapter that draws the
        distinction reads it, and its callers should not have to restate a
        value the other adapters ignore.

        ``anchor_message_ref`` is the external post the agent reports it is
        answering — the last message it was actually handed. Unlike the two
        above it names a *message* rather than a thread, and it is set whether
        or not that message opened one, so an adapter can mark the message
        itself (Discord puts a reaction on it) without moving where the status
        is posted. None when nothing the agent was handed crossed this bridge.

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
                channel_id, agent_name, mention_handle, thread_root_id, deeplink_url
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
        mention_handle: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None = None,
    ) -> str | None:
        """Post a message nudging the operator that the agent needs input.

        `mention_handle` is the agent owner's account on this platform, or None
        when there is nobody to reach — no owner, or an owner who has not said
        which account here is theirs. That case says so instead of posting a
        line nobody is notified about: a nudge that reaches no one looks
        identical to an agent that never asked.

        Returns the posted message ref so callers that can remove it (Slack,
        Mattermost) track it for cleanup when the turn ends."""
        label = await self.agent_label_for_body(agent_name)
        if mention_handle:
            text = f"@{mention_handle} **{label}** needs your input."
        else:
            text = (
                f"**{label}** needs your input — but nobody here is linked "
                f"to its owner, so this pings no one. Link your "
                f"{self.platform_name} account in Switch Console to be notified."
            )
        body = self.translate_outbound(text + self._deeplink_suffix(deeplink_url))
        return await self.send_message(channel_id, agent_name, body, thread_root_id)

    @abstractmethod
    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        """Provision a channel on the platform and return its external id.

        When the platform *refuses* — a permission not consented, a name it
        will not take — raise :class:`BridgeOperationError` carrying what the
        platform said. Room creation turns that into a 502 quoting it, so the
        operator who asked for the room learns why it failed; anything else
        becomes an opaque 500 and the explanation stays in the log. Raise
        :class:`ChannelCreationUnsupported` instead when declining without
        asking the platform at all.
        """
        ...

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
        raise ChannelCreationUnsupported(
            f"{self.platform_name} cannot create DM channels — on this platform "
            "DMs are initiated by the user from the messaging client"
        )

    @property
    def platform_name(self) -> str:
        """The platform as a person would name it, for messages that reach a
        user. The class name is the fallback rather than the source: "Telegram"
        belongs in a dialog, "TelegramAdapter" does not."""
        return type(self).__name__.removesuffix("Adapter")

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Search the platform's own user directory (CHOO-2137).

        Lets someone claim their platform identity before Switch has ever seen
        them speak — `ExternalUser` rows are only created on first message, so
        without this a freshly connected workspace offers nobody to pick from.

        Platforms with no searchable directory raise instead of returning an
        empty list, so the caller can say "you must post once first" rather
        than showing an empty picker that looks broken.
        """
        raise NotImplementedError(
            f"{self.platform_name} has no searchable user directory — on this "
            "platform someone must send a message before Switch knows them"
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
    ) -> list[str]:
        """Add the given people to a channel; return the ids that could not be.

        ``user_names`` and ``user_external_ids`` are positionally paired.

        A person who cannot be added is a poor reason to fail the whole
        operation — the caller is usually creating a room, and abandoning it
        over one guest account or one missing platform permission leaves a
        half-provisioned room behind and tells the operator nothing. Nor should
        it pass silently, which reports a room that quietly lacks the people
        asked for. So: continue, and hand back who was left out for the caller
        to disclose.
        """
        ...

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

    def set_channel_team_persister(
        self, persist: Callable[[str, str], Awaitable[None]]
    ) -> None:
        """Install a callback the adapter uses to persist which container a
        channel belongs to, when that is learned from inbound traffic rather
        than configured.

        Default is a no-op; Teams overrides it because a Graph message
        subscription is created against `teams/{team}/channels/{channel}`, and
        the team arrives only on an inbound activity. Losing it on restart
        silently kills capture in every channel outside the configured team."""
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

    def set_agent_presentation_resolver(
        self, resolver: Callable[[str], Awaitable[AgentPresentation | None]]
    ) -> None:
        """Install the lookup for how an agent is presented — its label and its
        icon — returning None for a name that is not an agent at all.

        The bridge core supplies this because the adapter has no database of
        its own. One resolver rather than one per field because a send needs
        both at once and they come off the same row: two would be two round
        trips for one message. Resolution happens per send rather than being
        cached, so a renamed or re-iconed agent reads correctly on its next
        message instead of at the next restart."""
        self._resolve_agent_presentation = resolver

    def default_agent_icon(self, agent_name: str) -> str:
        """The avatar for an agent that has set no icon.

        Overridable for a platform that needs the default in a particular shape
        — Mattermost uploads the bytes rather than passing a link on, so it
        pins the response format."""
        return default_icon_url(agent_name)

    def adapt_icon_url(self, raw: str | None, agent_name: str) -> str:
        """Turn the stored icon URL into the one this platform should be handed.

        `raw` is the agent's own icon, or None when it has none and the
        platform default stands in. Pure and synchronous so it composes with a
        single lookup: an override adjusts the URL, it does not go looking for
        one."""
        return raw or self.default_agent_icon(agent_name)

    def escape_label_for_body(self, label: str) -> str:
        """Neutralise a label's markup before it goes into message text.

        A display name is presentation text an agent's owner chooses, and
        `_ping_operator` inlines it into a body. Two constructs are near
        universal across chat platforms and are the ones a name can use to
        claim something it is not:

        - `@…` addresses somebody. Whether the platform resolves `@channel`,
          `@here`, a person or one of our own agent handles, the label gets to
          notify people the message was never aimed at. A zero-width space
          after every `@` leaves the sigil legible and the resolution dead.
        - `[text](url)` renders an anchor whose destination the label chose
          and whose visible text hides it. The zero-width space goes after the
          `]`, breaking the `](` adjacency every Markdown dialect requires —
          after the `[` it lands inside the visible text and the link still
          matches.

        Defused rather than escaped, because the escape has to survive as far
        as whatever renders it: on most platforms nothing of ours resolves
        these, so there is no matcher here to defeat, only the platform's own
        rendering. A zero-width space is also inert in every escaping pipeline
        it may pass through afterwards, so it cannot compound with one.

        Safe by default and specialised by override: the failure mode of the
        other order is silent, since a platform whose adapter forgets this
        renders a forged name correctly and says nothing. An override adds its
        platform's own rule on top and calls up to this one — Teams its `<at>`
        tags, Slack and Discord their markup escaping. None of them replaces
        it, and the `@` rule is why: a platform's escaper defends against the
        label carrying that platform's syntax, but Switch's own outbound
        mention pass runs over the finished body and turns a plain `@handle`
        into a real mention, needing no syntax from the label at all.

        Not covered anywhere: emphasis, where a label's `*` or `_` can
        unbalance the run around it. That is cosmetic, and the line held here
        is that forged markup is closed while broken formatting is not worth
        an escape that would show up in every ordinary name."""
        return label.replace("@", "@" + _ZERO_WIDTH_SPACE).replace(
            "]", "]" + _ZERO_WIDTH_SPACE
        )

    async def agent_rendering(self, agent_name: str) -> AgentRendering:
        """Everything a send needs to present an agent, from ONE lookup.

        The paired accessor, for the common case of a post that carries both a
        name and an avatar. The single-field accessors below are for callers
        that need one of them alone — an unescaped label is not among them:
        :attr:`AgentRendering.field_label` is reachable only alongside the
        escaped one, so choosing it is a choice."""
        raw = AgentPresentation(display_name=None, icon_url=None)
        if self._resolve_agent_presentation is not None:
            found = await self._resolve_agent_presentation(agent_name)
            if found is not None:
                raw = found
        label = raw.display_name or agent_name
        return AgentRendering(
            field_label=label,
            body_label=self.escape_label_for_body(label),
            icon_url=self.adapt_icon_url(raw.icon_url, agent_name),
        )

    async def agent_icon_url(self, agent_name: str) -> str:
        """The icon URL to render for an agent on this platform.

        Adapters call this wherever they need a per-message avatar: the agent's
        own icon when it has one, otherwise this platform's existing default."""
        return (await self.agent_rendering(agent_name)).icon_url

    async def agent_label_for_body(self, agent_name: str) -> str:
        """The label to inline into message text, escaped for this platform.

        A display name is free text — punctuation is the point of it — so
        inlining it raw lets a name break the surrounding markup or forge
        markup of its own. Every caller that builds a body string must use
        this, or :attr:`AgentRendering.body_label`."""
        return (await self.agent_rendering(agent_name)).body_label
