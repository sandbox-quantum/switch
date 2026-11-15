"""An IRC server on a real local socket, for the adapter's tests.

It speaks enough of the protocol the way Ergo and Solanum do for the bot to
register, log in, join, talk and read history back: CAP negotiation, SASL
PLAIN, NickServ, ISUPPORT, read markers and `CHATHISTORY AFTER`. What it is
sent is recorded, with when it arrived, and a test can say anything to the
bot or drop the connection.
"""

from __future__ import annotations

import asyncio
import base64
import ssl
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from switch_core.bridges.collaboration.irc import client as client_module
from switch_core.bridges.collaboration.irc.adapter import (
    IrcAdapter,
    IrcConnectionConfig,
)
from switch_core.bridges.collaboration.irc.protocol import Line, parse
from switch_core.bridges.collaboration.models import (
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
)
from switch_core.outbound import OutboundPolicy

NICK = "switchbot"
PASSWORD = "test-placeholder-password"
CHANNEL = "#ops"

ALL_CAPS = {
    "sasl": "PLAIN,EXTERNAL",
    "server-time": "",
    "message-tags": "",
    "account-tag": "",
    "account-notify": "",
    "batch": "",
    "draft/chathistory": "",
    "draft/read-marker": "",
    "echo-message": "",
}


def stamp(moment: datetime | None = None) -> str:
    moment = moment or datetime.now(UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def ago(**delta: float) -> str:
    return stamp(datetime.now(UTC) - timedelta(**delta))


def privmsg(
    text: str,
    *,
    nick: str = "ada",
    target: str = CHANNEL,
    msgid: str | None = "m1",
    account: str | None = "ada",
    sent: str | None = None,
) -> str:
    tags = []
    if msgid is not None:
        tags.append(f"msgid={msgid}")
    if account is not None:
        tags.append(f"account={account}")
    if sent is not None:
        tags.append(f"time={sent}")
    head = f"@{';'.join(tags)} " if tags else ""
    return f"{head}:{nick}!{nick}@users.example PRIVMSG {target} :{text}"


@dataclass
class Received:
    line: Line
    raw: str
    at: float
    connection: int


@dataclass
class _Client:
    number: int
    writer: asyncio.StreamWriter
    nick: str = ""
    caps: set[str] = field(default_factory=set)
    negotiating: bool = False
    user: bool = False
    registered: bool = False
    account: str | None = None


def _self_signed(directory: Path) -> ssl.SSLContext:
    """A TLS context for `localhost` with a certificate nobody signed."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.now(UTC)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False
        )
        .sign(key, hashes.SHA256())
    )
    cert_file, key_file = directory / "cert.pem", directory / "key.pem"
    cert_file.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_file, key_file)
    return context


class FakeIrcServer:
    def __init__(self, *, tls_in: Path | None = None) -> None:
        # Where to write a certificate, for a server that speaks TLS.
        self._tls_in = tls_in
        self.caps: dict[str, str] = dict(ALL_CAPS)
        self.accounts = {NICK: PASSWORD}
        # Whether NickServ's login is confirmed with 900, as Atheme and Anope
        # do, or only with the bot's own ACCOUNT, as Ergo does.
        self.nickserv_sends_900 = True
        # Nicks someone else holds.
        self.taken: set[str] = set()
        self.received: list[Received] = []
        self.connections = 0
        self.open = 0
        # channel -> the bot's read marker, None for never read.
        self.markers: dict[str, str | None] = {}
        # channel -> the raw lines `CHATHISTORY` answers from, oldest first.
        self.history: dict[str, list[tuple[str, str]]] = {}
        self.isupport = "CHANTYPES=# CHATHISTORY=1000 NICKLEN=32"
        # channel -> who is in it already, as a names list shows them.
        self.members: dict[str, list[str]] = {}
        # Holds `CHATHISTORY` answers back until set, when given.
        self.hold_history: asyncio.Event | None = None
        # Answers nothing at all, as a server that accepts and then hangs.
        self.silent = False
        # How often the bot asked for a marker without setting it.
        self.marker_queries = 0
        self._clients: list[_Client] = []
        self._server: asyncio.Server | None = None
        self._changed = asyncio.Event()

    @property
    def port(self) -> int:
        assert self._server is not None
        return int(self._server.sockets[0].getsockname()[1])

    async def __aenter__(self) -> FakeIrcServer:
        context = None if self._tls_in is None else _self_signed(self._tls_in)
        self._server = await asyncio.start_server(
            self._serve, "127.0.0.1", 0, ssl=context
        )
        return self

    async def __aexit__(self, *_: object) -> None:
        assert self._server is not None
        for client in self._clients:
            client.writer.close()
        self._server.close()
        await self._server.wait_closed()

    # ── What a test does ─────────────────────────────────────────────────────

    def sent(self, command: str) -> list[Line]:
        return [r.line for r in self.received if r.line.command == command]

    def said(self, target: str | None = None) -> list[str]:
        """The text of every PRIVMSG the bot sent, to `target` if given."""
        return [
            line.params[1]
            for line in self.sent("PRIVMSG")
            if target is None or line.params[0] == target
        ]

    async def wait_for(self, condition: Callable[[], bool]) -> None:
        async with asyncio.timeout(5):
            while True:
                self._changed.clear()
                if condition():
                    return
                await self._changed.wait()

    async def tell(self, raw: str) -> None:
        """Say `raw` to the bot on its newest connection."""
        client = self._clients[-1]
        client.writer.write(f"{raw}\r\n".encode())
        await client.writer.drain()

    async def drop(self) -> None:
        """Close the bot's newest connection, as a network does on a netsplit."""
        client = self._clients[-1]
        client.writer.close()
        await self.wait_for(lambda: self.open == 0)

    # ── The protocol ─────────────────────────────────────────────────────────

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self.connections += 1
        self.open += 1
        client = _Client(number=self.connections, writer=writer)
        self._clients.append(client)
        self._changed.set()
        try:
            while raw := await reader.readline():
                text = raw.decode().rstrip("\r\n")
                line = parse(text)
                self.received.append(
                    Received(line, text, time.monotonic(), client.number)
                )
                await self._answer(client, line)
                await writer.drain()
                self._changed.set()
                if line.command == "QUIT":
                    break
        except (ConnectionError, OSError):
            pass
        finally:
            self.open -= 1
            writer.close()
            self._changed.set()

    def _send(self, client: _Client, raw: str) -> None:
        if "server-time" in client.caps and not raw.startswith("@"):
            raw = f"@time={stamp()} {raw}"
        client.writer.write(f"{raw}\r\n".encode())

    async def _answer(self, client: _Client, line: Line) -> None:
        command, params = line.command, line.params
        me = client.nick or "*"
        if self.silent:
            return
        if command == "CAP":
            self._cap(client, params)
        elif command == "NICK":
            if params[0] in self.taken:
                self._send(
                    client,
                    f":irc.example 433 {me} {params[0]} :Nickname is already in use",
                )
            elif client.registered:
                self._send(client, f":{me}!switch@bot.example NICK {params[0]}")
                client.nick = params[0]
            else:
                client.nick = params[0]
        elif command == "USER":
            client.user = True
        elif command == "AUTHENTICATE":
            self._authenticate(client, params[0])
        elif command == "PING":
            self._send(client, f":irc.example PONG irc.example :{params[-1]}")
        elif command == "JOIN":
            for channel in params[0].split(","):
                self._send(client, f":{me}!switch@bot.example JOIN {channel}")
                members = self.members.setdefault(channel, [])
                members.append(me if members else f"@{me}")
                self._send(
                    client, f":irc.example 353 {me} = {channel} :{' '.join(members)}"
                )
                self._send(client, f":irc.example 366 {me} {channel} :End of NAMES")
                if "draft/read-marker" in client.caps:
                    marker = self.markers.get(channel)
                    self._send(
                        client,
                        f":irc.example MARKREAD {channel} "
                        + (f"timestamp={marker}" if marker else "*"),
                    )
        elif command == "PRIVMSG" and params[0].lower() == "nickserv":
            self._nickserv(client, params[1])
        elif command == "MARKREAD" and len(params) == 1:
            # Asked for the marker, without setting it.
            self.marker_queries += 1
            marker = self.markers.get(params[0])
            self._send(
                client,
                f":irc.example MARKREAD {params[0]} "
                + (f"timestamp={marker}" if marker else "*"),
            )
        elif command == "MARKREAD":
            self.markers[params[0]] = params[1].removeprefix("timestamp=")
            self._send(client, f":irc.example MARKREAD {params[0]} {params[1]}")
        elif command == "CHATHISTORY":
            asyncio.create_task(self._chathistory(client, params))
        if (
            not client.registered
            and client.nick
            and client.user
            and not client.negotiating
            and client.nick not in self.taken
        ):
            client.registered = True
            self._send(client, f":irc.example 001 {client.nick} :Welcome")
            self._send(
                client,
                f":irc.example 005 {client.nick} {self.isupport} :are supported",
            )

    def _cap(self, client: _Client, params: tuple[str, ...]) -> None:
        verb = params[0].upper()
        if verb == "LS":
            client.negotiating = True
            offered = " ".join(
                f"{name}={value}" if value else name
                for name, value in self.caps.items()
            )
            self._send(client, f":irc.example CAP * LS :{offered}")
        elif verb == "REQ":
            asked = params[-1].split()
            if all(cap in self.caps for cap in asked):
                client.caps.update(asked)
                self._send(client, f":irc.example CAP * ACK :{params[-1]}")
            else:
                self._send(client, f":irc.example CAP * NAK :{params[-1]}")
        elif verb == "END":
            client.negotiating = False

    def _authenticate(self, client: _Client, argument: str) -> None:
        if argument == "PLAIN":
            self._send(client, "AUTHENTICATE +")
            return
        _, account, password = base64.b64decode(argument).decode().split("\0")
        if self.accounts.get(account) == password:
            client.account = account
            self._send(
                client,
                f":irc.example 900 {client.nick} {client.nick}!switch@bot.example "
                f"{account} :You are now logged in as {account}",
            )
            self._send(client, f":irc.example 903 {client.nick} :SASL successful")
        else:
            self._send(
                client, f":irc.example 904 {client.nick} :SASL authentication failed"
            )

    def _nickserv(self, client: _Client, text: str) -> None:
        _, account, password = text.split(" ")
        if self.accounts.get(account) == password:
            client.account = account
            if self.nickserv_sends_900:
                self._send(
                    client,
                    f":irc.example 900 {client.nick} {client.nick}!switch@bot.example "
                    f"{account} :You are now logged in as {account}",
                )
            elif "account-notify" in client.caps:
                self._send(
                    client, f":{client.nick}!switch@bot.example ACCOUNT {account}"
                )
        else:
            self._send(
                client,
                f":NickServ!NickServ@services.example NOTICE {client.nick} "
                ":Invalid password for that account",
            )

    async def _chathistory(self, client: _Client, params: tuple[str, ...]) -> None:
        if self.hold_history is not None:
            await self.hold_history.wait()
        _, channel, after, limit = params
        kind, _, value = after.partition("=")
        stored = self.history.get(channel, [])
        if kind == "msgid":
            ids = [parse(raw).tags.get("msgid") for _, raw in stored]
            found = [raw for _, raw in stored[ids.index(value) + 1 :]]
        else:
            found = [raw for sent, raw in stored if sent > value]
        batch = f"h{len(self.received)}"
        self._send(client, f"BATCH +{batch} chathistory {channel}")
        for raw in found[: int(limit)]:
            self._send(client, f"@batch={batch};{raw.lstrip('@')}")
        self._send(client, f"BATCH -{batch}")
        await client.writer.drain()


async def until(condition: Callable[[], bool]) -> None:
    async with asyncio.timeout(5):
        while not condition():
            await asyncio.sleep(0.01)


def quick(monkeypatch: pytest.MonkeyPatch) -> None:
    """Retries, waits and pacing short enough for tests."""
    monkeypatch.setattr(client_module, "_FIRST_RETRY_SECONDS", 0.01)
    monkeypatch.setattr(client_module, "_LAST_RETRY_SECONDS", 0.05)
    monkeypatch.setattr(client_module, "_LINE_INTERVAL_SECONDS", 0.001)
    monkeypatch.setattr(client_module, "_NICKSERV_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(client_module, "_SEND_WAIT_SECONDS", 0.5)


def config(server: FakeIrcServer, **overrides: Any) -> IrcConnectionConfig:
    return IrcConnectionConfig.model_validate(
        {
            "server": "127.0.0.1",
            "port": server.port,
            "tls": False,
            "nick": NICK,
            "channels": CHANNEL,
            **overrides,
        }
    )


class Inbound:
    """What the adapter handed Switch."""

    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.app_joins: list[InboundAppJoin] = []
        # Messages Switch fails to take, by what they say.
        self.refused: set[str] = set()

    async def message(self, message: InboundMessage) -> None:
        if message.content in self.refused:
            raise RuntimeError("Switch could not take the message")
        self.messages.append(message)

    async def command(self, command: InboundCommand) -> None:
        self.commands.append(command)

    async def app_join(self, join: InboundAppJoin) -> None:
        self.app_joins.append(join)

    async def ignore(self, _: object) -> None:
        return None


def adapter_for(
    server: FakeIrcServer, *, listening: bool = True, **overrides: Any
) -> IrcAdapter:
    adapter = IrcAdapter(config=config(server, **overrides))
    adapter.set_outbound_policy(OutboundPolicy.parse("127.0.0.0/8"))
    adapter.set_listening(listening)
    return adapter


async def started(
    server: FakeIrcServer,
    inbound: Inbound | None = None,
    *,
    listening: bool = True,
    **overrides: Any,
) -> IrcAdapter:
    """An adapter connected to `server` and in its channels, or a quiet copy
    that connects to nothing."""
    inbound = inbound or Inbound()
    adapter = adapter_for(server, listening=listening, **overrides)
    await adapter.start(
        inbound.message,
        inbound.command,
        inbound.ignore,
        inbound.ignore,
        inbound.app_join,
    )
    if listening:
        await server.wait_for(lambda: bool(server.sent("JOIN")))
        await asyncio.sleep(0.05)
    return adapter
