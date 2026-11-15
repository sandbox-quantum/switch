from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import re
import secrets
import ssl
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Mapping
from typing import ClassVar
from uuid import uuid4

from pydantic import Field, field_validator, model_validator

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    ChannelNotBindable,
    MessagePartlySent,
    PlatformAdapter,
    RequestCard,
    RichContent,
    TurnActivity,
)
from switch_core.bridges.collaboration.irc.client import (
    IrcLoginRefused,
    IrcNickTaken,
    IrcNotConnected,
    IrcSession,
)
from switch_core.bridges.collaboration.irc.markup import (
    IRC_MARKUP,
    from_irc,
    lines,
    to_irc,
)
from switch_core.bridges.collaboration.irc.protocol import (
    Line,
    casefold,
    is_channel,
    is_nick,
    text_budget,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    ChannelType,
    CreatedChannel,
    FailureReason,
    InboundAgentJoin,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    InboundUserJoin,
    RetireOutcome,
)
from switch_core.bridges.collaboration.session.renderers import Markup

logger = logging.getLogger(__name__)

# A hostname, or an IP address checked separately.
_HOSTNAME = re.compile(
    r"[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*"
)

# A person's id is the services account they were logged in to when they
# spoke, which only they can use. Someone not logged in is known by their nick
# alone, which anyone can take once they let go of it.
_ACCOUNT_ID = "account:"
_NICK_ID = "nick:"

# Room names become channel names: what is left after this, lowercased.
_CHANNEL_NAME_INVALID = re.compile(r"[^a-z0-9_-]+")

# Most networks cut a topic at 300 to 390 bytes (`TOPICLEN`), and the line
# that sets it has to fit in 512.
_TOPIC_MAX_BYTES = 300

# A display name long enough to crowd out what the agent said is cut, since
# it goes in front of every line.
_LABEL_MAX = 32

# A relayed request travels as a database notification, whose payload Postgres
# caps at 8000 bytes; a long message is handed over in parts under this.
_RELAY_MAX_BYTES = 6000

# The network's own services. What they say to the bot is not a person
# starting a conversation, and nothing an agent says should reach them.
_SERVICES = frozenset(
    {
        "nickserv",
        "chanserv",
        "memoserv",
        "operserv",
        "hostserv",
        "botserv",
        "saslserv",
        "histserv",
        "global",
        "alis",
    }
)

# How many cards and problems are remembered as already said again, so a
# redraw of one that has not changed says nothing.
_SAID_AGAIN_MAX = 1000

# A command is `!` and a word starting with a letter. Anything else that starts
# with `!` (`!!!`, `! look`, `!1`) is something said, not a command.
_COMMAND = re.compile(r"!([A-Za-z][\w-]*)(?:\s+(.*))?", re.DOTALL)

# When a channel message Switch could not take is read back again, while the
# connection stays up: soon, then less often, then every five minutes until it
# has been taken.
_READ_BACK_RETRY_SECONDS = (5.0, 30.0, 120.0, 300.0)
# How long one such read-back may take before it counts as failed.
_READ_BACK_TIMEOUT_SECONDS = 120.0

# Said in place of the rest of a message the connection dropped under.
_CUT_SHORT = "(The rest of this message did not reach IRC: the connection dropped.)"


def _server_address(server: str, port: int) -> str:
    host = f"[{server}]" if ":" in server else server
    return f"{host}:{port}"


class IrcConnectionConfig(BridgeConnectionConfig):
    server: str = Field(
        title="Server",
        description="The hostname of the IRC network's server, e.g. irc.example.net",
    )
    port: int = Field(
        default=6697,
        ge=1,
        le=65535,
        title="Port",
        description="6697 is TLS on most networks.",
    )
    tls: bool = Field(
        default=True,
        title="Use TLS",
        description="Turn off only for a server on your own network that has no TLS.",
    )
    verify_tls: bool = Field(
        default=True,
        title="Verify TLS certificate",
        description="Turn off only for a server with a self-signed certificate "
        "you trust.",
    )
    nick: str = Field(
        title="Nick",
        description="The bot's nick. Every agent speaks through it.",
    )
    account_name: str | None = Field(
        default=None,
        title="Account name",
        description="The services account the bot logs in to. Leave blank when "
        "it is the bot's nick.",
    )
    account_password: str | None = Field(
        default=None,
        title="Account password",
        description="The account's password, for SASL or, on a network without "
        "it, NickServ. Leave blank for a bot that is not registered.",
    )
    channels: str = Field(
        default="",
        title="Channels",
        description="Channels the bot joins, separated by commas, e.g. #ops, #deploys",
    )

    @field_validator("server")
    @classmethod
    def _server_is_a_host(cls, value: str) -> str:
        host = value.strip().strip("[]").lower()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if not _HOSTNAME.fullmatch(host):
                raise ValueError(
                    "server must be the IRC server's hostname alone, e.g. "
                    "irc.example.net, without a scheme or a port"
                ) from None
        return host

    @field_validator("nick")
    @classmethod
    def _nick_is_a_nick(cls, value: str) -> str:
        if not is_nick(value.strip()):
            raise ValueError(
                "nick must start with a letter or one of []\\`_^{|} and use "
                "letters, digits, those and '-', up to 30 characters"
            )
        return value.strip()

    @field_validator("account_name", "account_password")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        if any(char in value for char in "\r\n\x00 "):
            raise ValueError("must not contain spaces or line breaks")
        return value.strip()

    @field_validator("channels")
    @classmethod
    def _channels_are_channels(cls, value: str) -> str:
        names = [casefold(name) for name in re.split(r"[,\s]+", value) if name]
        for name in names:
            if not is_channel(name):
                raise ValueError(
                    f"{name!r} is not a channel name: it starts with # and has "
                    "no spaces, commas or colons"
                )
        return ",".join(dict.fromkeys(names))

    @model_validator(mode="after")
    def _password_only_over_tls(self) -> IrcConnectionConfig:
        if self.account_password is not None and not self.tls:
            raise ValueError(
                "Turn on TLS to log the bot in: without it the account password "
                "would cross the network in the clear"
            )
        return self

    @property
    def channel_list(self) -> list[str]:
        return [name for name in self.channels.split(",") if name]


def _ssl_context(config: IrcConnectionConfig) -> ssl.SSLContext | None:
    if not config.tls:
        return None
    context = ssl.create_default_context()
    if not config.verify_tls:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def _session(
    config: IrcConnectionConfig,
    *,
    resolve: Callable[[str, int], Awaitable[list[str]]],
    on_line: Callable[[Line], Awaitable[None]],
    on_registered: Callable[[], None],
) -> IrcSession:
    return IrcSession(
        host=config.server,
        port=config.port,
        ssl_context=_ssl_context(config),
        resolve=resolve,
        nick=config.nick,
        account=config.account_name,
        password=config.account_password,
        on_line=on_line,
        on_registered=on_registered,
    )


async def _any_address(host: str, port: int) -> list[str]:
    """The name itself: `asyncio.open_connection` resolves it."""
    return [host]


async def _ignore_line(_: Line) -> None:
    return None


def _person_id(line: Line) -> str:
    account = line.tags.get("account")
    if account and account != "*":
        return _ACCOUNT_ID + casefold(account)
    return _NICK_ID + casefold(line.nick or "")


def _nick_of(external_user_id: str) -> str | None:
    """The nick to reach a person by. An account's name is the nick it was
    registered with on most networks, so that is the one tried."""
    for prefix in (_ACCOUNT_ID, _NICK_ID):
        if external_user_id.startswith(prefix):
            nick = external_user_id.removeprefix(prefix)
            return nick if is_nick(nick) else None
    return None


def _message_ref(line: Line) -> str:
    """The network's own id for the message (`msgid`), the same on every
    delivery. Where it gives none, one derived from when the server says the
    message was sent and what it was, which a replay repeats. With no time on
    it either, the network never sends a message twice, so each arrival is a
    message of its own."""
    msgid = line.tags.get("msgid")
    if msgid:
        return msgid
    sent = line.tags.get("time")
    if sent is None:
        return f"irc-{uuid4().hex}"
    digest = hashlib.sha256(
        "\x00".join([sent, line.source or "", *line.params]).encode()
    )
    return f"irc-{digest.hexdigest()[:32]}"


def _channel_slug(name: str) -> str:
    """A room's name as a channel name, without the `#` or a suffix."""
    slug = _CHANNEL_NAME_INVALID.sub("-", name.strip().lower()).strip("-_")[:40]
    return slug or "switch"


def _new_channel(name: str) -> str:
    """A channel for a new room: its name, and a suffix that keeps it from
    walking into a channel someone else already has."""
    return f"#{_channel_slug(name)}-{secrets.token_hex(2)}"


def _relay_parts(texts: list[str]) -> list[list[str]]:
    parts: list[list[str]] = [[]]
    used = 0
    for text in texts:
        size = len(json.dumps(text)) + 2
        if parts[-1] and used + size > _RELAY_MAX_BYTES:
            parts.append([])
            used = 0
        parts[-1].append(text)
        used += size
    return parts


class IrcAdapter(PlatformAdapter):
    """IRC collaboration bridge adapter.

    One bot on the operator's network speaks for every agent, with the agent's
    name at the head of each line, since IRC has no way to send under another
    name. The bot dials out over TLS and logs in to its account with SASL, or
    NickServ where the network has no SASL.

    Only the process holding the bridge connects: a second connection would be
    a second user wanting the same nick. Every other process runs quietly and
    hands what needs the connection (a message, a join, a channel to create,
    an invitation, a channel to leave) to the holder (`receive_relayed`).

    A channel is a room, and a message sent to the bot directly is one too.
    IRC has no threads, edits, deletions, reactions, attachments, typing or
    user directory; each method below says what it does instead.
    """

    display_name: ClassVar[str] = "IRC"
    # Leaving is all a bot can do: a channel ends when its last member leaves.
    channel_on_delete = "left"
    keeps_quiet_unless_listening: ClassVar[bool] = True

    # A channel exists while anyone is in it, so creating one is joining a
    # name nobody uses (`_new_channel`).
    supports_channel_creation: ClassVar[bool] = True
    # The network can be asked who is online, not who exists: an account that
    # is not connected cannot be found.
    supports_directory_search: ClassVar[bool] = False
    # Clients linkify http(s); a `switchdash://` link would show as text.
    renders_custom_url_schemes: ClassVar[bool] = False
    # IRC has no reactions.
    supports_activity_reactions: ClassVar[bool] = False

    # Approval and question cards are posted as text and answered by typing
    # the handle the card prints. A turn's progress is not posted: it is a
    # status redrawn at every step, and IRC cannot redraw a line.
    draws_session_activity: ClassVar[bool] = True
    # A problem somebody has to act on is said in a line of its own, since
    # that is the one part of a turn worth saying.
    separate_attention_slot: ClassVar[bool] = True

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Connect, register and log in once, as `start` will, then quit.

        The server has been through the outbound policy before this is
        called, and the password goes only to it, over TLS.
        """
        config = IrcConnectionConfig.model_validate(connection_config)
        session = _session(
            config,
            resolve=_any_address,
            on_line=_ignore_line,
            on_registered=lambda: None,
        )
        address = _server_address(config.server, config.port)
        try:
            await session.check()
        except IrcLoginRefused as exc:
            raise BridgeCredentialError(
                f"{address} would not log the bot in as {config.nick}: {exc}. "
                "Check the nick, the account name and the password."
            ) from exc
        except IrcNickTaken as exc:
            raise BridgeCredentialError(
                f"The nick {config.nick} is in use on {address}: {exc}. Choose "
                "another nick, or wait for the connection using it to close."
            ) from exc
        except (OSError, TimeoutError) as exc:
            raise BridgeCredentialError(
                f"Could not reach the IRC server at {address}: "
                f"{exc or type(exc).__name__}. Check the server, the port and "
                "whether it uses TLS."
            ) from exc

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, IrcLoginRefused):
            return "auth_failed"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """The nick on its network. Two bridges with one nick would each knock
        the other off."""
        config = IrcConnectionConfig.model_validate(connection_config)
        address = _server_address(config.server, config.port)
        return f"IRC nick {casefold(config.nick)} on {address}"

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        # The policy checks http(s) URLs; the scheme only picks a default
        # port, and the port is given, so this names exactly what is dialled.
        config = IrcConnectionConfig.model_validate(connection_config)
        return [f"https://{_server_address(config.server, config.port)}"]

    @classmethod
    def unlinkable_account_reason(cls, external_user_id: str) -> str | None:
        if external_user_id.startswith(_NICK_ID):
            return (
                "This IRC user was not logged in to an account when they spoke, "
                "so anyone could have been using that nick. Log in to your "
                "network's account (SASL or NickServ) and post the code again."
            )
        return None

    @classmethod
    def link_code_instructions(
        cls, code: str, connection_config: Mapping[str, object]
    ) -> str:
        return (
            "Log in to your IRC network's account, then post "
            f"`!link-account {code}` in a channel the Switch bot is in, or send "
            "it to the bot directly."
        )

    def __init__(self, *, config: IrcConnectionConfig) -> None:
        super().__init__()
        self._config = config
        self._session: IrcSession | None = None
        # The longest nick the bot can be seen under: its own, or its account
        # name, which some networks' NickServ renames it to on login.
        self._longest_nick = max(config.nick, config.account_name or "", key=len)
        # message ref -> what was last said again in its place, by `update_rich`.
        # Losing it costs one repeat after a restart.
        self._said_again: OrderedDict[str, str] = OrderedDict()
        # Channels with a message Switch could not take on this connection.
        # Their read marker stays where it is, so the message is read back
        # (`_retry_read_back`, or the next connection); marking a later one
        # read would skip it.
        self._unrelayed: set[str] = set()
        # channel -> the task reading it back while the connection stays up.
        self._retries: dict[str, asyncio.Task[None]] = {}

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
        # One bot speaks for every agent, so no agent joins on its own.
        self._on_agent_joined = on_agent_joined
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        if not self._listening:
            logger.info(
                "IRC adapter for %s running quietly: another process holds this "
                "bridge and connects for it",
                self._config.nick,
            )
            return
        self._session = _session(
            self._config,
            resolve=self.outbound_policy.resolve,
            on_line=self._on_line,
            on_registered=self._unrelayed.clear,
        )
        for channel in self._config.channel_list:
            self._session.join(channel)
        try:
            await self._session.start()
        except BaseException:
            self._session = None
            raise
        logger.info(
            "IRC adapter started for %s as %s",
            _server_address(self._config.server, self._config.port),
            self._config.nick,
        )

    async def stop(self) -> None:
        retries = list(self._retries.values())
        for task in retries:
            task.cancel()
        await asyncio.gather(*retries, return_exceptions=True)
        if self._session is not None:
            await self._session.stop()
            self._session = None
        logger.info("IRC adapter stopped")

    async def receive_relayed(self, request: Mapping[str, str]) -> None:
        """Do what a quiet copy handed over. Never raises: a message is kept
        until the bot is connected to say it, and a join until it is
        connected to join, so nothing is retried by the relay meanwhile."""
        session = self._session
        if session is None:
            return
        action = request.get("action")
        if action == "say" and self._valid_target(request["target"]):
            session.queue(request["target"], request["lines"].split("\n"))
        elif action == "join" and is_channel(request["channel"]):
            session.join(
                request["channel"],
                topic=request["topic"],
                secret=request["secret"] == "yes",
            )
        elif (
            action == "invite"
            and is_channel(request["channel"])
            and is_nick(request["nick"])
        ):
            self._invite(session, request["nick"], request["channel"])
        elif action == "part" and is_channel(request["channel"]):
            session.part(request["channel"])
        else:
            logger.warning("Ignoring a relayed IRC request %r", dict(request))

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def _on_line(self, line: Line) -> None:
        if line.command == "JOIN":
            await self._joined(casefold(line.params[0]))
        elif line.command == "PRIVMSG":
            await self._received(line)

    async def _joined(self, channel: str) -> None:
        """The bot is in a channel: its room is made now rather than on the
        first message. A channel that has one already keeps it."""
        if self._on_app_joined is None:
            return
        await self._on_app_joined(
            InboundAppJoin(
                channel_id=channel,
                channel_type="channel_public",
                channel_name=channel.lstrip("#&"),
            )
        )

    async def _received(self, line: Line) -> None:
        session = self._session
        assert session is not None
        target, text = line.params
        in_channel = is_channel(target)
        if (
            line.nick is None
            or not (in_channel or casefold(target) == casefold(session.nick))
            or (not in_channel and casefold(line.nick) in _SERVICES)
        ):
            # From the server or its services, or to a channel's operators
            # only (`@#channel`), which no room stands for.
            return
        channel = casefold(target) if in_channel else casefold(line.nick)
        try:
            if not session.is_me(line):
                await self._relay(line, channel, in_channel, text)
        except Exception:
            self._unrelayed.add(channel)
            if in_channel:
                # A newer message's mark, held back while the channel is read
                # back, would skip this one once released.
                session.forget_held_mark(channel)
                self._schedule_read_back(channel)
            raise
        sent = line.tags.get("time")
        if in_channel and sent and channel not in self._unrelayed:
            session.mark_read(channel, sent)

    def _schedule_read_back(self, channel: str) -> None:
        """Read the channel back soon, so a message that failed to reach
        Switch while the connection stays up is not left waiting for the next
        reconnect, with the channel's read marker stuck before it."""
        if channel not in self._retries:
            self._retries[channel] = asyncio.create_task(
                self._retry_read_back(channel), name=f"irc-read-back-{channel}"
            )

    async def _retry_read_back(self, channel: str) -> None:
        attempt = 0
        try:
            while channel in self._unrelayed:
                await asyncio.sleep(
                    _READ_BACK_RETRY_SECONDS[
                        min(attempt, len(_READ_BACK_RETRY_SECONDS) - 1)
                    ]
                )
                attempt += 1
                session = self._session
                if session is None or channel not in self._unrelayed:
                    # Stopped, or a new connection read the channel back.
                    return
                if not session.keeps_history:
                    self._unrelayed.discard(channel)
                    logger.error(
                        "A message in IRC %s did not reach Switch and cannot be "
                        "read back: the network keeps no history with a read "
                        "marker",
                        channel,
                    )
                    return
                self._unrelayed.discard(channel)
                read = session.read_back(channel)
                if read is None:
                    # Not in the channel on this connection: the next join
                    # reads it back from the marker.
                    self._unrelayed.add(channel)
                    return
                try:
                    async with asyncio.timeout(_READ_BACK_TIMEOUT_SECONDS):
                        await read
                except TimeoutError:
                    self._unrelayed.add(channel)
                    logger.warning(
                        "Reading IRC %s back took too long; trying again", channel
                    )
        finally:
            self._retries.pop(channel, None)

    async def _relay(
        self, line: Line, channel: str, in_channel: bool, text: str
    ) -> None:
        """Hand one message to Switch. The bot's own lines never reach here:
        every agent speaks as the bot, so each one is an echo."""
        if text.startswith("\x01"):
            # CTCP. `/me` is relayed as what it shows; the rest are a client
            # asking the bot's client something, and are not Switch's.
            verb, _, body = text.strip("\x01").partition(" ")
            if verb != "ACTION" or not body.strip():
                return
            text = f"*{body.strip()}*"
        stripped = from_irc(text).strip()
        if not stripped:
            return
        assert line.nick is not None
        channel_type: ChannelType = "channel_public" if in_channel else "direct"
        sender_id = _person_id(line)
        channel_name = channel.lstrip("#&") if in_channel else line.nick
        command = _COMMAND.fullmatch(stripped)
        if command is not None:
            if self._on_command is not None:
                await self._on_command(
                    InboundCommand(
                        channel_id=channel,
                        channel_type=channel_type,
                        sender_id=sender_id,
                        sender_name=line.nick,
                        command=command.group(1),
                        args=(command.group(2) or "").strip(),
                        message_ref=_message_ref(line),
                        channel_name=channel_name,
                    )
                )
            return
        if self._on_message is None:
            return
        await self._on_message(
            InboundMessage(
                channel_id=channel,
                channel_type=channel_type,
                sender_id=sender_id,
                sender_name=line.nick,
                content=text,
                message_ref=_message_ref(line),
                channel_name=channel_name,
                self_mention_token=self._mentioned(stripped),
            )
        )

    def _mentioned(self, text: str) -> str | None:
        """The bot's nick, when the message addresses it the IRC way
        (`nick: …`) or names it with an `@`."""
        assert self._session is not None
        nick = re.escape(self._session.nick)
        if re.match(rf"{nick}[:,]", text, re.IGNORECASE) or re.search(
            rf"(?<![\w@])@{nick}\b", text, re.IGNORECASE
        ):
            return self._session.nick
        return None

    def translate_inbound(self, raw_message: str) -> str:
        return from_irc(raw_message)

    # ── Outbound ─────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return to_irc(content)

    def rich_markup(self) -> Markup:
        return IRC_MARKUP

    def escape_label_for_body(self, label: str) -> str:
        """Control characters out first: in a name they would colour or break
        the line it heads."""
        return super().escape_label_for_body(re.sub(r"[\x00-\x1f\x7f]", "", label))

    def render_app_mention(self, token: str) -> str:
        # On IRC a mention is the nick itself.
        return token

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        """Say `content` with the agent's name at the head of each line.
        IRC has no threads, so `thread_root_id` is not used."""
        label = (await self.agent_label_for_body(sender_name))[:_LABEL_MAX]
        return await self._say(channel_id, content, prefix=f"<{label}> ", wait=True)

    async def admin_message(
        self,
        channel_id: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        message_type: str | None = None,
        drawn: str | None = None,
    ) -> str | None:
        """As the bot itself, with no agent's name: a notice is Switch
        speaking. Queued rather than waited for, since a notice is often said
        while a message is being handled, and the next message should not wait
        for a long reply ahead of it to go out."""
        return await self._say(
            channel_id,
            self._admin_body(self.translate_outbound(content), drawn),
            prefix="",
            wait=False,
        )

    async def _say(
        self, target: str, text: str, *, prefix: str, wait: bool
    ) -> str | None:
        """Say `text` in a channel, or to a person, as lines that fit.

        IRC gives a message no id, so the reference returned is minted here; it
        names nothing on the network, since no message can be edited, deleted
        or replied to there. None when nothing was said.

        The holder waits for the lines to be written, unless told not to. A
        quiet copy hands them to the holder, and the reference then says they
        were handed over: the holder keeps them until it is connected to say
        them, and only its stopping first loses them, which it logs.

        Raises `MessagePartlySent` when the connection drops after some of the
        lines went out: sending the message again would repeat them. A line
        saying the rest is missing goes out once the bot is connected again.
        """
        if not self._valid_target(target):
            return None
        texts = lines(
            text, prefix=prefix, budget=text_budget(self._longest_nick, target)
        )
        if not texts:
            return None
        ref = uuid4().hex
        if self._session is None:
            if self._relay_to_holder is None:
                logger.error(
                    "Did not say a message in IRC %s: this process does not hold "
                    "the bridge and has no way to reach the one that does",
                    target,
                )
                return None
            for part, chunk in enumerate(_relay_parts(texts)):
                self._hand_to_holder(
                    {
                        "action": "say",
                        "target": target,
                        "lines": "\n".join(chunk),
                        # Two identical messages are still two messages.
                        "id": f"{ref}-{part}",
                    }
                )
            return ref
        if not wait:
            self._session.queue(target, texts)
            return ref
        try:
            await self._session.send(target, texts)
        except IrcNotConnected as error:
            if not error.written:
                logger.error("Did not say a message in IRC %s: %s", target, error)
                return None
            logger.error(
                "Only %d of %d lines of a message reached IRC %s: %s",
                error.written,
                len(texts),
                target,
                error,
            )
            if self._session is not None:
                self._session.queue(target, [_CUT_SHORT])
            raise MessagePartlySent(
                platform=self.platform_name,
                first_ref=ref,
                delivered=error.written,
                total=len(texts),
            ) from error
        return ref

    @staticmethod
    def _valid_target(target: str) -> bool:
        if is_channel(target) or is_nick(target):
            return True
        logger.error("Not saying anything to %r: it is no IRC channel or nick", target)
        return False

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """A card, or a problem with a turn, is said. A turn's progress is
        not: the reference returned stands for a status nobody is shown, and
        the agent's reply still reaches the channel as its own message."""
        if isinstance(content, TurnActivity) and content.error_summary is None:
            return uuid4().hex
        return await super().post_rich(channel_id, agent_name, content, thread_root_id)

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """IRC cannot redraw a line, so what changed is said again where it
        matters, once: a card when it is settled, and a problem that is new.
        The rest (a card being answered, a problem cleared) is not said."""
        if isinstance(content, RequestCard):
            if content.request.state not in ("resolved", "closed"):
                return
            said = "settled"
        elif content.error_summary is None:
            return
        else:
            said = content.error_summary
        if self._said_again.get(message_ref) == said:
            return
        await super().post_rich(channel_id, agent_name, content, thread_root_id)
        self._said_again[message_ref] = said
        self._said_again.move_to_end(message_ref)
        if len(self._said_again) > _SAID_AGAIN_MAX:
            self._said_again.popitem(last=False)

    def rich_fallback_text(self, content: RichContent) -> str:
        if isinstance(content, TurnActivity) and content.error_summary is not None:
            return self._rich_escape(content.error_summary)
        return super().rich_fallback_text(content)

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        logger.warning(
            "IRC cannot edit a message, so the change to %s in %s is not shown",
            message_ref,
            channel_id,
        )

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.warning(
            "IRC cannot take a message back, so %s stays in %s",
            message_ref,
            channel_id,
        )

    async def send_typing(
        self, channel_id: str, sender_name: str, is_typing: bool
    ) -> None:
        # IRC has no typing indicator a network passes on reliably.
        return None

    # ── Channels ─────────────────────────────────────────────────────────────

    @classmethod
    def channel_name_for(cls, room_name: str) -> str:
        return _channel_slug(room_name)

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        """Join a channel nobody uses yet, which makes it, with the bot as its
        operator. A private room's channel is secret and invite-only. Its
        name is given without the `#`, as every message from it names it."""
        channel = _new_channel(name)
        topic = re.sub(r"[\x00-\x1f]", " ", topic).strip()
        topic = topic.encode()[:_TOPIC_MAX_BYTES].decode(errors="ignore")
        self._join(channel, topic=topic, secret=channel_type != "channel_public")
        return CreatedChannel(id=channel, name=channel.lstrip("#&"))

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """Be in every channel a room is bound to, now and after every
        reconnect. A person's conversation with the bot needs no joining.

        A private room's channel is made secret and invite-only here too, if
        the bot finds it is the one creating it: so it is when the request to
        create it was relayed while no process held the bridge, and the
        holder that took it over comes to it from here.
        """
        for channel, channel_type in channels:
            if is_channel(channel):
                self._join(channel, topic="", secret=channel_type != "channel_public")

    def _join(self, channel: str, *, topic: str, secret: bool) -> None:
        if self._session is None:
            self._hand_to_holder(
                {
                    "action": "join",
                    "channel": channel,
                    "topic": topic,
                    "secret": "yes" if secret else "no",
                }
            )
        else:
            self._session.join(channel, topic=topic, secret=secret)

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        if not is_channel(external_channel_id):
            # A conversation with one person has nothing to leave.
            return RetireOutcome(outcome="kept")
        if self._session is None:
            self._hand_to_holder({"action": "part", "channel": external_channel_id})
        else:
            self._session.part(external_channel_id)
        return RetireOutcome(outcome="left")

    async def require_bindable_channel(self, channel_id: str) -> None:
        """A room is bound to a channel by its name, in lower case, which is
        how every message from it is told apart."""
        if not is_channel(channel_id) or channel_id != casefold(channel_id):
            raise ChannelNotBindable(
                f"{channel_id!r} is not an IRC channel id: give the channel's "
                f"name in lower case, e.g. {casefold(channel_id)!r}"
            )

    async def check_channel_usable(self, channel_id: str) -> None:
        """A room bound to an existing channel is joined now, from whichever
        process the binding reached, rather than at the holder's next start.
        Whether the network lets the bot in is known only to the holder, which
        logs a refusal; a channel nobody is in is created by joining it."""
        if is_channel(channel_id):
            self._join(channel_id, topic="", secret=False)

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        """The same answer on every process, from the id alone: none of them
        knows more without asking the network, which only the holder can."""
        return "channel_public" if is_channel(channel_id) else "direct"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents speak through the bot, which is in the channel already.
        return None

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """Invite each person, which on IRC is what adding is: the invitation
        lets them into an invite-only channel, and they join from their
        client. It reaches only someone online under that nick; the network
        says when they are not, and that is logged."""
        if not is_channel(channel_id):
            logger.warning(
                "Not inviting anyone to IRC %s: it is a conversation with one "
                "person, which nobody else can join",
                channel_id,
            )
            return list(user_external_ids)
        left_out: list[str] = []
        for external_id in user_external_ids:
            nick = _nick_of(external_id)
            if nick is None:
                left_out.append(external_id)
            elif self._session is None:
                self._hand_to_holder(
                    {"action": "invite", "channel": channel_id, "nick": nick}
                )
            elif not self._invite(self._session, nick, channel_id):
                left_out.append(external_id)
        return left_out

    @staticmethod
    def _invite(session: IrcSession, nick: str, channel: str) -> bool:
        """Invite `nick`, or log why not; whether the invitation is on its way."""
        try:
            session.invite(nick, channel)
        except IrcNotConnected as error:
            logger.warning("Could not invite %s to IRC %s: %s", nick, channel, error)
            return False
        return True

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    # ── Agent identity ───────────────────────────────────────────────────────

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # An agent's name travels at the head of each of its lines.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None
