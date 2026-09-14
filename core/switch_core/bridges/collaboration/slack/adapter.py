from __future__ import annotations

import asyncio
import logging
import math
import re
import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import datetime
from typing import Any, ClassVar

import httpx
from pydantic import BaseModel, Field
from slack_sdk.errors import SlackApiError
from slack_sdk.socket_mode.aiohttp import SocketModeClient
from slack_sdk.socket_mode.request import SocketModeRequest
from slack_sdk.socket_mode.response import SocketModeResponse
from slack_sdk.web.async_client import AsyncWebClient

from switch_core.bridges.collaboration.adapter import (
    CollaborationAdapter,
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
    ChannelType,
    DirectoryUser,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
    InboundUserJoin,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.session.renderers.slack import (
    SlackMessage,
    render_activity,
    render_attention,
    render_request,
    render_turn_with_request,
    with_session_context,
)
from switch_core.bridges.collaboration.slack.agent_groups import (
    SlackAgentGroupDirectory,
)
from switch_core.bridges.collaboration.slack.avatar import on_slack_background
from switch_core.bridges.collaboration.slack.mrkdwn import escape_mrkdwn

logger = logging.getLogger(__name__)

# Stamped on the description of every user group we mint for an agent, so a
# reload can tell ours apart from the workspace's own groups.
_AGENT_GROUP_MARKER = "Switch agent — "

# User group calls are rate-limited at roughly 20/minute, and the Slack client
# retries connection errors but not throttling.
_RATE_LIMIT_MAX_ATTEMPTS = 5
_RATE_LIMIT_DEFAULT_DELAY = 30

# These responses confirm that Slack rejected the format before publication.
# Never retry an uncertain delivery as another message merely to change format.
_BLOCK_FORMAT_ERRORS = {"invalid_blocks", "invalid_blocks_format", "block_mismatch"}


def _publication_metadata(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    for block in blocks:
        marker = block.get("block_id", "")
        if isinstance(marker, str) and marker.startswith("switch-request:"):
            return {
                "metadata": {
                    "event_type": "switch_publication",
                    "event_payload": {"token": marker.removeprefix("switch-request:")},
                }
            }
    return {}


# Slack refusals that mean this workspace cannot host agent user groups at all,
# rather than that one particular call went wrong. Each maps to what an operator
# would have to change to get autocomplete working.
_USERGROUPS_UNAVAILABLE_ERRORS = {
    "permission_denied": (
        "this workspace restricts managing user groups to admins — allow the "
        "Switch bot to manage them under Workspace settings → Roles & "
        "permissions → Account types."
    ),
    "no_permission": (
        "this workspace restricts managing user groups to admins — allow the "
        "Switch bot to manage them under Workspace settings → Roles & "
        "permissions → Account types."
    ),
    "plan_upgrade_required": ("user groups need a paid Slack plan (Pro or above)."),
    "paid_teams_only": ("user groups need a paid Slack plan (Pro or above)."),
    "missing_scope": (
        "the Slack app is missing the usergroups:read / usergroups:write "
        "scopes — reinstall it with the scopes from SLACK_SETUP.md."
    ),
}


# Slack caps a user group's description but does not publish the limit, so this
# is a conservative guess; the create path falls back to a bare marker if Slack
# refuses it anyway.
_GROUP_DESCRIPTION_MAX = 140


def _group_description(agent_description: str) -> str:
    """The marker, plus as much of the agent's description as will fit."""
    full = f"{_AGENT_GROUP_MARKER}{agent_description}".strip()
    if len(full) <= _GROUP_DESCRIPTION_MAX:
        return full
    return full[: _GROUP_DESCRIPTION_MAX - 1].rstrip() + "…"


# Reaction on the message an SDK turn is handling.
_WORKING_REACTION = "eyes"


def _retry_after_seconds(error: SlackApiError) -> int:
    """Seconds Slack asked us to wait, falling back to a safe default."""
    headers = getattr(error.response, "headers", None) or {}
    try:
        return max(1, int(headers.get("Retry-After", _RATE_LIMIT_DEFAULT_DELAY)))
    except (TypeError, ValueError):
        return _RATE_LIMIT_DEFAULT_DELAY


class SlackUser(BaseModel):
    name: str
    display_name: str


class SlackConnectionConfig(BridgeConnectionConfig):
    bot_token: str
    app_token: str
    workspace_id: str
    # The descriptions are not decoration: both registration forms build
    # themselves from this schema, so what is written here is the only
    # explanation an operator gets next to the checkbox.
    agent_usergroups: bool = Field(
        default=True,
        title="Agent name autocomplete",
        description=(
            "Give each agent a Slack user group so its name completes when you "
            "type @ in a channel. Needs a paid Slack plan and permission for "
            "the bot to manage user groups; without either, agents are still "
            "addressed by typing their name."
        ),
    )


class SlackAdapter(CollaborationAdapter):
    publishes_sdk_sessions: ClassVar[bool] = True
    separate_activity_log: ClassVar[bool] = True
    separate_attention_slot: ClassVar[bool] = True
    supports_activity_reactions: ClassVar[bool] = True
    renders_legacy_runtime_state: ClassVar[bool] = False

    # Every Slack bridge in this process shares one, because resolving a
    # mention that crossed a workspace boundary means reading a group another
    # bridge minted. Rebind it to a fresh instance to isolate a test.
    agent_group_directory: ClassVar[SlackAgentGroupDirectory] = (
        SlackAgentGroupDirectory()
    )

    def __init__(self, *, config: SlackConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._web_client: AsyncWebClient | None = None
        self._socket_client: SocketModeClient | None = None
        self._bot_user_id: str = ""
        self._bot_id: str = ""
        self._team_id: str = ""
        self._user_cache: dict[str, SlackUser] = {}
        self._channel_name_cache: dict[str, str] = {}
        self._seen_ts: OrderedDict[str, None] = OrderedDict()
        self._seen_ts_max = 1000
        self._channel_type_cache: dict[str, str] = {}
        self._last_user_message_ts: dict[str, str] = {}
        # Thread root (thread_ts, else message ts) of the last inbound user
        # message per channel — used to thread the "thinking" indicator into the
        # conversation the agent is responding to.
        self._last_thread_ts: dict[str, str] = {}
        # Folded Slack username → user id, for resolving outbound @mentions to
        # real Slack mentions. Primed from the bridge's known external users and
        # topped up as new ones are resolved.
        self._username_to_id: dict[str, str] = {}
        self._thinking_ts: dict[tuple[str, str], str] = {}
        # Agent user groups, when enabled. Slack owns these objects, so the maps
        # are built by reading them back rather than stored alongside the agent:
        # a group edited or removed in Slack would otherwise leave us pointing
        # at an id that no longer means what we think it does.
        # Folded agent name → subteam id, and subteam id → agent name.
        self._agent_group_ids: dict[str, str] = {}
        self._agent_group_names: dict[str, str] = {}
        # Retired agents keep their group in a disabled state — Slack has no
        # delete — so re-adding an agent re-enables rather than colliding.
        self._agent_groups_disabled: dict[str, str] = {}
        # Every group in the workspace, id → handle, so a mention of one we do
        # not own still renders as a handle instead of raw markup.
        self._group_handles: dict[str, str] = {}
        # Groups without our marker, keyed by folded handle and folded name, so
        # an agent can claim one that was created by hand.
        self._unadopted_groups: dict[str, str] = {}
        self._agent_groups_loaded = False
        # Set to Slack's error code once the workspace has told us it cannot
        # host user groups, so the bridge stops asking and says so only once.
        self._agent_usergroups_off_reason: str | None = None
        # (channel_id, ts) currently carrying the "being worked on" reaction.
        self._eyes: set[tuple[str, str]] = set()
        # (channel_id, ts) Slack says it cannot find. Retrying it on every
        # progress report of a long turn is how one unmarkable message became
        # a warning a second for as long as the agent worked.
        self._unmarkable: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._unmarkable_max = 500

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
        # Single-bot identity model: agents share one Slack bot via per-message
        # username/icon override, so there is no per-agent join to detect. The
        # app's own join to a channel is surfaced via on_app_joined instead.
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined

        self._web_client = AsyncWebClient(token=self._config.bot_token)

        auth = await self._web_client.auth_test()
        if not auth.get("ok"):
            raise RuntimeError(
                f"Slack auth_test failed: {auth.get('error', 'unknown error')}"
            )
        self._bot_user_id = auth["user_id"]
        self._bot_id = str(auth.get("bot_id", ""))
        # The team this bot is installed in. Not the same as the configured
        # workspace id on an Enterprise Grid org. Agent group lookup uses
        # the authenticated team identity rather than the configured org.
        self._team_id = str(auth.get("team_id", ""))
        logger.info(
            "Slack adapter authenticated as %s (workspace %s)",
            auth.get("user", ""),
            auth.get("team", ""),
        )

        self._socket_client = SocketModeClient(
            app_token=self._config.app_token,
            web_client=self._web_client,
        )
        self._socket_client.socket_mode_request_listeners.append(
            self._handle_socket_event  # type: ignore[arg-type]
        )
        await self._socket_client.connect()
        logger.info("Slack Socket Mode connected")

    async def stop(self) -> None:
        if self._socket_client:
            try:
                await self._socket_client.close()
            except Exception:
                pass
            self._socket_client = None
        self._web_client = None
        self.agent_group_directory.forget(self._team_id)
        logger.info("Slack adapter stopped")

    # ── Messaging ────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
    ) -> str | None:
        if not self._web_client:
            logger.error("Cannot send message: Slack client not connected")
            return None

        # An explicit thread root (a bridged reply) wins; otherwise DM "lobby"
        # channels keep their auto-threading under the last user message.
        thread_ts: str | None = None
        if thread_root_id:
            thread_ts = (
                self._parse_message_ref(thread_root_id)[1]
                if ":" in thread_root_id
                else thread_root_id
            )
        elif self._channel_type_cache.get(channel_id) in ("im", "mpim"):
            thread_ts = self._last_user_message_ts.get(channel_id)

        agent = await self.agent_rendering(sender_name)
        try:
            result = await self._web_client.chat_postMessage(
                channel=channel_id,
                text=content,
                username=agent.field_label,
                icon_url=agent.icon_url,
                thread_ts=thread_ts,
                unfurl_links=False,
                unfurl_media=False,
            )
            ts = result.get("ts", "")
            return f"{channel_id}:{ts}" if ts else None
        except SlackApiError as e:
            logger.error(
                "Failed to send message to Slack channel %s: %s", channel_id, e
            )
            return None

    async def post_blocks(
        self,
        channel_id: str,
        sender_name: str,
        text: str,
        blocks: list[dict[str, Any]],
        thread_root_id: str | None,
    ) -> str | None:
        """Post a Block Kit message, for what plain text cannot carry.

        Slack-only and deliberately not on `CollaborationAdapter`: blocks are
        Slack's own shape, and the platforms that need something like them need
        something different. `text` is what a notification and a client that
        will not render the blocks are left with, so it has to stand alone.
        """
        if not self._web_client:
            logger.error("Cannot post blocks: Slack client not connected")
            return None

        thread_ts = (
            self._parse_message_ref(thread_root_id)[1]
            if thread_root_id and ":" in thread_root_id
            else thread_root_id
        )
        agent = await self.agent_rendering(sender_name)
        arguments: dict[str, Any] = dict(
            channel=channel_id,
            text=text,
            blocks=blocks,
            username=agent.field_label,
            icon_url=agent.icon_url,
            thread_ts=thread_ts,
            unfurl_links=False,
            unfurl_media=False,
            **_publication_metadata(blocks),
        )
        try:
            try:
                result = await self._web_client.chat_postMessage(**arguments)
            except SlackApiError as exc:
                if exc.response.get("error") not in _BLOCK_FORMAT_ERRORS:
                    raise
                logger.warning(
                    "Slack rejected card blocks in %s (%s); sending its text fallback",
                    channel_id,
                    exc.response.get("error"),
                )
                arguments.pop("blocks")
                result = await self._web_client.chat_postMessage(**arguments)
            ts = result.get("ts", "")
            if not ts:
                raise RuntimeError(
                    "Slack accepted a card without returning its message reference."
                )
            return f"{channel_id}:{ts}"
        except SlackApiError as e:
            logger.error("Failed to post blocks to Slack channel %s: %s", channel_id, e)
            if e.response.get("error") in {
                "internal_error",
                "fatal_error",
                "request_timeout",
                "service_unavailable",
            }:
                raise
            return None

    async def find_request_card(
        self,
        channel_id: str,
        thread_root_id: str | None,
        token: str,
        created_at: datetime,
    ) -> str | None:
        """Find a reserved request or activity post by its shared recovery marker."""
        if self._web_client is None:
            raise RuntimeError(
                "Cannot recover a request card: Slack client not connected."
            )
        cursor = ""
        while True:
            arguments: dict[str, Any] = dict(
                channel=channel_id,
                oldest=str(created_at.timestamp()),
                inclusive=True,
                include_all_metadata=True,
                limit=100,
                cursor=cursor,
            )
            if thread_root_id:
                thread_ts = (
                    self._parse_message_ref(thread_root_id)[1]
                    if ":" in thread_root_id
                    else thread_root_id
                )
                result = await self._web_client.conversations_replies(
                    ts=thread_ts, **arguments
                )
            else:
                result = await self._web_client.conversations_history(**arguments)
            messages: list[dict[str, Any]] = result.get("messages") or []
            for message in messages:
                if not (
                    (self._bot_user_id and message.get("user") == self._bot_user_id)
                    or (self._bot_id and message.get("bot_id") == self._bot_id)
                ):
                    continue
                marker = message.get("metadata") or {}
                if (
                    marker.get("event_type") == "switch_publication"
                    and (marker.get("event_payload") or {}).get("token") == token
                ) or any(
                    block.get("block_id") == f"switch-request:{token}"
                    for block in message.get("blocks", [])
                ):
                    return f"{channel_id}:{message['ts']}"
            metadata: dict[str, Any] = result.get("response_metadata") or {}
            cursor = metadata.get("next_cursor", "")
            if not cursor:
                return None

    async def update_blocks(
        self,
        channel_id: str,
        message_ref: str,
        text: str,
        blocks: list[dict[str, Any]],
    ) -> None:
        """Replace an already posted Block Kit message in place.

        Failure is raised rather than logged, unlike `update_message`. A caller
        editing a card is replacing something a reader is acting on — a request
        card left showing buttons for a request that has already settled invites
        a press that cannot land — so it has to be able to say so instead.
        """
        if not self._web_client:
            raise RuntimeError("Cannot update blocks: Slack client not connected.")
        _, ts = self._parse_message_ref(message_ref)
        if not ts:
            raise ValueError(
                f"Cannot update blocks: invalid message ref {message_ref}."
            )
        arguments: dict[str, Any] = dict(
            channel=channel_id,
            ts=ts,
            text=text,
            blocks=blocks,
            **_publication_metadata(blocks),
        )
        try:
            await self._web_client.chat_update(**arguments)
        except SlackApiError as exc:
            if exc.response.get("error") not in _BLOCK_FORMAT_ERRORS:
                raise
            logger.warning(
                "Slack rejected updated card blocks in %s (%s); using its text fallback",
                channel_id,
                exc.response.get("error"),
            )
            # Clear stale interactive controls without creating a second post.
            arguments["blocks"] = []
            await self._web_client.chat_update(**arguments)

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """Post `content` as a Block Kit message: the activity block for a
        turn, or the request card, whichever `content` is."""
        message = self._render_rich(content)
        ref = await self.post_blocks(
            channel_id, agent_name, message.text, message.blocks, thread_root_id
        )
        if ref is None:
            raise RichContentFailed(
                f"Slack did not accept the message in channel {channel_id}.",
                text=message.text,
            )
        return ref

    async def update_rich(
        self, channel_id: str, message_ref: str, content: RichContent
    ) -> None:
        """Redraw what `post_rich` posted, in place.

        Chains `SlackApiError` as `RichContentFailed` rather than letting it
        through raw, so a caller that no longer imports this module still
        has one thing to catch.
        """
        remaining = getattr(self, "_rich_update_after", 0.0) - time.monotonic()
        if remaining > 0:
            raise RichContentThrottled(
                retry_after=remaining, text="Waiting for Slack to allow updates."
            )
        responder_name = None
        if isinstance(content, RequestCard) and content.responder_external_id:
            user = await self._resolve_user_name(content.responder_external_id)
            responder_name = user.display_name
        # Mention only on first publication, never on redraw or settlement.
        message = self._render_rich(
            replace(content, notify_external_id=None), responder_name=responder_name
        )
        try:
            await self.update_blocks(
                channel_id, message_ref, message.text, message.blocks
            )
        except SlackApiError as error:
            if (
                error.response.get("error") == "ratelimited"
                or getattr(error.response, "status_code", None) == 429
            ):
                headers = getattr(error.response, "headers", {}) or {}
                try:
                    delay = float(
                        headers.get("Retry-After", headers.get("retry-after", 30))
                    )
                    delay = max(1.0, delay) if math.isfinite(delay) else 30.0
                except (ValueError, TypeError):
                    delay = 30.0
                self._rich_update_after = time.monotonic() + delay
                raise RichContentThrottled(
                    retry_after=delay, text=message.text
                ) from error
            raise RichContentFailed(
                f"Slack could not update the message in channel {channel_id}: {error}",
                text=message.text,
            ) from error

    def _render_rich(
        self, content: RichContent, *, responder_name: str | None = None
    ) -> SlackMessage:
        if isinstance(content, TurnActivity):
            message = (
                render_attention(content.error_summary)
                if content.error_summary
                else render_activity(
                    content.items,
                    content.turn,
                    elapsed_seconds=content.elapsed_seconds,
                    tool_log=content.tool_log,
                    status_only=content.status_only,
                )
            )
            if content.tool_log and not content.error_summary:
                # Notifications/text-only clients get the compact plan header;
                # the expandable blocks retain the complete displayed tool log.
                message = SlackMessage(
                    text=message.text.split("\n", 1)[0], blocks=message.blocks
                )
            message = with_session_context(
                message,
                session_url=content.session_url
                if content.status_only and not content.error_summary
                else None,
                notify_external_id=content.notify_external_id,
                inline_link=content.status_only and not content.error_summary,
            )
            if content.publication_token and message.blocks:
                message.blocks[0]["block_id"] = (
                    f"switch-request:{content.publication_token}"
                )
            return message
        assert isinstance(content, RequestCard)
        if content.turn is not None:
            message = render_turn_with_request(
                content.items,
                content.turn,
                content.request,
                content.reference,
                elapsed_seconds=content.elapsed_seconds,
            )
        else:
            message = render_request(
                content.request,
                content.reference,
                responder_external_id=content.responder_external_id,
                responder_name=responder_name,
                unavailable_reason=content.unavailable_reason,
            )
        return with_session_context(
            message,
            notify_external_id=content.notify_external_id
            if content.request.state == "open"
            else None,
        )

    async def is_first_reply(
        self, channel_id: str, root_ref: str, message_ref: str
    ) -> bool:
        """Whether this message is the first reply under a thread root.

        Slack's message event names the thread but not the position in it, so
        the thread itself is the only place the answer exists. `messages[0]` is
        always the root, which makes `messages[1]` the first reply and two the
        whole page worth fetching.
        """
        if not self._web_client:
            logger.warning(
                "Cannot read the thread under %s in %s: Slack client not "
                "connected. Treating %s as not the first reply.",
                root_ref,
                channel_id,
                message_ref,
            )
            return False
        _, root_ts = self._parse_message_ref(root_ref)
        _, ts = self._parse_message_ref(message_ref)
        if not root_ts or not ts:
            return False
        try:
            result = await self._web_client.conversations_replies(
                channel=channel_id, ts=root_ts, limit=2
            )
        except Exception as e:
            # Broad because this is on the inbound path of every message: a
            # reset connection or a timed-out read comes out of the client as
            # neither a SlackApiError nor anything else caught above here, and
            # raising here loses the message rather than the answer.
            logger.warning(
                "Could not read the thread under %s in %s: %s. Treating %s as "
                "not the first reply.",
                root_ts,
                channel_id,
                e,
                ts,
            )
            return False
        messages = result.get("messages") or []
        return len(messages) > 1 and messages[1].get("ts") == ts

    async def tell_actor(
        self,
        channel_id: str,
        actor_ref: str,
        actor_name: str,
        thread_ref: str | None,
        text: str,
    ) -> None:
        """Slack's ephemeral message: one person, in place, and not kept.

        It suits a notice about an answer that did not land. That notice is
        only useful to whoever gave the answer, and only until they give
        another, so leaving nothing behind is the point rather than a
        limitation.

        `actor_name` goes unused here, and that is what being private buys:
        the only person who reads this is the one it is about, so it has
        nobody to name.

        Ephemerals are not deliverable to someone who is not in the channel,
        and Slack says so rather than failing quietly. Nothing here can put
        them there, so it is logged and left.
        """
        if not self._web_client:
            logger.warning(
                "Cannot tell %s in %s that their answer did not land: Slack "
                "client not connected. The notice was: %s",
                actor_ref,
                channel_id,
                text,
            )
            return
        try:
            await self._web_client.chat_postEphemeral(
                channel=channel_id,
                user=actor_ref,
                text=escape_mrkdwn(text),
                thread_ts=self._thread_ts_of(thread_ref),
            )
        except Exception as e:
            # Broad for the same reason `is_first_reply` is: this runs on the
            # inbound path of every message, so raising loses the message and
            # not just the notice.
            logger.warning(
                "Could not tell %s in %s that their answer did not land: %s. "
                "The notice was: %s",
                actor_ref,
                channel_id,
                e,
                text,
            )

    def adapt_icon_url(self, raw: str | None, agent_name: str) -> str:
        # Overridden for Slack alone: it flattens a transparent avatar onto
        # white. Adjusting here rather than at each call site keeps every place
        # that posts as an agent on the same background.
        return on_slack_background(super().adapt_icon_url(raw, agent_name))

    def slash_invite_hint(self) -> str:
        # Slack passes a slash command's whole tail through as free text, so the
        # invocation reads exactly like the `!` form.
        return "`/invite-agent @agent-name` — the Slack slash command"

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
        # On Slack an admin/system message renders as the Switch app itself —
        # no per-message username/icon override — so it reads as the platform
        # speaking, not an agent. message_type is available for future
        # per-type tweaks (e.g. richer self-mention guidance).
        if not self._web_client:
            logger.error("Cannot post admin message: Slack client not connected")
            return None

        thread_ts: str | None = None
        if thread_root_id:
            thread_ts = (
                self._parse_message_ref(thread_root_id)[1]
                if ":" in thread_root_id
                else thread_root_id
            )

        try:
            result = await self._web_client.chat_postMessage(
                channel=channel_id,
                text=content,
                thread_ts=thread_ts,
                unfurl_links=False,
                unfurl_media=False,
            )
            ts = result.get("ts", "")
            return f"{channel_id}:{ts}" if ts else None
        except SlackApiError as e:
            logger.error(
                "Failed to post admin message to Slack channel %s: %s", channel_id, e
            )
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
        """Upload a file natively via files_upload_v2.

        Slack's file upload cannot carry the per-message username/icon
        override that send_message uses, so the file post renders as the
        Switch app itself; the sender's identity is preserved by bolding
        their name in the comment. The upload's shared-message ts is pulled
        from the response when Slack provides it (v2 completes the share
        asynchronously, so it may be absent — then no ref is returned and
        replies to the file won't thread back to Matrix).
        """
        if not self._web_client:
            logger.error("Cannot send attachment: Slack client not connected")
            return None

        thread_ts: str | None = None
        if thread_root_id:
            thread_ts = (
                self._parse_message_ref(thread_root_id)[1]
                if ":" in thread_root_id
                else thread_root_id
            )

        label = await self.agent_label_for_body(sender_name)
        comment = (
            f"*{label}*: {self.translate_outbound(caption)}"
            if caption
            else f"*{label}* sent `{filename}`"
        )

        try:
            result = await self._web_client.files_upload_v2(
                channel=channel_id,
                file=data,
                filename=filename,
                initial_comment=comment,
                thread_ts=thread_ts,
            )
        except SlackApiError as e:
            logger.error(
                "Failed to upload attachment '%s' to Slack channel %s: %s",
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

        ts = self._extract_share_ts(result.get("files") or [], channel_id)
        return f"{channel_id}:{ts}" if ts else None

    async def send_attachments(
        self,
        channel_id: str,
        sender_name: str,
        files: list[OutboundAttachment],
        caption: str | None = None,
        thread_root_id: str | None = None,
    ) -> str | None:
        """Upload several files as ONE Slack post via files_upload_v2's
        `file_uploads` list, so N files share a single message and comment."""
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
        if not self._web_client:
            logger.error("Cannot send attachments: Slack client not connected")
            return None

        thread_ts: str | None = None
        if thread_root_id:
            thread_ts = (
                self._parse_message_ref(thread_root_id)[1]
                if ":" in thread_root_id
                else thread_root_id
            )

        names = ", ".join(f"`{file.filename}`" for file in files)
        label = await self.agent_label_for_body(sender_name)
        comment = (
            f"*{label}*: {self.translate_outbound(caption)}"
            if caption
            else f"*{label}* sent {names}"
        )

        try:
            result = await self._web_client.files_upload_v2(
                channel=channel_id,
                file_uploads=[
                    {"file": file.data, "filename": file.filename} for file in files
                ],
                initial_comment=comment,
                thread_ts=thread_ts,
            )
        except SlackApiError as e:
            logger.error(
                "Failed to upload %d attachments to Slack channel %s: %s",
                len(files),
                channel_id,
                e,
            )
            return await super().send_attachments(
                channel_id, sender_name, files, caption, thread_root_id
            )

        ts = self._extract_share_ts(result.get("files") or [], channel_id)
        return f"{channel_id}:{ts}" if ts else None

    @staticmethod
    def _extract_share_ts(
        files: list[dict[str, object]], channel_id: str
    ) -> str | None:
        """The ts of the message that shared an uploaded file into the channel,
        when the upload response already carries it."""
        for file in files:
            shares = file.get("shares")
            if not isinstance(shares, dict):
                continue
            for scope in ("public", "private"):
                entries = shares.get(scope)
                if isinstance(entries, dict):
                    for entry in entries.get(channel_id, []):
                        ts = entry.get("ts")
                        if ts:
                            return str(ts)
        return None

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        if not self._web_client:
            logger.error("Cannot update message: Slack client not connected")
            return

        _, ts = self._parse_message_ref(message_ref)
        if not ts:
            logger.error("Cannot update message: invalid message ref %s", message_ref)
            return

        try:
            await self._web_client.chat_update(
                channel=channel_id, ts=ts, text=new_content
            )
        except SlackApiError as e:
            logger.error("Failed to update Slack message %s: %s", message_ref, e)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        if not self._web_client:
            logger.error("Cannot delete message: Slack client not connected")
            return

        _, ts = self._parse_message_ref(message_ref)
        if not ts:
            logger.error("Cannot delete message: invalid message ref %s", message_ref)
            return

        try:
            await self._web_client.chat_delete(channel=channel_id, ts=ts)
        except SlackApiError as e:
            logger.error("Failed to delete Slack message %s: %s", message_ref, e)

    # ── Typing ───────────────────────────────────────────────────────────────

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        if not self._web_client:
            return

        if is_typing:
            # Slack has no native bot typing API, so the indicator is a real
            # posted message that must be explicitly deleted. Clear any leftover
            # from a previous turn first, then post a fresh one in the current
            # thread — never recycle a stale placeholder (it may sit in a
            # different thread and would otherwise linger across turns).
            await self._clear_thinking(channel_id, sender_name)

            thread_ts = self._last_thread_ts.get(channel_id)

            agent = await self.agent_rendering(sender_name)
            try:
                result = await self._web_client.chat_postMessage(
                    channel=channel_id,
                    text="_thinking..._",
                    username=agent.field_label,
                    icon_url=agent.icon_url,
                    thread_ts=thread_ts,
                )
                ts = result.get("ts")
                if ts:
                    self._thinking_ts[(channel_id, sender_name)] = str(ts)
            except SlackApiError:
                logger.exception("Failed to post thinking indicator in %s", channel_id)
        else:
            await self._clear_thinking(channel_id, sender_name)

    async def _clear_thinking(self, channel_id: str, sender_name: str) -> None:
        if not self._web_client:
            return
        ts = self._thinking_ts.pop((channel_id, sender_name), None)
        if not ts:
            return
        try:
            await self._web_client.chat_delete(channel=channel_id, ts=ts)
        except SlackApiError:
            logger.exception("Failed to delete thinking indicator in %s", channel_id)

    # ── SDK activity reactions ────────────────────────────────────────────────

    async def _mark_being_read(
        self,
        channel_id: str,
        thread_ts: str | None,
        *,
        working: bool,
        force: bool = False,
    ) -> None:
        """Mark the asking message and cache expected Slack reaction refusals."""
        ts = thread_ts
        if not ts or not self._web_client:
            return
        key = (channel_id, ts)
        if not force and working == (key in self._eyes):
            return
        if key in self._unmarkable:
            return

        try:
            if working:
                await self._web_client.reactions_add(
                    channel=channel_id, timestamp=ts, name=_WORKING_REACTION
                )
                self._eyes.add(key)
            else:
                await self._web_client.reactions_remove(
                    channel=channel_id, timestamp=ts, name=_WORKING_REACTION
                )
                self._eyes.discard(key)
        except SlackApiError as e:
            error = e.response.get("error", "")
            # Already there, or already gone: the end state is what was wanted,
            # so record it and say nothing.
            if error in ("already_reacted", "no_reaction"):
                self._eyes.add(key) if working else self._eyes.discard(key)
                return
            if error == "message_not_found":
                # There is no message to mark, and there will not be one later.
                self._unmarkable[key] = None
                if len(self._unmarkable) > self._unmarkable_max:
                    self._unmarkable.popitem(last=False)
                return
            if force:
                raise
            logger.warning(
                "Could not %s the working reaction on %s in %s: %s",
                "add" if working else "remove",
                ts,
                channel_id,
                error or e,
            )

    async def mark_activity(
        self,
        channel_id: str,
        message_ref: str,
        *,
        agent_name: str,
        working: bool,
        force: bool = False,
    ) -> None:
        """Mark the asking message, accepting either a timestamp or channel:ts.

        The SDK publication journal owns concurrent turn claims. ``force``
        reconciles Slack's reaction after a restart despite the local cache.

        `agent_name` is not used: every agent speaks as the one app here, so
        there is a single reaction on the message whoever is working behind
        it, and adding it twice or removing one agent's while another is
        still running would both be the same mark.
        """
        await self._mark_being_read(
            channel_id, self._thread_ts_of(message_ref), working=working, force=force
        )

    @staticmethod
    def _thread_ts_of(thread_root_id: str | None) -> str | None:
        if not thread_root_id:
            return None
        return (
            thread_root_id.split(":", 1)[1] if ":" in thread_root_id else thread_root_id
        )

    # ── Channel creation ──────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        if not self._web_client:
            raise RuntimeError("Slack client not connected")

        if channel_type in ("group", "direct"):
            raise ValueError(
                f"Cannot create {channel_type} channels — they are initiated from the messaging platform"
            )

        is_private = channel_type == "channel_private"
        channel_name = re.sub(r"[^a-z0-9_-]", "-", name.lower()).strip("-")[:80]

        try:
            result = await self._web_client.conversations_create(
                name=channel_name, is_private=is_private
            )
            channel_id: str = result["channel"]["id"]
        except SlackApiError:
            unique_name = f"{channel_name[:71]}-{uuid.uuid4().hex[:8]}"
            result = await self._web_client.conversations_create(
                name=unique_name, is_private=is_private
            )
            channel_id = result["channel"]["id"]

        try:
            await self._web_client.conversations_setTopic(
                channel=channel_id, topic=topic
            )
        except SlackApiError as e:
            logger.warning(
                "Failed to set topic for Slack channel %s: %s", channel_name, e
            )

        return channel_id

    async def create_dm_channel(
        self,
        *,
        agent_name: str,
        user_name: str,
        user_external_id: str,
    ) -> str:
        if not self._web_client:
            raise RuntimeError("Slack client not connected")

        raw_name = f"dm-{user_name}-{agent_name}"
        channel_name = re.sub(r"[^a-z0-9_-]", "-", raw_name.lower()).strip("-")[:80]
        try:
            result = await self._web_client.conversations_create(
                name=channel_name, is_private=True
            )
            channel_id: str = result["channel"]["id"]
        except SlackApiError:
            unique_name = f"{channel_name[:71]}-{uuid.uuid4().hex[:8]}"
            result = await self._web_client.conversations_create(
                name=unique_name, is_private=True
            )
            channel_id = result["channel"]["id"]

        try:
            await self._web_client.conversations_invite(
                channel=channel_id, users=user_external_id
            )
        except SlackApiError as e:
            if e.response.get("error") != "already_in_channel":
                raise

        return channel_id

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        """`slack://channel?team=<workspace>&id=<channel>` — opens the channel
        in the Slack desktop app. Pure: built from the configured workspace id
        and the channel id, no API call needed."""
        if not external_channel_id:
            return None
        return (
            f"slack://channel?team={self._config.workspace_id}&id={external_channel_id}"
        )

    async def home_deeplink(self) -> str | None:
        """`slack://open?team=<workspace>` — opens this workspace in the Slack
        desktop app, matching the scheme `channel_deeplink` already uses."""
        if not self._config.workspace_id:
            return None
        return f"slack://open?team={self._config.workspace_id}"

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        if not self._web_client:
            raise RuntimeError("Slack client not connected")
        result = await self._web_client.conversations_info(channel=channel_id)
        channel = result["channel"]
        if channel.get("is_im") or channel.get("is_mpim"):
            return "lobby"
        if channel.get("is_private") or channel.get("is_group"):
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
        if not self._web_client:
            raise RuntimeError(
                "Cannot add users to channel: Slack client not connected"
            )

        failed: list[str] = []
        for user_id in user_external_ids:
            try:
                await self._web_client.conversations_invite(
                    channel=channel_id, users=user_id
                )
            except SlackApiError as e:
                if e.response.get("error") != "already_in_channel":
                    logger.error(
                        "Failed to invite Slack user %s to channel %s: %s",
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
        """Give the agent a Slack user group so its name completes on `@`.

        Slack only offers autocomplete for things it knows about, and an agent
        is not a Slack user — one app serves all of them. A user group is the
        one handle an app can mint that still appears in the composer's `@`
        menu, so each agent gets one. The group is left empty: it exists to be
        completable and to arrive as a structured mention, and mentioning it
        notifies nobody.
        """
        if not self._agent_usergroups_available():
            return
        if not self._web_client:
            raise RuntimeError("Cannot create agent user group: Slack not connected")

        await self._ensure_agent_groups_loaded()
        if not self._agent_usergroups_available():
            return
        folded = agent_name.casefold()
        if folded in self._agent_group_ids:
            return

        handle = self._usergroup_handle(agent_name)
        adopted_id = self._unadopted_groups.get(folded) or self._unadopted_groups.get(
            handle.casefold()
        )
        if adopted_id:
            await self._adopt_group(adopted_id, agent_name)
            return

        disabled_id = self._agent_groups_disabled.get(folded)
        if disabled_id:
            await self._web_client.usergroups_enable(usergroup=disabled_id)
            self._agent_groups_disabled.pop(folded, None)
            self._remember_agent_group(disabled_id, agent_name)
            logger.info(
                "Re-enabled Slack user group %s for agent %s", disabled_id, agent_name
            )
            return

        try:
            result = await self._rate_limited(
                lambda: self._create_usergroup(agent_name, handle, agent_description),
                what=f"create a Slack user group for agent '{agent_name}'",
            )
        except SlackApiError as e:
            error = e.response.get("error", "")
            if error in ("handle_already_exists", "name_already_exists"):
                # Something already owns the handle. If it is one of ours the
                # reload adopts it; if it is a real group or a channel, say so
                # rather than leaving the agent silently unmentionable.
                await self._load_agent_usergroups()
                if folded in self._agent_group_ids:
                    return
                raise RuntimeError(
                    f"Cannot create a Slack user group for agent '{agent_name}': "
                    f"the handle '@{handle}' is already taken by a channel, "
                    "person or group that is not ours. Rename the agent or free "
                    "the handle."
                ) from e
            if error in _USERGROUPS_UNAVAILABLE_ERRORS:
                self._disable_agent_usergroups(error)
                return
            raise

        group = result.get("usergroup") or {}
        group_id = str(group.get("id", ""))
        if not group_id:
            raise RuntimeError(
                f"Slack returned no user group id when creating one for agent "
                f"'{agent_name}'"
            )
        self._remember_agent_group(group_id, agent_name)
        logger.info(
            "Created Slack user group @%s (%s) for agent %s",
            handle,
            group_id,
            agent_name,
        )

    async def remove_agent_identity(self, agent_name: str) -> None:
        if not self._agent_usergroups_available():
            return
        if not self._web_client:
            raise RuntimeError("Cannot remove agent user group: Slack not connected")

        await self._ensure_agent_groups_loaded()
        if not self._agent_usergroups_available():
            return
        folded = agent_name.casefold()
        group_id = self._agent_group_ids.get(folded)
        if not group_id:
            return

        # Slack has no delete for user groups — disabling is the documented way
        # to retire one, and it stops the handle resolving.
        await self._web_client.usergroups_disable(usergroup=group_id)
        self._agent_group_ids.pop(folded, None)
        self._agent_group_names.pop(group_id, None)
        self.agent_group_directory.discard(self._team_id, group_id)
        self._agent_groups_disabled[folded] = group_id
        logger.info("Disabled Slack user group %s for agent %s", group_id, agent_name)

    # ── Agent user groups ────────────────────────────────────────────────────

    def _agent_usergroups_available(self) -> bool:
        return self._config.agent_usergroups and not self._agent_usergroups_off_reason

    def _disable_agent_usergroups(self, error: str) -> None:
        """Stop attempting user groups on this bridge, saying why, once.

        The setting is on by default, so a workspace that simply cannot host
        user groups is an ordinary situation rather than a misconfiguration —
        but it must not be a silent one, and it must not repeat the complaint
        for every agent on every startup. Latching turns it into one warning
        that names the cause and the consequence.
        """
        if self._agent_usergroups_off_reason:
            return
        self._agent_usergroups_off_reason = error
        logger.warning(
            "Slack agent user groups are unavailable on this workspace (%s): %s "
            "Agent names will not autocomplete in the Slack composer; agents "
            "remain addressable by typing their name.",
            error,
            _USERGROUPS_UNAVAILABLE_ERRORS[error],
        )

    def _require_web_client(self) -> AsyncWebClient:
        if not self._web_client:
            raise RuntimeError("Slack client not connected")
        return self._web_client

    async def _rate_limited(
        self, call: Callable[[], Awaitable[Any]], *, what: str
    ) -> Any:
        """Run a Slack call, waiting out rate limits rather than losing it.

        Provisioning runs once per agent at startup, so a workspace with more
        agents than the per-minute allowance would otherwise come up with some
        agents mentionable and some not — and the caller only logs, so nothing
        would say which. Waiting keeps the backfill whole; giving up after a
        bounded number of attempts keeps a persistently throttled workspace
        from hanging startup, and says so rather than continuing quietly.
        """
        for attempt in range(_RATE_LIMIT_MAX_ATTEMPTS):
            try:
                return await call()
            except SlackApiError as e:
                if e.response.get("error") != "ratelimited":
                    raise
                if attempt == _RATE_LIMIT_MAX_ATTEMPTS - 1:
                    raise RuntimeError(
                        f"Slack kept rate-limiting the attempt to {what} after "
                        f"{_RATE_LIMIT_MAX_ATTEMPTS} tries. Some agents may have "
                        "no user group and so will not autocomplete; restart the "
                        "bridge to finish provisioning."
                    ) from e
                delay = _retry_after_seconds(e)
                logger.warning(
                    "Slack rate-limited the attempt to %s; retrying in %ss "
                    "(attempt %d/%d)",
                    what,
                    delay,
                    attempt + 1,
                    _RATE_LIMIT_MAX_ATTEMPTS,
                )
                await asyncio.sleep(delay)
        raise RuntimeError(f"Unreachable: exhausted retries to {what}")

    async def _create_usergroup(
        self, agent_name: str, handle: str, agent_description: str
    ) -> Any:
        """Create the group, retrying without the blurb if Slack rejects it.

        An agent's description is free text and can run to a paragraph, while
        Slack caps a user group's description and does not publish the limit —
        so a conservative truncation can still be refused. The description is
        decoration; the marker is the part that carries meaning. Losing an
        agent's autocomplete over the length of its blurb would be absurd, so
        the blurb is what gets dropped.
        """
        client = self._require_web_client()
        try:
            return await client.usergroups_create(
                name=agent_name,
                handle=handle,
                description=_group_description(agent_description),
            )
        except SlackApiError as e:
            if e.response.get("error") != "description_too_long":
                raise
            logger.warning(
                "Slack rejected the description for agent %s's user group as too "
                "long; creating it with just the marker instead.",
                agent_name,
            )
            return await client.usergroups_create(
                name=agent_name,
                handle=handle,
                description=f"{_AGENT_GROUP_MARKER}{agent_name}",
            )

    async def _adopt_group(self, group_id: str, agent_name: str) -> None:
        """Claim a user group someone made by hand for this agent.

        Where a workspace will not let the bot create groups, making them by
        hand is the only way to use the feature — so a group whose handle or
        name is exactly an agent's is taken to be that agent's. The match has to
        be exact: a workspace's own group must never be captured by an agent
        that happens to be named similarly.

        The marker is stamped on so later loads recognise it without needing
        the agent list. That is an optimisation, not a requirement — adoption
        happens per agent at startup either way — so failing to write it is
        worth a warning rather than abandoning the adoption.
        """
        for key in (agent_name.casefold(), self._usergroup_handle(agent_name)):
            self._unadopted_groups.pop(key, None)
        self._remember_agent_group(group_id, agent_name)
        logger.info(
            "Adopted existing Slack user group %s for agent %s", group_id, agent_name
        )

        try:
            await self._rate_limited(
                lambda: self._require_web_client().usergroups_update(
                    usergroup=group_id,
                    description=f"{_AGENT_GROUP_MARKER}{agent_name}",
                ),
                what=f"mark the adopted user group for agent '{agent_name}'",
            )
        except (SlackApiError, RuntimeError):
            logger.warning(
                "Adopted Slack user group %s for agent %s but could not mark it "
                "as ours; it will be re-adopted on each start.",
                group_id,
                agent_name,
                exc_info=True,
            )

    def _remember_agent_group(self, group_id: str, agent_name: str) -> None:
        self._agent_group_ids[agent_name.casefold()] = group_id
        self._agent_group_names[group_id] = agent_name
        self.agent_group_directory.add(self._team_id, group_id, agent_name)

    @staticmethod
    def _usergroup_handle(agent_name: str) -> str:
        """Fold an agent name into a Slack handle.

        Agent names already share Slack's handle character class, so this is
        usually just a lowercase. Anything outside it collapses to a hyphen so
        an unusual name still yields a mentionable handle; the group's `name`
        carries the agent name verbatim, so the round trip does not depend on
        the handle surviving unchanged.
        """
        handle = re.sub(r"[^a-z0-9._-]+", "-", agent_name.casefold())
        return handle.strip("-._") or "switch-agent"

    async def _ensure_agent_groups_loaded(self) -> None:
        if not self._agent_groups_loaded:
            await self._load_agent_usergroups()

    async def _load_agent_usergroups(self) -> None:
        """Rebuild the agent ↔ user group maps from Slack.

        Only groups we created are adopted, recognised by the marker on their
        description — a workspace's own groups must never be mistaken for an
        agent, or mentioning one would address an agent that has nothing to do
        with it.
        """
        if not self._web_client:
            raise RuntimeError("Cannot load Slack user groups: Slack not connected")

        try:
            result = await self._rate_limited(
                lambda: self._require_web_client().usergroups_list(
                    include_disabled=True
                ),
                what="list Slack user groups",
            )
        except SlackApiError as e:
            error = e.response.get("error", "")
            if error in _USERGROUPS_UNAVAILABLE_ERRORS:
                # The first call is where a workspace without the plan or the
                # permission finds out, so it is the natural place to give up.
                self._disable_agent_usergroups(error)
                self._agent_groups_loaded = True
                return
            raise

        groups: list[dict[str, Any]] = result.get("usergroups") or []

        self._agent_group_ids = {}
        self._agent_group_names = {}
        self._agent_groups_disabled = {}
        self._group_handles = {}
        self._unadopted_groups = {}
        for group in groups:
            group_id = str(group.get("id", ""))
            handle = str(group.get("handle", ""))
            name = str(group.get("name", ""))
            if not group_id:
                continue
            if handle:
                self._group_handles[group_id] = handle

            if not str(group.get("description", "")).startswith(_AGENT_GROUP_MARKER):
                # Not ours — but it may still be an agent's, made by hand. Keyed
                # both ways so an agent can claim it by either field.
                for key in (handle.casefold(), name.casefold()):
                    if key:
                        self._unadopted_groups[key] = group_id
                continue

            if not name:
                continue
            if group.get("date_delete"):
                self._agent_groups_disabled[name.casefold()] = group_id
            else:
                self._remember_agent_group(group_id, name)

        self.agent_group_directory.replace(self._team_id, self._agent_group_names)
        self._agent_groups_loaded = True
        logger.info(
            "Loaded %d Slack agent user groups (%d disabled, %d other groups seen)",
            len(self._agent_group_ids),
            len(self._agent_groups_disabled),
            len(self._group_handles) - len(self._agent_group_ids),
        )

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Translation ──────────────────────────────────────────────────────────

    def translate_outbound(self, content: str) -> str:
        return self._markdown_to_mrkdwn(self._translate_mentions_to_slack(content))

    def escape_label_for_body(self, label: str) -> str:
        """Escape the three characters Slack reserves, over the base defusal.

        `&`, `<` and `>` are how every piece of Slack markup is written, so
        escaping them is what stops a label from writing a link, a user mention
        or a `<!channel>` broadcast in Slack's own syntax.

        That is not on its own enough, which is why this builds on the
        inherited rule rather than replacing it. A label never has to reach
        Slack in Slack's syntax: `_translate_mentions_to_slack` runs over the
        finished body *after* the label is inlined, so a plain `@opsbot` in a
        display name is turned into a real `<!subteam^S…>` by this bridge,
        from text these three replacements do not touch. The `@` the base class
        defuses is what closes that.

        The three replacements themselves are `escape_mrkdwn`, shared with
        anything else that writes mrkdwn for this workspace."""
        return escape_mrkdwn(super().escape_label_for_body(label))

    def translate_inbound(self, raw_message: str) -> str:
        return self._translate_links_to_markdown(
            self._translate_mentions_to_markdown(raw_message)
        )

    @staticmethod
    def _translate_links_to_markdown(message: str) -> str:
        """Convert Slack link syntax `<url|label>` / `<url>` to markdown."""
        message = re.sub(r"<(https?://[^|>]+)\|([^>]+)>", r"[\2](\1)", message)
        return re.sub(r"<(https?://[^>]+)>", r"\1", message)

    @staticmethod
    def _unwrap_code_span(text: str) -> str:
        """Return the inside of a message that is *entirely* one Slack code span
        (```x``` or `x`), else the stripped text unchanged.

        Slack keeps the backticks in the delivered text, so a `!cmd` in a code
        span no longer starts with "!" and gets treated as chatter instead of a
        command. This happens a lot when people copy-paste a command. Unwrapping
        a whole-message span lets it run, while a span sitting inside prose (e.g.
        "run `!remove-alias @bot` to undo") is left alone.
        """
        stripped = text.strip()
        for fence in ("```", "`"):
            if (
                len(stripped) > 2 * len(fence)
                and stripped.startswith(fence)
                and stripped.endswith(fence)
                and fence not in stripped[len(fence) : -len(fence)]
            ):
                return stripped[len(fence) : -len(fence)].strip()
        return stripped

    def prime_mention_targets(self, targets: dict[str, str]) -> None:
        for name, external_id in targets.items():
            self._remember_mention_target(name, external_id)

    def _remember_mention_target(self, name: str, external_id: str) -> None:
        """Record a name → Slack id pair for outbound mention rendering.

        Slack handles are case-insensitive, so the map is keyed on the folded
        name. App and bot senders also reach here — their `external_id` is a
        `B…` bot id, which cannot form a valid user mention — so only real user
        ids (`U…`, or `W…` on enterprise grid) are kept; emitting `<@B…>` would
        render as broken markup rather than a mention."""
        if not external_id.startswith(("U", "W")):
            return
        self._username_to_id[name.casefold()] = external_id

    def _translate_mentions_to_slack(self, content: str) -> str:
        """Rewrite `@username` to a Slack `<@USER_ID>` mention for users we know,
        so Slack renders the person's display name, and `@agent-name` to the
        agent's user group where one exists, so an agent mention renders as a
        real pill rather than bare text — the same thing a person sees when they
        pick the agent from autocomplete. The group is empty, so rendering the
        mention notifies nobody. Unknown names are left as plain text."""

        def _replace(match: re.Match[str]) -> str:
            username = match.group(1)
            user_id = self._username_to_id.get(username.casefold())
            if user_id:
                return f"<@{user_id}>"
            group_id = self._agent_group_ids.get(username.casefold())
            return f"<!subteam^{group_id}>" if group_id else match.group(0)

        return re.sub(r"@([A-Za-z0-9][A-Za-z0-9._-]*)", _replace, content)

    # ── Socket Mode event handling ───────────────────────────────────────────

    async def _handle_socket_event(
        self, client: SocketModeClient, req: SocketModeRequest
    ) -> None:
        await client.send_socket_mode_response(
            SocketModeResponse(envelope_id=req.envelope_id)
        )

        if req.type == "slash_commands":
            await self._handle_slash_command(req.payload)
            return

        if req.type == "interactive":
            await self._handle_interactive(req.payload)
            return

        if req.type != "events_api":
            return

        event = req.payload.get("event", {})
        event_type = event.get("type")
        event_subtype = event.get("subtype")

        if event_type == "message":
            if event_subtype == "channel_join":
                await self._handle_member_joined_channel(event)
            else:
                await self._handle_message_event(event)
        elif event_type == "member_joined_channel":
            await self._handle_member_joined_channel(event)

    async def _handle_interactive(self, payload: dict[str, Any]) -> None:
        """Someone operated a Block Kit control on one of our messages.

        Only two things are read out of the payload: who Slack says acted, and
        which control they operated. A button's `value` is the opaque token this
        bridge minted when it posted the message, so a payload that was replayed
        or hand-built names nothing its sender was not already looking at.

        Slack sends one `block_actions` envelope per press, but the field is a
        list, and a press this bridge did not put there is somebody else's.
        """
        if payload.get("type") != "block_actions":
            return
        if self._on_interaction is None:
            return

        user_id = str((payload.get("user") or {}).get("id", ""))
        container = payload.get("container") or {}
        channel_id = str(
            (payload.get("channel") or {}).get("id", "")
            or container.get("channel_id", "")
        )
        message_ts = str(container.get("message_ts", ""))
        if not user_id or not channel_id:
            logger.warning("Slack block_actions missing user or channel, skipping")
            return

        user = await self._resolve_user_name(user_id)
        for action in payload.get("actions") or []:
            action_id = str(action.get("action_id", ""))
            value = str(action.get("value") or "")
            if not action_id or not value:
                continue
            await self._on_interaction(
                InboundInteraction(
                    channel_id=channel_id,
                    sender_id=user_id,
                    sender_name=user.name,
                    action_id=action_id,
                    value=value,
                    message_ref=f"{channel_id}:{message_ts}" if message_ts else None,
                )
            )

    async def _handle_member_joined_channel(self, event: dict[str, object]) -> None:
        user_id = str(event.get("user", ""))
        channel_id = str(event.get("channel", ""))
        if not user_id or not channel_id:
            return

        if user_id == self._bot_user_id:
            # The app itself was invited to / joined the channel. Surface it so
            # the room is auto-created immediately (single-app bridge: there is
            # no per-agent bot join to key off).
            if self._on_app_joined is None:
                return
            channel_type = await self.get_channel_type(channel_id)
            channel_name = await self._resolve_channel_name(channel_id)
            await self._on_app_joined(
                InboundAppJoin(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    channel_name=channel_name,
                )
            )
            return

        if self._on_user_joined is None:
            return

        user = await self._resolve_user_name(user_id)
        channel_type = await self.get_channel_type(channel_id)
        channel_name = await self._resolve_channel_name(channel_id)

        await self._on_user_joined(
            InboundUserJoin(
                channel_id=channel_id,
                channel_type=channel_type,
                external_user_id=user_id,
                external_username=user.name,
                channel_name=channel_name,
            )
        )

    # Message subtypes we still treat as real posts. file_share carries uploaded
    # attachments; thread_broadcast is a thread reply also sent to the channel;
    # bot_message is a post from a third-party Slack app (e.g. Datadog alerts).
    # Everything else (edits, deletes, channel-join system messages, …) is skipped.
    _ALLOWED_SUBTYPES = frozenset({"file_share", "thread_broadcast", "bot_message"})

    async def _handle_message_event(self, event: dict[str, object]) -> None:
        # Skip only our own posts (loop prevention). Messages from third-party
        # apps/bots carry a bot_id too, but we still bridge those — only the
        # bridge's own bot (matched on user id or bot_id) is dropped.
        if event.get("user") == self._bot_user_id or (
            self._bot_id and event.get("bot_id") == self._bot_id
        ):
            return
        subtype = event.get("subtype")
        if subtype and subtype not in self._ALLOWED_SUBTYPES:
            return

        channel_id = str(event.get("channel", ""))
        message_ts = str(event.get("ts", ""))
        if not channel_id or not message_ts:
            logger.warning("Slack message event missing channel or ts, skipping")
            return

        if message_ts in self._seen_ts:
            return
        self._seen_ts[message_ts] = None
        if len(self._seen_ts) > self._seen_ts_max:
            self._seen_ts.popitem(last=False)

        user_id = str(event.get("user", ""))
        text = str(event.get("text", ""))
        if not text.strip():
            # App posts (e.g. Datadog) often carry no top-level text — the body
            # lives in Block Kit blocks or legacy attachments.
            text = self._extract_rich_text(event)
        slack_channel_type = str(event.get("channel_type", ""))
        channel_type = self._to_channel_type(slack_channel_type)

        if slack_channel_type:
            self._channel_type_cache[channel_id] = slack_channel_type
        else:
            logger.warning(
                "Slack message event missing channel_type for %s", channel_id
            )
        self._last_user_message_ts[channel_id] = message_ts

        # App/bot posts (e.g. Datadog) carry no `user`; their identity lives in
        # bot_id + bot_profile/username. Key the puppet on the stable bot_id and
        # name it from the app's profile.
        bot_id = str(event.get("bot_id", ""))
        if not user_id and bot_id:
            bot_profile = event.get("bot_profile") or {}
            bot_name = (
                (bot_profile.get("name") if isinstance(bot_profile, dict) else "")
                or str(event.get("username", ""))
                or bot_id
            )
            user_id = bot_id
            user = SlackUser(name=bot_name, display_name=bot_name)
        else:
            user = await self._resolve_user_name(user_id)
        channel_name = await self._resolve_channel_name(channel_id)

        # A reply inside a thread carries thread_ts pointing at the root post;
        # the root message itself either omits it or sets thread_ts == ts. Map
        # genuine replies to the composite ref the message map is keyed on.
        thread_ts = str(event.get("thread_ts", "")) or None
        root_id: str | None = None
        if thread_ts and thread_ts != message_ts:
            root_id = f"{channel_id}:{thread_ts}"
        # Remember the thread this message belongs to so the "thinking"
        # indicator can be posted into the same conversation.
        self._last_thread_ts[channel_id] = thread_ts or message_ts
        message_ref = f"{channel_id}:{message_ts}"
        stripped = text.strip()
        if user_id and not bot_id:
            stripped = self._unwrap_code_span(stripped)
        if stripped.startswith("!") and self._on_command:
            parts = stripped.split(None, 1)
            command = parts[0].lstrip("!")
            args = self.translate_inbound(parts[1].strip()) if len(parts) > 1 else ""
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=user_id,
                    sender_name=user.name,
                    command=command,
                    args=args,
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return

        if self._on_message:
            attachments, attachment_failures = await self._fetch_attachments(
                event.get("files", []) or []  # type: ignore[arg-type]
            )
            self_mention = bool(self._bot_user_id) and f"<@{self._bot_user_id}>" in text
            await self._on_message(
                InboundMessage(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=user_id,
                    sender_name=user.name,
                    content=text,
                    message_ref=message_ref,
                    root_id=root_id,
                    channel_name=channel_name,
                    attachments=attachments,
                    attachment_failures=attachment_failures,
                    self_mention_token=self._bot_user_id if self_mention else None,
                    sender_is_app=bool(bot_id),
                )
            )

    async def _handle_slash_command(self, payload: dict[str, object]) -> None:
        """Translate a native Slack slash command into a Switch in-room command.

        A `/reset @agent` invocation is mapped 1:1 to the in-room `!reset @agent`
        command: the slash name IS the in-room command name, so it flows through
        the same command dispatcher as a typed `!`-command. Slack strips the
        leading `/`, so `/reset` arrives as `reset`.

        Slash commands are invisible to everyone and produce no channel post of
        their own, so we first post a visible "Running …" message (as the app)
        and route the command's result into *its* thread: the message ref is
        passed as the command's `message_ref`, so the bridged command event maps
        back to it and the result threads underneath rather than landing at the
        channel root.
        """
        command = str(payload.get("command", "")).lstrip("/")
        text = str(payload.get("text", ""))
        channel_id = str(payload.get("channel_id", ""))
        user_id = str(payload.get("user_id", ""))

        if not command or not channel_id:
            return

        user = await self._resolve_user_name(user_id)
        channel_name = str(payload.get("channel_name", "")) or None

        # Slack encodes @mentions in command arguments as `<@U…>`; normalise
        # them to `@name` so the command dispatcher's first `@` token resolves
        # to the target agent or role.
        args = self.translate_inbound(text)

        try:
            channel_type = await self.get_channel_type(channel_id)
        except SlackApiError as e:
            logger.warning(
                "Failed to resolve channel type for slash command in %s: %s",
                channel_id,
                e,
            )
            channel_type = "channel_public"

        # Post the visible "Running …" message as the app and use it as the
        # thread root for the command's result. If it fails to post, fall back
        # to a root-level result (message_ref=None) rather than dropping the
        # command.
        shown = f"/{command}" + (f" {text}" if text else "")
        running_ref = await self.admin_message(
            channel_id, f"⚙️ Running `{shown}` — result will appear in this thread."
        )

        if self._on_command:
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=user_id,
                    sender_name=user.name,
                    command=command,
                    args=args,
                    message_ref=running_ref,
                    channel_name=channel_name,
                )
            )

    @staticmethod
    def _to_channel_type(slack_type: str) -> ChannelType:
        if slack_type in ("im", "mpim"):
            return "lobby"
        if slack_type == "group":
            return "channel_private"
        if slack_type == "channel":
            return "channel_public"
        logger.warning(
            "Unknown Slack channel type '%s', defaulting to channel_public", slack_type
        )
        return "channel_public"

    # ── Attachments ──────────────────────────────────────────────────────────

    async def _fetch_attachments(
        self, files: list[dict[str, object]]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Download every attachment from a Slack message's `files`, whatever
        the type.

        Returns the successfully downloaded attachments and, separately, the
        ones that could not be relayed. A file that is oversize or fails to
        download is reported as a failure so the bridge can disclose it in the
        room — never dropped silently.
        """
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for file in files:
            mimetype = str(file.get("mimetype", "")) or "application/octet-stream"
            filename = str(file.get("name") or file.get("id") or "file")
            url = str(file.get("url_private_download") or file.get("url_private") or "")
            if not url:
                logger.warning(
                    "Slack attachment %s has no download url", file.get("id", "?")
                )
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason="no download url from Slack"
                    )
                )
                continue
            size = file.get("size")
            if isinstance(size, int) and size > self._max_attachment_bytes:
                logger.warning(
                    "Slack attachment %s is %d bytes, over the %d cap",
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
                data = await self._download_file(url)
            except Exception as exc:
                logger.exception("Failed to download Slack attachment %s", filename)
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

    async def _download_file(self, url: str) -> bytes:
        """Fetch a Slack private file URL with the bot token, returning bytes."""
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                url,
                headers={"Authorization": f"Bearer {self._config.bot_token}"},
            )
            resp.raise_for_status()
            return resp.content

    # ── User resolution ──────────────────────────────────────────────────────

    def _extract_rich_text(self, event: dict[str, object]) -> str:
        """Recover the readable body of an app post that has no top-level text.

        Slack apps put content in Block Kit `blocks` (preferred) or legacy
        `attachments`. Pull the human-readable strings out of both and join
        them into a single markdown-ish block."""

        def _blocks_text(blocks: object) -> list[str]:
            out: list[str] = []
            if not isinstance(blocks, list):
                return out
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype in ("section", "header"):
                    field = block.get("text")
                    if isinstance(field, dict) and field.get("text"):
                        out.append(str(field["text"]))
                    fields = block.get("fields")
                    if isinstance(fields, list):
                        for f in fields:
                            if isinstance(f, dict) and f.get("text"):
                                out.append(str(f["text"]))
                elif btype == "rich_text":
                    out.extend(_rich_text_elements(block.get("elements")))
            return out

        def _rich_text_elements(elements: object) -> list[str]:
            out: list[str] = []
            if not isinstance(elements, list):
                return out
            for el in elements:
                if not isinstance(el, dict):
                    continue
                if el.get("text"):
                    out.append(str(el["text"]))
                if "elements" in el:
                    out.extend(_rich_text_elements(el.get("elements")))
            return out

        parts = _blocks_text(event.get("blocks"))
        if not parts:
            attachments = event.get("attachments")
            if isinstance(attachments, list):
                for att in attachments:
                    if not isinstance(att, dict):
                        continue
                    pretext = att.get("pretext")
                    if pretext:
                        parts.append(str(pretext))
                    title = att.get("title")
                    if title:
                        link = att.get("title_link")
                        # Emit Slack link syntax so translate_inbound renders it
                        # as a markdown link (the title is clickable in Slack).
                        parts.append(f"<{link}|{title}>" if link else str(title))
                    body = att.get("text") or att.get("fallback")
                    if body:
                        parts.append(str(body))

        return "\n".join(p.strip() for p in parts if str(p).strip())

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Find workspace members by handle, real name or email.

        Slack has no server-side user search, so this pages `users.list` and
        filters locally. Deactivated accounts and bots are dropped — a bot is
        not a person who can own an agent. `email` is only present when the
        app holds the `users:read.email` scope; without it the field is simply
        absent rather than the search failing.
        """
        if not self._web_client:
            raise RuntimeError("Slack adapter is not started")

        needle = query.strip().lower()
        if not needle:
            return []

        matches: list[DirectoryUser] = []
        cursor: str | None = None
        while True:
            try:
                result = await self._web_client.users_list(
                    limit=200, cursor=cursor or None
                )
            except SlackApiError as e:
                raise RuntimeError(f"Slack user directory lookup failed: {e}") from e

            members: list[dict[str, Any]] = result.get("members") or []
            for member in members:
                if member.get("deleted") or member.get("is_bot"):
                    continue
                if member.get("id") == "USLACKBOT":
                    continue
                profile: dict[str, Any] = member.get("profile") or {}
                handle = member.get("name", "") or ""
                real_name = profile.get("real_name", "") or member.get("real_name", "")
                display_name = profile.get("display_name", "") or real_name or handle
                email = profile.get("email") or None
                haystack = " ".join(
                    part.lower()
                    for part in (handle, real_name, display_name, email or "")
                    if part
                )
                if needle not in haystack:
                    continue
                matches.append(
                    DirectoryUser(
                        external_user_id=str(member.get("id")),
                        username=handle or str(member.get("id")),
                        display_name=display_name or handle,
                        email=email,
                    )
                )

            metadata: dict[str, Any] = result.get("response_metadata") or {}
            cursor = metadata.get("next_cursor")
            if not cursor:
                break

        matches.sort(key=lambda u: u.display_name.lower())
        return matches

    async def _resolve_user_name(self, slack_user_id: str) -> SlackUser:
        cached = self._user_cache.get(slack_user_id)
        if cached:
            return cached

        if not self._web_client:
            return SlackUser(name=slack_user_id, display_name=slack_user_id)

        try:
            result = await self._web_client.users_info(user=slack_user_id)
            user = result["user"]
            name = user.get("name", slack_user_id)
            display_name = (
                user.get("profile", {}).get("display_name", "")
                or user.get("real_name", "")
                or name
            )
            resolved = SlackUser(name=name, display_name=display_name)
            self._user_cache[slack_user_id] = resolved
            self._remember_mention_target(name, slack_user_id)
            return resolved
        except SlackApiError as e:
            logger.warning("Failed to resolve Slack user %s: %s", slack_user_id, e)
            return SlackUser(name=slack_user_id, display_name=slack_user_id)

    async def _resolve_channel_name(self, channel_id: str) -> str | None:
        cached = self._channel_name_cache.get(channel_id)
        if cached:
            return cached

        if not self._web_client:
            raise RuntimeError("Cannot resolve channel name: adapter not started")

        try:
            result = await self._web_client.conversations_info(channel=channel_id)
            channel = result["channel"]
            name: str | None = channel.get("name") or channel.get("name_normalized")
            if name:
                self._channel_name_cache[channel_id] = name
            return name
        except SlackApiError as e:
            logger.warning("Failed to resolve Slack channel %s: %s", channel_id, e)
            return None

    # ── Mention translation ──────────────────────────────────────────────────

    def _translate_mentions_to_markdown(self, message: str) -> str:
        def _replace_mention(match: re.Match[str]) -> str:
            slack_user_id = match.group(1)
            cached = self._user_cache.get(slack_user_id)
            if cached:
                return f"@{cached.name}"
            return f"@{slack_user_id}"

        # Slack encodes a user mention as `<@U123>`, and — when a slash
        # command escapes its text — as `<@U123|username>`. Accept the optional
        # `|label` so escaped slash-command mentions (including the bridge bot's
        # own id, used as its room alias) resolve the same as message mentions.
        message = re.sub(r"<@(U[A-Z0-9]+)(?:\|[^>]+)?>", _replace_mention, message)
        return self._translate_usergroup_mentions(message)

    def _translate_usergroup_mentions(self, message: str) -> str:
        """Rewrite a user group mention to the plain `@agent-name` text.

        An agent's group is how its name reaches the composer's autocomplete,
        so a user picking it from the `@` menu sends `<!subteam^S123>` rather
        than the typed name. Resolving it back to the agent's name is what lets
        the rest of Switch treat it as an ordinary mention — the addressing
        layer downstream matches on the name, and knows nothing about Slack.

        The id maps to the agent name we stored on the group, not to the handle,
        so an agent whose name had to be folded to make a legal handle still
        resolves to its real name. Groups we do not know are left untouched: a
        workspace's own group is not an agent, and rewriting it would invent a
        mention of someone who does not exist.

        An id this workspace never minted may still be an agent's. On an
        Enterprise Grid org the composer offers a sibling workspace's group, so
        the mention arrives here naming a group only that bridge knows —
        consulting the shared directory is what keeps the agent addressable
        from either side of the org.
        """

        def _replace(match: re.Match[str]) -> str:
            group_id = match.group(1)
            agent_name = self._agent_group_names.get(
                group_id
            ) or self.agent_group_directory.resolve(group_id)
            if agent_name:
                return f"@{agent_name}"
            label = match.group(2)
            if label:
                return label.lstrip("|")
            # Not an agent's group, or one we have not adopted yet. Its handle
            # still reads as a mention, where the raw tag is just broken output
            # in the room — and if the handle is an agent's name, the ordinary
            # text matching downstream picks it up anyway.
            handle = self._group_handles.get(group_id)
            return f"@{handle}" if handle else match.group(0)

        # `<!subteam^S123>` is the documented form; the `|@handle` variant is
        # what Slack actually sends on some paths, so accept both.
        return re.sub(r"<!subteam\^([A-Z0-9]+)(\|[^>]*)?>", _replace, message)

    # ── Markdown → mrkdwn ────────────────────────────────────────────────────

    @staticmethod
    def _markdown_to_mrkdwn(text: str) -> str:
        code_blocks: list[str] = []

        def _save_code(m: re.Match[str]) -> str:
            code_blocks.append(m.group(0))
            return f"\x00CODE{len(code_blocks) - 1}\x00"

        text = re.sub(r"```.*?```", _save_code, text, flags=re.DOTALL)

        text = re.sub(r"^(\s*)[*+]\s", r"\1• ", text, flags=re.MULTILINE)

        def _convert_heading(m: re.Match[str]) -> str:
            content = re.sub(r"\*\*(.+?)\*\*", r"\1", m.group(1))
            return f"*{content}*"

        text = re.sub(r"^#{1,6}\s+(.+)$", _convert_heading, text, flags=re.MULTILINE)
        text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text)
        text = re.sub(r"~~(.+?)~~", r"~\1~", text)
        text = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", r"<\2|\1>", text)
        text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<\2|\1>", text)
        text = re.sub(r"^[-*_]{3,}\s*$", "───", text, flags=re.MULTILINE)

        for i, block in enumerate(code_blocks):
            text = text.replace(f"\x00CODE{i}\x00", block)

        return text

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _parse_message_ref(message_ref: str) -> tuple[str, str]:
        parts = message_ref.split(":", 1)
        if len(parts) != 2:
            logger.error("Invalid Slack message ref format: %s", message_ref)
            return "", ""
        return parts[0], parts[1]
