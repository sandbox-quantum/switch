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
from collections.abc import Awaitable, Callable
from typing import Any, ClassVar
from urllib.parse import urlsplit

import httpx
from pydantic import Field, field_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelRetirement,
    ChannelType,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)

logger = logging.getLogger(__name__)

# Zulip holds a long poll open for about 90 seconds before it answers with a
# heartbeat, so a read must be allowed to wait longer than that.
_POLL_TIMEOUT = httpx.Timeout(30.0, read=120.0)
# How long to wait before asking again after the server could not be reached.
_RETRY_SECONDS = 5.0
# How many unread messages are relayed at a time after a queue is made.
_UNREAD_PAGE = 100
# Zulip's default; the server's own figure replaces it once the queue is registered.
_DEFAULT_MESSAGE_LIMIT = 10_000
# Where an agent's post goes when it starts a conversation rather than
# answering in one: Zulip refuses a stream message without a topic.
NEW_CONVERSATION_TOPIC = "Switch"
# `@**name**` and `@_**name**` (silent), each optionally `|user_id`.
_MENTION = re.compile(r"@_?\*\*([^*|]+)(?:\|\d+)?\*\*")
# The mentions that notify everyone in a stream or topic.
_MASS_MENTION = re.compile(
    r"@_?\*\*(all|everyone|stream|channel|topic)\*\*", re.IGNORECASE
)
_LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


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
        return f"{parts.scheme}://{parts.netloc}"


class ZulipAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Zulip"
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # A generic bot cannot archive a stream, and the people in it keep its history.
    channel_on_delete: ClassVar[ChannelRetirement] = "left"
    # The bot has no way to search the organization's members by name here yet.
    supports_directory_search: ClassVar[bool] = False
    # Zulip links only web addresses, so a Console deeplink would arrive as text.
    renders_custom_url_schemes: ClassVar[bool] = False

    def __init__(self, *, config: ZulipConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._http = _client(config)
        self._bot_user_id: int | None = None
        self._bot_name = ""
        self._message_limit = _DEFAULT_MESSAGE_LIMIT
        self._listener: asyncio.Task[None] | None = None
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None

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
        me = await self._call("GET", "/api/v1/users/me")
        self._bot_user_id = int(me["user_id"])
        self._bot_name = str(me["full_name"])
        if self._listening:
            self._listener = asyncio.create_task(self._listen())

    async def stop(self) -> None:
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
                    queue_id = str(registered["queue_id"])
                    last_event_id = int(registered["last_event_id"])
                    self._message_limit = int(
                        registered.get("max_message_length", _DEFAULT_MESSAGE_LIMIT)
                    )
                    await self._relay_unread()
                answer = await self._call(
                    "GET",
                    "/api/v1/events",
                    params={"queue_id": queue_id, "last_event_id": last_event_id},
                    timeout=_POLL_TIMEOUT,
                )
                relayed: list[int] = []
                for event in answer.get("events", []):
                    last_event_id = max(last_event_id, int(event["id"]))
                    if event.get("type") == "message":
                        await self._relay(event["message"], event.get("flags", []))
                        relayed.append(int(event["message"]["id"]))
                await self._mark_read(relayed)
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
                # One bad event must not end the bridge's hearing.
                logger.exception("A Zulip event could not be relayed")
                await asyncio.sleep(_RETRY_SECONDS)

    async def _relay_unread(self) -> None:
        """Relay, oldest first, what reached the bot while it was not listening."""
        while True:
            answer = await self._call(
                "GET",
                "/api/v1/messages",
                params={
                    "anchor": "first_unread",
                    "num_before": "0",
                    "num_after": str(_UNREAD_PAGE),
                    "apply_markdown": "false",
                    "narrow": json.dumps([{"operator": "is", "operand": "unread"}]),
                },
            )
            messages = answer.get("messages", [])
            for message in messages:
                await self._relay(message, message.get("flags", []))
            await self._mark_read([int(message["id"]) for message in messages])
            if len(messages) < _UNREAD_PAGE:
                return

    async def _mark_read(self, message_ids: list[int]) -> None:
        if message_ids:
            await self._call(
                "POST",
                "/api/v1/messages/flags",
                data={"messages": json.dumps(message_ids), "op": "add", "flag": "read"},
            )

    async def _relay(self, message: dict[str, Any], flags: list[str]) -> None:
        if self._on_message is None or message.get("type") != "stream":
            return
        if message.get("sender_id") == self._bot_user_id:
            return
        stream_id = str(message["stream_id"])
        root = await self._topic_root(stream_id, str(message["subject"]))
        message_id = str(message["id"])
        root_id = None if root == message_id else root
        channel_type = await self.get_channel_type(stream_id)
        channel_name = str(message.get("display_recipient") or "") or None
        content = self.translate_inbound(str(message["content"]))
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
                self_mention_token=(
                    self._bot_name
                    if "mentioned" in flags and self._mentions_bot(message["content"])
                    else None
                ),
            )
        )

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
        """
        topic = (
            await self._topic_of(thread_root_id)
            if thread_root_id is not None
            else NEW_CONVERSATION_TOPIC
        )
        agent = await self.agent_rendering(sender_name)
        body = self._render_outbound(content)
        if not room_wide_mention:
            body = self.defuse_mass_mentions(body)
        first: str | None = None
        for part in _split(f"**{agent.body_label}:** {body}", self._message_limit):
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

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        await self._call(
            "PATCH",
            f"/api/v1/messages/{message_ref}",
            data={
                "content": _split(
                    self._render_outbound(new_content), self._message_limit
                )[0]
            },
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        await self._call("DELETE", f"/api/v1/messages/{message_ref}")

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """Nothing: Zulip shows typing only within a topic, and this names none."""
        return None

    # ── Streams ──────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
    ) -> str:
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
        return str(found["stream_id"])

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
        return (
            "channel_private" if stream["stream"]["invite_only"] else "channel_public"
        )

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
