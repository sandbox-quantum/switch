"""A small asyncio IRC client: connect, register (PASS/CAP/SASL PLAIN/NICK/
USER), join, read, and write with reconnect-on-drop.

Stdlib only (`asyncio` + `ssl`), no dependency on a third-party IRC library.
IRC's wire protocol is a handful of line-oriented commands over a plain
socket — `asyncio.open_connection` plus the parsing in `protocol.py` covers
all of it, and the repo has no existing convention or shared client for a
platform like this one (every other adapter here talks to its platform
over the vendor's own HTTP/WebSocket SDK), so a dependency would buy
maintenance of someone else's abstraction rather than less code.
"""

from __future__ import annotations

import asyncio
import logging
import random
import ssl
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

from switch_core.bridges.collaboration.irc.protocol import (
    ERR_NICKNAMEINUSE,
    ERR_PASSWDMISMATCH,
    ERR_SASLABORTED,
    ERR_SASLALREADY,
    ERR_SASLFAIL,
    ERR_SASLTOOLONG,
    ERR_YOUREBANNEDCREEP,
    RPL_SASLSUCCESS,
    RPL_WELCOME,
    ParsedLine,
    format_line,
    parse_line,
    sasl_plain_payload,
)
from switch_core.bridges.collaboration.irc.ratelimit import TokenBucket
from switch_core.bridges.collaboration.models import BridgeCredentialError

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT = 15.0
REGISTRATION_TIMEOUT = 20.0
MAX_NICK_RETRIES = 5
INITIAL_BACKOFF = 2.0
MAX_BACKOFF = 30.0

_SASL_FAILURE_NUMERICS = {
    ERR_SASLFAIL,
    ERR_SASLTOOLONG,
    ERR_SASLABORTED,
    ERR_SASLALREADY,
}


@dataclass(frozen=True)
class IRCConnectionParams:
    host: str
    port: int
    use_tls: bool
    verify_tls: bool
    nick: str
    username: str
    realname: str
    channels: list[str]
    sasl_username: str | None = None
    sasl_password: str | None = None
    server_password: str | None = None
    rate_capacity: float = 5.0
    rate_refill_per_second: float = 1.0


class Transport(Protocol):
    """What registration needs from a connection: lines in, lines out.

    Kept this narrow so the CAP/SASL/NICK state machine (`register`) is
    tested against an in-memory fake, without a socket or TLS, including the
    paths that matter most to a reviewer: a wrong SASL password, a nick
    already in use, a wrong server password.
    """

    async def read_line(self) -> ParsedLine | None: ...

    async def write_line(self, command: str, params: list[str]) -> None: ...


class RegistrationFailed(BridgeCredentialError):
    """The server refused registration itself (SASL, PASS, or nick)."""


async def register(transport: Transport, params: IRCConnectionParams) -> str:
    """Run PASS/CAP/SASL/NICK/USER and return the nick the server accepted.

    Raises `RegistrationFailed` for anything the operator typed wrong: a
    rejected server password, a failed SASL login, or a configured nick that
    stays taken after `MAX_NICK_RETRIES` suffixed retries.
    """
    if params.server_password:
        await transport.write_line("PASS", [params.server_password])

    await transport.write_line("CAP", ["LS", "302"])
    advertised = await _read_cap_ls(transport)

    nick = params.nick
    await transport.write_line("NICK", [nick])
    await transport.write_line("USER", [params.username, "0", "*", params.realname])

    wants_sasl = bool(params.sasl_username and params.sasl_password)
    wanted = [
        c for c in ("message-tags", "echo-message", "server-time") if c in advertised
    ]
    if wants_sasl and "sasl" in advertised:
        wanted.append("sasl")
    elif wants_sasl:
        raise RegistrationFailed(
            "SASL credentials were given but this server does not advertise "
            "the sasl capability."
        )

    acked: set[str] = set()
    if wanted:
        await transport.write_line("CAP", ["REQ", " ".join(wanted)])
        acked = await _read_cap_ack(transport)

    if wants_sasl:
        if "sasl" not in acked:
            raise RegistrationFailed("The server refused to negotiate SASL.")
        assert params.sasl_username is not None
        assert params.sasl_password is not None
        await _do_sasl_plain(transport, params.sasl_username, params.sasl_password)

    await transport.write_line("CAP", ["END"])

    retries = 0
    while True:
        line = await transport.read_line()
        if line is None:
            raise RegistrationFailed(
                "The connection closed before registration finished."
            )
        if line.command == RPL_WELCOME:
            return nick
        if line.command == ERR_NICKNAMEINUSE:
            retries += 1
            if retries > MAX_NICK_RETRIES:
                raise RegistrationFailed(
                    f"Nick {params.nick!r} (and every suffixed retry) is already in use."
                )
            nick = f"{params.nick}_{retries}"
            await transport.write_line("NICK", [nick])
        elif line.command == ERR_PASSWDMISMATCH:
            raise RegistrationFailed("The server rejected the connection password.")
        elif line.command == ERR_YOUREBANNEDCREEP:
            raise RegistrationFailed(
                "This bot is banned from the server (ERR_YOUREBANNEDCREEP)."
            )
        elif line.command == "ERROR":
            raise RegistrationFailed(
                f"Server closed the connection: {line.trailing or ''}"
            )


async def _read_cap_ls(transport: Transport) -> set[str]:
    caps: set[str] = set()
    while True:
        line = await transport.read_line()
        if line is None:
            raise RegistrationFailed(
                "The connection closed during capability negotiation."
            )
        if line.command != "CAP" or len(line.params) < 2 or line.params[1] != "LS":
            continue
        # A multiline CAP LS marks every chunk but the last with a literal
        # "*" where the capability list would otherwise be.
        is_continuation = len(line.params) > 3 and line.params[2] == "*"
        payload = line.params[-1]
        caps.update(token.split("=")[0] for token in payload.split() if token)
        if not is_continuation:
            return caps


async def _read_cap_ack(transport: Transport) -> set[str]:
    while True:
        line = await transport.read_line()
        if line is None:
            raise RegistrationFailed(
                "The connection closed during capability negotiation."
            )
        if line.command != "CAP" or len(line.params) < 3:
            continue
        subcommand = line.params[1]
        if subcommand == "ACK":
            return {token.split("=")[0] for token in line.params[-1].split() if token}
        if subcommand == "NAK":
            return set()


async def _do_sasl_plain(transport: Transport, username: str, password: str) -> None:
    await transport.write_line("AUTHENTICATE", ["PLAIN"])
    line = await transport.read_line()
    if line is None or line.command != "AUTHENTICATE" or line.trailing != "+":
        raise RegistrationFailed(
            "The server did not prompt for SASL PLAIN credentials."
        )
    await transport.write_line("AUTHENTICATE", [sasl_plain_payload(username, password)])
    while True:
        line = await transport.read_line()
        if line is None:
            raise RegistrationFailed(
                "The connection closed during SASL authentication."
            )
        if line.command == RPL_SASLSUCCESS:
            return
        if line.command in _SASL_FAILURE_NUMERICS:
            raise RegistrationFailed(
                f"SASL authentication failed ({line.command}): {line.trailing or 'rejected'}"
            )


class _StreamTransport:
    """`Transport` over a real `asyncio` socket."""

    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._reader = reader
        self._writer = writer

    async def read_line(self) -> ParsedLine | None:
        raw = await self._reader.readline()
        if not raw:
            return None
        text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if not text:
            return await self.read_line()
        return parse_line(text)

    async def write_line(self, command: str, params: list[str]) -> None:
        line = format_line(command, params)
        self._writer.write(f"{line}\r\n".encode())
        await self._writer.drain()

    def close(self) -> None:
        self._writer.close()


@dataclass
class _ConnectionState:
    transport: _StreamTransport
    nick: str
    bucket: TokenBucket


class IRCClient:
    """One IRC connection: register once (raising on bad credentials),
    then read and write for as long as `run` is active, reconnecting with
    backoff on any drop after that first success."""

    def __init__(
        self,
        params: IRCConnectionParams,
        *,
        on_line: Callable[[str, ParsedLine], Awaitable[None]],
    ) -> None:
        self._params = params
        self._on_line = on_line
        self._state: _ConnectionState | None = None
        self._stopped = False

    @property
    def nick(self) -> str | None:
        return self._state.nick if self._state else None

    async def _open_transport(self) -> _StreamTransport:
        ssl_context: ssl.SSLContext | None = None
        if self._params.use_tls:
            ssl_context = ssl.create_default_context()
            if not self._params.verify_tls:
                ssl_context.check_hostname = False
                ssl_context.verify_mode = ssl.CERT_NONE
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(
                self._params.host, self._params.port, ssl=ssl_context
            ),
            timeout=CONNECT_TIMEOUT,
        )
        return _StreamTransport(reader, writer)

    async def connect_once(self) -> None:
        """Open the connection and register, synchronously. Raises
        `RegistrationFailed` (a `BridgeCredentialError`) for bad credentials,
        letting that surface to the caller rather than being retried."""
        if self._state is not None:
            self._state.transport.close()
            self._state = None
        transport = await self._open_transport()
        try:
            nick = await asyncio.wait_for(
                register(transport, self._params), timeout=REGISTRATION_TIMEOUT
            )
        except Exception:
            transport.close()
            raise
        bucket = TokenBucket(
            self._params.rate_capacity, self._params.rate_refill_per_second
        )
        self._state = _ConnectionState(transport=transport, nick=nick, bucket=bucket)

    async def join_configured_channels(self) -> None:
        state = self._require_state()
        for channel in self._params.channels:
            await state.transport.write_line("JOIN", [channel])

    def _require_state(self) -> _ConnectionState:
        if self._state is None:
            raise RuntimeError("IRC client is not connected")
        return self._state

    async def send_line(self, command: str, params: list[str]) -> None:
        state = self._require_state()
        await state.bucket.acquire()
        await state.transport.write_line(command, params)

    async def disconnect(self, *, quit_message: str | None = None) -> None:
        state = self._state
        self._state = None
        if state is None:
            return
        try:
            await state.transport.write_line(
                "QUIT", [quit_message] if quit_message else []
            )
        except Exception:
            pass
        state.transport.close()

    async def run(self) -> None:
        """Read loop with reconnect-on-drop.

        Call `connect_once` and `join_configured_channels` first, so a bad
        credential raises straight out of that call rather than being
        retried here. This resumes from the connection they made; every
        later drop reconnects with backoff — unless the reconnect itself
        hits a `RegistrationFailed` (a credential rejected, or rotted,
        after it once worked), which is raised rather than retried, for the
        same reason the first connection is not retried blindly."""
        backoff = INITIAL_BACKOFF
        while not self._stopped:
            try:
                await self._read_until_disconnected()
            except Exception as exc:
                if self._stopped:
                    return
                logger.warning("IRC connection dropped (%s); reconnecting", exc)
            if self._stopped:
                return
            while not self._stopped:
                jitter = random.uniform(0, backoff * 0.25)
                await asyncio.sleep(backoff + jitter)
                try:
                    await self.connect_once()
                    await self.join_configured_channels()
                    backoff = INITIAL_BACKOFF
                    break
                except RegistrationFailed:
                    raise
                except Exception as exc:
                    backoff = min(backoff * 2, MAX_BACKOFF)
                    logger.warning(
                        "IRC reconnect failed (%s); retrying in %.1fs", exc, backoff
                    )

    async def _read_until_disconnected(self) -> None:
        state = self._require_state()
        while True:
            line = await state.transport.read_line()
            if line is None:
                raise ConnectionError("IRC server closed the connection")
            if line.command == "PING":
                await self.send_line("PONG", line.params)
                continue
            await self._on_line(state.nick, line)

    async def stop(self) -> None:
        self._stopped = True
        await self.disconnect(quit_message="Switch bridge stopping")
