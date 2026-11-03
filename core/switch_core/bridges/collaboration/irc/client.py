"""The bot's connection to an IRC network, kept open until stopped.

One TCP connection, over TLS unless the operator turned it off, made to an
address the outbound policy allowed just before. Registration negotiates the
IRCv3 capabilities the bridge uses and logs the bot in to its account: SASL
PLAIN where the network offers it, NickServ where it does not. After that the
connection is read for messages, answered when the server pings it, and
dialled again with backoff when it drops.

Everything the bot sends after registering goes through one paced writer: a
burst of `_BURST` lines, then one every `_LINE_INTERVAL_SECONDS`, which is
what keeps a long reply from getting the bot disconnected for flooding.

Where the network keeps history (`draft/chathistory`) and a read marker the
account owns (`draft/read-marker`), each channel is read back on every join
from where the marker says the bot last read it. The marker is the network's,
so it is the same for whichever process holds the bridge next. Elsewhere,
what is said while nobody is connected is lost, and said so in the log.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import random
import re
import ssl
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from switch_core.bridges.collaboration.irc.protocol import (
    NICK_FALLBACKS,
    Line,
    build,
    casefold,
    is_channel,
    parse,
)

logger = logging.getLogger(__name__)

_CONNECT_TIMEOUT_SECONDS = 15.0
_REGISTER_TIMEOUT_SECONDS = 30.0
# How long NickServ has to confirm a login before it counts as refused.
_NICKSERV_TIMEOUT_SECONDS = 15.0
# How long a send waits for a connection being made again.
_SEND_WAIT_SECONDS = 15.0
# How long stopping waits for lines already queued to go out.
_DRAIN_SECONDS = 5.0
_FIRST_RETRY_SECONDS = 1.0
_LAST_RETRY_SECONDS = 60.0
# Silence after which the bot pings the server; twice as long and the
# connection is taken to be dead.
_IDLE_SECONDS = 120.0

# Most networks let a client send a handful of lines at once and then about
# one a second before they start delaying it, and disconnect it for "excess
# flood" soon after.
_BURST = 5
_LINE_INTERVAL_SECONDS = 1.0

# Lines asked for per `CHATHISTORY` request; the network's own limit
# (`ISUPPORT CHATHISTORY`) wins when it is lower.
_HISTORY_PAGE = 100
# How far back a channel is read at most. A marker can be far older than any
# outage, and relaying days of conversation would hand agents talk nobody
# asked them about.
_HISTORY_LIMIT = timedelta(days=1)

_SASL_CHUNK = 400
_USERNAME = "switch"
_REALNAME = "Switch"

_TIMESTAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z")
_MSGID = re.compile(r"[^\s\x00-\x1f,]{1,128}")

# What reading a channel back takes: its history, the read marker, the time
# and id each message was sent with, and the batch a page arrives in.
_HISTORY_CAPS = frozenset(
    {"draft/chathistory", "draft/read-marker", "server-time", "message-tags", "batch"}
)
# Who sent a message, by account; and the bot's own login, which NickServ on
# some networks (Ergo) confirms only this way.
_WANTED_CAPS = frozenset({"account-tag", "account-notify", *_HISTORY_CAPS})

# Numerics that end a login: the nick is not one the network takes (432), a
# ban (465), or a SASL failure (902 nick locked, 904 failed, 905 too long).
_REFUSALS = {"432", "465", "902", "904", "905"}

# The prefixes a channel's operators carry in a names list (`ISUPPORT PREFIX`).
_OPERATOR_PREFIXES = "~&@"


class IrcLoginRefused(Exception):
    """The network would not register the bot or log it in, which trying
    again soon will not change: the nick or the password has to."""


class IrcNickTaken(Exception):
    """Every nick the bot tries is in use, most often by a connection of its
    own that has not timed out yet. It frees up by itself."""


class IrcNotConnected(RuntimeError):
    """The bot has no registered connection to send on."""


@dataclass
class _History:
    """One `chathistory` batch being read: which channel, how many lines it
    carried and the last one's id and time, to ask for the next page from."""

    channel: str
    received: int = 0
    last_msgid: str | None = None
    last_time: str | None = None


@dataclass
class _Setup:
    """What to make of a channel the bot has just created, once it is in it,
    and who to invite then: an invitation to a channel that is not
    invite-only yet does not let anyone in once it is."""

    topic: str
    secret: bool
    invites: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _CaughtUp:
    """Handed over after a channel's history, in line with its messages: the
    channel is read back as far as the network keeps it."""

    channel: str


@dataclass
class _Queued:
    line: str
    # Settled once the line is written, for a sender that waits; None for one
    # that does not, whose line is kept across a reconnect.
    written: asyncio.Future[None] | None


class IrcSession:
    """The bot's one connection, from `start` until `stop`.

    Lines a handler should see (messages, and the bot's own joins) are queued
    and handed to `on_line` one at a time, in the order they arrived, by a
    task of their own, so a slow handler never holds up answering a ping.
    """

    def __init__(
        self,
        *,
        host: str,
        port: int,
        ssl_context: ssl.SSLContext | None,
        resolve: Callable[[str, int], Awaitable[list[str]]],
        nick: str,
        account: str | None,
        password: str | None,
        on_line: Callable[[Line], Awaitable[None]],
        on_registered: Callable[[], None],
    ) -> None:
        self._host = host
        self._port = port
        self._ssl = ssl_context
        self._resolve = resolve
        self._wanted_nick = nick
        self._account_name = account or nick
        self._password = password
        self._on_line = on_line
        self._on_registered = on_registered

        # The connection as it stands, reset by `_reset` for each new one.
        self.nick = nick
        self.account: str | None = None
        self.caps: set[str] = set()
        self._writer: asyncio.StreamWriter | None = None
        self._registered = asyncio.Event()
        self._history_page = _HISTORY_PAGE
        self._histories: dict[str, _History] = {}
        # Channels joined, or being joined, on this connection.
        self._joining: set[str] = set()
        # Channels joined on this connection whose read marker the network has
        # not sent yet; the first one it sends says where to read back from.
        self._awaiting_marker: set[str] = set()
        # Channels joined on this connection whose members are not known yet,
        # which say whether the bot has just created the channel.
        self._awaiting_names: set[str] = set()
        self._allowance = float(_BURST)
        self._allowance_at = 0.0
        # Lines for the writer. What keeps the bot in its channels goes ahead
        # of messages, so a room being made does not wait behind a reply.
        self._control: deque[str] = deque()
        self._outbox: deque[_Queued] = deque()
        self._marks: dict[str, str] = {}
        self._wake = asyncio.Event()
        # Set while the writer has nothing left to write.
        self._idle = asyncio.Event()

        # What every connection is brought to.
        self._channels: dict[str, None] = {}
        self._setups: dict[str, _Setup] = {}

        # Kept in the order lines are handed over rather than read: channels
        # being read back, whose markers wait until their history has been.
        # Marking a newer message first would skip what is still to come.
        self._reading_back: set[str] = set()
        self._held_marks: dict[str, str] = {}

        self._events: asyncio.Queue[Line | _CaughtUp] = asyncio.Queue()
        self._tasks: list[asyncio.Task[None]] = []

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        """Connect and register once, then keep connected in the background.

        A refused login, or a server the outbound policy refuses, is raised
        here: neither changes by trying again. A network that cannot be
        reached, or a nick still taken, is logged and tried again, as it is
        after a drop.
        """
        first: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._tasks = [
            asyncio.create_task(self._connect_forever(first), name="irc-connection"),
            asyncio.create_task(self._deliver_forever(), name="irc-events"),
        ]
        try:
            await first
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        """Finish what is being said, for a little while, then quit. The
        process holding the bridge next does not have it to say."""
        writer = self._writer
        if writer is not None and self.registered:
            try:
                async with asyncio.timeout(_DRAIN_SECONDS):
                    await self._idle.wait()
            except TimeoutError:
                pass
            try:
                writer.write(f"{build('QUIT', 'Switch is disconnecting')}\r\n".encode())
                async with asyncio.timeout(2):
                    await writer.drain()
            except (OSError, TimeoutError):
                pass
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        if self._outbox:
            logger.error(
                "%d message line(s) for %s were not sent: the bridge stopped first",
                len(self._outbox),
                self._host,
            )
            self._fail_waiting()
            self._outbox.clear()

    async def check(self) -> None:
        """Connect, register and log in once, then leave: a credential check."""
        reader, writer = await self._open()
        try:
            await self._register(reader, writer)
            writer.write(f"{build('QUIT', 'Checked')}\r\n".encode())
            await writer.drain()
        finally:
            writer.close()

    # ── What the bridge asks for ─────────────────────────────────────────────

    @property
    def registered(self) -> bool:
        return self._registered.is_set()

    def is_me(self, line: Line) -> bool:
        """Whether the bot sent `line`, under its nick now or, in a channel's
        history, under the account it is logged in to."""
        if line.nick is not None and casefold(line.nick) == casefold(self.nick):
            return True
        account = line.tags.get("account")
        return (
            account is not None
            and self.account is not None
            and casefold(account) == casefold(self.account)
        )

    def join(self, channel: str, *, topic: str = "", secret: bool = False) -> None:
        """Be in `channel` from now on, on this connection and every later
        one. If the bot turns out to be creating it, it is given `topic`, and
        made secret and invite-only when `secret`; a channel that already
        exists is left as it is."""
        self._channels[channel] = None
        if (topic or secret) and channel not in self._joining:
            self._setups.setdefault(channel, _Setup(topic=topic, secret=secret))
        if self.registered and channel not in self._joining:
            self._joining.add(channel)
            self._enqueue(build("JOIN", channel))

    def part(self, channel: str) -> None:
        self._channels.pop(channel, None)
        self._setups.pop(channel, None)
        if self.registered and channel in self._joining:
            self._joining.discard(channel)
            self._enqueue(build("PART", channel, "This room was deleted in Switch"))

    def invite(self, nick: str, channel: str) -> None:
        setup = self._setups.get(channel)
        if setup is not None:
            setup.invites.append(nick)
            return
        self._require_registered()
        self._enqueue(build("INVITE", nick, channel))

    def queue(self, target: str, texts: list[str]) -> None:
        """Queue one `PRIVMSG` per text without waiting for them to go out.
        They are kept until they can be, across a reconnect."""
        for line in [build("PRIVMSG", target, text) for text in texts]:
            self._enqueue(line)

    async def send(self, target: str, texts: list[str]) -> None:
        """Say `texts` and return once every line is written, waiting a while
        for a connection being made again. Raises `IrcNotConnected` if there
        is none, or if it drops before every line is out: the sender is told,
        so nothing it gave up on is sent later."""
        try:
            async with asyncio.timeout(_SEND_WAIT_SECONDS):
                await self._registered.wait()
        except TimeoutError:
            raise IrcNotConnected(
                f"not connected to {self._host} for {_SEND_WAIT_SECONDS:.0f}s"
            ) from None
        lines = [build("PRIVMSG", target, text) for text in texts]
        futures = [asyncio.get_running_loop().create_future() for _ in lines]
        for line, written in zip(lines, futures, strict=True):
            self._enqueue(line, written)
        await asyncio.gather(*futures)

    def mark_read(self, channel: str, timestamp: str) -> None:
        """Move the channel's read marker up to `timestamp`. Coalesced: only
        the latest waiting for the writer is sent."""
        if "draft/read-marker" not in self.caps or not _TIMESTAMP.fullmatch(timestamp):
            return
        if channel in self._reading_back:
            _keep_latest(self._held_marks, channel, timestamp)
        elif _keep_latest(self._marks, channel, timestamp):
            self._idle.clear()
            self._wake.set()

    def _require_registered(self) -> None:
        if not self.registered:
            raise IrcNotConnected(f"not connected to {self._host}")

    def _enqueue(self, line: str, written: asyncio.Future[None] | None = None) -> None:
        if line.startswith("PRIVMSG "):
            self._outbox.append(_Queued(line, written))
        else:
            self._control.append(line)
        self._idle.clear()
        self._wake.set()

    # ── The connection ───────────────────────────────────────────────────────

    async def _connect_forever(self, first: asyncio.Future[None]) -> None:
        delay = _FIRST_RETRY_SECONDS
        try:
            while True:
                try:
                    reader, writer = await self._open()
                    try:
                        await self._register(reader, writer)
                        self._registered.set()
                        if not first.done():
                            first.set_result(None)
                        delay = _FIRST_RETRY_SECONDS
                        await self._run(reader, writer)
                    finally:
                        self._registered.clear()
                        writer.close()
                        self._fail_waiting()
                except asyncio.CancelledError:
                    raise
                except (OSError, TimeoutError, IrcNickTaken) as error:
                    logger.warning("IRC connection to %s failed: %r", self._host, error)
                except IrcLoginRefused as refused:
                    if not first.done():
                        raise
                    logger.error(
                        "%s refused to log the bot in, so nothing reaches Switch "
                        "from IRC: %s. Check the bridge's nick, account name and "
                        "password.",
                        self._host,
                        refused,
                    )
                    delay = _LAST_RETRY_SECONDS
                except Exception:
                    if not first.done():
                        raise
                    # A server the policy now refuses, or a line this cannot
                    # read: the connection is made again rather than given up.
                    logger.exception("IRC connection to %s failed", self._host)
                    delay = _LAST_RETRY_SECONDS
                if not first.done():
                    first.set_result(None)
                wait = delay * random.uniform(0.5, 1.0)
                logger.info("Reconnecting to %s in %.1fs", self._host, wait)
                await asyncio.sleep(wait)
                delay = min(delay * 2, _LAST_RETRY_SECONDS)
        except BaseException as error:
            # A refusal on the first attempt, an address the policy refuses,
            # or a stop before the first attempt finished: `start` says so.
            if not first.done():
                if isinstance(error, asyncio.CancelledError):
                    first.set_exception(IrcNotConnected("stopped while connecting"))
                else:
                    first.set_exception(error)
                    return
            raise

    async def _open(self) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """Connect to an address `resolve` allowed, resolved just now, so the
        name cannot resolve somewhere else between the check and the
        connection; each in turn until one answers. TLS still checks the
        certificate against the name."""
        addresses = await self._resolve(self._host, self._port)
        failure: Exception | None = None
        for address in addresses:
            try:
                async with asyncio.timeout(_CONNECT_TIMEOUT_SECONDS):
                    return await asyncio.open_connection(
                        address,
                        self._port,
                        ssl=self._ssl,
                        server_hostname=self._host if self._ssl is not None else None,
                        # A line's tags may take 8191 bytes beside its 512.
                        limit=8192 + 512,
                    )
            except (OSError, TimeoutError) as error:
                failure = error
        assert failure is not None
        raise failure

    def _reset(self, writer: asyncio.StreamWriter) -> None:
        self._writer = writer
        self.nick = self._wanted_nick
        self.account = None
        self.caps = set()
        self._history_page = _HISTORY_PAGE
        self._histories.clear()
        self._joining.clear()
        self._awaiting_marker.clear()
        self._awaiting_names.clear()
        self._control.clear()
        self._marks.clear()
        self._allowance = float(_BURST)
        self._allowance_at = asyncio.get_running_loop().time()

    async def _register(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """CAP negotiation, SASL, NICK and USER, until the server welcomes the
        bot; then NickServ, where the account is not logged in yet."""
        self._reset(writer)
        self._write(build("CAP", "LS", "302"))
        self._write(build("NICK", self.nick))
        self._write(build("USER", _USERNAME, "0", "*", _REALNAME))
        offered: dict[str, str] = {}
        fallbacks = 0
        async with asyncio.timeout(_REGISTER_TIMEOUT_SECONDS):
            while True:
                line = await self._next(reader)
                command = line.command
                if command == "CAP" and len(line.params) >= 3:
                    self._negotiate(line, offered)
                elif command == "AUTHENTICATE" and line.params == ("+",):
                    self._authenticate()
                elif command in ("903", "907"):
                    self._write(build("CAP", "END"))
                elif command == "433" and fallbacks < NICK_FALLBACKS:
                    fallbacks += 1
                    self.nick = self._wanted_nick + "_" * fallbacks
                    logger.warning(
                        "%s says the nick %s is in use; registering as %s",
                        self._host,
                        self._wanted_nick,
                        self.nick,
                    )
                    self._write(build("NICK", self.nick))
                elif command == "433" or (command == "432" and fallbacks):
                    # Taken, or a fallback longer than the network allows.
                    raise IrcNickTaken(_said(line))
                elif command in _REFUSALS:
                    raise IrcLoginRefused(_said(line))
                elif command == "ERROR":
                    raise ConnectionError(
                        f"{self._host} closed the link: {_said(line)}"
                    )
                elif command == "001":
                    self.nick = line.params[0]
                    break
                else:
                    await self._handle(line)
        if self._password is not None and self.account is None:
            await self._identify(reader)
        self._on_registered()

    def _negotiate(self, line: Line, offered: dict[str, str]) -> None:
        verb = line.params[1].upper()
        if verb == "LS":
            for item in line.params[-1].split():
                name, _, value = item.partition("=")
                offered[name] = value
            if line.params[2] == "*":
                return
            wanted = sorted(_WANTED_CAPS & offered.keys())
            mechanisms = offered.get("sasl")
            if (
                self._password is not None
                and mechanisms is not None
                and (not mechanisms or "PLAIN" in mechanisms.upper().split(","))
            ):
                wanted.append("sasl")
            if wanted:
                self._write(build("CAP", "REQ", " ".join(wanted)))
            else:
                self._write(build("CAP", "END"))
        elif verb == "ACK":
            self.caps.update(cap for cap in line.params[-1].split() if cap[0] != "-")
            if "sasl" in self.caps and self._password is not None:
                self._write(build("AUTHENTICATE", "PLAIN"))
            else:
                self._write(build("CAP", "END"))
        elif verb == "NAK":
            # Refused as a set, so none of it is on: carry on without.
            self._write(build("CAP", "END"))

    def _authenticate(self) -> None:
        assert self._password is not None
        token = f"{self._account_name}\0{self._account_name}\0{self._password}"
        encoded = base64.b64encode(token.encode()).decode()
        chunks = [
            encoded[i : i + _SASL_CHUNK] for i in range(0, len(encoded), _SASL_CHUNK)
        ]
        if len(chunks[-1]) == _SASL_CHUNK:
            chunks.append("+")
        for chunk in chunks:
            self._write(build("AUTHENTICATE", chunk))

    async def _identify(self, reader: asyncio.StreamReader) -> None:
        """Log in through NickServ, on a network without SASL, and wait for
        the network to say the account is logged in: 900, or the bot's own
        `ACCOUNT` where services do not send that."""
        assert self._password is not None
        self._write(
            build(
                "PRIVMSG", "NickServ", f"IDENTIFY {self._account_name} {self._password}"
            )
        )
        said = "nothing"
        try:
            async with asyncio.timeout(_NICKSERV_TIMEOUT_SECONDS):
                while self.account is None:
                    line = await self._next(reader)
                    if line.command == "NOTICE" and casefold(line.nick or "") == (
                        "nickserv"
                    ):
                        said = repr(_said(line))
                    await self._handle(line)
        except TimeoutError:
            raise IrcLoginRefused(
                f"NickServ did not log {self._account_name} in; it said {said}"
            ) from None

    async def _run(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        if not _HISTORY_CAPS <= self.caps:
            logger.warning(
                "%s does not offer channel history with a read marker, so "
                "anything said in the bot's channels while Switch was not "
                "connected is not relayed",
                self._host,
            )
        self._join_all()
        # Whichever ends first ends the connection: the server closing it, or
        # a write that failed.
        tasks = {
            asyncio.create_task(self._read(reader), name="irc-reader"),
            asyncio.create_task(self._pace(writer), name="irc-writer"),
        }
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        for task in done:
            task.result()

    async def _read(self, reader: asyncio.StreamReader) -> None:
        while True:
            line = await self._next(reader, ping_when_idle=True)
            if line.command == "ERROR":
                raise ConnectionError(f"{self._host} closed the link: {_said(line)}")
            await self._handle(line)

    def _join_all(self) -> None:
        """Join every channel, a few to a line."""
        batch: list[str] = []
        for channel in self._channels:
            if batch and len(",".join([*batch, channel]).encode()) > 400:
                self._enqueue(build("JOIN", ",".join(batch)))
                batch = []
            batch.append(channel)
            self._joining.add(channel)
        if batch:
            self._enqueue(build("JOIN", ",".join(batch)))

    async def _next(
        self, reader: asyncio.StreamReader, *, ping_when_idle: bool = False
    ) -> Line:
        """The next line from the server, answering its pings on the way."""
        pinged = False
        while True:
            try:
                async with asyncio.timeout(_IDLE_SECONDS):
                    raw = await reader.readline()
            except TimeoutError:
                if not ping_when_idle or pinged:
                    raise
                pinged = True
                self._write(build("PING", "switch"))
                continue
            if not raw:
                raise ConnectionError(f"{self._host} closed the connection")
            text = raw.decode(errors="replace").rstrip("\r\n")
            if not text:
                continue
            try:
                line = parse(text)
            except ValueError:
                continue
            if line.command == "PING":
                self._write(build("PONG", *line.params[-1:]))
                if self.registered and casefold(self.nick) != casefold(
                    self._wanted_nick
                ):
                    # Taken back once whoever had it lets go.
                    self._write(build("NICK", self._wanted_nick))
                continue
            return line

    def _write(self, line: str) -> None:
        """Write a line now, outside the pace: registration, and the answers
        the server is owed."""
        assert self._writer is not None
        self._writer.write(f"{line}\r\n".encode())

    async def _handle(self, line: Line) -> None:
        command, params = line.command, line.params
        mine = line.nick is not None and casefold(line.nick) == casefold(self.nick)
        history = self._histories.get(line.tags.get("batch", ""))
        if history is not None:
            # Every line counts towards the page, whatever its command.
            history.received += 1
            history.last_msgid = line.tags.get("msgid", history.last_msgid)
            history.last_time = line.tags.get("time", history.last_time)
        if command == "PRIVMSG" and len(params) == 2:
            self._events.put_nowait(line)
        elif command == "JOIN" and mine and params:
            channel = casefold(params[0])
            self._joining.add(channel)
            self._awaiting_marker.add(channel)
            self._awaiting_names.add(channel)
            self._events.put_nowait(line)
        elif command in ("PART", "KICK") and params:
            kicked = command == "KICK" and len(params) >= 2
            if (kicked and casefold(params[1]) == casefold(self.nick)) or (
                command == "PART" and mine
            ):
                self._joining.discard(casefold(params[0]))
            if kicked and casefold(params[1]) == casefold(self.nick):
                logger.warning(
                    "The bot was kicked from %s on %s: %s",
                    params[0],
                    self._host,
                    params[2] if len(params) > 2 else "no reason given",
                )
        elif command == "NICK" and mine and params:
            self.nick = params[0]
        elif command == "353" and len(params) >= 4:
            self._names(casefold(params[2]), params[3].split())
        elif command == "366" and len(params) >= 2:
            self._names(casefold(params[1]), None)
        elif command == "900" and len(params) >= 3:
            self.account = params[2]
        elif command == "ACCOUNT" and mine and params:
            self.account = None if params[0] == "*" else params[0]
        elif command == "005":
            self._isupport(params[1:-1])
        elif command == "MARKREAD" and len(params) == 2:
            self._read_back(casefold(params[0]), params[1])
        elif command == "BATCH" and params:
            self._batch(params)
        elif command == "FAIL" or (
            # 433 is the nick still taken, each time `_next` asks for it back.
            command.isdigit() and 400 <= int(command) < 600 and command != "433"
        ):
            logger.warning("%s refused a request: %s", self._host, " ".join(params))
            if command == "FAIL" and params[0] == "CHATHISTORY":
                for param in params[2:]:
                    if casefold(param) in self._channels:
                        self._events.put_nowait(_CaughtUp(casefold(param)))

    def _names(self, channel: str, names: list[str] | None) -> None:
        """The first names the network lists for a channel the bot has just
        joined: whether the bot made it, being its one member and operator.
        `None` is the end of the list."""
        if channel not in self._awaiting_names:
            return
        self._awaiting_names.discard(channel)
        setup = self._setups.pop(channel, None)
        if setup is None:
            return
        created = (
            names is not None
            and len(names) == 1
            and names[0][:1] in _OPERATOR_PREFIXES
            and casefold(names[0].lstrip(_OPERATOR_PREFIXES + "%+"))
            == (casefold(self.nick))
        )
        if created:
            if setup.secret:
                # Hidden from the channel list, and only for those invited.
                self._enqueue(build("MODE", channel, "+si"))
            if setup.topic:
                self._enqueue(build("TOPIC", channel, setup.topic))
        else:
            logger.info(
                "IRC channel %s existed before the bot joined it, so its modes "
                "and topic are left as they are",
                channel,
            )
        for nick in setup.invites:
            self._enqueue(build("INVITE", nick, channel))

    def _isupport(self, tokens: tuple[str, ...]) -> None:
        for token in tokens:
            name, _, value = token.partition("=")
            if name in ("CHATHISTORY", "draft/CHATHISTORY") and value.isdigit():
                limit = int(value)
                if limit:
                    self._history_page = min(_HISTORY_PAGE, limit)

    # ── Reading back what was missed ─────────────────────────────────────────

    def _read_back(self, channel: str, marker: str) -> None:
        """Ask for a channel's history from its read marker, the first time
        the network sends the marker on this connection."""
        if channel not in self._awaiting_marker:
            # The network repeating a marker the bot moved itself.
            return
        self._awaiting_marker.discard(channel)
        stamp = marker.removeprefix("timestamp=")
        if not _HISTORY_CAPS <= self.caps or not _TIMESTAMP.fullmatch(stamp):
            # `*` is a channel the bot never read: nothing before now is its.
            self._events.put_nowait(_CaughtUp(channel))
            return
        oldest = datetime.now(UTC) - _HISTORY_LIMIT
        if _parse_time(stamp) < oldest:
            logger.warning(
                "IRC channel %s was last read before the last %s; only that much "
                "is read back, and anything older is not relayed",
                channel,
                _HISTORY_LIMIT,
            )
            stamp = _format_time(oldest)
        self._ask_history(channel, f"timestamp={stamp}")

    def _ask_history(self, channel: str, after: str) -> None:
        self._enqueue(
            build("CHATHISTORY", "AFTER", channel, after, str(self._history_page))
        )

    def _batch(self, params: tuple[str, ...]) -> None:
        reference = params[0]
        if reference.startswith("+") and len(params) >= 3:
            if params[1] == "chathistory" and is_channel(params[2]):
                self._histories[reference[1:]] = _History(casefold(params[2]))
        elif reference.startswith("-"):
            history = self._histories.pop(reference[1:], None)
            if history is None:
                return
            if history.received >= self._history_page:
                # A full page: there may be more after its last line.
                if history.last_msgid and _MSGID.fullmatch(history.last_msgid):
                    self._ask_history(history.channel, f"msgid={history.last_msgid}")
                    return
                if history.last_time and _TIMESTAMP.fullmatch(history.last_time):
                    self._ask_history(history.channel, f"timestamp={history.last_time}")
                    return
            self._events.put_nowait(_CaughtUp(history.channel))

    # ── The paced writer ─────────────────────────────────────────────────────

    async def _pace(self, writer: asyncio.StreamWriter) -> None:
        """Write queued lines at the pace the network allows: channel upkeep,
        then messages, and read markers only when nothing else waits."""
        while True:
            if not self._control and not self._outbox and not self._marks:
                self._idle.set()
                self._wake.clear()
                await self._wake.wait()
                continue
            await self._take_turn()
            queued: _Queued | None = None
            if self._control:
                line = self._control.popleft()
            elif self._outbox:
                queued = self._outbox[0]
                line = queued.line
            else:
                channel = next(iter(self._marks))
                line = build(
                    "MARKREAD", channel, f"timestamp={self._marks.pop(channel)}"
                )
            writer.write(f"{line}\r\n".encode())
            await writer.drain()
            if queued is not None:
                # Off the queue only once written, so a line the connection
                # dropped under is still there for the next one.
                self._outbox.popleft()
                if queued.written is not None and not queued.written.done():
                    queued.written.set_result(None)

    async def _take_turn(self) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time()
        self._allowance = min(
            float(_BURST),
            self._allowance + (now - self._allowance_at) / _LINE_INTERVAL_SECONDS,
        )
        self._allowance_at = now
        if self._allowance < 1:
            await asyncio.sleep((1 - self._allowance) * _LINE_INTERVAL_SECONDS)
            self._allowance = 1.0
            self._allowance_at = loop.time()
        self._allowance -= 1

    def _fail_waiting(self) -> None:
        """Take the lines of senders that wait off the queue, and tell them:
        the connection they were for is gone, and a sender told so may post
        the message again, so it must not also go out on the next one."""
        kept: deque[_Queued] = deque()
        for queued in self._outbox:
            if queued.written is None:
                kept.append(queued)
            elif not queued.written.done():
                queued.written.set_exception(
                    IrcNotConnected(f"the connection to {self._host} closed")
                )
        self._outbox = kept

    # ── Handing lines over ───────────────────────────────────────────────────

    async def _deliver_forever(self) -> None:
        while True:
            item = await self._events.get()
            if isinstance(item, _CaughtUp):
                self._caught_up(item.channel)
                continue
            if item.command == "JOIN":
                self._reading_back.add(casefold(item.params[0]))
            try:
                await self._on_line(item)
            except asyncio.CancelledError:
                raise
            except Exception:
                # One bad line must not stop the ones behind it.
                logger.exception("Failed to handle an IRC %s", item.command)

    def _caught_up(self, channel: str) -> None:
        self._reading_back.discard(channel)
        held = self._held_marks.pop(channel, None)
        if held is not None:
            self.mark_read(channel, held)


def _keep_latest(marks: dict[str, str], channel: str, timestamp: str) -> bool:
    """Put `timestamp` in `marks` unless an earlier one would replace a
    later one; whether it went in."""
    waiting = marks.get(channel)
    if waiting is not None and _parse_time(timestamp) <= _parse_time(waiting):
        return False
    marks[channel] = timestamp
    return True


def _said(line: Line) -> str:
    """What a server line says, for a log or an error: its last parameter,
    with control characters taken out."""
    text = line.params[-1] if line.params else line.command
    return re.sub(r"[\x00-\x1f]", "", text)[:300]


def _parse_time(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def _format_time(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + (
        f"{moment.microsecond // 1000:03d}Z"
    )
