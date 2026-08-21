from __future__ import annotations

import logging
import re
import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any

import httpx
from pydantic import BaseModel
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
from switch_core.bridges.collaboration.slack.avatar import on_slack_background

logger = logging.getLogger(__name__)


class SlackUser(BaseModel):
    name: str
    display_name: str


class SlackConnectionConfig(BridgeConnectionConfig):
    bot_token: str
    app_token: str
    workspace_id: str


class SlackAdapter(CollaborationAdapter):
    def __init__(self, *, config: SlackConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._web_client: AsyncWebClient | None = None
        self._socket_client: SocketModeClient | None = None
        self._bot_user_id: str = ""
        self._bot_id: str = ""
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
                text=self.translate_outbound(content),
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
        key = (channel_id, agent_name)
        if state == "working":
            # Resuming work means the requested input was provided — clear the
            # now-resolved pings, then ensure the working indicator is up.
            await self._clear_input_pings(channel_id, agent_name)
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
        pass

    async def remove_agent_identity(self, agent_name: str) -> None:
        pass

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
        so Slack renders the person's display name. Unknown names (e.g. agents,
        or users we have not resolved) are left as plain text."""

        def _replace(match: re.Match[str]) -> str:
            username = match.group(1)
            user_id = self._username_to_id.get(username.casefold())
            return f"<@{user_id}>" if user_id else match.group(0)

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
        if stripped.startswith("!") and self._on_command:
            parts = stripped.split(None, 1)
            command = parts[0].lstrip("!")
            args = parts[1].strip() if len(parts) > 1 else ""
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

        # Slack encodes any @mentions in the slash text as `<@U…>`; normalise
        # them to `@name` so the command dispatcher's targeting (first @token →
        # target agent/role) resolves the same way it does for a typed command.
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
        return re.sub(r"<@(U[A-Z0-9]+)(?:\|[^>]+)?>", _replace_mention, message)

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
