"""A scripted IRC server on localhost, enough of one to drive the IRC adapter
the way a real network would: capability negotiation, SASL, nickname
collisions, joins with a names list, and lines pushed at the client."""

from __future__ import annotations

import asyncio
import base64
import contextlib
from dataclasses import dataclass, field

from switch_core.bridges.collaboration.irc.protocol import parse_line


@dataclass
class FakeIrcd:
    caps: str = "message-tags server-time account-tag sasl=PLAIN"
    sasl_account: tuple[str, str] | None = None
    taken_nicks: set[str] = field(default_factory=set)
    #: Channel name -> nicks already in it.
    members: dict[str, list[str]] = field(default_factory=dict)
    #: Channel name -> numeric the server refuses a JOIN with.
    refusals: dict[str, str] = field(default_factory=dict)
    password: str | None = None

    def __post_init__(self) -> None:
        self.lines: list[str] = []
        self.port = 0
        self.connections = 0
        self._server: asyncio.base_events.Server | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._nick = "*"
        self._line_seen = asyncio.Event()

    async def __aenter__(self) -> FakeIrcd:
        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.drop()
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def opener(
        self, host: str, port: int, *, ssl: object = None
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """Stands in for the network: whatever the config names, dial us."""
        return await asyncio.open_connection("127.0.0.1", self.port)

    async def push(self, line: str) -> None:
        assert self._writer is not None, "no client connected"
        self._writer.write(f"{line}\r\n".encode())
        await self._writer.drain()

    async def drop(self) -> None:
        writer, self._writer = self._writer, None
        if writer is not None:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def wait_for(
        self, prefix: str, count: int = 1, timeout: float = 5
    ) -> list[str]:
        """The lines received so far that start with `prefix`, once there are
        `count` of them."""

        async def until() -> list[str]:
            while True:
                found = [line for line in self.lines if line.startswith(prefix)]
                if len(found) >= count:
                    return found
                self._line_seen.clear()
                await self._line_seen.wait()

        return await asyncio.wait_for(until(), timeout)

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self.connections += 1
        self._writer = writer
        self._nick = "*"
        negotiating = False
        registered = False
        got_user = False
        password_ok = self.password is None
        try:
            while True:
                raw = await reader.readline()
                if not raw:
                    return
                line = raw.decode().rstrip("\r\n")
                self.lines.append(line)
                self._line_seen.set()
                msg = parse_line(line)
                cmd, params = msg.command, msg.params
                if cmd == "CAP" and params[:1] == ["LS"]:
                    negotiating = True
                    await self.push(f":srv CAP * LS :{self.caps}")
                elif cmd == "CAP" and params[:1] == ["REQ"]:
                    await self.push(f":srv CAP * ACK :{params[1]}")
                elif cmd == "AUTHENTICATE" and params == ["PLAIN"]:
                    await self.push("AUTHENTICATE +")
                elif cmd == "AUTHENTICATE":
                    _, user, secret = base64.b64decode(params[0]).decode().split("\0")
                    if self.sasl_account == (user, secret):
                        await self.push(f":srv 900 {self._nick} x {user} :Logged in")
                        await self.push(f":srv 903 {self._nick} :SASL successful")
                    else:
                        await self.push(
                            f":srv 904 {self._nick} :SASL authentication failed"
                        )
                elif cmd == "PASS":
                    password_ok = params[0] == self.password
                elif cmd == "NICK":
                    if params[0] in self.taken_nicks:
                        await self.push(
                            f":srv 433 * {params[0]} :Nickname is already in use"
                        )
                    else:
                        self._nick = params[0]
                elif cmd == "USER":
                    got_user = True
                elif cmd == "CAP" and params[:1] == ["END"]:
                    negotiating = False
                elif cmd == "JOIN":
                    await self._join(params[0])
                if (
                    not registered
                    and got_user
                    and not negotiating
                    and self._nick != "*"
                ):
                    if not password_ok:
                        await self.push(f":srv 464 {self._nick} :Password incorrect")
                        await self.drop()
                        return
                    registered = True
                    await self.push(f":srv 001 {self._nick} :Welcome to FakeNet")
        except (ConnectionError, asyncio.CancelledError):
            return

    async def _join(self, channel: str) -> None:
        refusal = self.refusals.get(channel)
        if refusal is not None:
            await self.push(
                f":srv {refusal} {self._nick} {channel} :Cannot join channel"
            )
            return
        await self.push(f":{self._nick}!u@h JOIN {channel}")
        names = " ".join(
            ["@" + n for n in self.members.get(channel, [])] + [self._nick]
        )
        await self.push(f":srv 353 {self._nick} = {channel} :{names}")
        await self.push(f":srv 366 {self._nick} {channel} :End of /NAMES list.")
