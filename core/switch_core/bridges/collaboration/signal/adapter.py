"""Signal, through a signal-cli daemon the operator runs and registers.

Signal has no bot API, so Switch talks to signal-cli's HTTP daemon
(`signal-cli daemon --http`): JSON-RPC calls on `/api/v1/rpc` to send, and a
Server-Sent Events stream on `/api/v1/events` that delivers what the account
receives. The daemon holds the account's keys; Switch holds none.

Shaped by what Signal is:

- **One account for every agent.** Each reply opens with the agent's name.
- **No threads.** A reply that quotes a message is treated as a reply in that
  message's thread, and an agent's reply in a thread quotes the thread's root.
- **One reader per account.** The event stream is opened only by the
  switch-core process holding the bridge (`keeps_quiet_unless_listening`);
  every process can still send, since a send is a plain HTTP call.
- **A private account can be linked.** signal-cli can be linked to an existing
  phone as a second device, so only the conversations of the people on the
  connection's allow-list reach Switch.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import itertools
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
    RichContent,
    RichContentFailed,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    AttachmentFailure,
    BridgeConnectionConfig,
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    ChannelType,
    CreatedChannel,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
)

logger = logging.getLogger(__name__)

_E164 = re.compile(r"^\+[1-9][0-9]{6,14}$")
_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

#: A group's channel id is this prefix and the group's base64 id; anything
#: else is the other party of a direct conversation.
GROUP_PREFIX = "group."

#: The reaction an agent's work is shown with.
WORKING_EMOJI = "👀"

#: Signal clients send a longer body as a file; stay under it.
MAX_MESSAGE = 2000

#: Ends an edit cut short: an edit cannot grow into a second message.
_TRUNCATED = "\n\n_… (cut: too long to edit in one Signal message)_"

#: Signal marks where a mention sat in the text with this character.
_MENTION_MARK = "￼"

#: A command: `!`, a name starting with a letter, and its arguments. Anything
#: else that starts with `!` (`!!!`, `! look`) is an ordinary message.
_COMMAND = re.compile(r"^!([A-Za-z][\w-]*)(?:\s+(.*))?$", re.DOTALL)

#: How long to wait before reopening a dropped event stream, at most.
_MAX_BACKOFF = 30.0


def _identifiers(raw: str) -> list[str]:
    return [p for p in (part.strip() for part in re.split(r"[,\s]+", raw)) if p]


class SignalConnectionConfig(BridgeConnectionConfig):
    daemon_url: str = Field(
        title="signal-cli daemon address",
        description=(
            "Where `signal-cli daemon --http` listens, e.g. http://localhost:8080. "
            "Keep it on localhost or a private network: the daemon has no login."
        ),
    )
    account: str = Field(
        title="Signal account",
        description="The phone number signal-cli is registered or linked as, e.g. +15551234567.",
    )
    allowed_senders: str = Field(
        title="Allowed people",
        description=(
            "Whose messages reach Switch: phone numbers (E.164) or Signal account "
            "ids, comma separated. Messages from anyone else are ignored. If "
            "signal-cli is linked to your own phone, add your own number to "
            "talk to agents from it."
        ),
    )
    default_agent: str | None = Field(
        default=None,
        title="Agent that answers",
        description=(
            "The agent added to each new conversation. Leave empty to add agents "
            "yourself with !invite-agent."
        ),
    )

    @field_validator("daemon_url")
    @classmethod
    def _daemon_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(
                "write the address as http://host:port, e.g. http://localhost:8080"
            )
        if parts.path or parts.query:
            raise ValueError(
                "give only the daemon's address, without /api/v1/... after it"
            )
        return value

    @field_validator("account")
    @classmethod
    def _account(cls, value: str) -> str:
        value = value.strip()
        if not _E164.fullmatch(value):
            raise ValueError("write the number in E.164 form, e.g. +15551234567")
        return value

    @field_validator("allowed_senders")
    @classmethod
    def _allowed_senders(cls, value: str) -> str:
        ids = _identifiers(value)
        if not ids:
            raise ValueError("list at least one person whose messages may reach Switch")
        bad = [i for i in ids if not (_E164.fullmatch(i) or _UUID.fullmatch(i))]
        if bad:
            raise ValueError(
                f"not a phone number in E.164 form or a Signal account id: {', '.join(bad)}"
            )
        return ", ".join(ids)

    @field_validator("default_agent")
    @classmethod
    def _default_agent(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().lstrip("@")
        return value or None

    @property
    def allowed(self) -> frozenset[str]:
        return frozenset(i.lower() for i in _identifiers(self.allowed_senders))


# ── Formatting: Switch Markdown as Signal text styles ──────────────────────

_STYLE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"```[^\n]*\n(.*?)\n?```", re.DOTALL), "MONOSPACE"),
    (re.compile(r"`([^`\n]+)`"), "MONOSPACE"),
    (re.compile(r"\*\*([^*\n]+)\*\*"), "BOLD"),
    (re.compile(r"__([^_\n]+)__"), "BOLD"),
    (re.compile(r"~~([^~\n]+)~~"), "STRIKETHROUGH"),
    (re.compile(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])"), "ITALIC"),
    (re.compile(r"(?<!\w)_([^_\n]+)_(?!\w)"), "ITALIC"),
]


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def to_signal_text(markdown: str) -> tuple[str, list[str]]:
    """Switch Markdown as Signal's plain text and its `textStyle` ranges.

    Signal draws bold, italic, monospace and strikethrough as ranges over the
    text, counted in UTF-16 code units (an emoji is two), as
    `start:length:STYLE`. Markers are stripped and each run they marked
    becomes a range; anything else (headings, links) is written plainly.
    """
    text = re.sub(r"^#{1,6}\s+", "", markdown, flags=re.MULTILINE)
    text = re.sub(r"!?\[([^\]]+)\]\((\S+?)\)", r"\1 (\2)", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Strip the earliest marked run, one at a time, moving the ranges already
    # found to where their text now sits. Each pass shortens the text.
    spans: list[tuple[int, int, str]] = []  # (start, end) in str indices
    while True:
        found: tuple[re.Match[str], str] | None = None
        for pattern, style in _STYLE_PATTERNS:
            for match in pattern.finditer(text):
                # Nothing is styled inside code.
                if any(
                    s <= match.start() < e for s, e, st in spans if st == "MONOSPACE"
                ):
                    continue
                if found is None or match.start() < found[0].start():
                    found = (match, style)
                break
        if found is None:
            break
        match, style = found
        opening = match.start(1) - match.start()
        closing = match.end() - match.end(1)
        inner = match.group(1)
        moved: list[tuple[int, int, str]] = []
        for s, e, st in spans:
            if s >= match.end():
                s, e = s - opening - closing, e - opening - closing
            elif s >= match.start(1) and e <= match.end(1):
                s, e = s - opening, e - opening
            elif s <= match.start() and e >= match.end():
                e -= opening + closing
            moved.append((s, e, st))
        spans = [*moved, (match.start(), match.start() + len(inner), style)]
        text = text[: match.start()] + inner + text[match.end() :]
    styles = [
        f"{_utf16_len(text[:s])}:{_utf16_len(text[s:e])}:{st}"
        for s, e, st in sorted(spans)
        if e > s and e <= len(text)
    ]
    return text, styles


def split_message(text: str, limit: int = MAX_MESSAGE) -> list[str]:
    """`text` in pieces of at most `limit`, cut at the latest paragraph,
    line, sentence or word boundary."""
    pieces: list[str] = []
    rest = text
    while len(rest) > limit:
        window = rest[:limit]
        cut = -1
        for boundary in ("\n\n", "\n", ". ", " "):
            found = window.rfind(boundary)
            if found > limit // 2:
                cut = found + len(boundary)
                break
        if cut <= 0:
            cut = limit
        pieces.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        pieces.append(rest)
    return pieces


def message_ref(timestamp: int | str, author: str) -> str:
    """How Signal names a message: its author and its sent timestamp."""
    return f"{timestamp}:{author}"


def _parse_ref(ref: str) -> tuple[int, str]:
    timestamp, _, author = ref.partition(":")
    return int(timestamp), author


class SignalRpcError(Exception):
    """signal-cli answered a call with a JSON-RPC error."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"{message} (code {code})")
        self.code = code
        self.message = message


class SignalAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "Signal"

    # One account for every agent, and Signal has no channel the bot can make
    # without knowing everyone's number, nor any directory to search.
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    # Only one reader of the account's messages: the process holding the bridge.
    keeps_quiet_unless_listening: ClassVar[bool] = True
    # A Signal group notifies its members of every message.
    every_message_notifies_members: ClassVar[bool] = True
    # The account reacts 👀 to the message being worked on; every agent shares it.
    supports_activity_reactions: ClassVar[bool] = True

    #: Swapped for an `httpx.MockTransport` in tests.
    _transport: ClassVar[httpx.AsyncBaseTransport | None] = None

    def __init__(self, *, config: SignalConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._ids = itertools.count(1)
        self._listener: asyncio.Task[None] | None = None
        self._last_event_id: str | None = None
        self._on_message: Callable[[InboundMessage], Awaitable[None]] | None = None
        self._on_command: Callable[[InboundCommand], Awaitable[None]] | None = None

    # ── signal-cli's JSON-RPC ───────────────────────────────────────────────

    @classmethod
    def _client(
        cls, config: SignalConnectionConfig, *, timeout: float | None = 30.0
    ) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=config.daemon_url, timeout=timeout, transport=cls._transport
        )

    @classmethod
    async def _rpc_with(
        cls,
        config: SignalConnectionConfig,
        method: str,
        params: dict[str, Any],
        call_id: int = 1,
    ) -> Any:
        body = {
            "jsonrpc": "2.0",
            "method": method,
            "id": call_id,
            "params": {"account": config.account, **params},
        }
        async with cls._client(config) as client:
            response = await client.post("/api/v1/rpc", json=body)
        if response.status_code >= 400:
            raise BridgeOperationError(
                f"signal-cli refused {method} ({response.status_code}): {response.text[:200]}"
            )
        try:
            answer = response.json()
        except ValueError as exc:
            raise BridgeOperationError(
                f"signal-cli answered {method} with something that is not JSON: "
                f"{response.text[:200]}"
            ) from exc
        if answer.get("error"):
            error = answer["error"]
            raise SignalRpcError(
                int(error.get("code", 0)), str(error.get("message", ""))
            )
        return answer.get("result")

    async def _rpc(self, method: str, params: dict[str, Any]) -> Any:
        try:
            return await self._rpc_with(self.config, method, params, next(self._ids))
        except SignalRpcError as exc:
            raise BridgeOperationError(
                f"Signal refused {method}: {exc.message}"
            ) from exc

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        config = SignalConnectionConfig.model_validate(connection_config)
        try:
            async with cls._client(config, timeout=10.0) as client:
                check = await client.get("/api/v1/check")
        except httpx.TransportError as exc:
            raise BridgeCredentialError(
                f"No signal-cli daemon answers at {config.daemon_url}. Start it with "
                "`signal-cli daemon --http`, and check the address."
            ) from exc
        if check.status_code != 200:
            raise BridgeCredentialError(
                f"{config.daemon_url} answered {check.status_code}: is it a signal-cli "
                "daemon started with --http?"
            )
        try:
            accounts = await cls._rpc_with(config, "listAccounts", {})
        except SignalRpcError as exc:
            raise BridgeCredentialError(
                "The daemon would not list its accounts. Start it without -a "
                f"(`signal-cli daemon --http`) so it serves every account: {exc.message}"
            ) from exc
        except BridgeOperationError as exc:
            raise BridgeCredentialError(
                f"The signal-cli daemon at {config.daemon_url} refused to list its "
                f"accounts: {exc}"
            ) from exc
        except httpx.TransportError as exc:
            raise BridgeCredentialError(
                f"The signal-cli daemon at {config.daemon_url} stopped answering while "
                "listing its accounts. Check that it is still running."
            ) from exc
        numbers = {
            str(a.get("number")) for a in (accounts or []) if isinstance(a, dict)
        }
        if config.account not in numbers:
            raise BridgeCredentialError(
                f"{config.account} is not registered or linked in this signal-cli "
                "daemon. Register it (signal-cli register) or link it (signal-cli link) first."
            )

    @classmethod
    def exclusive_resource(cls, connection_config: dict[str, object]) -> str | None:
        """One connection per Signal account: two would each read its messages."""
        account = connection_config.get("account")
        return f"Signal account {account}" if account else None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        url = connection_config.get("daemon_url")
        return [str(url)] if url else []

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, httpx.TransportError):
            return "network"
        if isinstance(exc, SignalRpcError):
            return "platform_error"
        return None

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
        if self._listening:
            self._listener = asyncio.create_task(self._listen(), name="signal-events")

    async def stop(self) -> None:
        if self._listener is not None:
            self._listener.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._listener
            self._listener = None

    async def _listen(self) -> None:
        """Keep the event stream open, reopening it after a drop."""
        backoff = 1.0
        while True:
            try:
                async for event in self._events():
                    backoff = 1.0
                    try:
                        await self.handle_event(event)
                    except Exception:
                        logger.exception("Could not handle a Signal event")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "Signal event stream dropped (%s); reopening", type(exc).__name__
                )
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF)

    async def _events(self) -> AsyncIterator[dict[str, Any]]:
        """One connection's worth of events from `/api/v1/events`.

        Sends `Last-Event-ID` when reopening, so a daemon that keeps recent
        events can replay what this process missed; a replay is harmless,
        since a message's ref is the same on every delivery.
        """
        headers = {"Accept": "text/event-stream"}
        if self._last_event_id:
            headers["Last-Event-ID"] = self._last_event_id
        async with self._client(self.config, timeout=None) as client:
            async with client.stream(
                "GET",
                "/api/v1/events",
                params={"account": self.config.account},
                headers=headers,
            ) as response:
                if response.status_code != 200:
                    raise BridgeOperationError(
                        f"signal-cli events answered {response.status_code}"
                    )
                data: list[str] = []
                event_id: str | None = None
                async for line in response.aiter_lines():
                    if line == "":
                        if data:
                            if event_id:
                                self._last_event_id = event_id
                            try:
                                yield json.loads("\n".join(data))
                            except ValueError:
                                logger.warning("Skipped an unreadable Signal event")
                        data, event_id = [], None
                        continue
                    if line.startswith(":"):
                        continue  # keep-alive
                    field, _, value = line.partition(":")
                    value = value.removeprefix(" ")
                    if field == "data":
                        data.append(value)
                    elif field == "id":
                        event_id = value

    # ── Inbound ─────────────────────────────────────────────────────────────

    async def handle_event(self, event: dict[str, Any]) -> None:
        """One `receive` event: a message for the account, from anyone or from
        the account's own phone (a sync of what it sent)."""
        params = event.get("params", event)
        envelope = params.get("envelope")
        if not isinstance(envelope, dict):
            return
        source = str(
            envelope.get("sourceNumber")
            or envelope.get("source")
            or envelope.get("sourceUuid")
            or ""
        )
        source_uuid = str(envelope.get("sourceUuid") or "")
        sender_name = str(envelope.get("sourceName") or source)

        data = envelope.get("dataMessage")
        sync = (envelope.get("syncMessage") or {}).get("sentMessage")
        if isinstance(data, dict) and (
            data.get("message") is not None or data.get("attachments")
        ):
            message = data
            group = (data.get("groupInfo") or {}).get("groupId")
            channel_id = f"{GROUP_PREFIX}{group}" if group else source
            author = source
        elif isinstance(sync, dict):
            # Written on the account's own phone and synced to this device.
            message = sync
            source = self.config.account
            source_uuid = ""
            sender_name = str(envelope.get("sourceName") or self.config.account)
            group = (sync.get("groupInfo") or {}).get("groupId")
            destination = str(
                sync.get("destinationNumber")
                or sync.get("destination")
                or sync.get("destinationUuid")
                or ""
            )
            # What the owner writes elsewhere stays theirs: only their Note to
            # Self, and their chats with people on the allow-list, reach Switch.
            if group or not destination:
                return
            if (
                destination != self.config.account
                and destination.lower() not in self.config.allowed
            ):
                return
            channel_id = destination
            author = self.config.account
        else:
            return  # receipts, typing, reactions: nothing for a room

        if (
            source.lower() not in self.config.allowed
            and source_uuid.lower() not in self.config.allowed
        ):
            logger.info("Ignored a Signal message from someone not on the allow-list")
            return

        timestamp = message.get("timestamp") or envelope.get("timestamp")
        ref = message_ref(str(timestamp), author)
        text = self._with_mentions(
            str(message.get("message") or ""), message.get("mentions") or []
        )
        channel_type: ChannelType = "channel_private" if group else "direct"
        root_id = self._quote_ref(message.get("quote"))

        attachment_items = message.get("attachments") or []
        command = _COMMAND.match(text.strip())
        if command and not attachment_items and self._on_command is not None:
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=source,
                    sender_name=sender_name,
                    command=command.group(1),
                    args=(command.group(2) or "").strip(),
                    message_ref=ref,
                    root_id=root_id,
                )
            )
            return
        if self._on_message is None:
            return
        attachments, failures = await self._fetch_attachments(
            attachment_items, channel_id
        )
        await self._on_message(
            InboundMessage(
                channel_id=channel_id,
                channel_type=channel_type,
                sender_id=source,
                sender_name=sender_name,
                content=text,
                message_ref=ref,
                root_id=root_id,
                attachments=attachments,
                attachment_failures=failures,
            )
        )

    @staticmethod
    def _with_mentions(text: str, mentions: list[dict[str, Any]]) -> str:
        """Signal's mention marks written back as `@name`."""
        for mention in sorted(mentions, key=lambda m: -int(m.get("start", 0))):
            start, length = int(mention.get("start", 0)), int(mention.get("length", 1))
            name = (
                mention.get("name")
                or mention.get("number")
                or mention.get("uuid")
                or "someone"
            )
            # Offsets are UTF-16 units; convert to a str index.
            index, units = 0, 0
            while index < len(text) and units < start:
                units += 2 if ord(text[index]) > 0xFFFF else 1
                index += 1
            if text[index : index + length] == _MENTION_MARK * length:
                text = f"{text[:index]}@{name}{text[index + length :]}"
        return text

    @staticmethod
    def _quote_ref(quote: Any) -> str | None:
        if not isinstance(quote, dict) or quote.get("id") is None:
            return None
        author = (
            quote.get("authorNumber") or quote.get("author") or quote.get("authorUuid")
        )
        return message_ref(str(quote["id"]), str(author)) if author else None

    async def _fetch_attachments(
        self, attachments: list[dict[str, Any]], channel_id: str
    ) -> tuple[list[Attachment], list[AttachmentFailure]]:
        fetched: list[Attachment] = []
        failures: list[AttachmentFailure] = []
        for item in attachments:
            name = str(item.get("filename") or item.get("id") or "attachment")
            size = int(item.get("size") or 0)
            if size > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=name, reason="It is larger than Switch accepts."
                    )
                )
                continue
            try:
                result = await self._rpc(
                    "getAttachment", {"id": item.get("id"), **self._target(channel_id)}
                )
                encoded = result.get("data") if isinstance(result, dict) else result
                if not isinstance(encoded, str) or not encoded:
                    raise BridgeOperationError(
                        "signal-cli returned no data for the attachment"
                    )
                data = base64.b64decode(encoded, validate=True)
            except (BridgeOperationError, binascii.Error, httpx.TransportError) as exc:
                failures.append(
                    AttachmentFailure(
                        filename=name,
                        reason=f"Could not download it from Signal: {exc}",
                    )
                )
                continue
            if len(data) > self._max_attachment_bytes:
                failures.append(
                    AttachmentFailure(
                        filename=name, reason="It is larger than Switch accepts."
                    )
                )
                continue
            fetched.append(
                Attachment(
                    filename=name,
                    mimetype=str(item.get("contentType") or "application/octet-stream"),
                    data=data,
                )
            )
        return fetched, failures

    # ── Outbound ────────────────────────────────────────────────────────────

    def _target(self, channel_id: str) -> dict[str, Any]:
        if channel_id.startswith(GROUP_PREFIX):
            return {"groupId": channel_id.removeprefix(GROUP_PREFIX)}
        return {"recipient": [channel_id]}

    async def _send(self, channel_id: str, params: dict[str, Any]) -> str:
        result = await self._rpc("send", {**self._target(channel_id), **params})
        timestamp = result.get("timestamp") if isinstance(result, dict) else None
        if timestamp is None:
            raise BridgeOperationError(
                "signal-cli did not say when the message was sent"
            )
        return message_ref(str(timestamp), self.config.account)

    def _quote(self, thread_root_id: str | None) -> dict[str, Any]:
        if not thread_root_id:
            return {}
        try:
            timestamp, author = _parse_ref(thread_root_id)
        except ValueError:
            return {}
        return {"quoteTimestamp": timestamp, "quoteAuthor": author}

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Send as the account, the agent's name in bold at the start.

        A reply in a thread quotes the thread's root. A long reply goes as
        several messages; the ref is the first one's.
        """
        body = f"**{sender_name}:** {content}" if sender_name else content
        first: str | None = None
        for index, piece in enumerate(split_message(body)):
            text, styles = to_signal_text(piece)
            params: dict[str, Any] = {"message": text}
            if styles:
                params["textStyle"] = styles
            if index == 0:
                params.update(self._quote(thread_root_id))
            ref = await self._send(channel_id, params)
            first = first or ref
        return first

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """Edit one of the account's own messages (Signal allows it for a day).

        `new_content` is written as given. The agent's name is not passed
        here, so a caller that knows it goes through `update_rich`, which puts
        the name back at the head.
        """
        await self._edit(channel_id, message_ref, new_content)

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """Redraw a card or a turn with the agent's name at its head again.

        Every agent shares the account, so the name is part of the message: an
        edit without it would no longer say who is speaking.
        """
        text = self.rich_fallback_text(content)
        try:
            await self._edit(channel_id, message_ref, f"**{agent_name}:** {text}")
        except Exception as error:
            raise RichContentFailed(
                f"Signal could not update message {message_ref} in {channel_id}: {error}",
                text=text,
            ) from error

    async def _edit(self, channel_id: str, message_ref: str, body: str) -> None:
        """Replace the text of one of the account's own messages.

        An edit cannot become several messages, so a body longer than one is
        cut, and the cut is marked in the message and logged.
        """
        timestamp, author = _parse_ref(message_ref)
        if author != self.config.account:
            return
        pieces = split_message(body, MAX_MESSAGE - len(_TRUNCATED))
        if len(pieces) > 1:
            logger.warning(
                "Signal edit of %s in %s is longer than one message (%d characters); "
                "sending the first %d",
                message_ref,
                channel_id,
                len(body),
                len(pieces[0]),
            )
            body = pieces[0] + _TRUNCATED
        text, styles = to_signal_text(body)
        params: dict[str, Any] = {"message": text, "editTimestamp": timestamp}
        if styles:
            params["textStyle"] = styles
        await self._send(channel_id, params)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        """Delete one of the account's own messages for everyone."""
        timestamp, author = _parse_ref(message_ref)
        if author != self.config.account:
            return
        await self._rpc(
            "remoteDelete", {"targetTimestamp": timestamp, **self._target(channel_id)}
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        try:
            await self._rpc(
                "sendTyping", {"stop": not is_typing, **self._target(channel_id)}
            )
        except BridgeOperationError:
            logger.debug("Signal refused a typing indicator", exc_info=True)

    async def notify_working(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        await self.send_typing(channel_id, agent_name, True)

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
        """React 👀 to the message being worked on, or take the reaction back.

        One mark between every agent, since they share the account. Signal
        keeps one reaction per account per message, so adding it again, or
        removing one that is not there, changes nothing.
        """
        if mark != "working":
            return
        timestamp, author = _parse_ref(message_ref)
        await self._rpc(
            "sendReaction",
            {
                "emoji": WORKING_EMOJI,
                "targetAuthor": author,
                "targetTimestamp": timestamp,
                "remove": not on,
                **self._target(channel_id),
            },
        )

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
        """Send the file itself, as a data URI signal-cli uploads."""
        if len(data) > self._max_attachment_bytes:
            return await self.send_message(
                channel_id,
                sender_name,
                f"_{filename} is too large to send on Signal._",
                thread_root_id,
            )
        safe_name = re.sub(r"[;,]", "_", filename)
        uri = f"data:{mimetype};filename={safe_name};base64,{base64.b64encode(data).decode()}"
        text, styles = to_signal_text(
            f"**{sender_name}:** {caption}" if caption else f"**{sender_name}**"
        )
        params: dict[str, Any] = {
            "message": text,
            "attachments": [uri],
            **self._quote(thread_root_id),
        }
        if styles:
            params["textStyle"] = styles
        return await self._send(channel_id, params)

    # ── Conversations ───────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        raise ChannelCreationUnsupported(
            "Signal conversations start on Signal: add the account to a group, or "
            "message it, and the room appears."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_private" if channel_id.startswith(GROUP_PREFIX) else "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents share the one account; there is no membership to change.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        # Adding people to a group is done on Signal, by its members.
        return list(user_external_ids)

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return [self.config.default_agent] if self.config.default_agent else []

    # ── Markup ──────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        # Kept as Markdown: `send_message` turns it into Signal's text styles.
        return content

    def translate_inbound(self, raw_message: str) -> str:
        return raw_message
