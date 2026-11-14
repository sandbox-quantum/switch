"""IRC as a messaging platform: one bot on the operator's network.

The operator gives Switch a server, a nick and, optionally, the services
account the nick logs in to. Switch dials out over TLS, logs in with SASL
(or NickServ where the network has no SASL), and joins its channels. Every
agent speaks through that one bot, with its name at the start of each line.
A channel is a room; a conversation with the bot is a direct room.

IRC has no threads, edits, deletes, reactions or files, and a channel exists
only while somebody is in it; the adapter declares all of that, and its docs
page (`docs/messaging-platforms/irc.md`) says what happens instead.

Several pods: only the pod holding the bridge connects. A quiet copy hands
everything that needs the connection (a message, a card, a channel to join
or leave, an invite) to the holder (`_hand_to_holder`). Nothing another pod
needs is kept in memory: the holder's channels come from the bridge's rooms
on every start, and where the network keeps read markers
(`draft/read-marker`) the next holder reads back what it missed
(`draft/chathistory`) from where the last one stopped.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import random
import re
import ssl
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from switch_core.bridges.collaboration.adapter import (
    AgentIdentity,
    ChannelNotBindable,
    PlatformAdapter,
    RequestCard,
    RichContent,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.irc.client import (
    IrcConnection,
    IrcDisconnected,
    IrcLoginRefused,
    Outbox,
    Settings,
)
from switch_core.bridges.collaboration.irc.markup import (
    BOLD,
    MONO,
    RenderedLine,
    from_irc,
    to_irc,
    wrap,
)
from switch_core.bridges.collaboration.irc.protocol import (
    Line,
    LineError,
    build,
    casefold,
    is_channel,
    valid_channel,
    valid_nick,
)
from switch_core.bridges.collaboration.models import (
    BridgeConnectionConfig,
    BridgeCredentialError,
    ChannelRetirement,
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
from switch_core.bridges.collaboration.session.renderers.neutral import request_summary
from switch_core.sessions.contract import TURN_ENDED
from switch_core.signals import MAX_PAYLOAD_BYTES

logger = logging.getLogger(__name__)

# Marks a line from a fenced code block inside a rendered body, between
# `_render_outbound` and `send_message`, which cuts code and prose
# differently. It is a control character the renderer strips from any text it
# is given, so no message can carry one of its own.
_CODE_LINE = "\x1a"

_RECONNECT_FIRST = 1.0
_RECONNECT_MOST = 60.0
_LOGIN_RETRY = 60.0
_DRAIN_ON_STOP = 5.0
_READ_BACK_LIMIT = timedelta(hours=24)
_HISTORY_PAGE = 100
_MARK_EVERY = 2.0
# A relayed message whose parts never all arrive is given up after this.
_RELAY_PARTS_WITHIN = 60.0

# Network services, whose private messages are never relayed to a room.
_SERVICES = frozenset(
    {"nickserv", "chanserv", "memoserv", "operserv", "hostserv", "botserv", "global"}
)


class IrcConnectionConfig(BridgeConnectionConfig):
    server: str = Field(
        title="Server",
        description="The network's server name, for example irc.libera.chat.",
    )
    port: int = Field(
        default=6697,
        ge=1,
        le=65535,
        title="Port",
        description="6697 for TLS on most networks, 6667 without.",
    )
    tls: bool = Field(
        default=True,
        title="Use TLS",
        description="Connect encrypted. Required when the bot has a password.",
    )
    verify_tls: bool = Field(
        default=True,
        title="Check the server's certificate",
        description=(
            "Turn off only for a server you run yourself with a self-signed "
            "certificate."
        ),
    )
    nick: str = Field(
        title="Nick",
        description="The bot's nick on the network. Every agent speaks through it.",
    )
    account: str | None = Field(
        default=None,
        title="Services account",
        description=(
            "The account the nick logs in to (SASL, or NickServ where the "
            "network has no SASL). Leave empty for a bot without one."
        ),
    )
    password: str | None = Field(
        default=None,
        title="Services password",
        description="The services account's password.",
        repr=False,
    )
    channels: str = Field(
        default="",
        title="Channels",
        description=(
            "Channels to join, separated by commas, for example #project, #ops. "
            "Each becomes a room. The bot also joins a channel it is invited to."
        ),
    )
    accept_invites: bool = Field(
        default=True,
        title="Join when invited",
        description="Join a channel when someone invites the bot with /invite.",
    )

    @field_validator("server")
    @classmethod
    def _server(cls, value: str) -> str:
        value = value.strip().lower()
        if not value or not re.fullmatch(r"[a-z0-9.\-]+|\[?[0-9a-f:]+\]?", value):
            raise ValueError("Enter the server's name alone, like irc.libera.chat")
        return value.strip("[]")

    @field_validator("nick")
    @classmethod
    def _nick(cls, value: str) -> str:
        value = value.strip()
        if not valid_nick(value):
            raise ValueError(
                "A nick starts with a letter and uses letters, digits and -[]\\`_^{|}"
            )
        return value

    @field_validator("account", "password")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return value if value and value.strip() else None

    @field_validator("channels")
    @classmethod
    def _channels(cls, value: str) -> str:
        names = [name.strip() for name in value.split(",") if name.strip()]
        for name in names:
            if not valid_channel(name):
                raise ValueError(f"{name!r} is not a channel name, like #project")
        return ", ".join(names)

    @model_validator(mode="after")
    def _login(self) -> IrcConnectionConfig:
        if bool(self.account) != bool(self.password):
            raise ValueError(
                "Give both the services account and its password, or neither"
            )
        if self.password and not self.tls:
            raise ValueError(
                "Turn on TLS: the password would cross the network in clear text"
            )
        return self

    def channel_list(self) -> list[str]:
        return [name.strip() for name in self.channels.split(",") if name.strip()]

    def settings(self) -> Settings:
        return Settings(
            host=self.server,
            port=self.port,
            tls=self.tls,
            verify_tls=self.verify_tls,
            nick=self.nick,
            username=re.sub(r"[^a-z0-9]", "", self.nick.lower())[:10] or "switch",
            realname="Switch bridge",
            account=self.account,
            password=self.password,
        )


class _IrcMarkup(Markup):
    """Cards in IRC's own formatting codes, not Markdown's asterisks."""

    def bold(self, text: str) -> str:
        return f"{BOLD}{text}{BOLD}"

    def code(self, text: str) -> str:
        return f"{MONO}{text}{MONO}"

    def command(self, text: str) -> str:
        return self.code(text)


_IRC_MARKUP = _IrcMarkup()


def _said(error: BaseException) -> str:
    return str(error) or type(error).__name__


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:30] or "room"


class IrcAdapter(PlatformAdapter):
    display_name: ClassVar[str] = "IRC"
    # A channel exists while somebody is in it: creating one is joining a
    # fresh name, and the bot can only leave it when its room is deleted.
    supports_channel_creation: ClassVar[bool] = True
    channel_on_delete: ClassVar[ChannelRetirement] = "left"
    # The network can say who is online, not who exists.
    supports_directory_search: ClassVar[bool] = False
    # Clients linkify http(s) only.
    renders_custom_url_schemes: ClassVar[bool] = False
    # Cards are posted as text and answered by typing their handle.
    draws_session_activity: ClassVar[bool] = True
    separate_attention_slot: ClassVar[bool] = True
    # A client highlights a line only when it names the reader.
    notifies_only_by_mention: ClassVar[bool] = True
    keeps_quiet_unless_listening: ClassVar[bool] = True

    def __init__(self, *, config: IrcConnectionConfig) -> None:
        super().__init__()
        self.config = config
        self._outbox = Outbox()
        self._connection: IrcConnection | None = None
        self._runner: asyncio.Task[None] | None = None
        self._marker: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        # Channels the bot should be in, folded, with their names as given.
        self._wanted: dict[str, str] = {
            self._fold(name): name for name in config.channel_list()
        }
        self._joined: set[str] = set()
        # Channels this bot is creating, awaiting the names list that says
        # whether it made them: (topic, private).
        self._creating: dict[str, tuple[str, bool]] = {}
        # Invites held until a channel being set up is invite-only.
        self._invites_held: dict[str, list[str]] = {}
        # Read markers: the newest message relayed per channel, still to be
        # sent, and the channels being read back (their marker is held).
        self._marks_due: dict[str, str] = {}
        self._reading_back: dict[str, str | None] = {}
        self._cards_said: set[str] = set()
        # Pages of history being read: batch id -> [channel, lines, last msgid].
        self._batches: dict[str, list[Any]] = {}
        self._relayed_parts: dict[str, tuple[float, dict[int, list[str]]]] = {}

    # ── Declarations ─────────────────────────────────────────────────────────

    @classmethod
    def classify_failure(cls, exc: BaseException) -> FailureReason | None:
        if isinstance(exc, IrcLoginRefused):
            return "auth_failed"
        if isinstance(exc, ssl.SSLCertVerificationError):
            return "config_invalid"
        if isinstance(exc, (IrcDisconnected, ConnectionError, TimeoutError)):
            return "network"
        return None

    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        """One bridge per nick per network: two would fight over the nick."""
        server = str(connection_config.get("server") or "").strip().lower()
        nick = str(connection_config.get("nick") or "").strip()
        return f"irc {casefold(nick)}@{server}" if server and nick else None

    @classmethod
    def outbound_urls(cls, connection_config: dict[str, object]) -> list[str]:
        """The server, so the outbound policy checks its host and port.

        Written as an https URL only because a URL is what the policy reads;
        what it checks is the host, the port and every address the host
        resolves to.
        """
        server = str(connection_config.get("server") or "").strip()
        port = connection_config.get("port", 6697)
        return [f"https://{server}:{port}"] if server else []

    @classmethod
    def unlinkable_account_reason(cls, external_user_id: str) -> str | None:
        if external_user_id.startswith("nick:"):
            return (
                "Anyone can use a nick that is not logged in to the network's "
                "services, so it cannot be linked to a Switch account. Log in "
                "with your services account and send a message again."
            )
        return None

    @classmethod
    async def verify_credentials(cls, connection_config: dict[str, object]) -> None:
        """Connect, log in and leave, so a wrong nick or password is said now."""
        config = IrcConnectionConfig.model_validate(connection_config)
        connection = IrcConnection(config.settings(), on_line=_ignore)
        try:
            await connection.open(config.server)
        except IrcLoginRefused as error:
            raise BridgeCredentialError(error.reason) from error
        except ssl.SSLCertVerificationError as error:
            raise BridgeCredentialError(
                f"The certificate of {config.server} could not be verified "
                f"({error.verify_message}). Turn off checking only for a server "
                "you run yourself."
            ) from error
        except (OSError, TimeoutError) as error:
            raise BridgeCredentialError(
                f"Could not reach {config.server}:{config.port}: {_said(error)}"
            ) from error
        finally:
            await connection.close("Switch checked the login")

    @property
    def nick(self) -> str:
        return self._connection.nick if self._connection else self.config.nick

    @staticmethod
    def _fold(name: str) -> str:
        # Always rfc1459, whatever the network says: a channel id is stored with
        # the room and computed by every pod, connected or not, so it has to
        # come out the same everywhere. rfc1459 folds a superset of `ascii`.
        return casefold(name)

    def _chantypes(self) -> str:
        return self._connection.server.chantypes if self._connection else "#&"

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
        self._on_user_joined = on_user_joined
        self._on_app_joined = on_app_joined
        self._stopping.clear()
        if not self._listening:
            logger.info(
                "IRC bridge %s@%s running quietly: another process holds the connection",
                self.config.nick,
                self.config.server,
            )
            return
        # A refused login on the first start fails the start, so the operator
        # sees it at once; after that a refusal is retried.
        await self._connect()
        self._runner = asyncio.create_task(
            self._run(), name=f"irc-{self.config.nick}@{self.config.server}"
        )
        self._marker = asyncio.create_task(
            self._send_marks(), name=f"irc-marks-{self.config.server}"
        )

    async def stop(self) -> None:
        self._stopping.set()
        for task in (self._marker, self._runner):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._marker = self._runner = None
        connection, self._connection = self._connection, None
        if connection is not None:
            await connection.drain(_DRAIN_ON_STOP)
            if not self._outbox.empty():
                logger.error(
                    "IRC bridge %s@%s stopped with %d line(s) unsent",
                    self.config.nick,
                    self.config.server,
                    len(self._outbox.lines()),
                )
            await connection.close()
        self._outbox.fail_all(IrcDisconnected("The IRC bridge stopped"))
        self._joined.clear()

    async def _connect(self) -> None:
        """Dial an address the outbound policy allowed, trying each in turn,
        and never the name again: what it resolves to was checked just now."""
        addresses = await self.outbound_policy.resolve(
            self.config.server, self.config.port
        )
        last: BaseException | None = None
        for address in addresses:
            connection = IrcConnection(
                self.config.settings(), on_line=self._on_line, outbox=self._outbox
            )
            try:
                await connection.open(address)
            except IrcLoginRefused:
                raise
            except (OSError, TimeoutError) as error:
                last = error
                continue
            self._connection = connection
            self._joined.clear()
            for name in self._wanted.values():
                connection.send(build("JOIN", name), urgent=True)
            logger.info(
                "IRC bridge connected to %s as %s%s",
                self.config.server,
                connection.nick,
                f" (logged in as {connection.logged_in_as})"
                if connection.logged_in_as
                else "",
            )
            return
        raise IrcDisconnected(
            f"Could not reach {self.config.server}:{self.config.port}: "
            f"{_said(last) if last else 'it has no address'}"
        )

    async def _run(self) -> None:
        delay = _RECONNECT_FIRST
        while not self._stopping.is_set():
            connection = self._connection
            if connection is not None:
                try:
                    await connection.run()
                except IrcDisconnected as error:
                    logger.warning(
                        "IRC bridge lost %s: %s", self.config.server, _said(error)
                    )
                except Exception:
                    logger.exception(
                        "IRC bridge connection to %s failed", self.config.server
                    )
                self._connection = None
                self._joined.clear()
            wait = delay * random.uniform(0.5, 1.0)
            await asyncio.sleep(wait)
            try:
                await self._connect()
                delay = _RECONNECT_FIRST
            except IrcLoginRefused as error:
                logger.error(
                    "IRC bridge %s@%s: the network refused the login (%s). Retrying in %.0fs",
                    self.config.nick,
                    self.config.server,
                    error.reason,
                    _LOGIN_RETRY,
                )
                delay = _LOGIN_RETRY
            except Exception as error:
                logger.warning(
                    "IRC bridge could not reconnect to %s: %s. Retrying in %.0fs",
                    self.config.server,
                    _said(error),
                    delay * 2,
                )
                delay = min(delay * 2, _RECONNECT_MOST)

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        """Join every channel bridged to a room, on every start: the holder's
        channel list comes from the rooms, never from another process."""
        for channel_id, _ in channels:
            if is_channel(channel_id, self._chantypes()):
                self._want(channel_id)

    def _want(self, name: str) -> None:
        folded = self._fold(name)
        self._wanted.setdefault(folded, name)
        if self._connection is not None and folded not in self._joined:
            self._connection.send(build("JOIN", name), urgent=True)

    # ── Inbound ──────────────────────────────────────────────────────────────

    async def _on_line(self, line: Line) -> None:
        handler = _HANDLERS.get(line.command)
        if handler is not None:
            await handler(self, line)

    def _is_self(self, nick: str) -> bool:
        """The bot under its nick now or any fallback it may have used, so its
        own lines read back from history are known as echoes too."""
        folded = self._fold(nick)
        own = {self._fold(self.config.nick + "_" * n) for n in range(4)}
        return folded in own or folded == self._fold(self.nick)

    async def _on_privmsg(self, line: Line) -> None:
        if line.source is None or line.source.user is None:
            return  # A server's own line, not a person's.
        nick = line.source.nick
        account = line.tags.get("account")
        own_account = self._connection.logged_in_as if self._connection else None
        if self._is_self(nick) or (account and own_account and account == own_account):
            return  # Every agent speaks as the bot: its lines are echoes.
        target, text = line.param(0), line.param(1)
        if target[:1] in "@+%~&" and target[1:2] in self._chantypes():
            return  # Addressed to a channel's operators only.
        to_channel = is_channel(target, self._chantypes())
        if not to_channel and self._fold(nick) in _SERVICES:
            return
        if text.startswith("\x01"):
            body = text.strip("\x01")
            if not body.upper().startswith("ACTION "):
                return  # CTCP other than /me.
            text = f"*{body[7:]}*"
        channel_type: ChannelType
        if to_channel:
            channel_id, channel_type = self._fold(target), "channel_public"
        else:
            channel_id, channel_type = self._fold(nick), "direct"
        sender_id = f"account:{account}" if account else f"nick:{self._fold(nick)}"
        content = self.translate_inbound(text)
        message_ref = self._message_ref(line, nick, target, text)
        if not content:
            return
        if content.startswith("!") and self._on_command is not None:
            command, _, args = content[1:].partition(" ")
            await self._on_command(
                InboundCommand(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=nick,
                    command=command,
                    args=args.strip(),
                    message_ref=message_ref,
                    channel_name=target if to_channel else nick,
                )
            )
        elif self._on_message is not None:
            await self._on_message(
                InboundMessage(
                    channel_id=channel_id,
                    channel_type=channel_type,
                    sender_id=sender_id,
                    sender_name=nick,
                    content=content,
                    message_ref=message_ref,
                    channel_name=target if to_channel else nick,
                    self_mention_token=self.nick if self._names_bot(content) else None,
                )
            )
        stamp = line.tags.get("time")
        if to_channel and stamp:
            self._marked(channel_id, stamp)

    def _names_bot(self, content: str) -> bool:
        """Addressed IRC-style (`nick: …`) or as `@nick`."""
        folded = self._fold(content)
        own = self._fold(self.nick)
        return (
            folded.startswith((f"{own}:", f"{own},"))
            or re.search(rf"(?<![\w@])@{re.escape(own)}(?![\w-])", folded) is not None
        )

    @staticmethod
    def _message_ref(line: Line, nick: str, target: str, text: str) -> str:
        """The network's own `msgid`, the same on every delivery; otherwise a
        hash of when, who, where and what, which a replay repeats. Without a
        `time` tag a network never sends a line twice, so each gets its own."""
        msgid = line.tags.get("msgid")
        if msgid:
            return f"irc:{msgid}"
        stamp = line.tags.get("time")
        if stamp:
            digest = hashlib.sha256(
                "\0".join((stamp, nick, target, text)).encode()
            ).hexdigest()[:32]
            return f"irc:h{digest}"
        return f"irc:u{uuid.uuid4().hex}"

    async def _on_join(self, line: Line) -> None:
        if line.source is None or not self._is_self(line.source.nick):
            return
        name = line.param(0)
        folded = self._fold(name)
        first = folded not in self._joined
        self._joined.add(folded)
        self._wanted.setdefault(folded, name)
        if first and self._on_app_joined is not None:
            await self._on_app_joined(
                InboundAppJoin(
                    channel_id=folded, channel_type="channel_public", channel_name=name
                )
            )

    async def _on_part_or_kick(self, line: Line) -> None:
        name = line.param(0)
        gone = (
            line.param(1)
            if line.command == "KICK"
            else (line.source.nick if line.source else "")
        )
        if not self._is_self(gone):
            return
        folded = self._fold(name)
        self._joined.discard(folded)
        if line.command == "KICK":
            logger.warning(
                "IRC bridge was kicked from %s: %s", name, line.param(2) or "no reason"
            )

    async def _on_invite(self, line: Line) -> None:
        if not self.config.accept_invites or line.source is None:
            return
        if not self._is_self(line.param(0)):
            return
        channel = line.param(1)
        if valid_channel(channel, self._chantypes()):
            logger.info("IRC bridge invited to %s by %s", channel, line.source.nick)
            self._want(channel)

    async def _on_names(self, line: Line) -> None:
        """Whether the bot made a channel it is creating: it is then the only
        member, and an operator. Only then are its topic and modes set."""
        channel = self._fold(line.param(2))
        setup = self._creating.pop(channel, None)
        if setup is None or self._connection is None:
            return
        names = line.param(-1).split()
        made = (
            len(names) == 1
            and names[0][:1] in "~&@"
            and self._is_self(names[0].lstrip("~&@%+"))
        )
        if not made:
            logger.info(
                "IRC channel %s already existed; leaving it as it is", line.param(2)
            )
            for nick in self._invites_held.pop(channel, []):
                self._connection.send(build("INVITE", nick, line.param(2)), urgent=True)
            return
        topic, private = setup
        if private:
            self._connection.send(build("MODE", line.param(2), "+si"), urgent=True)
        if topic:
            self._connection.send(
                build("TOPIC", line.param(2), topic[:300]), urgent=True
            )
        for nick in self._invites_held.pop(channel, []):
            self._connection.send(build("INVITE", nick, line.param(2)), urgent=True)

    # ── Missed messages (read markers and history) ───────────────────────────

    def _has_history(self) -> bool:
        caps = self._connection.server.caps if self._connection else set()
        return "draft/chathistory" in caps and "draft/read-marker" in caps

    def _marked(self, channel: str, stamp: str) -> None:
        """A message in `channel` at `stamp` was relayed. While the channel is
        read back its marker is held, so a newer live message cannot move it
        past history still to come."""
        if not self._has_history():
            return
        if channel in self._reading_back:
            held = self._reading_back[channel]
            self._reading_back[channel] = stamp if held is None else max(held, stamp)
            return
        due = self._marks_due.get(channel)
        self._marks_due[channel] = stamp if due is None else max(due, stamp)

    async def _send_marks(self) -> None:
        """Send each channel's newest read marker every few seconds, so a
        busy channel costs one MARKREAD a period rather than one a message."""
        while True:
            await asyncio.sleep(_MARK_EVERY)
            if self._connection is None or not self._outbox.empty():
                continue
            due, self._marks_due = self._marks_due, {}
            for channel, stamp in due.items():
                name = self._wanted.get(channel, channel)
                self._connection.send(build("MARKREAD", name, f"timestamp={stamp}"))

    async def _on_markread(self, line: Line) -> None:
        """The network's read marker for a channel, sent after a JOIN: read
        back from it what was said while no process held the bridge."""
        if self._connection is None or not self._has_history():
            return
        name, marker = line.param(0), line.param(1)
        channel = self._fold(name)
        if not is_channel(name, self._chantypes()) or channel in self._reading_back:
            return
        if not marker.startswith("timestamp="):
            return  # `*`: a channel never read before has nothing to catch up.
        since = marker.removeprefix("timestamp=")
        floor = (datetime.now(UTC) - _READ_BACK_LIMIT).strftime(
            "%Y-%m-%dT%H:%M:%S.000Z"
        )
        if since < floor:
            logger.warning(
                "IRC bridge reading back %s from 24 hours ago, not from its last "
                "read marker (%s)",
                name,
                since,
            )
            since = floor
        self._reading_back[channel] = None
        self._connection.send(
            build(
                "CHATHISTORY", "AFTER", name, f"timestamp={since}", str(_HISTORY_PAGE)
            ),
            urgent=True,
        )

    async def _on_batch(self, line: Line) -> None:
        """The end of a page of history: ask for the next page if it was full,
        otherwise release the channel's held marker."""
        reference = line.param(0)
        if reference.startswith("+"):
            if line.param(1) == "chathistory":
                self._batches[reference[1:]] = [self._fold(line.param(2)), 0, None]
            return
        page = self._batches.pop(reference[1:], None)
        if page is None or self._connection is None:
            return
        channel, count, last_msgid = page
        name = self._wanted.get(channel, channel)
        if count >= _HISTORY_PAGE and last_msgid:
            self._connection.send(
                build(
                    "CHATHISTORY",
                    "AFTER",
                    name,
                    f"msgid={last_msgid}",
                    str(_HISTORY_PAGE),
                ),
                urgent=True,
            )
            return
        held = self._reading_back.pop(channel, None)
        if held:
            self._marks_due[channel] = max(self._marks_due.get(channel, held), held)

    async def _on_history_line(self, line: Line) -> None:
        batch = line.tags.get("batch")
        page = self._batches.get(batch) if batch else None
        if page is not None and line.command == "PRIVMSG":
            page[1] += 1
            page[2] = line.tags.get("msgid") or page[2]
        if line.command == "PRIVMSG":
            await self._on_privmsg(line)

    # ── Outbound ─────────────────────────────────────────────────────────────

    def _target(self, channel_id: str) -> str:
        return self._wanted.get(channel_id, channel_id)

    def _lines(self, target: str, sender_name: str, content: str) -> list[str]:
        """`content` (already rendered) as PRIVMSG lines, each prefixed with
        the sender and within the network's line length."""
        label = re.sub(r"[\x00-\x1f\x7f]", "", sender_name).strip() or "agent"
        prefix = f"<{label}> "
        connection = self._connection
        budget = (
            connection.text_budget("PRIVMSG", target)
            if connection
            else IrcConnection(self.config.settings(), on_line=_ignore).text_budget(
                "PRIVMSG", target
            )
        ) - len(prefix.encode())
        rendered = [
            RenderedLine(raw[1:], code=True)
            if raw.startswith(_CODE_LINE)
            else RenderedLine(raw)
            for raw in content.split("\n")
            if raw.strip(_CODE_LINE + " ")
        ]
        return [
            build("PRIVMSG", target, prefix + text) for text in wrap(rendered, budget)
        ]

    def _say(self, target: str, lines: list[str]) -> None:
        if self._listening:
            for line in lines:
                self._outbox.put(line)
            return
        self._relay_lines(target, lines)

    def _relay_lines(self, target: str, lines: list[str]) -> None:
        """Hand lines to the holder in parts that each fit one notification.
        Each part carries the message's id and its place, so two identical
        messages are not taken for one, and parts arriving out of order are
        put back in order before anything is said."""
        message_id = uuid.uuid4().hex
        limit = MAX_PAYLOAD_BYTES - 1000
        parts: list[list[str]] = [[]]
        size = 0
        for line in lines:
            cost = len(json.dumps(line).encode()) + 2
            if parts[-1] and size + cost > limit:
                parts.append([])
                size = 0
            parts[-1].append(line)
            size += cost
        for index, part in enumerate(parts):
            self._hand_to_holder(
                {
                    "action": "say",
                    "target": target,
                    "id": message_id,
                    "part": str(index),
                    "of": str(len(parts)),
                    "lines": json.dumps(part),
                }
            )

    async def receive_relayed(self, request: Mapping[str, str]) -> None:
        """Work a quiet copy handed to this process, which holds the bridge.
        Queued even while reconnecting: the outbox outlives the connection."""
        action = request.get("action")
        try:
            if action == "say":
                self._receive_part(request)
            elif action == "join":
                self._want(request["channel"])
            elif action == "create":
                self._create_here(
                    request["channel"],
                    request.get("topic", ""),
                    request.get("private") == "1",
                )
            elif action == "invite":
                nicks = json.loads(request["nicks"])
                if not isinstance(nicks, list) or not all(
                    isinstance(nick, str) and valid_nick(nick) for nick in nicks
                ):
                    raise ValueError("relayed nicks are not a list of nicks")
                self._invite_here(request["channel"], nicks)
            elif action == "part":
                self._part_here(request["channel"])
            else:
                logger.warning("Ignoring a relayed IRC request %r", action)
        except (KeyError, ValueError, LineError) as error:
            logger.error("Refusing a malformed relayed IRC request: %s", _said(error))

    def _receive_part(self, request: Mapping[str, str]) -> None:
        now = time.monotonic()
        for stale, (since, _) in list(self._relayed_parts.items()):
            if now - since > _RELAY_PARTS_WITHIN:
                logger.error("IRC bridge gave up on a relayed message missing parts")
                self._relayed_parts.pop(stale, None)
        message_id, count = request["id"], int(request["of"])
        lines = json.loads(request["lines"])
        if not isinstance(lines, list) or not all(isinstance(x, str) for x in lines):
            raise ValueError("relayed lines are not a list of strings")
        for line in lines:
            if not line.startswith("PRIVMSG ") or any(c in line for c in "\r\n\0"):
                raise ValueError("a relayed line is not a message")
        _, parts = self._relayed_parts.setdefault(message_id, (now, {}))
        parts[int(request["part"])] = lines
        if len(parts) < count:
            return
        self._relayed_parts.pop(message_id, None)
        for index in range(count):
            for line in parts[index]:
                self._outbox.put(line)

    async def send_message(
        self,
        channel_id: str,
        sender_name: str,
        content: str,
        thread_root_id: str | None = None,
        *,
        room_wide_mention: bool = False,
    ) -> str | None:
        target = self._target(channel_id)
        self._say(target, self._lines(target, sender_name, content))
        return f"irc:out-{uuid.uuid4().hex}"

    async def post_rich(
        self,
        channel_id: str,
        agent_name: str,
        content: RichContent,
        thread_root_id: str | None = None,
    ) -> str:
        """A request card as a message of its own, said once; a turn only when
        it failed. A turn's progress is a status redrawn at every step, which
        IRC cannot do, so it is not posted; the agent's reply still arrives as
        its own message."""
        if isinstance(content, RequestCard):
            key = f"{content.request.request_id}:open"
            self._cards_said.add(key)
            return await self._send_rich(
                channel_id, agent_name, self.rich_fallback_text(content)
            )
        if content.error_summary and content.turn.status in TURN_ENDED:
            return await self._say_failure(channel_id, agent_name, content)
        return f"irc:turn-{content.turn.turn_id}"

    async def update_rich(
        self,
        channel_id: str,
        agent_name: str,
        message_ref: str,
        content: RichContent,
        thread_root_id: str | None,
    ) -> None:
        """A line cannot be redrawn: a card is said again once, when it is
        settled, so the channel sees how it was answered; a turn that ended
        in failure is said once."""
        if isinstance(content, RequestCard):
            if content.request.result is None:
                return
            key = f"{content.request.request_id}:settled"
            if key in self._cards_said:
                return
            self._cards_said.add(key)
            await self._send_rich(
                channel_id, agent_name, self.rich_fallback_text(content)
            )
        elif content.error_summary and content.turn.status in TURN_ENDED:
            key = f"{content.turn.turn_id}:failed"
            if key not in self._cards_said:
                self._cards_said.add(key)
                await self._say_failure(channel_id, agent_name, content)

    async def _say_failure(
        self, channel_id: str, agent_name: str, content: TurnActivity
    ) -> str:
        text = self.translate_outbound(content.error_summary or "")
        return await self._send_rich(channel_id, agent_name, text)

    async def _send_rich(self, channel_id: str, agent_name: str, text: str) -> str:
        try:
            ref = await self.send_message(channel_id, agent_name, text)
        except (LineError, ValueError) as error:
            raise RichContentFailed(
                f"IRC could not send the message in {channel_id}: {_said(error)}",
                text=text,
            ) from error
        assert ref is not None
        return ref

    def rich_markup(self) -> Markup:
        return _IRC_MARKUP

    def rich_fallback_text(self, content: RichContent) -> str:
        """A card answered here names who answered by their IRC handle, as
        the channel knows them, rather than by their Switch identity."""
        if not isinstance(content, RequestCard) or not content.responder_external_id:
            return super().rich_fallback_text(content)
        responder = content.responder_external_id.split(":", 1)[-1]
        return request_summary(
            content.request,
            content.reference,
            escape=self._rich_escape,
            limit=self.rich_fallback_limit(),
            markup=self.rich_markup(),
            responder=self._rich_escape(responder),
            unavailable_reason=content.unavailable_reason,
        )

    def rich_fallback_limit(self) -> int:
        # Several lines are fine on IRC; past this a card floods the channel.
        return 1500

    async def update_message(
        self, channel_id: str, message_ref: str, new_content: str
    ) -> None:
        logger.debug("IRC cannot change a message that has been sent (%s)", message_ref)

    async def delete_message(self, channel_id: str, message_ref: str) -> None:
        logger.debug(
            "IRC cannot take back a message that has been sent (%s)", message_ref
        )

    async def send_typing(self, *args: Any, **kwargs: Any) -> None:
        # No typing indicator a network passes on reliably.
        return None

    # ── Channels ─────────────────────────────────────────────────────────────

    async def create_channel(
        self,
        name: str,
        topic: str,
        *,
        channel_type: ChannelType = "channel_public",
        owner_external_id: str | None = None,
    ) -> CreatedChannel:
        """Join a fresh channel: `#<room-name>-<4 hex>`, so it never walks
        into one somebody else uses, and two rooms of one name get two. Its id
        is the name folded as the network compares names, and its name the one
        people type."""
        channel = f"#{_slug(name)}-{uuid.uuid4().hex[:4]}"
        private = channel_type != "channel_public"
        if self._listening:
            self._create_here(channel, topic, private)
        else:
            self._hand_to_holder(
                {
                    "action": "create",
                    "channel": channel,
                    "topic": topic,
                    "private": "1" if private else "0",
                }
            )
        return CreatedChannel(id=self._fold(channel), name=channel)

    def _create_here(self, channel: str, topic: str, private: bool) -> None:
        self._creating[self._fold(channel)] = (topic, private)
        self._want(channel)

    async def add_users_to_channel(
        self,
        channel_id: str,
        user_names: list[str],
        user_external_ids: list[str],
    ) -> list[str]:
        """Invite each person by nick. Somebody known only by a services
        account cannot be invited by it, and is handed back."""
        nicks: list[str] = []
        left_out: list[str] = []
        for name, external_id in zip(user_names, user_external_ids, strict=True):
            nick = (
                external_id.removeprefix("nick:")
                if external_id.startswith("nick:")
                else name
            )
            if valid_nick(nick):
                nicks.append(nick)
            else:
                left_out.append(external_id)
        channel = self._target(channel_id)
        if nicks:
            if self._listening:
                self._invite_here(channel, nicks)
            else:
                self._hand_to_holder(
                    {"action": "invite", "channel": channel, "nicks": json.dumps(nicks)}
                )
        return left_out

    def _invite_here(self, channel: str, nicks: list[str]) -> None:
        folded = self._fold(channel)
        if folded in self._creating:
            # An invite sent before a channel is +i lets nobody in later.
            self._invites_held.setdefault(folded, []).extend(nicks)
            return
        for nick in nicks:
            self._outbox.put(build("INVITE", nick, channel), urgent=True)

    async def retire_channel(self, external_channel_id: str) -> RetireOutcome:
        channel = self._target(external_channel_id)
        if self._listening:
            self._part_here(channel)
        else:
            self._hand_to_holder({"action": "part", "channel": channel})
        return RetireOutcome(outcome="left")

    def _part_here(self, channel: str) -> None:
        folded = self._fold(channel)
        self._wanted.pop(folded, None)
        self._joined.discard(folded)
        self._outbox.put(
            build("PART", channel, "The room was deleted in Switch"), urgent=True
        )

    async def require_bindable_channel(self, channel_id: str) -> None:
        if not valid_channel(channel_id, self._chantypes()):
            raise ChannelNotBindable(
                f"{channel_id!r} is not an IRC channel. Give its name, like #project."
            )
        if self._listening:
            self._want(channel_id)
        else:
            self._hand_to_holder({"action": "join", "channel": channel_id})

    async def get_channel_type(self, channel_id: str) -> ChannelType:
        return (
            "channel_public" if is_channel(channel_id, self._chantypes()) else "direct"
        )

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        # Agents speak through the bot, which is already in the channel.
        return None

    async def get_channel_agent_names(self, channel_id: str) -> list[str]:
        return []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        # One bot speaks for every agent; there is no identity to create.
        return None

    async def remove_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    # ── Markup ───────────────────────────────────────────────────────────────

    def _render_outbound(self, content: str) -> str:
        return "\n".join(
            f"{_CODE_LINE}{line.text}" if line.code else line.text
            for line in to_irc(content)
        )

    def translate_inbound(self, raw_message: str) -> str:
        return from_irc(raw_message)


async def _ignore(line: Line) -> None:
    return None


_Handler = Callable[[IrcAdapter, Line], Awaitable[None]]

_HANDLERS: dict[str, _Handler] = {
    "PRIVMSG": IrcAdapter._on_history_line,
    "JOIN": IrcAdapter._on_join,
    "PART": IrcAdapter._on_part_or_kick,
    "KICK": IrcAdapter._on_part_or_kick,
    "INVITE": IrcAdapter._on_invite,
    "353": IrcAdapter._on_names,
    "MARKREAD": IrcAdapter._on_markread,
    "BATCH": IrcAdapter._on_batch,
}
