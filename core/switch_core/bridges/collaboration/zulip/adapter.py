"""Zulip: one bot in the person's own organization, self-created.

The person creates a generic bot in their Zulip organization and gives Switch
its email and API key. Switch hears the organization through Zulip's event
queue — long polling, so no public address is needed — and posts through the
REST API as that one bot.

A stream is a room and each of its topics is a thread. Every Zulip message has
a topic, so the first message of a topic is the thread's root and the rest of
the topic are replies to it. Nothing about that is remembered here: a thread's
topic is read back from its root message whenever it is needed, so any pod can
post into any thread.

Zulip gives a bot no per-message name or avatar, so every agent posts as the one
bot with its name at the head of the message, as on Telegram. People are told
apart by their Zulip user id: Zulip hides members' real email addresses by
default, so the email one person sees for another is not theirs to match on.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    ActivityMarkRefused,
    AgentIdentity,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelRetirement,
    ChannelType,
    CreatedChannel,
    DirectoryUser,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers.neutral import request_summary
from switch_core.outbound import OutboundPolicy, guarded_async_client

logger = logging.getLogger(__name__)

# Zulip holds a long poll open for about 90 seconds before it answers with a
# heartbeat, so a read must be allowed to wait longer than that.
_POLL_TIMEOUT = httpx.Timeout(30.0, read=120.0)
# How long to wait before asking again after the server could not be reached.
_RETRY_SECONDS = 5.0
# How many unread messages are relayed at a time after a queue is made.
_UNREAD_PAGE = 100

DIRECT_MESSAGE_ANSWER = (
    "I only work in streams. Write in a stream Switch is in, and mention an "
    "agent there to ask it something."
)
# Zulip's defaults; the server's own figures replace them once the queue is registered.
_DEFAULT_MESSAGE_LIMIT = 10_000
_DEFAULT_TOPIC_LIMIT = 60
# Room left in a message for the agent's name at its head, so a card or a
# turn drawn to `rich_fallback_limit` is still one message once it is named.
_LABEL_ROOM = 200
# What an edit too long for one message ends with: the post it edits was
# split, and an edit reaches only its first part.
EDIT_CUT_MARKER = "\n\n_… cut to fit one Zulip message._"
# The topic of an agent's post that starts a conversation and says nothing to
# name it by: Zulip refuses a stream message without a topic.
NEW_CONVERSATION_TOPIC = "Switch"
# How long a stream's privacy is trusted before it is asked again.
_STREAM_TYPE_TTL_SECONDS = 300.0
# Redirects followed to fetch an upload: a server storing files in S3
# answers the temporary link with one, to the object.
_MAX_DOWNLOAD_REDIRECTS = 5
# What each work mark is drawn as. One account may hold several reactions on a
# message, so a prompt still waiting and one being worked on are told apart.
_ACTIVITY_EMOJI: dict[ActivityMark, str] = {"working": "eyes", "queued": "hourglass"}
# What adding a reaction already there, or removing one that is not, answers:
# the mark is as asked either way.
_REACTION_AS_ASKED = ("REACTION_ALREADY_EXISTS", "REACTION_DOES_NOT_EXIST")
# A file a person attached, as Zulip writes its link into the message.
_UPLOAD_LINK = re.compile(r"\[([^\]]*)\]\(/user_uploads/([^)\s]+)\)")
# `@**name**` and `@_**name**` (silent), each optionally `|user_id`.
_MENTION = re.compile(r"@_?\*\*([^*|]+)(?:\|\d+)?\*\*")
# The mentions that notify everyone in a stream or topic.
_MASS_MENTION = re.compile(
    r"@_?\*\*(all|everyone|stream|channel|topic)\*\*", re.IGNORECASE
)
_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")
# Zulip error codes that ask to be tried again rather than refuse for good.
_TRANSIENT_CODES = ("RATE_LIMIT_HIT", "NOT_JSON")


class ZulipError(Exception):
    """An error answer from Zulip's API: its `code` and its own explanation."""

    def __init__(self, code: str, msg: str) -> None:
        super().__init__(f"{code}: {msg}")
        self.code = code
        self.msg = msg


class ZulipConnectionConfig(BridgeConnectionConfig):
    server_url: str = Field(
        title="Server URL",
        description="Your Zulip organization's address, for example https://chat.example.com.",
    )
    bot_email: str = Field(
        title="Bot email",
        description="The email Zulip shows for the bot, under Personal settings, Bots.",
    )
    api_key: str = Field(
        title="Bot API key",
        description="The bot's API key, from the same page.",
    )

    @field_validator("server_url")
    @classmethod
    def _an_https_origin(cls, value: str) -> str:
        """An https origin with nothing after it; plain http only on this machine."""
        parts = urlsplit(value.strip())
        host = parts.hostname or ""
        loopback = host in _LOOPBACK_HOSTS or host.endswith(".localhost")
        if parts.scheme != "https" and not (parts.scheme == "http" and loopback):
            raise ValueError("The server URL must start with https://.")
        if not host or parts.path.strip("/") or parts.query or parts.fragment:
            raise ValueError(
                "The server URL is the organization's address alone, with no path."
            )
        if parts.username is not None or parts.password is not None:
            raise ValueError(
                "The server URL must not carry a user name or password; the bot's "
                "email and API key go in their own fields."
            )
        netloc = f"[{host}]" if ":" in host else host
        if parts.port is not None:
            netloc = f"{netloc}:{parts.port}"
        return f"{parts.scheme}://{netloc}"


class ZulipAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Zulip"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # A generic bot cannot archive a stream, and the people in it keep its history.
    channel_on_delete: ClassVar[ChannelRetirement] = "left"
    supports_directory_search: ClassVar[bool] = True
    # Zulip links only web addresses, so a Console deeplink would arrive as text.
    renders_custom_url_schemes: ClassVar[bool] = False
    # Turns, and the approval and question cards they wait on, are drawn as
    # the base's text: Zulip gives a bot no buttons, so a card is answered by
    # typing what it says.
    draws_session_activity: ClassVar[bool] = True
    supports_activity_reactions: ClassVar[bool] = True
    supports_queue_reaction: ClassVar[bool] = True

    def __init__(self, *, config: ZulipConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._http = _client(config)
        self._bot_user_id: int | None = None
        self._bot_name = ""
        self._message_limit = _DEFAULT_MESSAGE_LIMIT
        self._topic_limit = _DEFAULT_TOPIC_LIMIT
        self._started = False
        self._listener: asyncio.Task[None] | None = None
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        # The names of people this process has relayed, by Zulip user id, to
        # name whoever answers a card. Safe to lose: the card then names the
        # person's Switch identity instead.
        self._names: dict[str, str] = {}
        # Each stream's privacy and when it was read, so relaying a message
        # does not ask Zulip about its stream every time.
        self._stream_types: dict[str, tuple[ChannelType, float]] = {}

    # ── Who we are ───────────────────────────────────────────────────────────

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = ZulipConnectionConfig.model_validate(connection_config)
        async with _client(config) as http:
            try:
                me = await _call(http, "GET", "/api/v1/users/me")
            except ZulipError as exc:
                raise BridgeCredentialError(
                    f"Zulip refused the bot: {exc.msg}"
                ) from exc
            except httpx.HTTPError as exc:
                raise BridgeCredentialError(
                    f"Could not reach Zulip at {config.server_url}: {exc}"
                ) from exc
        if not me.get("is_bot"):
            raise BridgeCredentialError(
                "These are a person's credentials, not a bot's. Create a generic bot "
                "under Personal settings, Bots, and use its email and API key."
            )

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        return [ZulipConnectionConfig.model_validate(connection_config).server_url]

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, ZulipError):
            return "auth_failed" if exc.code == "UNAUTHORIZED" else "platform_error"
        if isinstance(exc, httpx.TransportError):
            return "network"
        return None

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
        try:
            me = await self._call("GET", "/api/v1/users/me")
        except BaseException:
            await self._http.aclose()
            raise
        self._bot_user_id = int(me["user_id"])
        self._bot_name = str(me["full_name"])
        self._started = True
        if self._listening:
            self._start_listener()

    def set_listening(self, listening: bool) -> None:
        """Before `start` as the base has it, and after it too: the listener
        starts or stops with the change, so the bot is never left deaf by the
        order the two were called in."""
        super().set_listening(listening)
        if not self._started:
            return
        if listening:
            self._start_listener()
        elif self._listener is not None:
            self._listener.cancel()
            self._listener = None

    def _start_listener(self) -> None:
        if self._listener is None or self._listener.done():
            self._listener = asyncio.create_task(self._listen())

    async def stop(self) -> None:
        self._started = False
        if self._listener is not None:
            self._listener.cancel()
            try:
                await self._listener
            except asyncio.CancelledError:
                pass
            self._listener = None
        await self._http.aclose()

    async def _listen(self) -> None:
        """Hear the organization through one event queue, made again when it lapses.

        What reaches the bot while no queue is open (Switch restarting, the
        bridge moving to another pod, a queue Zulip dropped with
        `BAD_EVENT_QUEUE_ID`) is still unread for the bot, so every new queue
        starts by relaying the bot's unread messages. Each message is marked
        read once it is relayed, on Zulip's side, so this needs no state of
        its own and holds across pods and restarts. One heard both ways is
        dropped by its `message_ref`, Zulip's own message id.

        A queue is used only once the backlog has been relayed through it, so
        a backlog cut short by a failure Zulip may not repeat (the server out
        of reach, a rate limit) is relayed again, from a new queue, rather
        than left unread for good. A message that fails for any other reason
        is logged and left unread, and the rest are relayed past it.
        """
        queue_id: str | None = None
        last_event_id = -1
        while True:
            try:
                if queue_id is None:
                    registered = await self._call(
                        "POST",
                        "/api/v1/register",
                        data={
                            "event_types": json.dumps(["message"]),
                            "apply_markdown": "false",
                        },
                    )
                    self._message_limit = int(
                        registered.get("max_message_length", _DEFAULT_MESSAGE_LIMIT)
                    )
                    self._topic_limit = int(
                        registered.get("max_topic_length", _DEFAULT_TOPIC_LIMIT)
                    )
                    await self._relay_unread()
                    queue_id = str(registered["queue_id"])
                    last_event_id = int(registered["last_event_id"])
                answer = await self._call(
                    "GET",
                    "/api/v1/events",
                    params={"queue_id": queue_id, "last_event_id": last_event_id},
                    timeout=_POLL_TIMEOUT,
                )
                last_event_id = await self._relay_events(
                    answer.get("events", []), last_event_id
                )
            except asyncio.CancelledError:
                raise
            except ZulipError as exc:
                if exc.code == "BAD_EVENT_QUEUE_ID":
                    queue_id = None
                    continue
                logger.error("Zulip refused the event queue: %s", exc)
                await asyncio.sleep(_RETRY_SECONDS)
            except httpx.HTTPError as exc:
                logger.warning("Zulip could not be reached, asking again: %s", exc)
                await asyncio.sleep(_RETRY_SECONDS)
            except Exception:
                logger.exception("The Zulip event queue failed, asking again")
                await asyncio.sleep(_RETRY_SECONDS)

    async def _relay_events(
        self, events: list[dict[str, Any]], last_event_id: int
    ) -> int:
        """Relay one poll's events, marking each relayed message read.

        Answers the id of the last event dealt with. A failure worth trying
        again stops there, so the next poll asks Zulip for that event again.
        """
        relayed: list[int] = []
        try:
            for event in events:
                if event.get("type") == "message":
                    message = event["message"]
                    if await self._relay_one(message, event.get("flags", [])):
                        relayed.append(int(message["id"]))
                last_event_id = max(last_event_id, int(event["id"]))
        finally:
            await self._mark_read(relayed)
        return last_event_id

    async def _relay_unread(self) -> None:
        """Relay, oldest first, what reached the bot while it was not listening.

        Each page starts after the last message of the one before, so a
        message left unread because it failed is not read back forever.
        """
        anchor = "first_unread"
        while True:
            answer = await self._call(
                "GET",
                "/api/v1/messages",
                params={
                    "anchor": anchor,
                    "include_anchor": json.dumps(anchor == "first_unread"),
                    "num_before": "0",
                    "num_after": str(_UNREAD_PAGE),
                    "apply_markdown": "false",
                    "narrow": json.dumps([{"operator": "is", "operand": "unread"}]),
                },
            )
            messages = answer.get("messages", [])
            relayed: list[int] = []
            try:
                for message in messages:
                    if await self._relay_one(message, message.get("flags", [])):
                        relayed.append(int(message["id"]))
            finally:
                await self._mark_read(relayed)
            if len(messages) < _UNREAD_PAGE:
                return
            anchor = str(messages[-1]["id"])

    async def _relay_one(self, message: dict[str, Any], flags: list[str]) -> bool:
        """Relay one message: True once it is dealt with and can be marked read.

        A failure Zulip may not repeat is raised, for the caller to come back
        to the message. Any other is logged and the message is left unread,
        so one bad message does not hold up those after it.
        """
        try:
            await self._relay(message, flags)
        except Exception as exc:
            if _transient(exc):
                raise
            logger.exception(
                "Zulip message %s could not be relayed; it is left unread",
                message.get("id"),
            )
            return False
        return True

    async def _answer_direct_message(self, sender_id: int) -> None:
        """Tell someone who wrote to the bot directly where Switch listens.

        A room is a stream, so a direct message has no room to reach; it is
        answered rather than dropped, so the sender is not left waiting. Not
        to another bot, which could answer back and keep the two talking.
        """
        sender = await self._call("GET", f"/api/v1/users/{sender_id}")
        if sender["user"].get("is_bot"):
            return
        await self._call(
            "POST",
            "/api/v1/messages",
            data={
                "type": "direct",
                "to": json.dumps([sender_id]),
                "content": DIRECT_MESSAGE_ANSWER,
            },
        )

    async def _mark_read(self, message_ids: list[int]) -> None:
        if message_ids:
            await self._call(
                "POST",
                "/api/v1/messages/flags",
                data={"messages": json.dumps(message_ids), "op": "add", "flag": "read"},
            )

    async def _relay(self, message: dict[str, Any], flags: list[str]) -> None:
        if self._on_message is None or message.get("sender_id") == self._bot_user_id:
            return
        if message.get("type") != "stream":
            await self._answer_direct_message(int(message["sender_id"]))
            return
        stream_id = str(message["stream_id"])
        root, channel_type = await asyncio.gather(
            self._topic_root(stream_id, str(message["subject"])),
            self._stream_type(stream_id),
        )
        message_id = str(message["id"])
        root_id = None if root == message_id else root
        channel_name = str(message.get("display_recipient") or "") or None
        self._names[str(message["sender_id"])] = str(message["sender_full_name"])
        raw = str(message["content"])
        content = self.translate_inbound(raw)
        if content.strip().startswith("!") and self._on_command is not None:
            command, _, args = content.strip()[1:].partition(" ")
            await self._on_command(
                InboundCommand(
                    channel_id=stream_id,
                    channel_type=channel_type,
                    sender_id=str(message["sender_id"]),
                    sender_name=str(message["sender_full_name"]),
                    command=command,
                    args=args.strip(),
                    message_ref=message_id,
                    root_id=root_id,
                    channel_name=channel_name,
                )
            )
            return
        attachments, attachment_failures = await self._attachments(raw)
        await self._on_message(
            InboundMessage(
                channel_id=stream_id,
                channel_type=channel_type,
                sender_id=str(message["sender_id"]),
                sender_name=str(message["sender_full_name"]),
                content=content,
                message_ref=message_id,
                root_id=root_id,
                channel_name=channel_name,
                attachments=attachments,
                attachment_failures=attachment_failures,
                self_mention_token=(
                    self._bot_name
                    if "mentioned" in flags and self._mentions_bot(message["content"])
                    else None
                ),
            )
        )

    async def _attachments(
        self, content: str
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """The files a message links to, fetched through the bot's own access.

        One too large to relay, or that cannot be fetched, is reported rather
        than dropped, so the room says what it is missing.
        """
        links = _UPLOAD_LINK.findall(content)
        if not links:
            return [], []
        attachments: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        async with _download_client(self.outbound_policy) as download:
            for name, path in links:
                filename = name or path.rsplit("/", 1)[-1]
                try:
                    grant = await self._call("GET", f"/api/v1/user_uploads/{path}")
                    fetched = await self._download(
                        download, urljoin(self._config.server_url, str(grant["url"]))
                    )
                except (ZulipError, httpx.HTTPError, ValueError) as exc:
                    failures.append(
                        AttachmentFailure(
                            filename=filename,
                            reason=f"Zulip did not hand it over: {exc}",
                        )
                    )
                    continue
                if fetched is None:
                    failures.append(
                        AttachmentFailure(
                            filename=filename,
                            reason=f"larger than the {self._max_attachment_bytes // (1024 * 1024)} MiB Switch relays",
                        )
                    )
                    continue
                data, mimetype = fetched
                attachments.append(
                    Attachment(filename=filename, mimetype=mimetype, data=data)
                )
        return attachments, failures

    async def _download(
        self, client: httpx.AsyncClient, url: str
    ) -> tuple[bytes, str] | None:
        """A file's bytes and type, or None once it outgrows what Switch relays.

        The size is enforced while reading, so an oversize file is not pulled
        down whole first. The link Zulip grants is temporary and needs no
        credentials, so none are sent with it, nor to wherever it redirects.
        """
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            declared = response.headers.get("content-length")
            if declared is not None and int(declared) > self._max_attachment_bytes:
                return None
            chunks: list[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > self._max_attachment_bytes:
                    return None
                chunks.append(chunk)
            mimetype = response.headers.get("content-type", "application/octet-stream")
        return b"".join(chunks), mimetype

    def _mentions_bot(self, content: str) -> bool:
        return any(name == self._bot_name for name in _MENTION.findall(content))

    # ── Threads ──────────────────────────────────────────────────────────────

    async def _topic_root(self, stream_id: str, topic: str) -> str:
        """The id of a topic's first message: the root of the thread it is."""
        answer = await self._call(
            "GET",
            "/api/v1/messages",
            params={
                "anchor": "oldest",
                "num_before": "0",
                "num_after": "1",
                "narrow": json.dumps(
                    [
                        {"operator": "channel", "operand": int(stream_id)},
                        {"operator": "topic", "operand": topic},
                    ]
                ),
            },
        )
        messages = answer.get("messages", [])
        if not messages:
            raise BridgeOperationError(f"Zulip has no message in topic {topic!r}.")
        return str(messages[0]["id"])

    async def _topic_of(self, message_ref: str) -> str:
        """The topic a message is in, read back from Zulip rather than remembered."""
        answer = await self._call("GET", f"/api/v1/messages/{message_ref}")
        return str(answer["message"]["subject"])

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
        """Post as the bot with the agent's name at the head, split at Zulip's limit.

        The reference returned is the first part's, so an edit or a delete of
        the post reaches the part that carries the name.

        A post that starts a conversation gets a topic of its own, named after
        its first line, so it is the root of its own thread: in one shared
        topic every such post would be read back as replies to the first.
        """
        topic = (
            await self._topic_of(thread_root_id)
            if thread_root_id is not None
            else _new_topic(content, self._topic_limit)
        )
        body = await self._labelled(sender_name, content, room_wide_mention)
        first: str | None = None
        for part in _split(body, self._message_limit):
            sent = await self._call(
                "POST",
                "/api/v1/messages",
                data={
                    "type": "stream",
                    "to": channel_id,
                    "topic": topic,
                    "content": part,
                },
            )
            first = first or str(sent["id"])
        return first

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
        """Upload the file to Zulip and post a link to it, as Zulip's own clients do.

        A file Zulip refuses, one over the organization's upload limit say, is
        named in the post with Zulip's reason instead.
        """
        try:
            uploaded = await self._call(
                "POST",
                "/api/v1/user_uploads",
                files={"file": (filename, data, mimetype)},
            )
        except ZulipError as exc:
            note = f"_sent {filename}, which Zulip would not take: {exc.msg}_"
            body = f"{caption}\n{note}" if caption else note
            return await self.send_message(
                channel_id, sender_name, body, thread_root_id
            )
        link = f"[{filename}]({uploaded['url']})"
        body = f"{caption}\n{link}" if caption else link
        return await self.send_message(channel_id, sender_name, body, thread_root_id)

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
        """One reaction per mark through the one bot, whichever agent it is for.

        Adding a mark already there, or removing one that is not, leaves the
        message as asked, which is what a restart's reconciliation (`force`)
        relies on. Anything else Zulip refuses, it will refuse again.
        """
        emoji = _ACTIVITY_EMOJI[mark]
        path = f"/api/v1/messages/{message_ref}/reactions"
        try:
            if on:
                await self._call("POST", path, data={"emoji_name": emoji})
            else:
                await self._call("DELETE", path, params={"emoji_name": emoji})
        except ZulipError as exc:
            if exc.code in _REACTION_AS_ASKED:
                return
            raise ActivityMarkRefused(
                f"Zulip refused to {'add' if on else 'remove'} the {mark} reaction on "
                f"{message_ref}: {exc.msg}"
            ) from exc

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._edit(
            message_ref,
            self.defuse_mass_mentions(self._render_outbound(new_content)),
        )

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a card or a turn with the agent's name at its head again.

        One bot posts for every agent, so the name is part of the message: an
        edit without it would read as the bot's own words, or another agent's.
        """
        text = self.rich_fallback_text(content)
        try:
            await self._edit(
                message_ref,
                await self._labelled(agent_name, text, room_wide_mention=False),
            )
        except Exception as error:
            raise RichContentFailed(
                f"Zulip could not update message {message_ref} in stream "
                f"{channel_id}: {error}",
                text=text,
            ) from error

    async def _labelled(
        self, agent_name: str, content: str, room_wide_mention: bool
    ) -> str:
        """`content` as the agent says it: its name at the head, and a mass
        mention defused unless the post is meant for the whole room."""
        agent = await self.agent_rendering(agent_name)
        body = self._render_outbound(content)
        if not room_wide_mention:
            body = self.defuse_mass_mentions(body)
        return f"**{agent.body_label}:** {body}"

    async def _edit(self, message_ref: str, content: str) -> None:
        """Rewrite a message, cut visibly where it outgrows one message.

        An edit reaches one message, and a post too long for one was split,
        so what does not fit is cut with a note saying so rather than dropped
        without one.
        """
        if len(content) > self._message_limit:
            logger.warning(
                "An edit to Zulip message %s is %d characters, over the %d one "
                "message holds; it is cut to fit",
                message_ref,
                len(content),
                self._message_limit,
            )
            content = (
                content[: self._message_limit - len(EDIT_CUT_MARKER)] + EDIT_CUT_MARKER
            )
        await self._call(
            "PATCH", f"/api/v1/messages/{message_ref}", data={"content": content}
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._call("DELETE", f"/api/v1/messages/{message_ref}")

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """Nothing: Zulip shows typing only within a topic, and this names none."""
        return None

    def rich_fallback_limit(self) -> int:
        return self._message_limit - _LABEL_ROOM

    def rich_fallback_text(self, content: RichContent) -> str:
        """The base's text, with whoever answered a card named as Zulip names them.

        A silent mention, so it links the person without notifying them again.
        """
        if not isinstance(content, RequestCard):
            return super().rich_fallback_text(content)
        name = self._names.get(content.responder_external_id or "")
        return request_summary(
            content.request,
            content.reference,
            escape=self._rich_escape,
            limit=self.rich_fallback_limit(),
            markup=self.rich_markup(),
            responder=f"@_**{name}|{content.responder_external_id}**" if name else None,
            unavailable_reason=content.unavailable_reason,
        )

    # ── Streams ──────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        try:
            await self._call(
                "POST",
                "/api/v1/users/me/subscriptions",
                data={
                    "subscriptions": json.dumps([{"name": name, "description": topic}]),
                    "invite_only": json.dumps(channel_type == "channel_private"),
                },
            )
            found = await self._call(
                "GET", "/api/v1/get_stream_id", params={"stream": name}
            )
        except ZulipError as exc:
            raise BridgeOperationError(
                f"Zulip would not create the stream {name!r}: {exc.msg}"
            ) from exc
        return CreatedChannel(id=str(found["stream_id"]), name=name)

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        """Unsubscribe the bot from the stream, which stays with its people."""
        try:
            stream = await self._call("GET", f"/api/v1/streams/{external_channel_id}")
            await self._call(
                "DELETE",
                "/api/v1/users/me/subscriptions",
                params={"subscriptions": json.dumps([stream["stream"]["name"]])},
            )
        except (ZulipError, httpx.HTTPError) as exc:
            return RetireOutcome.failed(
                f"Zulip did not let the bot leave the stream: {exc}"
            )
        return RetireOutcome(outcome="left")

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        stream = await self._call("GET", f"/api/v1/streams/{channel_id}")
        channel_type: ChannelType = (
            "channel_private" if stream["stream"]["invite_only"] else "channel_public"
        )
        self._stream_types[channel_id] = (channel_type, time.monotonic())
        return channel_type

    async def _stream_type(self, channel_id: str) -> ChannelType:
        """`get_channel_type`, trusted for a few minutes: a stream's privacy
        rarely changes, and relaying a message should not ask every time."""
        cached = self._stream_types.get(channel_id)
        if (
            cached is not None
            and time.monotonic() - cached[1] < _STREAM_TYPE_TTL_SECONDS
        ):
            return cached[0]
        return await self.get_channel_type(channel_id)

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        """Nothing: every agent speaks through the one bot, already in the stream."""
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        stream = await self._call("GET", f"/api/v1/streams/{channel_id}")
        left_out: list[str] = []
        for external_id in user_external_ids:
            try:
                await self._call(
                    "POST",
                    "/api/v1/users/me/subscriptions",
                    data={
                        "subscriptions": json.dumps(
                            [{"name": stream["stream"]["name"]}]
                        ),
                        "principals": json.dumps([int(external_id)]),
                    },
                )
            except (ZulipError, ValueError) as exc:
                logger.warning(
                    "Could not add Zulip user %s to a stream: %s", external_id, exc
                )
                left_out.append(external_id)
        return left_out

    async def search_directory_users(self, query: str) -> list[DirectoryUser]:
        """The organization's people whose name contains `query`, ignoring case.

        Zulip has no search by name for a bot, so this filters the member
        list, which an organization keeps small enough to read whole. A person
        is named as a message from them is relayed: by user id and full name.
        Zulip hides people's addresses from a bot, so no email is offered.
        """
        term = query.strip().casefold()
        if not term:
            return []
        try:
            answer = await self._call("GET", "/api/v1/users")
        except ZulipError as exc:
            raise BridgeOperationError(
                f"Zulip would not list its members: {exc.msg}"
            ) from exc
        found = [
            DirectoryUser(
                external_user_id=str(member["user_id"]),
                username=str(member["full_name"]),
                display_name=str(member["full_name"]),
                email=None,
            )
            for member in answer["members"]
            if not member["is_bot"]
            and member["is_active"]
            and term in str(member["full_name"]).casefold()
        ]
        return sorted(found, key=lambda user: user.display_name.casefold())

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        """Nothing: Zulip gives a bot no per-message identity to create."""
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        """None: agents are not members of a stream, only the bot is."""
        return []

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        """Switch Markdown is Zulip's Markdown for everything Switch writes."""
        return content

    def translate_inbound(self, raw_message: str) -> str:
        """Zulip's mentions as the `@name` Switch addresses agents by."""
        return _MENTION.sub(lambda match: f"@{match.group(1)}", raw_message)

    def render_app_mention(self, token: str) -> str:
        """The bot as Zulip writes a mention of it."""
        return f"@**{token}**"

    def defuse_mass_mentions(self, text: str) -> str:
        """`@**all**` and its kin as text, so a relayed post notifies nobody."""
        return _MASS_MENTION.sub(lambda match: f"@​{match.group(1)}", text)

    async def _call(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        return await _call(self._http, method, path, **kwargs)


def _client(config: ZulipConnectionConfig) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=config.server_url,
        auth=(config.bot_email, config.api_key),
        timeout=httpx.Timeout(30.0),
    )


def _download_client(policy: OutboundPolicy) -> httpx.AsyncClient:
    """A client for an upload's temporary link: no credentials, and every hop
    of a redirect held to the outbound policy."""
    return guarded_async_client(
        policy,
        follow_redirects=True,
        max_redirects=_MAX_DOWNLOAD_REDIRECTS,
        timeout=httpx.Timeout(30.0, read=120.0),
    )


def _transient(exc: BaseException) -> bool:
    """Whether a failure may not happen again, so the work is worth repeating."""
    if isinstance(exc, httpx.HTTPError):
        return True
    return isinstance(exc, ZulipError) and exc.code in _TRANSIENT_CODES


def _new_topic(content: str, limit: int) -> str:
    """A topic for a post that starts a conversation: its first line, plain."""
    for line in content.splitlines():
        words = " ".join(re.sub(r"[*_`#>~|\[\]]", "", line).split())
        if words:
            return words if len(words) <= limit else words[: limit - 1].rstrip() + "…"
    return NEW_CONVERSATION_TOPIC


async def _call(
    http: httpx.AsyncClient, method: str, path: str, **kwargs: Any
) -> dict[str, Any]:
    """One API call; Zulip's error answers raise `ZulipError` with its own words."""
    response = await http.request(method, path, **kwargs)
    try:
        body = response.json()
    except ValueError as exc:
        raise ZulipError(
            "NOT_JSON", f"Zulip answered {response.status_code} without JSON"
        ) from exc
    if body.get("result") != "success":
        raise ZulipError(
            str(body.get("code", response.status_code)), str(body.get("msg", ""))
        )
    return dict(body)


def _split(text: str, limit: int) -> list[str]:
    """`text` in parts of at most `limit` characters, cut at a line where one fits."""
    parts: list[str] = []
    while len(text) > limit:
        cut = text.rfind("\n", 0, limit)
        cut = cut if cut > 0 else limit
        parts.append(text[:cut])
        text = text[cut:].lstrip("\n")
    parts.append(text)
    return parts
