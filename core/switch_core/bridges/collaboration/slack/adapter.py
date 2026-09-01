from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import replace
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
    LiveRuntimeIndicator,
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
from switch_core.bridges.collaboration.slack.agent_groups import (
    SlackAgentGroupDirectory,
)
from switch_core.bridges.collaboration.slack.avatar import on_slack_background

logger = logging.getLogger(__name__)

# Stamped on the description of every user group we mint for an agent, so a
# reload can tell ours apart from the workspace's own groups.
_AGENT_GROUP_MARKER = "Switch agent — "

# User group calls are rate-limited at roughly 20/minute, and the Slack client
# retries connection errors but not throttling.
_RATE_LIMIT_MAX_ATTEMPTS = 5
_RATE_LIMIT_DEFAULT_DELAY = 30

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


# Slack refusals that mean this app cannot host agent sessions at all, rather
# than that one call went wrong. Each says what an operator would have to change.
# How many identical unrecognised refusals before agent sessions are given up
# on. Slack returns codes this list does not know about, and a status that
# cannot work must not warn on every turn for the life of the bridge.
_AGENT_SESSIONS_FAILURE_LIMIT = 3

# How long a give-up over unrecognised errors lasts before the bridge tries
# again. Long enough that a bad patch is waited out rather than hammered
# through, short enough that a bridge does not stay dark for a day because of
# one. A refusal that named its own cause is not covered: nothing about the
# workspace will have changed, so it is not retried at all.
_AGENT_SESSIONS_RETRY_AFTER = 600

# Prefix on the trace lines that follow a turn through the session, so a run
# can be read end to end when something does not render. Debug level: the
# per-turn detail is only wanted when someone is looking for it.
_TRACE = "[agent-sessions] "

# Put on the message an agent is working on, for the whole turn.
_WORKING_REACTION = "eyes"

# Slack caps a task chunk's text; keep well inside it.
_STREAM_STEP_MAX = 200


def _plain(text: str) -> str:
    """Strip Switch's markup for somewhere that renders none.

    A task card's title is plain text, so markup passed into it arrives as
    literal `_underscores_` and backticks rather than emphasis."""
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"(?<!\w)[*_]([^*_]+)[*_](?!\w)", r"\1", text)
    return text.strip()


def _task_chunk(
    title: str, deeplink_url: str | None = None, *, done: bool = False
) -> dict[str, Any]:
    """One step in a streamed session.

    Slack documents this payload three mutually incompatible ways — the method
    reference, the guide's sample, and the guide's full example all differ. The
    method reference is the one followed here, and the shape is kept in this
    single function so correcting it against the live API is a one-line change
    rather than a hunt.
    """
    chunk: dict[str, Any] = {
        "type": "task_update",
        "id": "current",
        "title": title,
        "status": "complete" if done else "in_progress",
    }
    if deeplink_url:
        # The way back into the live session. It used to ride on the message
        # Switch posted; now the card stands alone, so it travels here.
        chunk["sources"] = [
            {"type": "url", "text": "Open in Switch Console", "url": deeplink_url}
        ]
    return chunk


_AGENT_SESSIONS_UNAVAILABLE_ERRORS = {
    "not_an_agent": (
        "the Slack app is not declared as an Agent — enable the Agents feature "
        "in the app's settings. Note that doing so removes access for workspace "
        "guests and cannot be undone."
    ),
    "not_authorized": (
        "Slack says the app is not a member of that channel. If it plainly is, "
        "the other cause is that the app is not declared as an Agent — only an "
        "Agent app may open sessions. Enabling that removes access for "
        "workspace guests and cannot be undone."
    ),
    "feature_disabled": (
        "the agent tasks feature is not enabled for this Slack workspace."
    ),
    "not_allowed_token_type": (
        "agent sessions need a granular bot token; this app's token is not one."
    ),
    "unknown_method": ("this Slack deployment does not offer the agent sessions API."),
    "missing_scope": (
        "the Slack app is missing the assistant:write scope — reinstall it with "
        "the scopes from SLACK_SETUP.md."
    ),
    "method_not_supported_for_channel_type": (
        "agent sessions are not supported in this kind of conversation."
    ),
}


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
    agent_sessions: bool = Field(
        default=True,
        title="Native progress card",
        description=(
            "Show an agent's progress in Slack's own live card instead of a "
            "message Switch posts. Needs the Slack app to be declared an "
            "Agent; without that, the posted message is used instead."
        ),
    )


class SlackAdapter(CollaborationAdapter):
    # Pin a turn's status to the message being worked on, opening a thread on
    # it when there is none. Without this a question asked at the channel root
    # has no thread, so its progress has nowhere to live and no session can be
    # opened for it — which was most turns.
    runtime_state_follows_anchor: ClassVar[bool] = True

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
        # Set once Slack has told us it will not host agent sessions, so the
        # bridge stops asking and says so only once.
        self._agent_sessions_off_reason: str | None = None
        # When a give-up over unrecognised errors expires. None means the
        # reason above is a workspace's settled answer and will not improve on
        # its own, so nothing re-arms it.
        self._agent_sessions_retry_at: float | None = None
        # Consecutive identical session-status failures, so an error code this
        # build does not recognise still stops complaining eventually.
        self._session_failures = 0
        self._last_session_error: str | None = None
        # While Slack is throttling us, when it said we may call again.
        self._sessions_throttled_until: float | None = None
        # (channel_id, thread_ts) -> agent whose turn owns that session, so the
        # stop button can be routed to the agent it belongs to.
        self._session_owner: dict[tuple[str, str], str] = {}
        # (channel_id, thread_ts) -> the open stream's ts, and the last step
        # pushed into it. A stream is what creates the session Slack renders.
        self._stream_ts: dict[tuple[str, str], str] = {}
        self._stream_step: dict[tuple[str, str], str] = {}
        # (channel_id, thread_ts) -> who asked. Streaming into a channel has to
        # name the person being replied to, which the runtime-state path does
        # not carry, so it is remembered from the message that started it.
        self._thread_requester: dict[tuple[str, str], str] = {}
        # (channel_id, agent_name) already reported as having no thread, so the
        # trace says it once rather than on every state report.
        self._threadless_logged: set[tuple[str, str]] = set()
        # (channel_id, ts) currently carrying the "being worked on" reaction.
        self._eyes: set[tuple[str, str]] = set()
        # (channel_id, agent_name) -> every thread that agent is working in.
        # A turn ends once but may have opened several.
        self._agent_threads: dict[tuple[str, str], set[str]] = {}
        # (channel_id, agent_name) -> every message that agent has marked. Not
        # the same as the threads: the mark goes on the message that asked,
        # which inside a thread is a reply rather than the root.
        self._agent_eyes: dict[tuple[str, str], set[str]] = {}
        # (channel_id, thread_ts) -> ts of the last message asking in it.
        self._thread_trigger: dict[tuple[str, str], str] = {}
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
        # workspace id on an Enterprise Grid org, where that is the org id
        # (`E…`) and streaming wants the team (`T…`) — so take it from the
        # authenticated identity rather than from config.
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
        logger.debug(
            _TRACE + "build carries agent sessions; config agent_sessions=%s",
            self._config.agent_sessions,
        )

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

        try:
            result = await self._web_client.chat_postMessage(
                channel=channel_id,
                text=content,
                username=sender_name,
                icon_url=await self.agent_icon_url(sender_name),
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

    async def agent_icon_url(self, agent_name: str) -> str:
        # Overridden for Slack alone: it flattens a transparent avatar onto
        # white. Wrapping the resolver rather than each call site keeps every
        # place that posts as an agent on the same background.
        return on_slack_background(await super().agent_icon_url(agent_name))

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

        comment = (
            f"*{sender_name}*: {self.translate_outbound(caption)}"
            if caption
            else f"*{sender_name}* sent `{filename}`"
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
        comment = (
            f"*{sender_name}*: {self.translate_outbound(caption)}"
            if caption
            else f"*{sender_name}* sent {names}"
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

            try:
                result = await self._web_client.chat_postMessage(
                    channel=channel_id,
                    text="_thinking..._",
                    username=sender_name,
                    icon_url=await self.agent_icon_url(sender_name),
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
        """Render runtime state as persistent, truly-deletable status messages.

        Slack's `chat_delete` removes a message cleanly (no tombstone), so the
        "working on it…" indicator and any "needs your input" pings are posted
        while relevant and deleted when the turn ends. The working indicator
        stays up through `awaiting-input` — the agent is mid-turn, just paused —
        and the pings are removed alongside it when the turn goes idle (or
        resumes to `working`, since the input that was requested was provided).
        When the agent was addressed in a thread, messages surface in that
        thread (``thread_root_id``); otherwise at the channel root.
        """
        # Handled before the branching below, because the working branch
        # returns early when it only has to refresh the message in place — and
        # the session still has to track the turn.
        await self._track_turn(
            channel_id,
            thread_root_id,
            agent_name,
            state=state,
            detail=detail,
            deeplink_url=deeplink_url,
        )

        key = (channel_id, agent_name)
        if state == "working":
            # Resuming work means the requested input was provided — clear the
            # now-resolved pings, then ensure the working indicator is up.
            await self._clear_input_pings(channel_id, agent_name)
            if self._streaming(channel_id, thread_root_id):
                # Slack is drawing this turn itself, and better: the card is
                # live, named for the agent, and carries the console link. A
                # posted message beside it would say the same thing twice, so
                # any earlier one is taken down.
                await self._clear_working(channel_id, agent_name)
                return
            # Posted under the agent's own name/icon, so the body just states
            # the activity — no need to repeat the agent name in the text.
            body = self._working_body(detail, deeplink_url)
            existing = self._working_msg.get(key)
            if existing is not None:
                # Refresh the live message in place with the latest activity.
                # Position is a separate concern — see reposition_runtime_state,
                # which moves the indicator when the conversation moves on.
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
            # Leave the working indicator up; add a ping and track it.
            ref = await self._ping_operator(
                channel_id, agent_name, mention_handle, thread_root_id, deeplink_url
            )
            if ref is not None:
                self._input_pings.setdefault(key, []).append(ref)
        else:
            await self._clear_working(channel_id, agent_name)
            await self._clear_input_pings(channel_id, agent_name)

    async def _track_turn(
        self,
        channel_id: str,
        thread_root_id: str | None,
        agent_name: str,
        *,
        state: str,
        detail: str | None,
        deeplink_url: str | None,
    ) -> None:
        """Keep every thread this agent has in flight, and end them together.

        An agent asked two things at once works on both, and each message gets
        its own card and its own eyes — but the turn ends **once**, naming only
        the thread it last touched. Cleaning up just that one leaves the first
        message marked as being worked on for good, and its card frozen
        mid-task. So the threads are remembered per agent and closed together.
        """
        akey = (channel_id, agent_name)
        thread_ts = self._thread_ts_of(thread_root_id)

        if state in ("working", "awaiting-input"):
            if not thread_ts:
                await self._update_session(
                    channel_id,
                    thread_root_id,
                    agent_name,
                    state=state,
                    detail=detail,
                    deeplink_url=deeplink_url,
                )
                return
            self._agent_threads.setdefault(akey, set()).add(thread_ts)
            asked_on = self._thread_trigger.get((channel_id, thread_ts), thread_ts)
            self._agent_eyes.setdefault(akey, set()).add(asked_on)
            await self._mark_being_read(channel_id, asked_on, working=True)
            await self._update_session(
                channel_id,
                thread_root_id,
                agent_name,
                state=state,
                detail=detail,
                deeplink_url=deeplink_url,
            )
            return

        for ts in sorted(self._agent_eyes.pop(akey, set())):
            await self._mark_being_read(channel_id, ts, working=False)
        for ts in sorted(self._agent_threads.pop(akey, set())):
            # Ownership goes with the turn: a stop pressed afterwards must not
            # interrupt whatever the agent moved on to.
            self._session_owner.pop((channel_id, ts), None)
            await self._drive_stream(
                channel_id,
                ts,
                agent_name,
                working=False,
                detail=None,
                deeplink_url=None,
            )

    async def _mark_being_read(
        self, channel_id: str, thread_ts: str | None, *, working: bool
    ) -> None:
        """Put 👀 on the message an agent is working on, and take it off after.

        Unlike the session card this needs nothing from Slack beyond a scope we
        already hold, and it works at the channel root as well as in a thread —
        so it is the one progress signal that is always available. It also says
        *which* message is being handled, which a status elsewhere cannot.
        """
        ts = thread_ts
        if not ts or not self._web_client:
            return
        key = (channel_id, ts)
        if working == (key in self._eyes):
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
            logger.warning(
                "Could not %s the working reaction on %s in %s: %s",
                "add" if working else "remove",
                ts,
                channel_id,
                error or e,
            )

    def _streaming(self, channel_id: str, thread_root_id: str | None) -> bool:
        """Whether Slack is already drawing this turn's progress itself."""
        thread_ts = self._thread_ts_of(thread_root_id)
        return bool(thread_ts) and (channel_id, thread_ts) in self._stream_ts

    # ── Native agent session ─────────────────────────────────────────────────

    async def _update_session(
        self,
        channel_id: str,
        thread_root_id: str | None,
        agent_name: str,
        *,
        state: str,
        detail: str | None = None,
        deeplink_url: str | None = None,
    ) -> None:
        """Mirror the turn onto a Slack agent session.

        This is additive: the status messages Switch posts are what actually
        carry the detail, and they are unchanged. This adds Slack's own live
        card of what the agent is doing, under the agent's name and icon.

        The card is the stream. Slack also has a session *status*, which does
        render — but as a second element attributed to the app rather than the
        agent, with Slack's own generic wording and no way to rename it. Two
        cards for one turn, one of them anonymous, reads worse than one, so it
        is deliberately not set here. The stop button that hangs off it goes
        with it.

        A session is scoped to a thread, so a turn with none is left to the
        posted messages alone.
        """
        if not self._config.agent_sessions:
            logger.debug(_TRACE + "skipped for %s: turned off in config", agent_name)
            return
        if self._agent_sessions_off():
            # Silent by design. Giving up is announced once, where it happens;
            # saying so again per skipped turn produced eleven thousand lines
            # in a night — an instrument that ruins the thing it measures.
            return
        if not self._web_client:
            logger.debug(_TRACE + "skipped for %s: Slack not connected", agent_name)
            return
        thread_ts = self._thread_ts_of(thread_root_id)
        if not thread_ts:
            # Once per agent per channel. Runtime state is reported many times
            # a turn and most turns have no thread, so logging every one buries
            # everything else.
            if (channel_id, agent_name) not in self._threadless_logged:
                self._threadless_logged.add((channel_id, agent_name))
                logger.debug(
                    _TRACE + "no thread for %s in %s, so no session (state '%s')",
                    agent_name,
                    channel_id,
                    state,
                )
            return
        self._threadless_logged.discard((channel_id, agent_name))

        working = state in ("working", "awaiting-input")
        if working and self._sessions_throttled():
            # A step lost to throttling costs one line of the card. Teardown is
            # not skipped the same way: dropping it would leave the card open
            # for good, so it is attempted even while we are being throttled.
            return
        key = (channel_id, thread_ts)
        if working:
            self._session_owner[key] = agent_name
        else:
            self._session_owner.pop(key, None)

        await self._drive_stream(
            channel_id,
            thread_ts,
            agent_name,
            working=working,
            detail=detail,
            deeplink_url=deeplink_url,
        )

    def _note_session_failure(
        self,
        error: str,
        agent_name: str,
        channel_id: str,
        *,
        retry_after: int | None = None,
    ) -> None:
        """Log a failed status call, and give up if it is not going to improve.

        A known refusal names its cause immediately. An unrecognised one cannot
        be told apart from a passing fault on the first sight of it, so it is
        logged and retried — but only so many times. Slack returns codes this
        list does not know about (`not_authorized` for an app that is not an
        agent, found in the pilot), and without a backstop each one means a
        warning on every turn for as long as the bridge runs.

        Throttling is the exception, and is not counted at all: it says the app
        is busy, not that it is unfit, and counting it turned a burst of
        traffic into a bridge that never showed a card again.
        """
        if error == "ratelimited":
            self._note_session_throttled(retry_after or _RATE_LIMIT_DEFAULT_DELAY)
            return

        if error in _AGENT_SESSIONS_UNAVAILABLE_ERRORS:
            self._disable_agent_sessions(error)
            return

        # One turn's status failing is not worth losing the turn over — the
        # posted indicator still says what is happening.
        self._session_failures = (
            self._session_failures + 1 if error == self._last_session_error else 1
        )
        self._last_session_error = error
        logger.warning(
            "Could not set the Slack session status for agent %s in %s: %s",
            agent_name,
            channel_id,
            error or "unknown error",
        )
        if self._session_failures >= _AGENT_SESSIONS_FAILURE_LIMIT:
            self._disable_agent_sessions(error, retry_in=_AGENT_SESSIONS_RETRY_AFTER)

    def _note_session_throttled(self, delay: int) -> None:
        """Stand down for as long as Slack asked, and say so once per burst."""
        already_waiting = self._sessions_throttled()
        self._sessions_throttled_until = time.monotonic() + delay
        if already_waiting:
            logger.debug(_TRACE + "still throttled; waiting %ss more", delay)
            return
        logger.warning(
            "Slack is rate-limiting agent session updates; pausing them for %ss. "
            "Cards may miss a step until it clears; Switch's own status messages "
            "are unaffected.",
            delay,
        )

    def _sessions_throttled(self) -> bool:
        until = self._sessions_throttled_until
        if until is None:
            return False
        if time.monotonic() < until:
            return True
        self._sessions_throttled_until = None
        logger.debug(_TRACE + "throttling window elapsed; resuming session updates")
        return False

    def _agent_sessions_off(self) -> bool:
        """Whether sessions are given up on — re-arming a lapsed give-up.

        A give-up over errors this build cannot name is a guess, so it expires:
        the bridge tries again rather than staying dark until someone restarts
        it. A refusal that named its own cause does not expire, because nothing
        will have changed without an operator changing it.
        """
        if self._agent_sessions_off_reason is None:
            return False
        retry_at = self._agent_sessions_retry_at
        if retry_at is None or time.monotonic() < retry_at:
            return True
        logger.info(
            "Trying Slack agent sessions again after backing off over '%s'.",
            self._agent_sessions_off_reason,
        )
        self._agent_sessions_off_reason = None
        self._agent_sessions_retry_at = None
        self._session_failures = 0
        self._last_session_error = None
        return False

    async def _drive_stream(
        self,
        channel_id: str,
        thread_ts: str,
        agent_name: str,
        *,
        working: bool,
        detail: str | None,
        deeplink_url: str | None,
    ) -> None:
        """Open, extend and close the stream that backs the session.

        The stream calls go through the SDK's own methods, which send JSON and
        keep the argument names honest; only the session status has no typed
        method to use."""
        client = self._web_client
        if client is None:
            return
        key = (channel_id, thread_ts)
        open_ts = self._stream_ts.get(key)

        if not working:
            if open_ts:
                closing_ts = open_ts
                if self._stream_step.get(key):
                    # Marked done before closing. The card is deleted a moment
                    # later, so this only shows if that delete is refused — and
                    # a leftover reading "finished" beats one reading "failed",
                    # which is what an unfinished step renders as.
                    await self._call_session_api(
                        lambda: client.chat_appendStream(
                            channel=channel_id,
                            ts=closing_ts,
                            chunks=[_task_chunk(self._stream_step[key], done=True)],
                        ),
                        agent_name=agent_name,
                        channel_id=channel_id,
                        stream_key=key,
                    )
                await self._call_session_api(
                    lambda: client.chat_stopStream(channel=channel_id, ts=closing_ts),
                    agent_name=agent_name,
                    channel_id=channel_id,
                    stream_key=key,
                )
                # The card is a progress indicator, not a record. Once the turn
                # is over the agent's own reply is the thing worth reading, so
                # the card goes the way the posted status message always did.
                await self.delete_message(channel_id, f"{channel_id}:{closing_ts}")
                self._stream_ts.pop(key, None)
                self._stream_step.pop(key, None)
                logger.debug(_TRACE + "closed stream for %s on %s", agent_name, key[1])
            return

        step = (_plain(detail or "") or "Working")[:_STREAM_STEP_MAX]
        if open_ts is None:
            requester = self._thread_requester.get(key)
            if not requester:
                logger.debug(
                    _TRACE + "no stream for %s on %s: nobody recorded to stream to",
                    agent_name,
                    thread_ts,
                )
                return
            if not self._team_id:
                logger.debug(
                    _TRACE + "no stream for %s: the bot's team id is unknown",
                    agent_name,
                )
                return
            icon_url = await self.agent_icon_url(agent_name)
            open_ts = await self._call_session_api(
                lambda: client.chat_startStream(
                    channel=channel_id,
                    thread_ts=thread_ts,
                    recipient_user_id=requester,
                    recipient_team_id=self._team_id,
                    task_display_mode="timeline",
                    username=agent_name,
                    icon_url=icon_url,
                ),
                agent_name=agent_name,
                channel_id=channel_id,
            )
            if open_ts is None:
                return
            if not open_ts:
                logger.warning(
                    _TRACE + "Slack opened a stream for %s with no ts", agent_name
                )
                return
            self._stream_ts[key] = open_ts
            logger.debug(_TRACE + "opened stream %s for %s", open_ts, agent_name)
        elif self._stream_step.get(key) == step:
            return

        # Slack accumulates a task's sources across updates rather than
        # replacing them, so the link goes on the first step only — sending it
        # every time stacked eight identical links under one card.
        first_link = deeplink_url if self._stream_step.get(key) is None else None
        stream_ts = open_ts
        pushed = await self._call_session_api(
            lambda: client.chat_appendStream(
                channel=channel_id,
                ts=stream_ts,
                chunks=[_task_chunk(step, first_link)],
            ),
            agent_name=agent_name,
            channel_id=channel_id,
            stream_key=key,
        )
        if pushed is None:
            # The step never landed, so it is not what the card is showing —
            # and recording it would tell the next one the link had been sent.
            return
        self._stream_step[key] = step

    async def _call_session_api(
        self,
        call: Callable[[], Awaitable[Any]],
        *,
        agent_name: str,
        channel_id: str,
        stream_key: tuple[str, str] | None = None,
    ) -> str | None:
        """Make a session call, routing a refusal through the same give-up path.

        Returns the response's `ts` on success (empty string when it has none)
        and None on failure, so a caller that needs the stream's id cannot
        mistake a refusal for a stream it can append to.

        `stream_key` names the card being written to, where there is one, so a
        card that has gone can be forgotten instead of counted against the app.
        """
        try:
            result = await call()
        except SlackApiError as e:
            error = str(e.response.get("error", ""))
            if error == "message_not_found":
                self._forget_stream(stream_key, agent_name)
                return None
            self._note_session_failure(
                error,
                agent_name,
                channel_id,
                retry_after=_retry_after_seconds(e) if error == "ratelimited" else None,
            )
            return None
        self._session_failures = 0
        self._sessions_throttled_until = None
        return str(result.get("ts", ""))

    def _forget_stream(self, key: tuple[str, str] | None, agent_name: str) -> None:
        """Drop a card Slack says is no longer there.

        The card is deleted when a turn ends, so a state report that arrives
        just behind the teardown writes to something that has gone — as does a
        card a user deleted by hand. It says nothing about whether this app can
        host sessions, and counting it as if it did took the card away from
        every agent in the workspace over one stale thread. The turn falls back
        to the posted status message, and the next one opens a fresh card.
        """
        if key is not None:
            self._stream_ts.pop(key, None)
            self._stream_step.pop(key, None)
            self._session_owner.pop(key, None)
        logger.debug(
            _TRACE + "card for %s is gone; forgetting it and carrying on", agent_name
        )

    def _disable_agent_sessions(
        self, error: str, *, retry_in: int | None = None
    ) -> None:
        if self._agent_sessions_off_reason:
            return
        self._agent_sessions_off_reason = error
        self._agent_sessions_retry_at = (
            time.monotonic() + retry_in if retry_in is not None else None
        )
        reason = _AGENT_SESSIONS_UNAVAILABLE_ERRORS.get(
            error,
            f"Slack kept refusing with '{error or 'an unknown error'}'. If the "
            "app is not declared as an Agent in its settings, that is the "
            "likeliest cause.",
        )
        recovery = (
            f" Trying again in {retry_in}s."
            if retry_in is not None
            else " This will not change without an operator changing it."
        )
        logger.warning(
            "Slack agent sessions are unavailable for this app (%s): %s "
            "Turns still show Switch's own status messages; only Slack's native "
            "loading UX and stop button are missing.%s",
            error,
            reason,
            recovery,
        )

    @staticmethod
    def _thread_ts_of(thread_root_id: str | None) -> str | None:
        if not thread_root_id:
            return None
        return (
            thread_root_id.split(":", 1)[1] if ":" in thread_root_id else thread_root_id
        )

    async def _handle_session_stopped(self, event: dict[str, object]) -> None:
        """Route Slack's stop button to the agent whose turn it belongs to.

        Setting a session to `processing` puts a stop button on the thread. A
        button that does nothing is worse than no button, so it is wired to the
        same interrupt an operator can type — anything less would be a control
        that lies about what it does.
        """
        channel_id = str(event.get("channel_id") or event.get("channel") or "")
        thread_ts = str(event.get("thread_ts") or "")
        if not channel_id or not thread_ts or self._on_command is None:
            return

        agent_name = self._session_owner.pop((channel_id, thread_ts), None)
        if not agent_name:
            logger.info(
                "Slack session stopped in %s (%s) with no agent turn to interrupt",
                channel_id,
                thread_ts,
            )
            return

        user_id = str(event.get("user_id") or event.get("user") or "")
        user = await self._resolve_user_name(user_id) if user_id else None
        await self._on_command(
            InboundCommand(
                channel_id=channel_id,
                channel_type=await self.get_channel_type(channel_id),
                sender_id=user_id,
                sender_name=user.name if user else "slack",
                command="interrupt",
                args=f"@{agent_name}",
                message_ref=None,
                root_id=f"{channel_id}:{thread_ts}",
                channel_name=await self._resolve_channel_name(channel_id),
            )
        )

    async def _clear_working(self, channel_id: str, agent_name: str) -> None:
        live = self._working_msg.pop((channel_id, agent_name), None)
        if live is not None:
            await self.delete_message(channel_id, live.message_ref)

    async def _clear_input_pings(self, channel_id: str, agent_name: str) -> None:
        refs = self._input_pings.pop((channel_id, agent_name), [])
        for ref in refs:
            await self.delete_message(channel_id, ref)

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

    def translate_inbound(self, raw_message: str) -> str:
        return self._translate_links_to_markdown(
            self._translate_mentions_to_markdown(raw_message)
        )

    @staticmethod
    def _translate_links_to_markdown(message: str) -> str:
        """Convert Slack link syntax `<url|label>` / `<url>` to markdown."""
        message = re.sub(r"<(https?://[^|>]+)\|([^>]+)>", r"[\2](\1)", message)
        return re.sub(r"<(https?://[^>]+)>", r"\1", message)

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
        elif event_type == "agent_session_stopped":
            await self._handle_session_stopped(event)

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
        root = thread_ts or message_ts
        # The message that actually asked. Inside a thread this is a reply, not
        # the root, and the mark belongs on what was said — not on the
        # conversation it happens to sit in. An app's post counts: a Slack
        # workflow asking an agent something is a request like any other, and
        # treating it as nobody asking left the mark aimed at a thread root
        # that need not be a message at all.
        self._thread_trigger[(channel_id, root)] = message_ts
        # Streaming a reply into a channel has to name who it is for, and the
        # runtime-state path never sees the asker — so keep it per thread. This
        # one does need a person: Slack will not open a session addressed to an
        # app, so a workflow-triggered turn has the posted status message and
        # the mark, and no card.
        if user_id and not bot_id:
            self._thread_requester[(channel_id, root)] = user_id

        message_ref = f"{channel_id}:{message_ts}"
        stripped = text.strip()
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
