"""A scripted IRC server on a local port, for the IRC adapter's tests: it
speaks the registration the bot does (capabilities, SASL PLAIN, the welcome)
and records every line the bot sends."""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass, field


@dataclass
class FakeIrcServer:
    caps: str = "sasl message-tags account-tag"
    account: str = "switchbot"
    password: str = "correct horse"
    #: A numeric to answer NICK with instead of welcoming (433: in use).
    refuse_nick: str | None = None
    received: list[str] = field(default_factory=list)
    clients: list[asyncio.StreamWriter] = field(default_factory=list)
    joined: asyncio.Event = field(default_factory=asyncio.Event)
    _server: asyncio.Server | None = None

    @property
    def port(self) -> int:
        assert self._server is not None
        return int(self._server.sockets[0].getsockname()[1])

    async def __aenter__(self) -> FakeIrcServer:
        self._server = await asyncio.start_server(self._serve, "127.0.0.1", 0)
        return self

    async def __aexit__(self, *exc: object) -> None:
        for writer in self.clients:
            writer.close()
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def say(self, line: str) -> None:
        """Send `line` to every connected client, as the server would."""
        for writer in self.clients:
            writer.write(line.encode() + b"\r\n")
            await writer.drain()

    def sent(self, command: str) -> list[str]:
        """The lines the bot sent that start with `command`."""
        return [line for line in self.received if line.split(" ", 1)[0] == command]

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self.clients.append(writer)

        def reply(line: str) -> None:
            writer.write(line.encode() + b"\r\n")

        nick = "?"
        got_user = cap_ended = welcomed = False
        while True:
            raw = await reader.readline()
            if not raw:
                return
            line = raw.decode().rstrip("\r\n")
            self.received.append(line)
            command, _, rest = line.partition(" ")
            if command == "CAP" and rest.startswith("LS"):
                reply(f":irc.test CAP * LS :{self.caps}")
            elif command == "CAP" and rest.startswith("REQ"):
                reply(f":irc.test CAP * ACK {rest[4:]}")
            elif command == "CAP" and rest == "END":
                cap_ended = True
            elif command == "AUTHENTICATE" and rest == "PLAIN":
                reply("AUTHENTICATE +")
            elif command == "AUTHENTICATE":
                token = base64.b64decode(rest).split(b"\0")
                ok = token[1:] == [self.account.encode(), self.password.encode()]
                reply(
                    f":irc.test 903 {nick} :SASL authentication successful"
                    if ok
                    else f":irc.test 904 {nick} :SASL authentication failed"
                )
            elif command == "NICK":
                nick = rest
                if self.refuse_nick:
                    reply(
                        f":irc.test {self.refuse_nick} * {nick} :Nickname is already in use"
                    )
            elif command == "USER":
                got_user = True
            elif command == "JOIN":
                reply(f":{nick}!bot@test JOIN {rest}")
                self.joined.set()
            elif command == "PING":
                reply(f":irc.test PONG irc.test :{rest.lstrip(':')}")
            elif command == "QUIT":
                writer.close()
                return
            if got_user and cap_ended and not welcomed and not self.refuse_nick:
                welcomed = True
                reply(f":irc.test 001 {nick} :Welcome to the test network")
            await writer.drain()
