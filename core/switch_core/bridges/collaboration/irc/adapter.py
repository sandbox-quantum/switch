"""IRC: a bot that dials out to the operator's network and sits in the
channels they name.

The bot is one nick on the network. Agents have no accounts of their own
there, so each agent's lines are posted by the bot with the agent's name in
front (`[helper] …`). IRC has no threads, edits, reactions, attachments or
message cards; the flags below say so, and Switch falls back to plain text.

One connection per bridge, held by the switch-core process that holds the
bridge (`keeps_quiet_unless_listening`). A quiet copy elsewhere opens
nothing, and hands any line it is asked to post to the holder.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import re
import ssl
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import ClassVar

from pydantic import Field, field_validator, model_validator

from switch_core.bridges.collaboration.adapter import AgentIdentity, PlatformAdapter
from switch_core.bridges.collaboration.irc.protocol import (
    Line,
    format_line,
    is_channel,
    markdown_to_irc,
    parse_line,
    privmsg_budget,
    split_text,
    strip_formatting,
)
from switch_core.bridges.collaboration.models import (
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

# RFC 2812 §2.3.1, with the length most networks allow.
_NICK = re.compile(r"^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$")
# A channel name: a prefix, then no space, comma, BEL or colon.
_CHANNEL = re.compile(r"^[#&][^\s,\x07:]{1,49}$")
# A host name or address, nothing that could carry a path or a second host.
_HOST = re.compile(r"^[A-Za-z0-9.-]+$|^\[?[0-9A-Fa-f:.]+\]?$")

#: How long registration may take before the network is reported unreachable.
_REGISTER_TIMEOUT = 30.0
#: Lines sent at once before the limiter paces them, and how fast after.
#: Networks disconnect a client that floods them ("Excess Flood"); this stays
#: under the limits of the common ircd families.
_BURST = 4
_LINE_INTERVAL = 1.5
#: The most lines one reply posts. A longer reply says how much was left out
#: rather than holding the channel for minutes.
_MAX_REPLY_LINES = 15
_RECONNECT_MAX = 300.0
#: The most bytes of a message one relayed request carries. The signal bus
#: refuses a payload of about 8 KB, so a longer message is relayed in parts.
_RELAY_PART_BYTES = 6000
#: How many relayed requests the holder remembers having begun, so a retried
#: one does not post the lines it already sent a second time.
_RELAY_MEMORY = 512

#: The prefix of a sender id for a person the network did not say is logged
#: in to an account: the nick alone, which anyone can take when it is free.
NICK_ID_PREFIX = "nick:"
ACCOUNT_ID_PREFIX = "account:"


class IrcConnectionConfig(BridgeConnectionConfig):
    server: str = Field(
        title="Server",
        description="The IRC server's host name, such as irc.libera.chat.",
    )
    port: int = Field(
        6697,
        ge=1,
        le=65535,
        title="Port",
        description="6697 for TLS on most networks, 6667 without.",
    )
    tls: bool = Field(
        True,
        title="Use TLS",
        description="Turn off only for a network that offers no TLS.",
    )
    nick: str = Field(
        title="Nick",
        description="The bot's nick. Register it with the network's services "
        "so nobody else can take it.",
    )
    account: str | None = Field(
        None,
        title="Account",
        description="The services account to log in to, if not the nick.",
    )
    password: str | None = Field(
        None,
        title="Password",
        description="The account's password: sent with SASL PLAIN where the "
        "network offers it, and to NickServ otherwise.",
    )
    channels: list[str] = Field(
        min_length=1,
        title="Channels",
        description="The channels the bot joins, such as #switch.",
    )

    @field_validator("server")
    @classmethod
    def _server(cls, value: str) -> str:
        value = value.strip()
        if not value or not _HOST.match(value):
            raise ValueError("enter a host name only, such as irc.libera.chat")
        return value

    @field_validator("nick")
    @classmethod
    def _nick(cls, value: str) -> str:
        if not _NICK.match(value):
            raise ValueError(
                "a nick is up to 30 letters, digits or []\\`_^{|}-, and does "
                "not start with a digit or -"
            )
        return value

    @field_validator("channels")
    @classmethod
    def _channels(cls, value: list[str]) -> list[str]:
        seen: list[str] = []
        for channel in value:
            channel = channel.strip()
            if not _CHANNEL.match(channel):
                raise ValueError(
                    f"{channel!r} is not a channel name: it starts with # and "
                    "has no spaces or commas"
                )
            if channel.lower() not in (each.lower() for each in seen):
                seen.append(channel)
        return seen

    @model_validator(mode="after")
    def _account_needs_password(self) -> IrcConnectionConfig:
        if self.account and not self.password:
            raise ValueError("an account to log in to needs its password")
        return self


class IrcError(Exception):
    """The network refused the bot or dropped it."""


class IrcAuthError(IrcError):
    """The network refused the bot's nick or its login."""


@dataclass
class _Registered:
    nick: str
    caps: set[str]
    logged_in: bool


async def _register(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    config: IrcConnectionConfig,
) -> _Registered:
    """Introduce the bot and log it in, up to the server's welcome (001).

    Asks for SASL, message ids and account names where the server offers
    them (IRCv3 capability negotiation); a server that offers none still
    works, without them."""

    def send(command: str, *params: str) -> None:
        writer.write(format_line(command, *params).encode() + b"\r\n")

    account = config.account or config.nick
    offered: set[str] = set()
    acked: set[str] = set()
    logged_in = False
    send("CAP", "LS", "302")
    send("NICK", config.nick)
    send("USER", config.nick, "0", "*", "Switch")
    await writer.drain()
    while True:
        raw = await reader.readline()
        if not raw:
            raise IrcError(f"{config.server} closed the connection while signing in")
        line = parse_line(raw.decode(errors="replace"))
        if line is None:
            continue
        cmd, params = line.command, line.params
        if cmd == "PING":
            send("PONG", *(params[-1:] or [""]))
        elif cmd == "CAP" and len(params) >= 3 and params[1] == "LS":
            offered |= {cap.split("=", 1)[0] for cap in params[-1].split()}
            if params[2] != "*":  # the last line of a multi-line list
                wanted = {"message-tags", "account-tag"} & offered
                if config.password and "sasl" in offered:
                    wanted.add("sasl")
                if wanted:
                    send("CAP", "REQ", " ".join(sorted(wanted)))
                else:
                    send("CAP", "END")
        elif cmd == "CAP" and len(params) >= 3 and params[1] == "ACK":
            acked |= set(params[-1].split())
            if "sasl" in acked and config.password:
                send("AUTHENTICATE", "PLAIN")
            else:
                send("CAP", "END")
        elif cmd == "CAP" and len(params) >= 3 and params[1] == "NAK":
            send("CAP", "END")
        elif cmd == "AUTHENTICATE" and params[:1] == ["+"]:
            token = f"{account}\0{account}\0{config.password}".encode()
            encoded = base64.b64encode(token).decode()
            for start in range(0, len(encoded), 400):
                send("AUTHENTICATE", encoded[start : start + 400])
            if len(encoded) % 400 == 0:
                send("AUTHENTICATE", "+")
        elif cmd == "903":
            logged_in = True
            send("CAP", "END")
        elif cmd in ("902", "904", "905"):
            raise IrcAuthError(
                f"{config.server} refused the login for account {account}: "
                f"{params[-1] if params else 'SASL failed'}"
            )
        elif cmd == "433":
            raise IrcAuthError(
                f"The nick {config.nick} is already in use on {config.server}."
            )
        elif cmd == "432":
            raise IrcAuthError(
                f"{config.server} does not accept the nick {config.nick}."
            )
        elif cmd in ("464", "465"):
            raise IrcAuthError(
                f"{config.server} refused the bot: "
                f"{params[-1] if params else 'password incorrect or banned'}"
            )
        elif cmd == "ERROR":
            raise IrcError(f"{config.server} closed the link: {' '.join(params)}")
        elif cmd == "001":
            nick = params[0] if params else config.nick
            if config.password and not logged_in:
                # No SASL here: the older way, which most services still take.
                send("PRIVMSG", "NickServ", f"IDENTIFY {account} {config.password}")
            await writer.drain()
            return _Registered(nick=nick, caps=acked, logged_in=logged_in)
        await writer.drain()


async def _open(
    config: IrcConnectionConfig, address: str | None = None
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """A connection to the server: to `address`, the server's host already
    resolved and checked against the outbound policy, when given."""
    context = ssl.create_default_context() if config.tls else None
    return await asyncio.wait_for(
        asyncio.open_connection(
            address or config.server,
            config.port,
            ssl=context,
            server_hostname=config.server if context is not None else None,
        ),
        _REGISTER_TIMEOUT,
    )


@dataclass
class _Pacer:
    """A token bucket: `_BURST` lines at once, then one each `_LINE_INTERVAL`."""

    tokens: float = _BURST
    stamp: float = field(default_factory=time.monotonic)

    async def wait(self) -> None:
        while True:
            now = time.monotonic()
            self.tokens = min(_BURST, self.tokens + (now - self.stamp) / _LINE_INTERVAL)
            self.stamp = now
            if self.tokens >= 1:
                self.tokens -= 1
                return
            await asyncio.sleep((1 - self.tokens) * _LINE_INTERVAL)


class IrcAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "IRC"
    supports_channel_creation: ClassVar[bool] = False
    supports_directory_search: ClassVar[bool] = False
    renders_custom_url_schemes: ClassVar[bool] = False
    keeps_quiet_unless_listening: ClassVar[bool] = True

    def __init__(self, *, config: IrcConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._nick = config.nick
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._task: asyncio.Task[None] | None = None
        self._pacer = _Pacer()
        # One reply's lines go out together, not interleaved with another's.
        self._send_lock = asyncio.Lock()
        self._relay_progress: dict[str, int] = {}
        self._stopping = False

    # ── Who this is ──────────────────────────────────────────────────────

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, IrcAuthError):
            return "auth_failed"
        if isinstance(exc, IrcError):
            return "network"
        return None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        # The policy checks a URL's host and port, which is all an IRC server
        # is; the scheme is only what lets it read them. The adapter resolves
        # the host through the same policy again each time it connects.
        config = IrcConnectionConfig.model_validate(connection_config)
        return [f"https://{config.server}:{config.port}"]

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Sign in once and leave: a taken nick, a wrong password or an
        unreachable server is said now, not hours later."""
        config = IrcConnectionConfig.model_validate(connection_config)
        try:
            reader, writer = await _open(config)
        except (OSError, TimeoutError, ssl.SSLError) as exc:
            raise BridgeCredentialError(
                f"Could not reach {config.server}:{config.port}"
                f"{' with TLS' if config.tls else ''}: {exc or type(exc).__name__}. "
                "Check the server, the port and the TLS setting."
            ) from exc
        try:
            await asyncio.wait_for(_register(reader, writer, config), _REGISTER_TIMEOUT)
        except IrcError as exc:
            raise BridgeCredentialError(str(exc)) from exc
        except TimeoutError as exc:
            raise BridgeCredentialError(
                f"{config.server} did not finish signing the bot in."
            ) from exc
        finally:
            try:
                writer.write(b"QUIT :Checked the connection\r\n")
                writer.close()
                await writer.wait_closed()
            except (OSError, ssl.SSLError):
                pass

    @classmethod
    def unlinkable_account_reason(cls, external_user_id: str) -> str | None:
        if external_user_id.startswith(NICK_ID_PREFIX):
            return (
                "This person was not logged in to a services account on the "
                "network, and a nick alone can be taken by anyone once it is free."
            )
        return None

    @classmethod
    def link_code_instructions(
        cls, code: str, connection_config: Mapping[str, object]
    ) -> str:
        return (
            "Log in to your services account on the network, then post "
            f"`!link-account {code}` in a channel the bot is in."
        )

    # ── Lifecycle ────────────────────────────────────────────────────────

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
        self._stopping = False
        if not self._listening:
            return
        # The first sign-in is awaited, so a refused one fails the start
        # where the operator sees it; later ones reconnect on their own.
        await self._connect()
        self._task = asyncio.create_task(self._run(), name="irc-reader")

    async def stop(self) -> None:
        self._stopping = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        await self._close("Switch is stopping")

    async def _connect(self) -> None:
        address: str | None = None
        policy = getattr(self, "_outbound_policy", None)
        if policy is not None:
            address = (await policy.resolve(self.config.server, self.config.port))[0]
        try:
            reader, writer = await _open(self.config, address)
        except (OSError, TimeoutError, ssl.SSLError) as exc:
            raise IrcError(
                f"Could not reach {self.config.server}:{self.config.port}: {exc}"
            ) from exc
        try:
            registered = await asyncio.wait_for(
                _register(reader, writer, self.config), _REGISTER_TIMEOUT
            )
        except BaseException:
            writer.close()
            raise
        self._reader, self._writer = reader, writer
        self._nick = registered.nick
        for channel in self.config.channels:
            await self._write("JOIN", channel)
        logger.info(
            "IRC bridge signed in to %s as %s%s",
            self.config.server,
            self._nick,
            " (SASL)" if registered.logged_in else "",
        )

    async def _close(self, reason: str) -> None:
        writer, self._writer, self._reader = self._writer, None, None
        if writer is None:
            return
        try:
            writer.write(format_line("QUIT", reason).encode() + b"\r\n")
            writer.close()
            await writer.wait_closed()
        except (OSError, ssl.SSLError):
            pass

    async def _run(self) -> None:
        """Read until the connection drops, then sign in again with growing
        pauses; the stream is lost only for as long as the network is."""
        delay = 2.0
        while not self._stopping:
            try:
                await self._read()
                delay = 2.0
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning(
                    "IRC connection to %s lost", self.config.server, exc_info=True
                )
            await self._close("Reconnecting")
            if self._stopping:
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, _RECONNECT_MAX)
            try:
                await self._connect()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning(
                    "Could not sign in to %s again; retrying",
                    self.config.server,
                    exc_info=True,
                )

    async def _read(self) -> None:
        reader = self._reader
        if reader is None:
            raise IrcError("not connected")
        while True:
            raw = await reader.readline()
            if not raw:
                raise IrcError(f"{self.config.server} closed the connection")
            line = parse_line(raw.decode(errors="replace"))
            if line is None:
                continue
            await self._handle(line)

    async def _handle(self, line: Line) -> None:
        if line.command == "PING":
            await self._write("PONG", *(line.params[-1:] or [""]))
        elif line.command == "PRIVMSG" and len(line.params) >= 2:
            await self._privmsg(line)
        elif line.command == "ERROR":
            raise IrcError(f"{self.config.server} closed the link: {line.params}")
        elif line.command == "NICK" and line.nick and self._same(line.nick, self._nick):
            self._nick = line.params[0] if line.params else self._nick
        elif line.command == "KICK" and len(line.params) >= 2:
            if self._same(line.params[1], self._nick):
                logger.warning(
                    "The IRC bot was kicked from %s; joining it again", line.params[0]
                )
                await asyncio.sleep(5)
                await self._write("JOIN", line.params[0])

    @staticmethod
    def _same(a: str, b: str) -> bool:
        # RFC 1459 casemapping, which most networks use.
        table = str.maketrans("[]\\~", "{}|^")
        return a.lower().translate(table) == b.lower().translate(table)

    async def _privmsg(self, line: Line) -> None:
        nick = line.nick
        target, text = line.params[0], line.params[1]
        if nick is None or self._same(nick, self._nick):
            return
        if text.startswith("\x01"):
            # CTCP. An action (`/me waves`) is something said; nothing else is.
            if not text.startswith("\x01ACTION "):
                return
            text = f"_{nick} {text[8:].rstrip(chr(1))}_"
        channel_type: ChannelType
        if is_channel(target):
            channel_id, channel_type = target.lower(), "channel_public"
        else:
            # A private message to the bot: a direct room with that person.
            channel_id, channel_type = nick.lower(), "direct"
        account = line.tags.get("account")
        sender_id = (
            f"{ACCOUNT_ID_PREFIX}{account}"
            if account and account != "*"
            else f"{NICK_ID_PREFIX}{nick.lower()}"
        )
        # The server's id for the message, the same on every delivery, where
        # the network has one; IRC delivers nothing twice otherwise.
        message_ref = line.tags.get("msgid") or uuid.uuid4().hex
        stripped = strip_formatting(text).strip()
        if stripped.startswith("!") and self._on_command:
            parts = stripped.split(None, 1)
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=nick,
                    command=parts[0].lstrip("!"),
                    args=parts[1].strip() if len(parts) > 1 else "",
                    message_ref=message_ref,
                    channel_name=target if is_channel(target) else nick,
                )
            )
            return
        if self._on_message:
            await self._on_message(
                InboundMessage(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=nick,
                    content=text,
                    message_ref=message_ref,
                    channel_name=target if is_channel(target) else nick,
                )
            )

    # ── Sending ──────────────────────────────────────────────────────────

    async def _write(self, command: str, *params: str) -> None:
        writer = self._writer
        if writer is None:
            raise BridgeOperationError(
                f"The IRC bridge is not connected to {self.config.server} right now."
            )
        await self._pacer.wait()
        writer.write(format_line(command, *params).encode() + b"\r\n")
        await writer.drain()

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Post `content` in `channel_id`, each line led by the sender's name.

        IRC has no threads, so `thread_root_id` is ignored and a reply lands
        in the channel. A long line is cut to what the server relays whole,
        and a reply longer than `_MAX_REPLY_LINES` says how much it left out."""
        if not self._listening:
            for part in _relay_parts(content):
                self._hand_to_holder(
                    {
                        "action": "send",
                        "id": uuid.uuid4().hex,
                        "channel_id": channel_id,
                        "sender_name": sender_name,
                        "content": part,
                    }
                )
            return uuid.uuid4().hex
        prefix, lines = self._compose(channel_id, sender_name, content)
        await self._post(channel_id, prefix, lines)
        return uuid.uuid4().hex

    @staticmethod
    def _compose(
        channel_id: str, sender_name: str, content: str
    ) -> tuple[str, list[str]]:
        prefix = f"[{sender_name}] "
        budget = privmsg_budget(channel_id) - len(prefix.encode())
        lines = split_text(content, budget)
        if len(lines) > _MAX_REPLY_LINES:
            left = len(lines) - (_MAX_REPLY_LINES - 1)
            lines = [
                *lines[: _MAX_REPLY_LINES - 1],
                f"… {left} more lines not shown here; the whole reply is in Switch.",
            ]
        return prefix, lines

    async def _post(
        self,
        channel_id: str,
        prefix: str,
        lines: list[str],
        relay_id: str | None = None,
    ) -> None:
        """Write `lines`. For a relayed request, remember how many went out, so
        a retry after a write failed part-way sends only the rest."""
        async with self._send_lock:
            start = self._relay_progress.get(relay_id, 0) if relay_id else 0
            for index in range(start, len(lines)):
                await self._write("PRIVMSG", channel_id, prefix + lines[index])
                if relay_id:
                    self._relay_progress[relay_id] = index + 1
            if relay_id:
                self._relay_progress.setdefault(relay_id, len(lines))
                while len(self._relay_progress) > _RELAY_MEMORY:
                    del self._relay_progress[next(iter(self._relay_progress))]

    async def receive_relayed(self, request: Mapping[str, str]) -> None:
        if request.get("action") != "send":
            await super().receive_relayed(request)
            return
        prefix, lines = self._compose(
            request["channel_id"], request["sender_name"], request["content"]
        )
        await self._post(request["channel_id"], prefix, lines, request.get("id"))

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        """IRC has no edits: a line once sent stays as it was."""
        return None

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        """IRC has no deletes."""
        return None

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        """IRC has no typing indicator the bot can show."""
        return None

    # ── Channels ─────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        raise ChannelCreationUnsupported(
            "The IRC bot joins the channels named in its connection; it does "
            "not create new ones."
        )

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return "channel_public" if is_channel(channel_id) else "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        """Agents speak through the bot, which is in the channel already."""
        return None

    async def add_users_to_channel(
        self, channel_id: str, user_names: list[str], user_external_ids: list[str]
    ) -> list[str]:
        """A bot cannot bring people into a channel; they join it themselves."""
        return list(user_external_ids)

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        """An agent has no nick of its own: its name leads each of its lines."""
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    # ── Text ─────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return markdown_to_irc(content)

    def translate_inbound(self, raw_message: str) -> str:
        return strip_formatting(raw_message)


def _relay_parts(content: str) -> list[str]:
    """`content` in pieces of at most `_RELAY_PART_BYTES`, cut between lines
    where it can be, so each fits in one relayed request."""
    parts: list[str] = []
    current: list[str] = []
    size = 0
    for line in split_text(content, _RELAY_PART_BYTES):
        extra = len(line.encode()) + (1 if current else 0)
        if current and size + extra > _RELAY_PART_BYTES:
            parts.append("\n".join(current))
            current, size, extra = [], 0, len(line.encode())
        current.append(line)
        size += extra
    if current:
        parts.append("\n".join(current))
    return parts
