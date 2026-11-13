"""One connection to an IRC network: log in, then read and write lines.

Plain asyncio streams and `ssl`, so the bridge adds no dependency. The
connection dials an address the caller already checked against the outbound
policy, and checks the server's certificate against the name the operator
typed, so DNS cannot redirect the bot's password elsewhere.

What it does on its own, because every user of it needs it:
- negotiates IRCv3 capabilities (`CAP LS 302`) and logs in with SASL PLAIN,
  or with NickServ `IDENTIFY` where the network offers no SASL;
- registers under `nick_` (up to three underscores) while the nick is held,
  for example by the previous holder's connection not yet timed out, and
  takes the nick back on a later server PING;
- answers PING, pings an idle server and drops a silent one;
- paces what it writes (a burst, then a steady rate) so the network's flood
  protection never disconnects it, with channel upkeep ahead of messages.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import ssl
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from switch_core.bridges.collaboration.irc.protocol import (
    MAX_LINE_BYTES,
    Line,
    build,
    casefold,
    parse,
)

logger = logging.getLogger(__name__)

# The capabilities the bridge uses, when the network offers them.
WANTED_CAPS = (
    "server-time",
    "message-tags",
    "account-tag",
    "account-notify",
    "batch",
    "draft/chathistory",
    "draft/read-marker",
)

# Dialing one address, then logging in once connected.
CONNECT_TIMEOUT = 10.0
REGISTER_TIMEOUT = 30.0
IDENTIFY_TIMEOUT = 15.0
IDLE_PING_AFTER = 120.0
PONG_WITHIN = 60.0
NICK_FALLBACKS = 3

# Lines sent at once before pacing starts, then one every `PACE` seconds.
BURST = 5
PACE = 1.0

URGENT = 0
NORMAL = 1

# Longest a host part is allowed to be (a DNS name), and the usual cap on the
# `~user` part, for the prefix the server adds to every line it relays.
_MAX_HOST = 63
_MAX_USER = 11


class IrcLoginRefused(Exception):
    """The network refused the bot's nick or password. `reason` is the
    network's own words, safe to show: it never contains the password."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class IrcDisconnected(ConnectionError):
    """The connection closed, or the server stopped answering."""


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    tls: bool
    verify_tls: bool
    nick: str
    username: str
    realname: str
    account: str | None = None
    # Kept out of the text form, so a settings object in a log shows no secret.
    password: str | None = field(default=None, repr=False)


@dataclass
class _Outgoing:
    line: str
    sent: asyncio.Future[None] | None = None


class Outbox:
    """Lines waiting to be written, kept across reconnects.

    The adapter owns one for the life of the bridge, so a reply queued while
    the connection drops is written by the next connection rather than lost.
    Channel upkeep (`urgent`) goes ahead of messages; within a priority,
    lines go in the order they were queued.
    """

    def __init__(self) -> None:
        self._queue: asyncio.PriorityQueue[tuple[int, int, _Outgoing]] = (
            asyncio.PriorityQueue()
        )
        self._order = 0
        # Lines put back count down from here, so a line a connection took but
        # could not write goes out first on the next one.
        self._requeued = 0

    def put(self, line: str, *, urgent: bool = False) -> None:
        self._order += 1
        self._queue.put_nowait(
            (URGENT if urgent else NORMAL, self._order, _Outgoing(line))
        )

    async def put_and_wait(self, line: str, *, urgent: bool = False) -> None:
        """Queue a line and wait until a connection has written it."""
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._order += 1
        self._queue.put_nowait(
            (URGENT if urgent else NORMAL, self._order, _Outgoing(line, future))
        )
        await future

    async def get(self) -> _Outgoing:
        _, _, item = await self._queue.get()
        return item

    def requeue(self, item: _Outgoing) -> None:
        """Put back a line a connection took but could not write, first in line."""
        self._requeued -= 1
        self._queue.put_nowait((URGENT, self._requeued, item))

    def empty(self) -> bool:
        return self._queue.empty()

    def lines(self) -> list[str]:
        """What is waiting, in the order it will be written."""
        waiting = sorted(self._queue._queue)  # type: ignore[attr-defined]
        return [item.line for _, _, item in waiting]

    def fail_all(self, error: BaseException) -> None:
        """Give up on everything waiting, when the bridge stops for good."""
        while not self._queue.empty():
            _, _, item = self._queue.get_nowait()
            if item.sent is not None and not item.sent.done():
                item.sent.set_exception(error)


@dataclass
class ServerInfo:
    """What the network said about itself while the bot logged in."""

    caps: set[str] = field(default_factory=set)
    casemapping: str = "rfc1459"
    chantypes: str = "#&"
    nicklen: int = 30
    network: str | None = None


def _sasl_payload(account: str, password: str) -> list[str]:
    """SASL PLAIN, base64, in the 400-byte pieces AUTHENTICATE takes."""
    encoded = base64.b64encode(f"{account}\0{account}\0{password}".encode()).decode()
    pieces = [encoded[i : i + 400] for i in range(0, len(encoded), 400)]
    if len(pieces[-1]) == 400:
        pieces.append("+")
    return pieces


def tls_context(verify: bool) -> ssl.SSLContext:
    context = ssl.create_default_context()
    if not verify:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


class IrcConnection:
    """A logged-in connection. Build it, `await open(...)`, then `run()`."""

    def __init__(
        self,
        settings: Settings,
        *,
        on_line: Callable[[Line], Awaitable[None]],
        outbox: Outbox | None = None,
        burst: int | None = None,
        pace: float | None = None,
    ) -> None:
        self.settings = settings
        self._on_line = on_line
        self._burst = BURST if burst is None else burst
        self._pace = PACE if pace is None else pace
        # Whether the writer holds a line it has taken and not yet written,
        # waiting its turn: the outbox alone would look empty meanwhile.
        self._in_flight = False
        self.server = ServerInfo()
        self.nick = settings.nick
        self.logged_in_as: str | None = None
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self.outbox = outbox or Outbox()
        self._writer_task: asyncio.Task[None] | None = None
        self._closed = asyncio.Event()
        # The longest `:nick!user@host ` the server puts in front of a line it
        # relays from the bot, learned from the bot's own JOIN once known.
        self._learned_prefix: int | None = None

    # ── Opening ──────────────────────────────────────────────────────────────

    async def open(self, address: str) -> None:
        """Dial `address` (already checked by the caller), log in, and be
        ready to send. Raises `IrcLoginRefused` for a refused nick or
        password, `ssl.SSLError` for a certificate that cannot be verified,
        and `OSError` / `TimeoutError` when the server cannot be reached."""
        context = tls_context(self.settings.verify_tls) if self.settings.tls else None
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(
                address,
                self.settings.port,
                ssl=context,
                server_hostname=self.settings.host if context else None,
                # A name with an IPv6 address that goes nowhere (often
                # `localhost`) would otherwise cost the whole timeout.
                happy_eyeballs_delay=0.25,
            ),
            timeout=CONNECT_TIMEOUT,
        )
        try:
            await asyncio.wait_for(self._register(), timeout=REGISTER_TIMEOUT)
        except BaseException:
            await self._abort()
            raise
        self._writer_task = asyncio.create_task(
            self._write_paced(), name=f"irc-writer-{self.settings.host}"
        )

    async def _register(self) -> None:
        wants_login = bool(self.settings.account and self.settings.password)
        offered: set[str] = set()
        sasl_done = False
        fallbacks = 0
        self._raw(build("CAP", "LS", "302"))
        self._raw(build("NICK", self.nick))
        self._raw(
            build("USER", self.settings.username, "0", "*", self.settings.realname)
        )
        while True:
            line = await self._read_line()
            if line.command == "PING":
                self._raw(build("PONG", line.param(0)))
            elif line.command == "CAP":
                sasl_done = await self._negotiate(line, offered, wants_login, sasl_done)
            elif line.command == "AUTHENTICATE" and line.param(0) == "+":
                assert self.settings.account and self.settings.password
                for piece in _sasl_payload(
                    self.settings.account, self.settings.password
                ):
                    self._raw(build("AUTHENTICATE", piece))
            elif line.command in ("900",):
                self.logged_in_as = line.param(2) or self.settings.account
            elif line.command == "903":
                sasl_done = True
                self._raw(build("CAP", "END"))
            elif line.command in ("902", "904", "905", "906", "908"):
                if line.command == "908":
                    continue
                said = line.param(-1) or "the network gave no reason"
                if not said.lower().startswith("sasl authentication failed"):
                    said = f"SASL authentication failed: {said}"
                raise IrcLoginRefused(said)
            elif line.command == "433":
                fallbacks += 1
                if fallbacks > NICK_FALLBACKS:
                    raise IrcLoginRefused(
                        f"The nick {self.settings.nick} and its fallbacks are in use"
                    )
                self.nick = self.settings.nick + "_" * fallbacks
                self._raw(build("NICK", self.nick))
            elif line.command in ("432", "465", "464"):
                raise IrcLoginRefused(line.param(-1) or "The network refused the bot")
            elif line.command == "001":
                self.nick = line.param(0) or self.nick
            elif line.command == "005":
                self._isupport(line.params[1:-1])
            elif line.command in ("376", "422"):
                break
            elif line.command == "ERROR":
                raise IrcLoginRefused(
                    line.param(0) or "The network closed the connection"
                )
        if wants_login and not sasl_done and self.logged_in_as is None:
            await self._identify()

    async def _negotiate(
        self, line: Line, offered: set[str], wants_login: bool, sasl_done: bool
    ) -> bool:
        sub = line.param(1).upper()
        if sub == "LS":
            more = line.param(2) == "*"
            for cap in line.param(-1).split():
                offered.add(cap.split("=", 1)[0])
            if more:
                return sasl_done
            request = [cap for cap in WANTED_CAPS if cap in offered]
            if wants_login and "sasl" in offered:
                request.append("sasl")
            if request:
                self._raw(build("CAP", "REQ", " ".join(request)))
            else:
                self._raw(build("CAP", "END"))
        elif sub == "ACK":
            self.server.caps.update(line.param(-1).split())
            if "sasl" in self.server.caps and wants_login and not sasl_done:
                self._raw(build("AUTHENTICATE", "PLAIN"))
            else:
                self._raw(build("CAP", "END"))
        elif sub == "NAK":
            self._raw(build("CAP", "END"))
        return sasl_done

    async def _identify(self) -> None:
        """Log in through NickServ, where the network had no SASL.

        Confirmed by 900 (Atheme and Anope) or by the bot's own `ACCOUNT`
        (Ergo sends only that); refused by NickServ saying so.
        """
        assert self.settings.account and self.settings.password
        self._raw(
            build(
                "PRIVMSG",
                "NickServ",
                f"IDENTIFY {self.settings.account} {self.settings.password}",
            )
        )
        deadline = time.monotonic() + IDENTIFY_TIMEOUT
        own = casefold(self.nick, self.server.casemapping)
        while time.monotonic() < deadline:
            try:
                line = await asyncio.wait_for(
                    self._read_line(), timeout=deadline - time.monotonic()
                )
            except TimeoutError:
                break
            if line.command == "PING":
                self._raw(build("PONG", line.param(0)))
            elif line.command == "900":
                self.logged_in_as = line.param(2) or self.settings.account
                return
            elif line.command == "ACCOUNT" and line.source is not None:
                if casefold(line.source.nick, self.server.casemapping) == own:
                    self.logged_in_as = line.param(0)
                    return
            elif line.command == "NICK" and line.source is not None:
                if casefold(line.source.nick, self.server.casemapping) == own:
                    self.nick = line.param(0)
                    own = casefold(self.nick, self.server.casemapping)
            elif (
                line.command == "NOTICE"
                and line.source is not None
                and line.source.nick.lower() == "nickserv"
            ):
                said = line.param(-1).lower()
                if any(
                    word in said
                    for word in (
                        "invalid",
                        "incorrect",
                        "not registered",
                        "failed",
                        "denied",
                    )
                ):
                    raise IrcLoginRefused(
                        f"NickServ refused the login: {line.param(-1)}"
                    )
        raise IrcLoginRefused("NickServ did not confirm the login")

    def _isupport(self, tokens: list[str]) -> None:
        for token in tokens:
            key, _, value = token.partition("=")
            if key == "CASEMAPPING" and value:
                self.server.casemapping = value.lower()
            elif key == "CHANTYPES" and value:
                self.server.chantypes = value
            elif key == "NICKLEN" and value.isdigit():
                self.server.nicklen = int(value)
            elif key == "NETWORK" and value:
                self.server.network = value

    # ── Reading ──────────────────────────────────────────────────────────────

    async def _read_line(self) -> Line:
        assert self._reader is not None
        raw = await self._reader.readline()
        if not raw:
            raise IrcDisconnected("The server closed the connection")
        return parse(raw.decode("utf-8", errors="replace"))

    async def run(self) -> None:
        """Hand every line to `on_line` until the connection closes, then
        raise `IrcDisconnected`. A handler that raises is logged and the
        connection carries on."""
        assert self._reader is not None
        awaiting_pong = False
        try:
            while True:
                try:
                    line = await asyncio.wait_for(
                        self._read_line(),
                        timeout=PONG_WITHIN if awaiting_pong else IDLE_PING_AFTER,
                    )
                except TimeoutError:
                    if awaiting_pong:
                        raise IrcDisconnected("The server stopped answering") from None
                    awaiting_pong = True
                    self.send(build("PING", "switch"), urgent=True)
                    continue
                awaiting_pong = False
                if line.command == "PING":
                    self.send(build("PONG", line.param(0)), urgent=True)
                    self._reclaim_nick()
                    continue
                if line.command == "ERROR":
                    raise IrcDisconnected(line.param(0) or "The server closed the link")
                self._track_self(line)
                try:
                    await self._on_line(line)
                except Exception:
                    logger.exception("Handling an IRC %s line failed", line.command)
        finally:
            await self._abort()

    def _track_self(self, line: Line) -> None:
        """Keep up with the bot's own nick, login and prefix."""
        if line.source is None:
            return
        own = casefold(self.nick, self.server.casemapping)
        if casefold(line.source.nick, self.server.casemapping) != own:
            return
        if line.command == "NICK":
            self.nick = line.param(0)
        elif line.command == "ACCOUNT":
            self.logged_in_as = None if line.param(0) == "*" else line.param(0)
        elif line.command == "JOIN" and line.source.user and line.source.host:
            self._learned_prefix = len(
                f":{line.source.nick}!{line.source.user}@{line.source.host} ".encode()
            )

    def _reclaim_nick(self) -> None:
        if self.nick != self.settings.nick:
            self.send(build("NICK", self.settings.nick), urgent=True)

    # ── Writing ──────────────────────────────────────────────────────────────

    def relay_prefix_bytes(self) -> int:
        """How many bytes the server puts in front of a line it relays from
        the bot, at most: learned from the bot's own JOIN, else the longest
        any nick, user and host part could be."""
        if self._learned_prefix is not None:
            return self._learned_prefix
        nick = max(len(self.nick), len(self.settings.nick) + NICK_FALLBACKS)
        return 1 + nick + 1 + _MAX_USER + 1 + _MAX_HOST + 1

    def text_budget(self, command: str, target: str) -> int:
        """Bytes left for the text of `command target :text` once the server
        has put the bot's prefix in front and CRLF at the end."""
        overhead = len(f"{command} {target} :".encode()) + 2
        return MAX_LINE_BYTES - self.relay_prefix_bytes() - overhead

    def send(self, line: str, *, urgent: bool = False) -> None:
        """Queue a line; channel upkeep (`urgent`) goes ahead of messages."""
        self.outbox.put(line, urgent=urgent)

    def _raw(self, line: str) -> None:
        assert self._writer is not None
        self._writer.write(line.encode() + b"\r\n")

    async def _write_paced(self) -> None:
        tokens = float(self._burst)
        last = time.monotonic()
        while True:
            item = await self.outbox.get()
            self._in_flight = True
            now = time.monotonic()
            tokens = min(float(self._burst), tokens + (now - last) / self._pace)
            last = now
            if tokens < 1:
                try:
                    await asyncio.sleep((1 - tokens) * self._pace)
                except asyncio.CancelledError:
                    self.outbox.requeue(item)
                    self._in_flight = False
                    raise
                tokens = 1.0
                last = time.monotonic()
            tokens -= 1
            if self._writer is None or self._writer.is_closing():
                self.outbox.requeue(item)
                self._in_flight = False
                return
            try:
                self._raw(item.line)
                await self._writer.drain()
            except (OSError, ConnectionError):
                # Written to a socket that was dying: it may or may not have
                # reached the server, and a duplicate line beats a lost one.
                self.outbox.requeue(item)
                self._in_flight = False
                return
            self._in_flight = False
            if item.sent is not None and not item.sent.done():
                item.sent.set_result(None)

    async def drain(self, within: float) -> None:
        """Give queued lines up to `within` seconds to be written."""
        deadline = time.monotonic() + within
        while (
            not self.outbox.empty() or self._in_flight
        ) and time.monotonic() < deadline:
            await asyncio.sleep(0.05)

    async def close(self, message: str = "Switch bridge stopping") -> None:
        if self._writer is not None and not self._writer.is_closing():
            with contextlib.suppress(Exception):
                self._raw(build("QUIT", message))
                await asyncio.wait_for(self._writer.drain(), timeout=2)
        await self._abort()

    async def _abort(self) -> None:
        task, self._writer_task = self._writer_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        writer, self._writer = self._writer, None
        if writer is not None:
            writer.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(writer.wait_closed(), timeout=2)
        self._closed.set()
