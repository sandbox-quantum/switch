"""One connection to an IRC server: dial, register, read, write politely.

Kept apart from the adapter so it can be driven against a scripted server in
the tests with nothing of Switch around it. It knows the protocol — capability
negotiation, SASL PLAIN, nickname collisions, PING — and nothing about rooms or
agents: every line the server sends after registration is handed to the
`on_message` callback as an `IrcMessage`.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import ssl
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from switch_core.bridges.collaboration.irc.protocol import (
    IrcMessage,
    build_line,
    parse_line,
)

logger = logging.getLogger(__name__)

#: Capabilities asked for when the server offers them. `message-tags` gives
#: each message an id (`msgid`) and lets typing be shown; `server-time` stamps
#: messages; `account-tag` says which services account sent a message.
WANTED_CAPS = ("message-tags", "server-time", "account-tag")

#: How many times a taken nickname is retried with a `_` appended.
NICK_RETRIES = 3

#: A server says nothing for this long, PINGs included, and the link is dead.
READ_TIMEOUT = 300.0

Opener = Callable[..., Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]


class IrcError(Exception):
    """Something went wrong talking to the IRC server."""


class IrcRegistrationError(IrcError):
    """The server refused to let us in: a wrong password, a failed SASL login,
    a ban, or a nickname it will not accept. The text is the server's own
    explanation, fit to show to the operator."""


@dataclass(frozen=True)
class IrcSettings:
    host: str
    port: int
    tls: bool
    nickname: str
    username: str
    realname: str = "Agent Switch"
    server_password: str | None = None
    sasl_username: str | None = None
    sasl_password: str | None = None
    verify_tls: bool = True


class TokenBucket:
    """Flood control: `burst` lines at once, then one every `interval` seconds.

    Servers disconnect a client that sends faster than they allow (an "Excess
    Flood" kill), and channels kick one that floods them, so a long reply is
    paced out rather than written in one go.
    """

    def __init__(
        self,
        burst: int,
        interval: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ) -> None:
        self._burst = burst
        self._interval = interval
        self._tokens = float(burst)
        self._clock = clock
        self._sleep = sleep
        self._stamp = clock()
        self._lock = asyncio.Lock()

    async def take(self) -> None:
        async with self._lock:
            now = self._clock()
            self._tokens = min(
                self._burst, self._tokens + (now - self._stamp) / self._interval
            )
            self._stamp = now
            if self._tokens < 1:
                wait = (1 - self._tokens) * self._interval
                await self._sleep(wait)
                self._stamp = self._clock()
                self._tokens = 1.0
            self._tokens -= 1


class IrcClient:
    def __init__(
        self,
        settings: IrcSettings,
        on_message: Callable[[IrcMessage], Awaitable[None]],
        *,
        opener: Opener = asyncio.open_connection,
        bucket: TokenBucket | None = None,
        read_timeout: float = READ_TIMEOUT,
    ) -> None:
        self.settings = settings
        self.nick = settings.nickname
        self.caps: set[str] = set()
        self._on_message = on_message
        self._opener = opener
        self._bucket = bucket or TokenBucket(burst=5, interval=2.0)
        self._read_timeout = read_timeout
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._read_task: asyncio.Task[None] | None = None
        self._registered: asyncio.Future[None] | None = None
        self._offered: dict[str, str] = {}
        self._nick_attempts = 0
        self._closed = asyncio.Event()
        self._write_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._closed.is_set()

    async def connect(self, timeout: float = 20.0) -> None:
        """Open the connection and register. Returns once the server has
        welcomed us; raises `IrcRegistrationError` if it refused, and the
        socket's own error (`OSError`, `TimeoutError`) if it could not be
        reached."""
        s = self.settings
        context: ssl.SSLContext | None = None
        if s.tls:
            context = ssl.create_default_context()
            if not s.verify_tls:
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
        loop = asyncio.get_running_loop()
        self._registered = loop.create_future()
        self._reader, self._writer = await asyncio.wait_for(
            self._opener(s.host, s.port, ssl=context), timeout
        )
        self._read_task = asyncio.create_task(self._read_loop())
        try:
            await self._write("CAP", "LS", "302")
            if s.server_password:
                await self._write("PASS", s.server_password)
            await self._write("NICK", self.nick)
            await self._write("USER", s.username, "0", "*", s.realname)
            await asyncio.wait_for(asyncio.shield(self._registered), timeout)
        except BaseException:
            await self.close()
            raise

    async def wait_closed(self) -> None:
        await self._closed.wait()

    async def close(self, quit_message: str | None = None) -> None:
        writer, self._writer = self._writer, None
        if writer is not None:
            if quit_message is not None:
                with contextlib.suppress(Exception):
                    writer.write(build_line("QUIT", quit_message).encode())
                    await asyncio.wait_for(writer.drain(), 2)
            writer.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(writer.wait_closed(), 2)
        task = self._read_task
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._fail_registration(IrcError("Connection closed before registration"))
        self._closed.set()

    async def send(self, command: str, *params: str, tags: str | None = None) -> None:
        """Send one command. Messages people read (PRIVMSG, NOTICE) are paced
        by the flood-control bucket; protocol traffic is not."""
        if command in ("PRIVMSG", "NOTICE", "TAGMSG"):
            await self._bucket.take()
        await self._write(command, *params, tags=tags)

    async def _write(self, command: str, *params: str, tags: str | None = None) -> None:
        writer = self._writer
        if writer is None:
            raise IrcError("Not connected to the IRC server")
        line = build_line(command, *params)
        if tags:
            line = f"@{tags} {line}"
        async with self._write_lock:
            writer.write(line.encode())
            await writer.drain()

    def _fail_registration(self, exc: BaseException) -> None:
        if self._registered is not None and not self._registered.done():
            self._registered.set_exception(exc)
            # Retrieved here so an unawaited failure is not reported as lost.
            self._registered.exception()

    async def _read_loop(self) -> None:
        reader = self._reader
        assert reader is not None
        try:
            while True:
                raw = await asyncio.wait_for(reader.readline(), self._read_timeout)
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line:
                    continue
                try:
                    message = parse_line(line)
                except ValueError:
                    logger.warning("Skipping an unreadable IRC line")
                    continue
                await self._handle(message)
        except TimeoutError:
            logger.warning("IRC server %s went silent; closing", self.settings.host)
        except (OSError, asyncio.IncompleteReadError) as exc:
            logger.warning("IRC connection to %s lost: %s", self.settings.host, exc)
        except IrcRegistrationError as exc:
            self._fail_registration(exc)
        finally:
            self._fail_registration(
                IrcError("The IRC server closed the connection during registration")
            )
            writer, self._writer = self._writer, None
            if writer is not None:
                writer.close()
            self._closed.set()

    async def _handle(self, message: IrcMessage) -> None:
        command = message.command
        if command == "PING":
            await self._write("PONG", *(message.params or [""]))
            return
        registered = self._registered is not None and self._registered.done()
        if not registered:
            await self._handle_registration(message)
            return
        if command == "NICK" and message.nick == self.nick and message.params:
            self.nick = message.params[0]
        await self._on_message(message)

    async def _handle_registration(self, message: IrcMessage) -> None:
        command, params = message.command, message.params
        s = self.settings
        text = params[-1] if params else ""
        if command == "CAP" and len(params) >= 3:
            sub = params[1].upper()
            if sub == "LS":
                for item in params[-1].split():
                    name, _, value = item.partition("=")
                    self._offered[name] = value
                if params[2] == "*" and len(params) >= 4:
                    return  # more of the list follows
                wanted = [c for c in WANTED_CAPS if c in self._offered]
                if s.sasl_username:
                    mechanisms = self._offered.get("sasl")
                    if mechanisms is None or (
                        mechanisms and "PLAIN" not in mechanisms.split(",")
                    ):
                        raise IrcRegistrationError(
                            "This server does not offer SASL PLAIN login. Clear "
                            "the SASL fields, or use the server password instead."
                        )
                    wanted.append("sasl")
                if wanted:
                    await self._write("CAP", "REQ", " ".join(wanted))
                else:
                    await self._write("CAP", "END")
            elif sub == "ACK":
                self.caps.update(params[-1].split())
                if "sasl" in self.caps and s.sasl_username:
                    await self._write("AUTHENTICATE", "PLAIN")
                else:
                    await self._write("CAP", "END")
            elif sub == "NAK":
                if s.sasl_username:
                    raise IrcRegistrationError("The server refused SASL login.")
                await self._write("CAP", "END")
            return
        if command == "AUTHENTICATE" and params and params[0] == "+":
            user = s.sasl_username or ""
            blob = f"{user}\0{user}\0{s.sasl_password or ''}".encode()
            await self._write("AUTHENTICATE", base64.b64encode(blob).decode())
            return
        if command == "903":  # RPL_SASLSUCCESS
            await self._write("CAP", "END")
            return
        if command in ("902", "904", "905", "906"):
            raise IrcRegistrationError(f"SASL login failed: {text}")
        if command == "421" and len(params) >= 2 and params[1].upper() == "CAP":
            return  # an old server without capabilities; registration goes on
        if command in ("432", "433", "436", "437"):
            if command == "432" or self._nick_attempts >= NICK_RETRIES:
                raise IrcRegistrationError(
                    f"The server will not accept the nickname {self.nick!r}: {text}"
                )
            self._nick_attempts += 1
            self.nick = f"{s.nickname[:28]}{'_' * self._nick_attempts}"
            await self._write("NICK", self.nick)
            return
        if command == "464":
            raise IrcRegistrationError(f"The server password is wrong: {text}")
        if command in ("465", "466"):
            raise IrcRegistrationError(f"The server banned this connection: {text}")
        if command == "ERROR":
            raise IrcRegistrationError(f"The server closed the connection: {text}")
        if command == "001":
            if params:
                self.nick = params[0]
            assert self._registered is not None
            self._registered.set_result(None)
