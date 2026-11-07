"""Zulip, through a bot on the operator's own Zulip organization.

The bot dials out: it registers an event queue (`POST /api/v1/register`) and
long-polls it (`GET /api/v1/events`), so Switch needs no public address. Every
other call is a plain REST request authenticated as the bot.

How Zulip maps onto Switch:

- **A channel (stream) is a room, and each of its topics is a thread.** Every
  Zulip message has a topic, so every message in a channel carries its
  topic as its thread, the topic's first message included, and an agent's
  reply goes back into the same topic. A post an agent starts outside any
  thread goes to the connection's "Topic for new posts".
- **A direct message conversation with the bot is a room** (one person, or a
  group of people). It has no topics, so it has no threads.
- **One bot for every agent.** Zulip has no per-message sender name, so each
  reply opens with the agent's name.
- **Nothing is lost while Switch is away.** Zulip keeps a read flag per
  message for the bot itself. The bot marks what it has handled as read, and
  on every (re)connection it first catches up on what is still unread. The
  record lives on the Zulip server, so it survives a restart and a move to
  another switch-core process; a message handled twice is dropped as a
  duplicate, because its ref is Zulip's own message id.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import (
    ActivityMark,
    AgentIdentity,
    PlatformAdapter,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)

#: A channel's id is this prefix and Zulip's numeric stream id, which survives
#: a rename. A direct message conversation is `dm:` and the ids of the people
#: in it other than the bot, sorted.
STREAM_PREFIX = "stream:"
DM_PREFIX = "dm:"

#: A thread is a topic. The prefix keeps a topic called "42" from being read
#: as the message whose id is 42.
TOPIC_PREFIX = "topic:"

#: Zulip refuses a message longer than this.
MAX_MESSAGE = 10_000

#: The reaction an agent's work is shown with.
WORKING_EMOJI = "eyes"

#: How many message topics to remember before starting over.
_TOPIC_CACHE = 5000

#: How long to wait before reconnecting after a failure, at most.
_MAX_BACKOFF = 30.0

#: Uploaded files, as Zulip links them in a message's Markdown.
_UPLOAD_LINK = re.compile(r"\[([^\]]*)\]\((/user_uploads/(\d+)/([^)\s]+))\)")

#: A Zulip mention: `@**Full Name**`, `@**Full Name|12**`, or the silent `@_**…**`.
_MENTION = re.compile(r"@_?\*\*([^*|]+)(?:\|\d+)?\*\*")

#: Zulip's own channel-wide mentions, which the base defusal does not know.
_WILDCARD = re.compile(
    r"@(_?\*\*(?:all|everyone|stream|channel|topic)\*\*)", re.IGNORECASE
)


class ZulipConnectionConfig(BridgeConnectionConfig):
    site: str = Field(
        title="Zulip address",
        description="Your organization's address, e.g. https://yourteam.zulipchat.com.",
    )
    email: str = Field(
        title="Bot email",
        description="The bot's email, shown on its card in Personal settings → Bots.",
    )
    api_key: str = Field(
        title="Bot API key",
        description="The bot's API key, shown on the same card.",
    )
    default_agent: str | None = Field(
        default=None,
        title="Agent that answers",
        description=(
            "The agent added to each new conversation. Leave empty to add agents "
            "yourself with !invite-agent."
        ),
    )
    default_topic: str = Field(
        default="Switch",
        title="Topic for new posts",
        description="Where a post an agent starts outside any topic goes.",
        max_length=60,
    )

    @field_validator("site")
    @classmethod
    def _site(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("write the address as https://yourteam.zulipchat.com")
        if parts.path or parts.query:
            raise ValueError("give only the organization's address, without a path")
        return value

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        value = value.strip()
        if "@" not in value or " " in value:
            raise ValueError(
                "write the bot's email, e.g. switch-bot@yourteam.zulipchat.com"
            )
        return value

    @field_validator("api_key")
    @classmethod
    def _api_key(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("paste the bot's API key")
        return value

    @field_validator("default_agent")
    @classmethod
    def _default_agent(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lstrip("@")
        return value or None

    @field_validator("default_topic")
    @classmethod
    def _default_topic(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name the topic new posts go to")
        return value


class ZulipApiError(Exception):
    """Zulip answered a call with `"result": "error"`."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{message} ({code})")
        self.status = status
        self.code = code
        self.message = message


# ── Text ────────────────────────────────────────────────────────────────────


def split_message(text: str, limit: int = MAX_MESSAGE) -> list[str]:
    """`text` in pieces of at most `limit`, cut at the latest paragraph,
    line, sentence or word boundary, never inside a code block."""
    pieces: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = -1
        for boundary in ("\n\n", "\n", ". ", " "):
            found = window.rfind(boundary)
            if found > limit // 2 and window[:found].count("```") % 2 == 0:
                cut = found + len(boundary)
                break
        if cut <= 0:
            cut = limit
        piece, rest = rest[:cut].rstrip(), rest[cut:].lstrip()
        if piece.count("```") % 2:
            # Cut inside a code block after all: close it here, reopen it next.
            piece, rest = f"{piece}\n```", f"```\n{rest}"
        pieces.append(piece)
    if rest:
        pieces.append(rest)
    return pieces


def to_zulip_markdown(markdown: str) -> str:
    """Switch Markdown in the dialect Zulip renders.

    Zulip has no `__bold__`, no `_italic_` and no headings, so those become
    `**bold**`, `*italic*` and a bold line. Code is left exactly as it is.
    """
    out: list[str] = []
    for index, part in enumerate(
        re.split(r"(```.*?```|`[^`\n]*`)", markdown, flags=re.DOTALL)
    ):
        if index % 2:
            out.append(part)
            continue
        part = re.sub(r"^#{1,6}\s+(.+)$", r"**\1**", part, flags=re.MULTILINE)
        part = re.sub(r"__([^_\n]+)__", r"**\1**", part)
        part = re.sub(r"(?<![\w_])_([^_\n]+)_(?![\w_])", r"*\1*", part)
        out.append(part)
    return "".join(out)


def handle_of(full_name: str) -> str:
    """A person's name as Switch writes it after an `@`: no spaces."""
    return re.sub(r"\s+", "", full_name)


def topic_of(thread_root_id: str | None) -> str | None:
    """The topic a thread root names, or None for a message id or nothing."""
    if thread_root_id and thread_root_id.startswith(TOPIC_PREFIX):
        return thread_root_id.removeprefix(TOPIC_PREFIX)
    return None


class ZulipAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Zulip"

    # One shared bot, which Zulip lets add a reaction and type in a topic.
    supports_activity_reactions: ClassVar[bool] = True
    # A bot can list and search people only through admin-level endpoints.
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    # Only the process holding the bridge reads the event queue.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    channel_mention: ClassVar[str | None] = "@**all**"

    #: Swapped for an `httpx.MockTransport` in tests.
    _transport: ClassVar[httpx.AsyncBaseTransport | None] = None

    def __init__(self, *, config: ZulipConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._listener: asyncio.Task[None] | None = None
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None
        self._bot_id: int | None = None
        self._max_upload_bytes: int | None = None
        # Lookups that are cheap to lose: a restart only repeats a request.
        self._streams: dict[int, dict[str, Any]] = {}
        self._topics: dict[int, str] = {}

    # ── Zulip's REST API ────────────────────────────────────────────────────

    @classmethod
    def _client(
        cls, config: ZulipConnectionConfig, *, timeout: float | None = 30.0
    ) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=config.site,
            auth=(config.email, config.api_key),
            timeout=timeout,
            transport=cls._transport,
        )

    @staticmethod
    def _form(values: dict[str, Any]) -> dict[str, str]:
        """Zulip's form encoding: lists and objects as JSON, the rest as text."""
        return {
            key: json.dumps(value)
            if isinstance(value, (list, dict, bool))
            else str(value)
            for key, value in values.items()
            if value is not None
        }

    @classmethod
    async def _call_with(
        cls,
        config: ZulipConnectionConfig,
        method: str,
        path: str,
        values: dict[str, Any] | None = None,
        *,
        files: dict[str, tuple[str, bytes, str]] | None = None,
        timeout: float | None = 30.0,
    ) -> dict[str, Any]:
        form = cls._form(values or {})
        async with cls._client(config, timeout=timeout) as client:
            if method in ("GET", "DELETE"):
                response = await client.request(method, f"/api/v1{path}", params=form)
            else:
                response = await client.request(
                    method, f"/api/v1{path}", data=form, files=files
                )
        try:
            answer = response.json()
        except ValueError:
            answer = {}
        if response.status_code == 401:
            raise BridgeCredentialError(
                "Zulip refused the bot's email and API key. Copy both again from "
                "Personal settings → Bots."
            )
        if response.status_code >= 400 or answer.get("result") != "success":
            raise ZulipApiError(
                response.status_code,
                str(answer.get("code") or "BAD_REQUEST"),
                str(answer.get("msg") or response.text[:200]),
            )
        return dict(answer)

    async def _call(
        self,
        method: str,
        path: str,
        values: dict[str, Any] | None = None,
        *,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> dict[str, Any]:
        try:
            return await self._call_with(self.config, method, path, values, files=files)
        except ZulipApiError as exc:
            raise BridgeOperationError(
                f"Zulip refused {method} {path}: {exc.message}"
            ) from exc

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = ZulipConnectionConfig.model_validate(connection_config)
        try:
            me = await cls._call_with(config, "GET", "/users/me", timeout=10.0)
        except httpx.TransportError as exc:
            raise BridgeCredentialError(
                f"No Zulip server answers at {config.site}. Check the address."
            ) from exc
        except ZulipApiError as exc:
            raise BridgeCredentialError(
                f"{config.site} did not answer as a Zulip server would: {exc.message}"
            ) from exc
        if not me.get("is_bot"):
            raise BridgeCredentialError(
                "These are a person's credentials, not a bot's. Create a bot in "
                "Personal settings → Bots and use its email and API key, so Switch "
                "never reads or posts as you."
            )

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        site = connection_config.get("site")
        return [str(site)] if site else []

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.TransportError):
            return "network"
        if isinstance(exc, ZulipApiError):
            return "platform_error"
        return None

    async def _bot_user_id(self) -> int:
        if self._bot_id is None:
            me = await self._call("GET", "/users/me")
            self._bot_id = int(me["user_id"])
        return self._bot_id

    # ── Lifecycle ───────────────────────────────────────────────────────────

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
        await self._bot_user_id()
        if self._listening:
            self._listener = asyncio.create_task(self._listen(), name="zulip-events")

    async def stop(self) -> None:
        if self._listener is not None:
            self._listener.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._listener
            self._listener = None

    async def _listen(self) -> None:
        """Keep an event queue open, catching up after every (re)connection."""
        backoff = 1.0
        while True:
            try:
                async for message in self._messages():
                    backoff = 1.0
                    try:
                        await self.handle_message(message)
                    except Exception:
                        logger.exception("Could not handle a Zulip message")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "Zulip event queue dropped (%s); reconnecting", type(exc).__name__
                )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF)

    async def _messages(self) -> AsyncIterator[dict[str, Any]]:
        """Every message for the bot, from one event queue's lifetime.

        The queue is registered before catching up, so nothing sent in between
        is missed; what arrives both ways is a duplicate Switch drops. Ends
        when Zulip forgets the queue (after a long pause), so the caller
        registers a new one and catches up again.
        """
        queue = await self._call_with(
            self.config,
            "POST",
            "/register",
            {
                "event_types": ["message"],
                "fetch_event_types": ["realm"],
                "apply_markdown": False,
            },
        )
        size = queue.get("max_file_upload_size_mib")
        if isinstance(size, int) and size > 0:
            self._max_upload_bytes = size * 1024 * 1024
        queue_id, last_event_id = queue["queue_id"], int(queue["last_event_id"])

        for message in await self._unread():
            yield message

        while True:
            try:
                answer = await self._call_with(
                    self.config,
                    "GET",
                    "/events",
                    {"queue_id": queue_id, "last_event_id": last_event_id},
                    timeout=None,
                )
            except ZulipApiError as exc:
                if exc.code == "BAD_EVENT_QUEUE_ID":
                    logger.info("Zulip expired the event queue; registering a new one")
                    return
                raise
            for event in answer.get("events", []):
                last_event_id = max(last_event_id, int(event.get("id", last_event_id)))
                if event.get("type") == "message":
                    yield event["message"]

    async def _unread(self) -> list[dict[str, Any]]:
        """What reached the bot while nothing was reading, oldest first."""
        answer = await self._call_with(
            self.config,
            "GET",
            "/messages",
            {
                "anchor": "oldest",
                "num_before": 0,
                "num_after": 1000,
                "narrow": [{"operator": "is", "operand": "unread"}],
                "apply_markdown": False,
            },
        )
        return sorted(answer.get("messages", []), key=lambda m: int(m["id"]))

    async def _mark_read(self, message_id: int) -> None:
        try:
            await self._call(
                "POST",
                "/messages/flags",
                {"messages": [message_id], "op": "add", "flag": "read"},
            )
        except BridgeOperationError:
            logger.warning("Could not mark Zulip message %s read", message_id)

    # ── Inbound ─────────────────────────────────────────────────────────────

    async def handle_message(self, message: dict[str, Any]) -> None:
        """One Zulip message, as a room message or a command."""
        message_id = int(message["id"])
        if int(message["sender_id"]) == await self._bot_user_id():
            return  # the bot's own post, coming back
        await self._deliver(message)
        # Only once Switch has it: an unread message is caught up on after a
        # restart, and a second delivery is dropped as a duplicate.
        await self._mark_read(message_id)

    async def _deliver(self, message: dict[str, Any]) -> None:
        channel_id, channel_type, root_id = await self._place(message)
        ref = str(message["id"])
        sender_id = str(message["sender_id"])
        sender_name = handle_of(str(message.get("sender_full_name") or sender_id))
        raw = str(message.get("content") or "")
        text = self.translate_inbound(raw)

        stripped = text.strip()
        if stripped.startswith("!") and self._on_command is not None:
            parts = stripped.split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=sender_name,
                    command=parts[0].lstrip("!"),
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=ref,
                    root_id=root_id,
                )
            )
            return
        if self._on_message is None:
            return
        attachments, failures = await self._fetch_attachments(raw)
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=sender_id,
                sender_name=sender_name,
                content=text,
                message_ref=ref,
                root_id=root_id,
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    async def _place(
        self, message: dict[str, Any]
    ) -> tuple[str, ChannelType, str | None]:
        """The room, its kind, and the thread a message belongs to."""
        if message.get("type") == "stream":
            stream_id = int(message["stream_id"])
            topic = str(message.get("subject") or "")
            self._remember_topic(int(message["id"]), topic)
            channel_id = f"{STREAM_PREFIX}{stream_id}"
            return (
                channel_id,
                await self.get_channel_type(channel_id),
                f"{TOPIC_PREFIX}{topic}",
            )
        bot_id = await self._bot_user_id()
        people = sorted(
            int(p["id"])
            for p in message.get("display_recipient") or []
            if int(p["id"]) != bot_id
        )
        channel_type: ChannelType = "direct" if len(people) <= 1 else "group"
        return f"{DM_PREFIX}{','.join(map(str, people))}", channel_type, None

    async def _fetch_attachments(
        self, content: str
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        """Files uploaded to Zulip and linked in the message."""
        fetched: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for match in _UPLOAD_LINK.finditer(content):
            label, realm_id, path = match.group(1), match.group(3), match.group(4)
            name = label or path.rsplit("/", 1)[-1]
            try:
                # Zulip hands an API client a short-lived address for the file.
                answer = await self._call("GET", f"/user_uploads/{realm_id}/{path}")
                async with self._client(self.config) as client:
                    response = await client.get(str(answer["url"]))
                response.raise_for_status()
            except (BridgeOperationError, httpx.HTTPError, KeyError) as exc:
                failures.append(
                    AttachmentFailure(
                        filename=name, reason=f"Could not download it from Zulip: {exc}"
                    )
                )
                continue
            if len(response.content) > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=name, reason="It is larger than Switch accepts."
                    )
                )
                continue
            fetched.append(
                Attachment(
                    filename=name,
                    mimetype=response.headers.get(
                        "content-type", "application/octet-stream"
                    ).split(";")[0],
                    data=response.content,
                )
            )
        return fetched, failures

    # ── Outbound ────────────────────────────────────────────────────────────

    async def _topic_for(self, thread_root_id: str | None) -> str:
        """The topic a post in this thread goes to."""
        named = topic_of(thread_root_id)
        if named is not None:
            return named
        if thread_root_id and thread_root_id.isdigit():
            # A thread rooted at a message: the message's own topic.
            message_id = int(thread_root_id)
            if message_id not in self._topics:
                answer = await self._call(
                    "GET", f"/messages/{message_id}", {"apply_markdown": False}
                )
                self._remember_topic(
                    message_id, str(answer["message"].get("subject") or "")
                )
            return self._topics[message_id]
        return self.config.default_topic

    def _remember_topic(self, message_id: int, topic: str) -> None:
        if len(self._topics) >= _TOPIC_CACHE:
            self._topics.clear()
        self._topics[message_id] = topic

    async def _destination(
        self, channel_id: str, thread_root_id: str | None
    ) -> dict[str, Any]:
        if channel_id.startswith(STREAM_PREFIX):
            return {
                "type": "stream",
                "to": int(channel_id.removeprefix(STREAM_PREFIX)),
                "topic": await self._topic_for(thread_root_id),
            }
        return {"type": "direct", "to": self._people(channel_id)}

    @staticmethod
    def _people(channel_id: str) -> list[int]:
        return [int(p) for p in channel_id.removeprefix(DM_PREFIX).split(",") if p]

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post as the bot, the agent's name in bold at the start.

        A long reply goes as several messages in the same place; the ref is
        the first one's.
        """
        destination = await self._destination(channel_id, thread_root_id)
        body = f"**{sender_name}:** {content}" if sender_name else content
        first: str | None = None
        for piece in split_message(body):
            answer = await self._call(
                "POST", "/messages", {**destination, "content": piece}
            )
            first = first or str(answer["id"])
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._call(
            "PATCH",
            f"/messages/{int(message_ref)}",
            {"content": split_message(new_content)[0]},
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._call("DELETE", f"/messages/{int(message_ref)}")

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # A channel's typing is per topic, which this call does not name, so only
        # direct messages get it here; `notify_working` covers channels.
        if channel_id.startswith(DM_PREFIX):
            await self._typing(channel_id, None, is_typing)

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        await self._typing(channel_id, thread_root_id, True)

    async def _typing(
        self, channel_id: str, thread_root_id: str | None, on: bool
    ) -> None:
        destination = await self._destination(channel_id, thread_root_id)
        if destination["type"] == "stream":
            values = {
                "type": "stream",
                "stream_id": destination["to"],
                "topic": destination["topic"],
            }
        else:
            values = {"type": "direct", "to": destination["to"]}
        try:
            await self._call(
                "POST", "/typing", {**values, "op": "start" if on else "stop"}
            )
        except BridgeOperationError:
            logger.debug("Zulip refused a typing notification", exc_info=True)

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
        """Put 👀 on the message being worked on, or take it off.

        One mark between every agent, since they share the bot. Zulip answers
        adding a reaction that is already there, or removing one that is not,
        with an error; both mean the message already shows what was asked.
        """
        if mark != "working":
            return
        try:
            await self._call_with(
                self.config,
                "POST" if on else "DELETE",
                f"/messages/{int(message_ref)}/reactions",
                {"emoji_name": WORKING_EMOJI},
            )
        except ZulipApiError as exc:
            if exc.code not in ("REACTION_ALREADY_EXISTS", "REACTION_DOES_NOT_EXIST"):
                raise BridgeOperationError(
                    f"Zulip refused the reaction: {exc.message}"
                ) from exc

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
        """Upload the file to Zulip and post a link to it."""
        limit = min(
            self._max_attachment_bytes,
            self._max_upload_bytes or self._max_attachment_bytes,
        )
        if len(data) > limit:
            return await self.send_message(
                channel_id,
                sender_name,
                f"*{filename} is too large to upload to Zulip.*",
                thread_root_id,
            )
        upload = await self._call(
            "POST", "/user_uploads", files={"filename": (filename, data, mimetype)}
        )
        url = str(upload.get("url") or upload.get("uri"))
        link = f"[{filename}]({url})"
        return await self.send_message(
            channel_id,
            sender_name,
            f"{caption}\n{link}" if caption else link,
            thread_root_id,
        )

    # ── Channels ────────────────────────────────────────────────────────────

    async def _stream(self, stream_id: int) -> dict[str, Any]:
        if stream_id not in self._streams:
            answer = await self._call("GET", f"/streams/{stream_id}")
            self._streams[stream_id] = dict(answer["stream"])
        return self._streams[stream_id]

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        if channel_id.startswith(DM_PREFIX):
            return "direct" if len(self._people(channel_id)) <= 1 else "group"
        try:
            stream = await self._stream(int(channel_id.removeprefix(STREAM_PREFIX)))
        except BridgeOperationError:
            # A private channel the bot can no longer see is still private.
            return "channel_private"
        return "channel_private" if stream.get("invite_only") else "channel_public"

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
        """Create a Zulip channel with the bot in it.

        Allowed only where the organization lets this bot create channels;
        Zulip's refusal is passed on as it is.
        """
        if channel_type not in ("channel_public", "channel_private"):
            raise ChannelCreationUnsupported(
                "A direct message conversation starts on Zulip: message the bot."
            )
        await self._call(
            "POST",
            "/users/me/subscriptions",
            {
                "subscriptions": [{"name": name, "description": topic}],
                "invite_only": channel_type == "channel_private",
            },
        )
        answer = await self._call("GET", "/get_stream_id", {"stream": name})
        return f"{STREAM_PREFIX}{int(answer['stream_id'])}"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents share the bot, which is already in the channel.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """Subscribe people to a channel; returns the ids not added."""
        ids = [i for i in user_external_ids if i.isdigit()]
        if not channel_id.startswith(STREAM_PREFIX) or not ids:
            return list(user_external_ids)
        stream = await self._stream(int(channel_id.removeprefix(STREAM_PREFIX)))
        try:
            await self._call(
                "POST",
                "/users/me/subscriptions",
                {
                    "subscriptions": [{"name": stream["name"]}],
                    "principals": [int(i) for i in ids],
                },
            )
        except BridgeOperationError:
            logger.warning(
                "Zulip refused to add people to %s", channel_id, exc_info=True
            )
            return list(user_external_ids)
        return [i for i in user_external_ids if not i.isdigit()]

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return [self.config.default_agent] if self.config.default_agent else []

    async def channel_deeplink(self, external_channel_id: str) -> str | None:
        if external_channel_id.startswith(STREAM_PREFIX):
            stream_id = external_channel_id.removeprefix(STREAM_PREFIX)
            return f"{self.config.site}/#narrow/channel/{stream_id}"
        return None

    async def home_deeplink(self) -> str | None:
        return self.config.site

    # ── Markup ──────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return to_zulip_markdown(content)

    def defuse_mass_mentions(self, text: str) -> str:
        """Also break Zulip's own `@**all**`, `@**channel**`, `@**topic**`…"""
        return _WILDCARD.sub("@​\\1", super().defuse_mass_mentions(text))

    def translate_inbound(self, raw_message: str) -> str:
        """Zulip's `@**Full Name**` mentions written as Switch's `@FullName`."""
        return _MENTION.sub(lambda m: f"@{handle_of(m.group(1))}", raw_message)
