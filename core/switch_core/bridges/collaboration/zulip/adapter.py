"""Zulip as a Switch messaging platform.

One bot, dialling out. The bot opens a Zulip event queue and long-polls it, so
the organization needs no public webhook address and Switch needs nothing
reachable from the internet for this platform.

**A stream is a room and a topic is a thread.** Zulip's own model is already
that shape — every message lives in a stream and a topic within it — so the
mapping is the platform's rather than one imposed on it. A message in the
default topic is top-level; a message in any other topic is a reply in that
thread. Renaming a topic on Zulip starts a new thread in Switch, because the
topic name is what both systems identify the thread by; the messages already
relayed stay in the old thread and the next reply opens the new one.

Everything an agent says arrives under one bot identity with the agent's name
and a stable mark at the head of the body: Zulip bots are separate accounts with
their own keys, and creating one per agent would need organization
administration the bridge does not have.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelType,
    DirectoryUser,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.zulip.chunking import MAX_MESSAGE, chunk_message
from switch_core.bridges.collaboration.zulip.http_client import (
    MAX_TOPIC_LENGTH,
    ZulipClient,
    ZulipError,
)

logger = logging.getLogger(__name__)

#: Reconnect delays for the event queue. A queue that expires is recovered at
#: once (that is the normal end of an idle hour, not a fault); anything else
#: waits, doubling, so an organization that is refusing us is not hammered.
_RETRY_MIN_SECONDS = 1.0
_RETRY_MAX_SECONDS = 30.0

#: A stable mark per agent, so a reader scanning a stream of messages from one
#: bot can tell the speakers apart at a glance. Derived from the identifier —
#: not configured, never salted, so it survives a restart and disagrees with no
#: other bridge.
_AGENT_MARKS = ("🟠", "🟣", "🟢", "🔵", "🟡", "🔴", "🟤", "⚫")

#: `@**Name**` (a mention) and `@_**Name**` (a silent one).
_MENTION = re.compile(r"@_?\*\*([^*\n]+)\*\*")
#: `#**Stream**` and `#**Stream>Topic**` — Zulip's stream links.
_STREAM_LINK = re.compile(r"#\*\*([^*\n>]+?)(?:>([^*\n]+))?\*\*")


class ZulipConnectionConfig(BridgeConnectionConfig):
    """What an operator types into Switch Console to connect one organization."""

    url: str = Field(
        description="Your Zulip organization's address, e.g. https://acme.zulipchat.com"
    )
    email: str = Field(
        description=(
            "The bot's Zulip address, e.g. switch-bot@acme.zulipchat.com — found "
            "in the bot's settings, not the person who created it"
        )
    )
    api_key: str = Field(
        description="The bot's API key, from the same Zulip bot settings"
    )
    default_topic: str = Field(
        default="Switch",
        description=(
            "Topic a message lands in when it is not a thread reply. Every room "
            "keeps this topic for its top-level conversation"
        ),
    )
    verify_tls: bool = Field(
        default=True,
        description="Verify the organization's TLS certificate. Turn off only for a self-hosted server with a private CA",
    )

    @field_validator("url")
    @classmethod
    def _organization(cls, value: str) -> str:
        cleaned = value.strip().rstrip("/")
        parsed = urlsplit(cleaned)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(
                "Give the organization's address, starting https:// — for example "
                "https://acme.zulipchat.com"
            )
        if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError(
                "Give only the organization's address: the bridge adds /api/v1 itself"
            )
        return cleaned

    @field_validator("email")
    @classmethod
    def _bot_address(cls, value: str) -> str:
        cleaned = value.strip()
        if "@" not in cleaned or cleaned.startswith("@") or cleaned.endswith("@"):
            raise ValueError(
                "Give the bot's full Zulip address, e.g. bot@acme.zulipchat.com"
            )
        return cleaned

    @field_validator("api_key")
    @classmethod
    def _key(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError(
                "Give the bot's API key. Zulip shows it once, in the bot's settings"
            )
        return cleaned

    @field_validator("default_topic")
    @classmethod
    def _topic(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Give a topic name; an empty one is not a topic")
        if len(cleaned) > MAX_TOPIC_LENGTH:
            raise ValueError(
                f"Zulip caps a topic at {MAX_TOPIC_LENGTH} characters; "
                f"this one is {len(cleaned)}"
            )
        if "\n" in cleaned:
            raise ValueError("A topic is one line; remove the line break")
        return cleaned


class ZulipAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Zulip"
    docs_slug: ClassVar[str | None] = "zulip"

    # The bot dials out: the event queue is opened by whichever pod holds the
    # bridge, and a quiet copy must not open a second one competing for events.
    keeps_quiet_unless_listening: ClassVar[bool] = True

    # A bot may create a stream by subscribing to it, where the organization
    # lets members create streams. Zulip refuses otherwise and says so.
    supports_channel_creation: ClassVar[bool] = True

    # `GET /users` lists the organization's members to any member, so somebody
    # who has never posted can still be found.
    supports_directory_search: ClassVar[bool] = True

    # Zulip linkifies http(s) only; a `switchdash://` target would arrive as
    # plain text, so the base rewrites Console links to https first.
    renders_custom_url_schemes: ClassVar[bool] = False

    # Deleting a room leaves the stream: archiving or deactivating one is an
    # organization-administrator action a bot does not have.
    channel_on_delete = "left"

    # Zulip mentions a whole stream with `@**all**`, which is what the server's
    # room-wide target becomes. No `@channel`-style word pages anyone by itself.
    channel_mention: ClassVar[str | None] = "@**all**"

    def __init__(self, *, config: ZulipConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._client: ZulipClient | None = None
        self._poll_task: asyncio.Task[None] | None = None
        self._stopping = False
        self._bot_user_id: str | None = None
        # stream id → channel type, learned from the queue registration. A
        # message event carries the stream id but not whether the stream is
        # private, and asking Zulip per message would double the traffic.
        self._stream_types: dict[str, ChannelType] = {}
        self._stream_names: dict[str, str] = {}

    # ── What Switch asks before a connection exists ──────────────────────────

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        url = connection_config.get("url")
        return [str(url)] if url else []

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Ask the organization who this bot is, so a wrong key fails here.

        Without this a mistyped API key looks like a saved connection and only
        surfaces when the first message is due, hours later.
        """
        config = ZulipConnectionConfig.model_validate(connection_config)
        client = ZulipClient(
            url=config.url,
            email=config.email,
            api_key=config.api_key,
            verify_tls=config.verify_tls,
        )
        try:
            await client.me()
        except ZulipError as exc:
            if exc.status in (401, 403):
                raise BridgeCredentialError(
                    f"Zulip refused these credentials: {exc.message}"
                ) from exc
            raise
        finally:
            await client.aclose()

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, ZulipError):
            return "auth_failed" if exc.status in (401, 403) else "platform_error"
        if isinstance(exc, httpx.HTTPError):
            return "network"
        return None

    # ── The connection ───────────────────────────────────────────────────────

    def _zulip(self) -> ZulipClient:
        if self._client is None:
            self._client = ZulipClient(
                url=self.config.url,
                email=self.config.email,
                api_key=self.config.api_key,
                verify_tls=self.config.verify_tls,
            )
        return self._client

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
        self._on_app_joined = on_app_joined
        if self.keeps_quiet_unless_listening and not self._listening:
            logger.info(
                "Zulip bridge %s is held by another pod; not opening an event queue here",
                self.config.url,
            )
            return
        self._stopping = False
        self._poll_task = asyncio.create_task(self._poll_events(), name="zulip-events")

    async def stop(self) -> None:
        self._stopping = True
        task, self._poll_task = self._poll_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    async def _poll_events(self) -> None:
        delay = _RETRY_MIN_SECONDS
        while not self._stopping:
            try:
                if self._bot_user_id is None:
                    # Needed to drop the bot's own posts, which Zulip delivers
                    # back over the queue like anybody else's.
                    self._bot_user_id = str(
                        (await self._zulip().me()).get("user_id") or ""
                    )
                registration = await self._zulip().register()
                self._remember_streams(registration)
                queue_id = str(registration.get("queue_id") or "")
                last_event_id = int(registration.get("last_event_id") or -1)
                if not queue_id:
                    raise ZulipError("Zulip opened an event queue without an id.")
                logger.info("Zulip event queue %s opened", queue_id)
                delay = _RETRY_MIN_SECONDS
                while not self._stopping:
                    body = await self._zulip().poll(queue_id, last_event_id)
                    for event in body.get("events") or []:
                        if not isinstance(event, dict):
                            continue
                        event_id = int(event.get("id") or -1)
                        if event_id <= last_event_id:
                            # A heartbeat repeats the id of the event before it.
                            continue
                        last_event_id = event_id
                        await self._handle_event(event)
            except asyncio.CancelledError:
                raise
            except ZulipError as exc:
                if self._stopping:
                    return
                if exc.code == "BAD_EVENT_QUEUE_ID":
                    # The normal end of an idle queue: open another at once.
                    continue
                logger.warning(
                    "Zulip event queue failed (%s): %s", exc.code, exc.message
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, _RETRY_MAX_SECONDS)
            except httpx.HTTPError as exc:
                if self._stopping:
                    return
                logger.warning("Lost the Zulip event queue: %s", exc)
                await asyncio.sleep(delay)
                delay = min(delay * 2, _RETRY_MAX_SECONDS)

    def _remember_streams(self, registration: dict[str, Any]) -> None:
        for stream in registration.get("subscriptions") or []:
            if not isinstance(stream, dict) or stream.get("stream_id") is None:
                continue
            stream_id = str(stream["stream_id"])
            self._stream_names[stream_id] = str(stream.get("name") or "")
            self._stream_types[stream_id] = (
                "channel_private" if stream.get("invite_only") else "channel_public"
            )

    async def _handle_event(self, event: dict[str, Any]) -> None:
        if event.get("type") != "message":
            # Heartbeats keep the queue alive and carry no news.
            return
        message = event.get("message")
        if isinstance(message, dict):
            await self._handle_message(message)

    async def _handle_message(self, message: dict[str, Any]) -> None:
        # Direct messages are not mapped: a Switch room is a stream, and a
        # conversation between two accounts has no stream to belong to.
        if message.get("type") != "stream":
            logger.debug("Ignoring a Zulip direct message; rooms are streams")
            return

        sender_id = str(message.get("sender_id") or "")
        sender_email = str(message.get("sender_email") or "").lower()
        if (self._bot_user_id and sender_id == self._bot_user_id) or (
            sender_email and sender_email == self.config.email.lower()
        ):
            # The bridge's own posts, which Zulip delivers back over the queue.
            return

        stream_id = message.get("stream_id")
        if stream_id is None:
            return
        channel_id = str(stream_id)
        topic = str(message.get("subject") or "")
        content = self.translate_inbound(str(message.get("content") or ""))
        sender_name = str(
            message.get("sender_full_name") or message.get("sender_email") or sender_id
        )
        attachments, failures = await self._inbound_attachments(message)
        root_id = topic if topic and topic != self.config.default_topic else None
        channel_type = self._stream_types.get(channel_id, "channel_public")

        stripped = content.strip()
        if stripped.startswith("!") and self._on_command:
            parts = stripped.split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    command=parts[0].lstrip("!"),
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=str(message.get("id") or "") or None,
                    root_id=root_id,
                    channel_name=self._stream_names.get(channel_id),
                )
            )
            return

        if self._on_message is None:
            return
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=sender_id,
                sender_name=sender_name,
                content=content,
                message_ref=str(message.get("id") or ""),
                root_id=root_id,
                channel_name=self._stream_names.get(channel_id),
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    async def _inbound_attachments(
        self, message: dict[str, Any]
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Fetch whatever came with the message, refusing oversize files aloud."""
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for item in message.get("attachments") or []:
            if not isinstance(item, dict):
                continue
            filename = str(item.get("file_name") or "attachment")
            try:
                declared = int(item.get("file_size") or 0)
            except (TypeError, ValueError):
                declared = 0
            if declared > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=(
                            f"the file is {declared} bytes, over this deployment's "
                            f"{self._max_attachment_bytes}-byte limit"
                        ),
                    )
                )
                continue
            url = str(item.get("url") or "")
            if not url:
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason="Zulip gave no download address"
                    )
                )
                continue
            try:
                data = await self._zulip().download(url)
            except (ZulipError, httpx.HTTPError) as exc:
                failures.append(
                    AttachmentFailure(
                        filename=filename, reason=f"the download failed: {exc}"
                    )
                )
                continue
            if len(data) > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=filename,
                        reason=(
                            f"the file is {len(data)} bytes, over this deployment's "
                            f"{self._max_attachment_bytes}-byte limit"
                        ),
                    )
                )
                continue
            attachments.append(
                Attachment(
                    filename=filename,
                    mimetype=str(item.get("mimetype") or "application/octet-stream"),
                    data=data,
                )
            )
        return attachments, failures

    # ── Posting ──────────────────────────────────────────────────────────────

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as the bot, with the agent's mark and name at the head.

        Zulip gives a bot no per-message identity, so the name is part of the
        body — the same degradation Telegram and Discord-in-DMs make.
        """
        agent = await self.agent_rendering(sender_name)
        text = (
            self.render_room_wide_mention(content)
            if room_wide_mention
            else self.translate_outbound(content)
        )
        body = self._attribute(sender_name, agent.body_label, text)
        refs = await self._post(channel_id, body, thread_root_id)
        return refs[0] if refs else None

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
        """Upload the bytes to the organization and link them from the message.

        Zulip attaches a file by uploading it and putting its `/user_uploads`
        path in the body, so a file arrives as a link the reader can open (and
        as a preview, for an image) rather than as bytes on the message.
        """
        agent = await self.agent_rendering(sender_name)
        uri = await self._zulip().upload(
            filename=filename, mimetype=mimetype, data=data
        )
        link = f"[{filename}]({uri})"
        caption_text = self.translate_outbound(caption or "")
        text = f"{caption_text}\n\n{link}" if caption_text else link
        body = self._attribute(sender_name, agent.body_label, text)
        refs = await self._post(channel_id, body, thread_root_id)
        return refs[0] if refs else None

    async def _post(
        self, channel_id: str, body: str, thread_root_id: str | None
    ) -> list[str]:
        topic = self._topic_for(thread_root_id)
        stream_id = self._stream_id(channel_id)
        refs: list[str] = []
        for piece in chunk_message(body):
            refs.append(
                await self._zulip().send_stream_message(
                    stream_id=stream_id, topic=topic, content=piece
                )
            )
        return refs

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._zulip().update_message(
            message_ref, self.translate_outbound(new_content)
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._zulip().delete_message(message_ref)

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # Zulip expires the indicator itself; only starting it needs a call.
        if not is_typing:
            return
        await self._zulip().start_typing(
            stream_id=self._stream_id(channel_id), topic=self.config.default_topic
        )

    # ── Rooms ────────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        """Create a stream (or join the one already named that) and return its id.

        Zulip creates a stream when the bot subscribes to a name it does not
        have. Whether that is allowed is the organization's decision — members
        can normally do it, a restricted organization cannot — and its refusal
        is passed on rather than guessed at.
        """
        stream = name.strip()
        if not stream:
            raise BridgeOperationError("A Zulip stream needs a name.")
        try:
            body = await self._zulip().subscribe(
                stream=stream,
                description=topic,
                invite_only=channel_type == "channel_private",
            )
        except ZulipError as exc:
            raise BridgeOperationError(
                f"Zulip refused the new stream: {exc.message}"
            ) from exc
        for section in ("subscribed", "already_subscribed"):
            entries = body.get(section)
            if isinstance(entries, dict):
                entry = entries.get(stream)
                if isinstance(entry, dict) and entry.get("stream_id") is not None:
                    stream_id = str(entry["stream_id"])
                    self._stream_names[stream_id] = stream
                    self._stream_types[stream_id] = channel_type
                    return stream_id
        found = await self._zulip().stream_by_name(stream)
        return str(found.get("stream_id"))

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """Leave the stream when the room is deleted.

        A bot cannot archive or deactivate a stream, but it can unsubscribe,
        which is the part of "the room is gone" it is able to carry out.
        """
        try:
            info = await self._zulip().stream(self._stream_id(external_channel_id))
            await self._zulip().unsubscribe(str(info.get("name") or ""))
        except (ZulipError, httpx.HTTPError) as exc:
            return RetireOutcome.failed(f"Zulip would not unsubscribe the bot: {exc}")
        return RetireOutcome(outcome="left")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        info = await self._zulip().stream(self._stream_id(channel_id))
        return "channel_private" if info.get("invite_only") else "channel_public"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # One bot posts for every agent, so there is no per-agent membership to
        # grant. The agent's name travels in the body instead.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        principals = [
            int(external_id)
            for external_id in user_external_ids
            if str(external_id).lstrip("-").isdigit()
        ]
        if not principals:
            return list(user_external_ids)
        try:
            info = await self._zulip().stream(self._stream_id(channel_id))
            await self._zulip().subscribe(
                stream=str(info.get("name") or ""), principals=principals
            )
        except (ZulipError, httpx.HTTPError) as exc:
            # Usually a bot without permission to subscribe other people, which
            # an organization grants deliberately. Report who was left out so
            # the room can say so, rather than failing the whole room.
            logger.warning(
                "Could not add %s to Zulip stream %s: %s",
                ", ".join(user_names) or "users",
                channel_id,
                exc,
            )
            return list(user_external_ids)
        return []

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        info = await self._zulip().stream(self._stream_id(external_channel_id))
        name = str(info.get("name") or "")
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        return f"{self.config.url}/#narrow/stream/{info.get('stream_id')}-{slug}"

    async def home_deeplink(self) -> str | None:
        return f"{self.config.url}/"

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # A Zulip bot is an account with its own credentials; making one per
        # agent needs organization administration the bridge does not have.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    # ── People ───────────────────────────────────────────────────────────────

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """Search the organization's members.

        Possible because `GET /users` lists them to any member — unlike a
        platform where the bot only ever sees people who spoke to it.
        """
        needle = query.strip().lower()
        found: list[DirectoryUser] = []
        for member in await self._zulip().users():
            if member.get("is_bot") or member.get("is_active") is False:
                continue
            name = str(member.get("full_name") or "")
            email = str(member.get("email") or "")
            if needle and needle not in name.lower() and needle not in email.lower():
                continue
            found.append(
                DirectoryUser(
                    external_user_id=str(member.get("user_id") or ""),
                    username=email or name,
                    display_name=name or email,
                    email=email or None,
                )
            )
            if len(found) >= 50:
                break
        return found

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        """Zulip renders CommonMark, which is what Switch bodies already are.

        The one Zulip form that pages a stream is `@**all**`, and it is added by
        `render_room_wide_mention` for a message the server marked — never by
        ordinary body text, which the base defuses.
        """
        return content

    def translate_inbound(self, raw_message: str) -> str:
        """Zulip Markdown → Switch Markdown.

        The two are close enough that only the forms Zulip adds need reading:
        `@**Ada**` mentions and `#**Stream>Topic**` links, neither of which
        Switch would resolve or display the way the sender meant.
        """

        def _stream(match: re.Match[str]) -> str:
            stream, topic = match.group(1), match.group(2)
            return f"#{stream} > {topic}" if topic else f"#{stream}"

        return _MENTION.sub(
            lambda match: f"@{match.group(1)}",
            _STREAM_LINK.sub(_stream, raw_message),
        )

    def render_app_mention(self, token: str) -> str:
        return f"@**{token}**"

    # ── Small helpers ────────────────────────────────────────────────────────

    @classmethod
    def _mark(cls, sender_name: str) -> str:
        digest = hashlib.blake2b(sender_name.encode("utf-8"), digest_size=8).digest()
        return _AGENT_MARKS[digest[0] % len(_AGENT_MARKS)]

    @classmethod
    def _attribute(cls, sender_name: str, label: str, content: str) -> str:
        head = f"{cls._mark(sender_name)} **{label}**"
        if not content:
            return head
        return f"{head}\n\n{content}"

    def _stream_id(self, channel_id: str) -> str:
        if not str(channel_id).isdigit():
            raise BridgeOperationError(
                f"{channel_id!r} is not a Zulip stream id; this bridge's rooms are streams"
            )
        return str(channel_id)

    def _topic_for(self, thread_root_id: str | None) -> str:
        topic = (thread_root_id or "").strip() or self.config.default_topic
        # Zulip refuses a topic over its cap outright, so a long thread name is
        # cut here where the reason is still visible.
        return topic[:MAX_TOPIC_LENGTH]


__all__ = [
    "MAX_MESSAGE",
    "ZulipAdapter",
    "ZulipConnectionConfig",
]
