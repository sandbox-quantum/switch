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
from datetime import datetime
from typing import Any, ClassVar

import httpx
import requests as sync_requests
from mattermostdriver import Driver
from mattermostdriver.exceptions import (
    ContentTooLarge,
    FeatureDisabled,
    InvalidOrMissingParameters,
    MethodNotAllowed,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
)

from switch_core.agent_icon import default_icon_url
from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    CollaborationAdapter,
    LiveRuntimeIndicator,
    RequestCard,
    RichContent,
    RichContentFailed,
    RichContentThrottled,
    TurnActivity,
    format_elapsed,
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
    OutboundAttachment,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    request_summary,
    turn_status,
)

logger = logging.getLogger(__name__)

# Ceiling on a bot icon Switch downloads before re-uploading it to Mattermost.
# Generously above any real avatar; it exists so a hostile or broken URL cannot
# stream unbounded data into memory.
_MAX_BOT_ICON_BYTES = 5 * 1024 * 1024

# Mattermost channel types a bot can be *added* to: open and private channels.
# Membership of a DM ("D") or group DM ("G") is a property of the conversation
# existing rather than of anyone joining, so Mattermost raises no `user_added`
# for them and they must not be adopted from a membership sweep either — a DM
# becomes a room when someone actually writes in it.
_JOINABLE_MM_CHANNEL_TYPES = frozenset({"O", "P"})

# Emoji marking the message an agent is currently working on.
_REACTION: dict[ActivityMark, str] = {
    "working": "eyes",
    "queued": "hourglass_flowing_sand",
}

# The post property carrying a publication's recovery marker. Props are part of
# the post but not part of what anyone reads, which is exactly what this needs
# to be: a marker in the message body would be visible clutter, and a marker
# held only on this side is lost the moment a post's response is — which is the
# one case it exists for. `patch_post` leaves props it is not given alone, so
# editing the status in place cannot drop it.
_PUBLICATION_PROP = "switch_publication"

# How far before the recorded reservation time to start looking for a post that
# may or may not exist. Covers ordinary clock skew between Switch and the
# Mattermost server without widening the search into unrelated history.
_RECOVERY_SKEW_MS = 60_000

# Mattermost's own default `MaxPostSize`. Servers can raise it to 16383, and a
# message cut to fit the default is a message that fits everywhere.
_MAX_POST = 4000

# The values of `TeamSettings.TeammateNameDisplay` under which Mattermost puts
# a bot's display name in the post header. Under any other value — including
# the server default, "username" — the display name is stored and never shown.
_NAME_DISPLAY_SHOWS_LABEL = frozenset({"full_name", "nickname_full_name"})

# The errors that mean Mattermost read the request and refused it. `mattermostdriver`
# maps these statuses to named exceptions; every one of them says the post does
# not exist and sending it again unchanged would be refused again.
#
# Everything else — a timeout, a dropped connection, a 5xx — leaves it unknown
# whether the post is on the server with only its response lost, and that is a
# different answer entirely: see `_as_rich_failure`.
_DEFINITE_REFUSALS = (
    InvalidOrMissingParameters,
    NoAccessTokenProvided,
    NotEnoughPermissions,
    ResourceNotFound,
    MethodNotAllowed,
    ContentTooLarge,
    FeatureDisabled,
)

# How long to wait after a rate limit that names no interval of its own.
# Matches the Slack adapter's fallback, for the same reason: long enough not to
# walk straight back into the limit, short enough that a live turn still moves.
_THROTTLE_FALLBACK_SECONDS = 30.0


def _throttle_delay(error: Exception) -> float | None:
    """Seconds Mattermost asked us to wait, or None if it did not ask.

    `mattermostdriver` has no exception for 429, so the underlying
    `requests.HTTPError` arrives with its response still attached — which is
    what carries the interval.
    """
    response = getattr(error, "response", None)
    if response is None or getattr(response, "status_code", None) != 429:
        return None
    headers = getattr(response, "headers", None) or {}
    try:
        return max(0.0, float(headers.get("Retry-After", "")))
    except (TypeError, ValueError):
        return _THROTTLE_FALLBACK_SECONDS


def _as_rich_failure(
    error: Exception, *, description: str, text: str
) -> RichContentFailed | None:
    """What a publication should make of a Mattermost error, or nothing.

    `None` means the outcome is unknown and the caller must let the error
    propagate: a post whose response was lost may be sitting in the channel,
    and `RichContentFailed` would have the caller drop its reservation and
    post a second copy of something a reader is meant to see once. The
    reservation survives instead, and `find_request_card` settles it.

    Only a server that understood the request and refused it becomes
    `RichContentFailed`, and only one asking us to slow down becomes
    `RichContentThrottled`.
    """
    retry_after = _throttle_delay(error)
    if retry_after is not None:
        return RichContentThrottled(retry_after=retry_after, text=text)
    if isinstance(error, _DEFINITE_REFUSALS):
        return RichContentFailed(f"{description}: {error}", text=text)
    return None


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
    # Verify the Mattermost server's TLS certificate. Defaults to True so admin
    # credentials and bot tokens are never sent over an unverified https
    # connection. Set False only for a self-signed internal CA you trust.
    verify_tls: bool = True


class MattermostAdapter(CollaborationAdapter):
    publishes_sdk_sessions: ClassVar[bool] = True

    #: One message, not two. The compact status carries its own tool counts, so
    #: there is nothing left for a separate log to hold that is worth a second
    #: message in the thread — and an expandable tool history is a later piece
    #: of work, not something to approximate with an extra post now.
    separate_activity_log: ClassVar[bool] = False

    #: A problem somebody has to act on still gets its own reply, so it
    #: notifies rather than arriving as a silent edit to a status the reader
    #: has already scrolled past. One per turn, cleared when it clears.
    separate_attention_slot: ClassVar[bool] = True

    #: A Mattermost thread notifies only the people named in it, so the agent's
    #: owner leads — they are who can open Console and act — and an attention
    #: post with nobody to name says as much. This is the legacy ping's policy,
    #: carried over: it is the one that reaches the person who can do something.
    notifies_only_by_mention: ClassVar[bool] = True

    #: The status is the turn's one post, not a line beside it, so the clock
    #: advancing is not on its own worth rewriting what a reader is reading.
    #: Elapsed time goes out with the next real change and with the ending.
    redraws_for_elapsed_time: ClassVar[bool] = False

    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True

    #: Each agent posts and reacts as its own bot here, so two agents working
    #: on one message leave two independent 👀 and each is claimed and removed
    #: on its own.
    activity_reactions_per_agent: ClassVar[bool] = True

    #: Off, because the SDK publication now draws the status. Leaving it on
    #: would put two competing accounts of the same turn in the channel: the
    #: legacy "working on it…" post edited to "✓ Done" beside the activity
    #: message saying the same thing in more detail. The legacy renderer stays
    #: in the file — it is what every unmigrated platform still uses — and this
    #: flag is what stops it publishing here.
    renders_legacy_runtime_state: ClassVar[bool] = False

    #: Mattermost renders a thread inline under its root as well as in the
    #: side panel, so anchoring the status to the message being worked on keeps
    #: it beside the answer instead of stranding it at the channel root.
    #:
    #: Read only by the legacy runtime-state path, which is off above. Kept
    #: because it is a true statement about the platform, and the platform is
    #: what the flag describes.
    runtime_state_follows_anchor: ClassVar[bool] = True

    #: `find_request_card` reads the channel's recent posts back, so a card
    #: whose send was never acknowledged can be bound to what is actually
    #: there instead of being disclosed as lost.
    recovers_uncertain_posts: ClassVar[bool] = True

    #: Every publication carries its token in a post prop, which is exact and
    #: invisible, so a status is as findable as a card despite printing no
    #: handle of its own.
    carries_publication_marker: ClassVar[bool] = True

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

        # (channel_id, thread root post id) -> the post that actually asked.
        # Inside a thread that is the reply, not the root the reply hangs off.
        # Bounded like _seen_post_ids: it grows with inbound traffic and only
        # the recent entries can still be the subject of a live turn.
        self._thread_trigger: OrderedDict[tuple[str, str], str] = OrderedDict()
        self._thread_trigger_max = 1000
        self._thread_trigger_lock = threading.Lock()

        # (agent_name, post_id) currently carrying the working reaction. A
        # reaction belongs to the bot that added it, so two agents on the same
        # post are two independent marks.
        self._marked: set[tuple[str, str, ActivityMark]] = set()

        # (channel_id, agent_name) -> the posts that agent has marked. An agent
        # asked two things at once works on both, and the turn ends once — so
        # the marks are cleared together rather than only on the last thread
        # touched.
        self._agent_eyes: dict[tuple[str, str], set[str]] = {}

        # Mattermost user id -> username, because a mention is written with the
        # handle and Switch stores the id. Stable for the life of a user, so a
        # hit here saves a round trip on every redraw that carries a mention.
        self._usernames: OrderedDict[str, str] = OrderedDict()
        self._usernames_max = 1000

        self._main_loop: asyncio.AbstractEventLoop | None = None

        # channel id -> channel name (URL slug), for building channel deeplinks.
        self._channel_name_cache: dict[str, str] = {}

        # The server's `TeamSettings.TeammateNameDisplay`, read once per run:
        # it decides whether a bot's display name is rendered anywhere, and
        # under the default ("username") it never is. None once a read has been
        # attempted and could not answer.
        self._name_display_setting: str | None = None
        self._name_display_read = False
        self._name_display_warned = False

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
        notice rather than the agent's own voice.

        Renders its own body: every caller passes Switch Markdown, so the
        conversion belongs here rather than at each of them — one of them
        forgetting is how a notice reached a channel with its markup showing.
        """
        content = self.translate_outbound(content)
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
        props: dict[str, str] | None = None,
    ) -> str | None:
        try:
            return await self._post_or_raise(
                driver, channel_id, content, thread_root_id, props
            )
        except Exception as e:
            logger.error("Failed to send Mattermost message to %s: %s", channel_id, e)
            return None

    async def _post_or_raise(
        self,
        driver: Driver,
        channel_id: str,
        content: str,
        thread_root_id: str | None,
        props: dict[str, str] | None,
    ) -> str:
        """Create a post and hand back its id, or raise saying why not.

        `_create_post` is the swallowing wrapper for callers whose failure is
        cosmetic. A publication's is not: the exception carries what Mattermost
        actually said, which is the difference between a caller that can retry
        sensibly and one that only knows it got `None`.
        """
        loop = self._main_loop
        if loop is None:
            raise RuntimeError("Mattermost is not connected.")
        post: dict[str, Any] = {"channel_id": channel_id, "message": content}
        if thread_root_id is not None:
            post["root_id"] = thread_root_id
        if props:
            post["props"] = props
        result = await loop.run_in_executor(None, driver.posts.create_post, post)
        post_id: str = result.get("id", "")
        if not post_id:
            raise RuntimeError("Mattermost accepted the post but returned no id.")
        return post_id

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

    # ── SDK session publication ──────────────────────────────────────────────

    def rich_fallback_limit(self) -> int:
        return _MAX_POST

    def rich_fallback_text(self, content: RichContent) -> str:
        """What a publication says, with nothing that needed looking up.

        The renderers are the same ones `post_rich` uses; what is missing is
        the mention and the responder's handle, both of which come from an id
        Switch holds and a call to Mattermost to turn it into a name. This is
        the string that goes in a `RichContentFailed`, where a failed lookup
        on top of a failed post would say nothing useful anyway.
        """
        return self._draw(content, mention=None, responder=None)

    def _draw(
        self, content: RichContent, *, mention: str | None, responder: str | None
    ) -> str:
        escape = self._rich_escape
        limit = self.rich_fallback_limit()
        markup = self.rich_markup()
        if isinstance(content, TurnActivity):
            # Charged to the same budget as the status it follows: a post that
            # just fits, plus a line saying it reached nobody, is a post
            # Mattermost refuses.
            tail = f"\n{self.unnotified_notice()}" if content.notify_unreachable else ""
            return (
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
        # The handle goes on its own line rather than in front of the heading:
        # a card is a block, and a handle wedged before "**Permission needed**"
        # reads as part of the heading. It is charged to the same budget, or a
        # form that just fits becomes a post Mattermost refuses. So is the
        # notice below it, which is the same admission the turn status makes:
        # a request nobody was named in is a request nobody was asked.
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
        return f"{lead}{body}{tail}"

    async def _render_rich(self, content: RichContent) -> str:
        mention = await self._mention(content.notify_external_id)
        responder = (
            await self._mention(content.responder_external_id)
            if isinstance(content, RequestCard)
            else None
        )
        return self._draw(content, mention=mention, responder=responder)

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post a turn's status or a request's form as the agent's own bot.

        The recovery marker rides along in the post's props rather than in
        anything a reader sees, so a post whose response was lost can be found
        again by `find_request_card` instead of being sent twice.

        Raises on every failure, unlike `send_message`, which reports one by
        returning `None`: a publication that silently did not happen is a
        reservation that never gets retried and a turn the channel never sees.
        What it raises is the point — `RichContentFailed` is the caller's
        licence to discard the reservation, so it is reserved for a refusal
        Mattermost actually gave. A send whose outcome nobody knows raises the
        transport's own error and keeps the reservation.
        """
        text = await self._render_rich(content)
        driver = self._bot_drivers.get(agent_name)
        if driver is None:
            raise RichContentFailed(
                f"No Mattermost bot for agent {agent_name!r}, so its activity "
                f"cannot be posted in channel {channel_id}.",
                text=text,
            )
        token = (
            content.publication_token
            if isinstance(content, TurnActivity)
            else content.reference.token
        )
        try:
            ref = await self._post_or_raise(
                driver,
                channel_id,
                text,
                thread_root_id,
                {_PUBLICATION_PROP: token} if token else None,
            )
        except Exception as error:
            failure = _as_rich_failure(
                error,
                description=f"Mattermost refused the post in channel {channel_id}",
                text=text,
            )
            if failure is None:
                raise
            raise failure from error
        return ref

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a publication in place, and say so when it did not happen.

        Not `update_message`: that one logs and returns, which is right for the
        legacy status line nobody is waiting on and wrong here. A card that
        failed to redraw is still showing a settled request as open, and the
        caller has a reply to post about it — but only if it is told.

        Edited as the agent's own bot where there is one. Mattermost keeps the
        original author through a patch either way, so the fallback to the
        admin driver changes who a reader sees the post from not at all; what
        it changes is the permission the edit is made with, and an agent bot
        editing its own post is the narrower of the two.

        Says "did not happen" only where Mattermost refused the edit. An edit
        whose outcome is unknown may well have landed, and reporting it as a
        refusal buys a fallback reply about a card that is already correct.
        """
        # A post notifies; an edit does not. Repeating the mention on every
        # redraw would be a handle in the channel that never resolves to
        # anything new for the person it names.
        text = await self._render_rich(replace(content, notify_external_id=None))
        driver = self._bot_drivers.get(agent_name) or self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            raise RichContentFailed(
                "Mattermost is not connected, so the post could not be updated.",
                text=text,
            )
        try:
            await loop.run_in_executor(
                None, driver.posts.patch_post, message_ref, {"message": text}
            )
        except Exception as error:
            failure = _as_rich_failure(
                error,
                description=(
                    f"Mattermost refused the edit to post {message_ref} in "
                    f"channel {channel_id}"
                ),
                text=text,
            )
            if failure is None:
                raise
            raise failure from error

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
        handle: str | None,
    ) -> str | None:
        """Look for a publication this bridge may already have posted.

        Asked when a post's outcome is unknown — the request timed out, or the
        process died between sending and recording the id. The answer decides
        between binding the reservation to what is there and posting a second
        copy of a card somebody is meant to answer exactly once, so a lookup
        that cannot be trusted must come back as "not found" rather than as a
        guess: `None` keeps the reservation and asks again.

        Matched on the props marker and on the post's author, because a token
        quoted back in somebody's message must not be mistaken for the post
        that carries it. `handle` is unused for the same reason it is on
        Slack: the props marker is exact, and invisible to a reader.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.warning(
                "Cannot look for the publication marked %s in channel %s: "
                "Mattermost is not connected.",
                token,
                channel_id,
            )
            return None
        since = max(0, int(created_at.timestamp() * 1000) - _RECOVERY_SKEW_MS)

        def _read() -> dict[str, Any]:
            if thread_root_id:
                return dict(driver.posts.get_thread(thread_root_id))
            return dict(
                driver.posts.get_posts_for_channel(channel_id, params={"since": since})
            )

        try:
            page = await loop.run_in_executor(None, _read)
        except Exception as e:
            logger.warning(
                "Could not read %s looking for the publication marked %s: %s.",
                f"thread {thread_root_id}"
                if thread_root_id
                else f"channel {channel_id}",
                token,
                e,
            )
            return None
        for post in (page.get("posts") or {}).values():
            if post.get("user_id") not in self._bridge_bot_ids:
                continue
            if (post.get("props") or {}).get(_PUBLICATION_PROP) != token:
                continue
            found = str(post.get("id") or "")
            if found:
                return found
        return None

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        """Whether this message is the first thing said under a thread root.

        Mattermost's websocket event names the root but not the position in the
        thread, so the thread itself is the only place the answer is. Ordered
        here on `create_at` rather than trusted from the API's own `order`: a
        bare "yes" deciding a permission is not worth resting on a field whose
        direction is not part of the contract.

        Never raises. This is on the inbound path of every message, ahead of
        the relay, so an exception out of it is not a refused answer but a
        message the room never sees.
        """
        driver = self._admin_driver
        loop = self._main_loop
        if driver is None or loop is None:
            logger.warning(
                "Cannot read the thread under %s in %s: Mattermost is not "
                "connected. Treating %s as not the first reply.",
                root_ref,
                channel_id,
                message_ref,
            )
            return False
        try:
            thread = await loop.run_in_executor(None, driver.posts.get_thread, root_ref)
        except Exception as e:
            logger.warning(
                "Could not read the thread under %s in %s: %s. Treating %s as "
                "not the first reply.",
                root_ref,
                channel_id,
                e,
                message_ref,
            )
            return False
        replies = sorted(
            (
                post
                for post in (thread.get("posts") or {}).values()
                if post.get("id") != root_ref and not post.get("delete_at")
            ),
            key=lambda post: (post.get("create_at") or 0, str(post.get("id") or "")),
        )
        return bool(replies) and replies[0].get("id") == message_ref

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
        """Put this agent's mark on the message, or take it off.

        Per agent, because the reaction belongs to the bot that added it:
        two agents on one message are two marks, and one finishing leaves the
        other's alone. `force` is the durable publisher reconciling after a
        restart, when this process's record of what is already there is empty
        and wrong rather than empty and right.

        Raises when the mark did not happen, including when there is no bot to
        make it with. The publisher retries on that and records completion
        only once the channel actually shows what it says it shows.
        """
        await self._react_or_raise(
            agent_name, message_ref, mark=mark, on=on, force=force
        )

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        """The one-shot typing nudge, at the place the agent was asked.

        What the legacy runtime path sent as a turn opened, kept for the SDK
        one: Mattermost expires it after a few seconds, so it costs the channel
        nothing and it is the only signal that arrives before the first post.
        """
        await self._post_typing(channel_id, agent_name, thread_root_id)

    async def _mention(self, external_user_id: str | None) -> str | None:
        """`@handle` for a Mattermost user id, or None if it cannot be resolved.

        None rather than the raw id: an id printed where a handle belongs
        notifies nobody and reads as noise, and the message it decorates is
        worth sending without it.
        """
        if not external_user_id:
            return None
        username = self._usernames.get(external_user_id)
        if username is None:
            driver = self._admin_driver
            loop = self._main_loop
            if driver is None or loop is None:
                return None
            try:
                user = await loop.run_in_executor(
                    None, driver.users.get_user, external_user_id
                )
            except Exception as e:
                logger.warning(
                    "Could not resolve Mattermost user %s to a handle: %s",
                    external_user_id,
                    e,
                )
                return None
            username = str(user.get("username") or "")
            if not username:
                return None
            self._usernames[external_user_id] = username
            while len(self._usernames) > self._usernames_max:
                self._usernames.popitem(last=False)
        return f"@{username}"

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
        await self._post_typing(channel_id, sender_name, None)

    async def _post_typing(
        self, channel_id: str, sender_name: str, thread_root_id: str | None
    ) -> None:
        """Tell Mattermost the agent's bot is typing, in a thread when given one.

        Mattermost expires the indicator on its own after a few seconds, so
        this is a one-shot nudge rather than something to switch off. Without
        `parent_id` it only ever shows at the channel root, which is the wrong
        place when the agent is answering inside a thread.
        """
        bot_info = self._agent_bots.get(sender_name)
        if not bot_info:
            logger.warning("No bot info found for sender name %s", sender_name)
            return

        bot_driver = self._bot_drivers.get(sender_name)
        loop = self._main_loop
        if not bot_driver or not loop:
            logger.warning("No bot driver found for sender name %s", sender_name)
            return

        body: dict[str, str] = {"channel_id": channel_id}
        if thread_root_id is not None:
            body["parent_id"] = thread_root_id

        try:
            await loop.run_in_executor(
                None,
                bot_driver.client.make_request,
                "post",
                f"/users/{bot_info['user_id']}/typing",
                body,
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
        mention_handle: str | None,
        thread_root_id: str | None,
        deeplink_url: str | None = None,
        detail: str | None = None,
        trigger_thread_root_id: str | None = None,
        anchor_message_ref: str | None = None,
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

        The message that triggered the turn is marked with 👀 throughout, and
        unmarked when it ends — see ``_track_eyes``.
        """
        await self._track_eyes(channel_id, agent_name, state, thread_root_id)

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
                # Where the message came from, not where the status went. The
                # status is pinned to the thread the answer will land in, but
                # typing is for whoever is waiting — and someone who wrote at
                # the channel root is watching the root, not a thread they have
                # not opened.
                #
                # Only as the turn opens. Mattermost expires a typing indicator
                # after a few seconds, and the posted message is what carries
                # the state from there on — repeating it on every activity
                # refresh would say "typing" for as long as the agent runs.
                await self._post_typing(channel_id, agent_name, trigger_thread_root_id)
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

    # ── The eyes on the message being worked on ──────────────────────────────

    def _remember_trigger(self, channel_id: str, root_id: str, post_id: str) -> None:
        """Record the latest post in a thread, so the eyes land on what asked.

        Written from the websocket thread and read from the main loop, hence
        the lock. Oldest entries are dropped past the cap: a thread nobody has
        written in for a thousand messages is not the subject of a live turn,
        and losing the entry only puts the mark on the thread root.
        """
        with self._thread_trigger_lock:
            self._thread_trigger[(channel_id, root_id)] = post_id
            self._thread_trigger.move_to_end((channel_id, root_id))
            while len(self._thread_trigger) > self._thread_trigger_max:
                self._thread_trigger.popitem(last=False)

    async def _track_eyes(
        self,
        channel_id: str,
        agent_name: str,
        state: str,
        thread_root_id: str | None,
    ) -> None:
        """Mark every message this agent is working on, and clear them together.

        ``thread_root_id`` is where the answer will land: the thread the agent
        was addressed in, or — since this adapter follows the anchor — the
        message itself when it was addressed at the channel root. The mark
        belongs on what was actually said, so a threaded turn is traced back
        through ``_thread_trigger`` to the reply that asked rather than being
        put on the root it hangs off.
        """
        akey = (channel_id, agent_name)

        if state in ("working", "awaiting-input"):
            if thread_root_id is None:
                return
            asked_on = self._thread_trigger.get(
                (channel_id, thread_root_id), thread_root_id
            )
            self._agent_eyes.setdefault(akey, set()).add(asked_on)
            await self._mark_being_read(agent_name, asked_on, working=True)
            return

        for post_id in sorted(self._agent_eyes.pop(akey, set())):
            await self._mark_being_read(agent_name, post_id, working=False)

    async def _mark_being_read(
        self, agent_name: str, post_id: str, *, working: bool, force: bool = False
    ) -> None:
        """Best-effort 👀 for the legacy runtime path, which cannot act on failure.

        Nothing on that path retries and nothing records what it did, so a
        failure here is cosmetic and is logged rather than raised. The SDK seam
        goes through `_react_or_raise`: its publisher writes a completion
        receipt on the strength of what it is told, and a swallowed failure
        there leaves 👀 on a finished turn for good.
        """
        try:
            await self._react_or_raise(
                agent_name, post_id, mark="working", on=working, force=force
            )
        except Exception as e:
            logger.warning(
                "Could not %s the working reaction on %s: %s",
                "add" if working else "remove",
                post_id,
                e,
            )

    async def _react_or_raise(
        self,
        agent_name: str,
        post_id: str,
        *,
        mark: ActivityMark,
        on: bool,
        force: bool,
    ) -> None:
        """Put 👀 on the post an agent is working on, and take it off after.

        Added by the agent's own bot rather than the bridge account, so the
        reaction says *which* agent picked the message up and two agents on one
        message read as two. This is the progress signal that always works:
        unlike the status post it needs no thread, and unlike the typing
        indicator it does not expire.

        `self._marked` is this process's memory of what it has already done,
        and a restart empties it while the reactions stay in the channel.
        `force` is for the caller that knows better from the journal: skipping
        the call because the set is empty would strand a 👀 on a turn that
        ended while the bridge was down. It is remembered per reaction: a
        queued prompt that starts running loses the hourglass and keeps the
        eyes, so one cannot answer for the other.

        A failure leaves that memory alone, so the next attempt is a real
        attempt rather than one the record talks out of trying. Removing a
        reaction Mattermost says is not there is the exception: the channel is
        already in the state being asked for, and there is nothing to retry.
        """
        key = (agent_name, post_id, mark)
        if not force and on == (key in self._marked):
            return

        bot_info = self._agent_bots.get(agent_name)
        driver = self._bot_drivers.get(agent_name)
        loop = self._main_loop
        if not bot_info or driver is None or loop is None:
            raise RuntimeError(f"no connected bot for {agent_name!r}")
        user_id = bot_info["user_id"]

        if on:
            await loop.run_in_executor(
                None,
                driver.reactions.create_reaction,
                {
                    "user_id": user_id,
                    "post_id": post_id,
                    "emoji_name": _REACTION[mark],
                },
            )
            self._marked.add(key)
            return
        try:
            await loop.run_in_executor(
                None,
                driver.reactions.delete_reaction,
                user_id,
                post_id,
                _REACTION[mark],
            )
        except ResourceNotFound:
            pass
        self._marked.discard(key)

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
        elapsed = format_elapsed(time.monotonic() - live.started_at)
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
    ) -> list[str]:
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError(
                "Cannot add users to channel: Mattermost client not connected"
            )

        loop = self._main_loop
        failed: list[str] = []
        # Mattermost resolves people by username and ignores the ids, and one
        # internal caller (the default-member add) has only a name to give — so
        # walk the names and reach for a paired id only if one was supplied.
        for index, username in enumerate(user_names):
            external_id = (
                user_external_ids[index] if index < len(user_external_ids) else username
            )
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
                failed.append(external_id)
        return failed

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

        # The username is the routing handle — the mention, the member-list key
        # and the key this adapter adopts a bot back by — so it stays the
        # identifier. Only the bot's own display name carries the label.
        label = (await self.agent_rendering(agent_name)).field_label
        if label != agent_name:
            self._warn_once_if_display_names_are_hidden()

        existing = await self._find_existing_bot(agent_name)
        if existing:
            bot_id: str = str(existing["user_id"])
            if existing.get("display_name") != label:
                try:
                    self._mm_api("put", f"/bots/{bot_id}", {"display_name": label})
                except Exception as e:
                    logger.exception(
                        "Failed to update the display name of Mattermost bot %s: %s",
                        agent_name,
                        e,
                    )
        else:
            try:
                bot = self._mm_api(
                    "post",
                    "/bots",
                    {
                        "username": agent_name,
                        "display_name": label,
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

        await self._bridge_channels_already_joined(agent_name, bot_id)

        logger.info("Created Mattermost bot identity: %s", agent_name)

    async def _bridge_channels_already_joined(
        self, agent_name: str, bot_id: str
    ) -> None:
        """Bridge the channels this bot is a member of but was never seen joining.

        A bot cannot witness its own joins: its websocket opens only after it has
        been added to the team, by which point Mattermost has already put it in
        the team's default channels. Those joins are therefore noticed only if
        some *other* agent's socket happens to be listening, which means the
        first agent on an instance bridges nothing at all and a later one drags
        the backlog in with it. Ask Mattermost outright instead of waiting to
        overhear it.

        Also runs for every known agent on startup, so a channel joined while the
        bridge was down is picked up rather than waiting for the next message in
        it.
        """
        loop = self._main_loop
        if self._on_agent_joined is None or self._admin_driver is None or loop is None:
            return
        try:
            channels = await loop.run_in_executor(
                None,
                self._admin_driver.channels.get_channels_for_user,
                bot_id,
                self._team_id,
            )
        except Exception:
            logger.exception(
                "Could not list Mattermost channels for agent %s", agent_name
            )
            return

        for channel in channels or []:
            channel_id = str(channel.get("id", ""))
            mm_type = str(channel.get("type", ""))
            if not channel_id or mm_type not in _JOINABLE_MM_CHANNEL_TYPES:
                continue
            try:
                await self._on_agent_joined(
                    InboundAgentJoin(
                        channel_id=channel_id,
                        channel_type=self._to_channel_type(mm_type),
                        agent_name=agent_name,
                        channel_name=str(channel.get("display_name", "")) or None,
                    )
                )
            except Exception:
                # One channel that cannot be bridged is not a reason to abandon
                # the rest, nor to fail the agent's registration.
                logger.exception(
                    "Could not bridge Mattermost channel %s for agent %s",
                    channel_id,
                    agent_name,
                )

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

    def _read_name_display_setting(self) -> str | None:
        """`TeamSettings.TeammateNameDisplay`, read at most once per run.

        None when the read could not answer — the server config is readable
        only by a system admin, and an agent's bot is worth having either
        way, so the caller reports the blind spot instead of failing on it."""
        if self._name_display_read:
            return self._name_display_setting
        self._name_display_read = True
        try:
            config = self._mm_api("get", "/config")
            setting = (config.get("TeamSettings") or {}).get("TeammateNameDisplay")
        except Exception as e:
            logger.warning(
                "Could not read the Mattermost server config (%s), so whether "
                "agent display names are rendered on this server is unknown",
                e,
            )
            return None
        if not isinstance(setting, str):
            logger.warning(
                "The Mattermost server config carries no "
                "TeamSettings.TeammateNameDisplay, so whether agent display "
                "names are rendered on this server is unknown"
            )
            return None
        self._name_display_setting = setting
        return setting

    def _warn_once_if_display_names_are_hidden(self) -> None:
        """Say so when this server will store an agent's display name and show
        nobody. Mattermost renders a bot under its username unless the server
        is told otherwise, so a display name Switch sets can be invisible with
        nothing about the write itself failing."""
        if self._name_display_warned:
            return
        setting = self._read_name_display_setting()
        if setting is None or setting in _NAME_DISPLAY_SHOWS_LABEL:
            return
        self._name_display_warned = True
        logger.warning(
            "Mattermost TeamSettings.TeammateNameDisplay is '%s', so agent "
            "display names will not appear in the post header on this server — "
            "set it to 'full_name' or 'nickname_full_name' to render them",
            setting,
        )

    # ── Bot icons ────────────────────────────────────────────────────────────

    def default_agent_icon(self, agent_name: str) -> str:
        # Mattermost uploads the image itself rather than passing a link on, so
        # the response has to be a PNG it can accept.
        return default_icon_url(agent_name, image_format="png")

    async def _set_bot_icon(self, bot_id: str, agent_name: str) -> None:
        if not self._admin_driver or not self._main_loop:
            logger.error("[BOT-ICON] skipping %s: no driver or loop", agent_name)
            return
        driver = self._admin_driver
        try:
            url = await self.agent_icon_url(agent_name)
            logger.debug("[BOT-ICON] fetching avatar for %s", agent_name)
            # This is the one place Switch dereferences an agent's icon URL
            # rather than handing it to a platform, so the fetch is bounded:
            # redirects off (a permitted host could otherwise bounce us to an
            # internal one, which validation at write time cannot foresee) and
            # a size ceiling so a hostile response cannot be read unbounded.
            async with httpx.AsyncClient(follow_redirects=False) as client:
                resp = await client.get(url, timeout=10.0)
                resp.raise_for_status()
                image_bytes = resp.content
            if len(image_bytes) > _MAX_BOT_ICON_BYTES:
                logger.error(
                    "[BOT-ICON] icon for %s is %d bytes, over the %d limit — "
                    "leaving the current icon in place",
                    agent_name,
                    len(image_bytes),
                    _MAX_BOT_ICON_BYTES,
                )
                return
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
        self._remember_trigger(channel_id, root_id or post_id, post_id)
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

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Find team members via Mattermost's own user search.

        Scoped to the bridge's team, and bots are dropped — a bot is not a
        person who can own an agent.
        """
        if not self._admin_driver or not self._main_loop:
            raise RuntimeError("Mattermost adapter is not started")

        term = query.strip()
        if not term:
            return []

        driver = self._admin_driver
        try:
            found = await self._main_loop.run_in_executor(
                None,
                driver.users.search_users,
                {"term": term, "team_id": self._team_id, "allow_inactive": False},
            )
        except Exception as e:
            raise RuntimeError(f"Mattermost user directory lookup failed: {e}") from e

        results: list[DirectoryUser] = []
        for user in found or []:
            if user.get("is_bot"):
                continue
            username = user.get("username", "") or ""
            first = user.get("first_name", "") or ""
            last = user.get("last_name", "") or ""
            full_name = " ".join(part for part in (first, last) if part)
            results.append(
                DirectoryUser(
                    external_user_id=str(user.get("id")),
                    username=username,
                    display_name=(user.get("nickname") or full_name or username),
                    email=user.get("email") or None,
                )
            )
        results.sort(key=lambda u: u.display_name.lower())
        return results

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
            "verify": self._config.verify_tls,
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
