"""An IRC network on a real local socket, for the IRC adapter's tests.

It speaks the part of IRC the bridge uses: CAP and SASL PLAIN, NickServ in
the Atheme style (900) and the Ergo style (`ACCOUNT`), nick collisions, JOIN
and NAMES, and, when offered, read markers and `CHATHISTORY AFTER`. What the
bot sends is recorded in `received`; `say` hands the bot a line as if
someone on the network had sent it.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import datetime
import ipaddress
import ssl
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from switch_core.bridges.collaboration.irc.protocol import parse

ALL_CAPS = (
    "sasl",
    "server-time",
    "message-tags",
    "account-tag",
    "account-notify",
    "batch",
    "draft/chathistory",
    "draft/read-marker",
)


def self_signed_context() -> ssl.SSLContext:
    """A server TLS context with a fresh self-signed certificate for 127.0.0.1."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "fake-irc")])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(hours=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName("localhost"),
                    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
                ]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    folder = Path(tempfile.mkdtemp())
    (folder / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (folder / "key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(folder / "cert.pem", folder / "key.pem")
    return context


@dataclass
class _Client:
    writer: asyncio.StreamWriter
    nick: str = "*"
    account: str | None = None
    caps: set[str] = field(default_factory=set)
    cap_open: bool = False
    user_sent: bool = False
    welcomed: bool = False


class FakeIrcServer:
    def __init__(
        self,
        *,
        caps: tuple[str, ...] = ALL_CAPS,
        accounts: dict[str, str] | None = None,
        nickserv: str | None = None,
        taken: set[str] | None = None,
        tls: bool = False,
        history: dict[str, list[str]] | None = None,
        markers: dict[str, str] | None = None,
    ) -> None:
        self.caps = caps
        self.accounts = accounts if accounts is not None else {"switchbot": "s3cret"}
        self.nickserv = nickserv
        self.taken = taken if taken is not None else set()
        self.tls = tls
        self.history = history if history is not None else {}
        self.markers = markers if markers is not None else {}
        self.received: list[str] = []
        self.clients: list[_Client] = []
        self.channels: dict[str, list[str]] = {}
        self.port = 0
        self._server: asyncio.Server | None = None
        self._batch = 0

    async def __aenter__(self) -> FakeIrcServer:
        self._server = await asyncio.start_server(
            self._serve,
            "127.0.0.1",
            0,
            ssl=self_signed_context() if self.tls else None,
        )
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        for client in self.clients:
            client.writer.close()
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
            self._server = None

    async def drop_everyone(self) -> None:
        """Close every connection, as a network restart would."""
        for client in list(self.clients):
            client.writer.close()
        self.clients.clear()

    # ── Driving the bot ──────────────────────────────────────────────────────

    def say(self, line: str) -> None:
        """Hand every connected bot `line`, as if the network sent it."""
        for client in self.clients:
            client.writer.write(line.encode() + b"\r\n")

    def sent(self, command: str) -> list[str]:
        return [line for line in self.received if line.split(" ", 1)[0] == command]

    async def wait_for(self, predicate, timeout: float = 5.0) -> str:  # type: ignore[no-untyped-def]
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            for line in self.received:
                if predicate(line):
                    return line
            await asyncio.sleep(0.01)
        raise AssertionError(
            f"The bot never sent a matching line: {self.received[-10:]}"
        )

    # ── The network ──────────────────────────────────────────────────────────

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        client = _Client(writer=writer)
        self.clients.append(client)
        try:
            while raw := await reader.readline():
                text = raw.decode(errors="replace").rstrip("\r\n")
                self.received.append(text)
                self._handle(client, text)
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            if client in self.clients:
                self.clients.remove(client)
            writer.close()

    def _send(self, client: _Client, line: str) -> None:
        client.writer.write(line.encode() + b"\r\n")

    def _prefix(self, client: _Client) -> str:
        return f"{client.nick}!bot@fake.host"

    def _handle(self, client: _Client, text: str) -> None:
        line = parse(text)
        command = line.command
        if command == "CAP":
            self._cap(client, line.param(0), line.param(-1))
        elif command == "AUTHENTICATE":
            self._authenticate(client, line.param(0))
        elif command == "NICK":
            self._nick(client, line.param(0))
        elif command == "USER":
            client.user_sent = True
            self._welcome(client)
        elif command == "PING":
            self._send(client, f":fake PONG fake :{line.param(0)}")
        elif command == "JOIN":
            self._join(client, line.param(0))
        elif command == "PRIVMSG" and line.param(0).lower() == "nickserv":
            self._identify(client, line.param(1))
        elif command == "MARKREAD":
            self.markers[line.param(0).lower()] = line.param(1).removeprefix(
                "timestamp="
            )
        elif command == "CHATHISTORY":
            self._chathistory(client, line.params)
        elif command == "QUIT":
            client.writer.close()

    def _cap(self, client: _Client, sub: str, arg: str) -> None:
        sub = sub.upper() if sub != "*" else sub
        if sub == "LS":
            client.cap_open = True
            self._send(client, f":fake CAP * LS :{' '.join(self.caps)}")
        elif sub == "REQ":
            wanted = arg.split()
            if all(cap in self.caps for cap in wanted):
                client.caps.update(wanted)
                self._send(client, f":fake CAP * ACK :{arg}")
            else:
                self._send(client, f":fake CAP * NAK :{arg}")
        elif sub == "END":
            client.cap_open = False
            self._welcome(client)

    def _authenticate(self, client: _Client, arg: str) -> None:
        if arg == "PLAIN":
            self._send(client, "AUTHENTICATE +")
            return
        _, account, password = base64.b64decode(arg).decode().split("\0")
        if self.accounts.get(account) == password:
            client.account = account
            self._send(
                client,
                f":fake 900 {client.nick} {self._prefix(client)} {account} :You are now logged in",
            )
            self._send(
                client, f":fake 903 {client.nick} :SASL authentication successful"
            )
        else:
            self._send(
                client,
                f":fake 904 {client.nick} :SASL authentication failed: Invalid account credentials",
            )

    def _nick(self, client: _Client, nick: str) -> None:
        if nick.lower() in {n.lower() for n in self.taken}:
            self._send(
                client, f":fake 433 {client.nick} {nick} :Nickname is already in use"
            )
            return
        old = client.nick
        client.nick = nick
        if client.welcomed:
            self._send(client, f":{old}!bot@fake.host NICK {nick}")
        self._welcome(client)

    def _welcome(self, client: _Client) -> None:
        if (
            client.welcomed
            or client.cap_open
            or not client.user_sent
            or client.nick == "*"
        ):
            return
        client.welcomed = True
        self._send(client, f":fake 001 {client.nick} :Welcome")
        self._send(
            client,
            f":fake 005 {client.nick} CASEMAPPING=rfc1459 CHANTYPES=#& NICKLEN=30 NETWORK=Fake :are supported",
        )
        self._send(client, f":fake 376 {client.nick} :End of MOTD")

    def _identify(self, client: _Client, text: str) -> None:
        words = text.split()
        if len(words) != 3 or words[0].upper() != "IDENTIFY":
            return
        account, password = words[1], words[2]
        if self.accounts.get(account) != password:
            self._send(
                client,
                f":NickServ!services@fake NOTICE {client.nick} :Invalid password for {account}",
            )
            return
        client.account = account
        if self.nickserv == "ergo":
            self._send(client, f":{self._prefix(client)} ACCOUNT {account}")
        else:
            self._send(
                client,
                f":fake 900 {client.nick} {self._prefix(client)} {account} :You are now logged in",
            )

    def _join(self, client: _Client, channels: str) -> None:
        for name in channels.split(","):
            members = self.channels.setdefault(name.lower(), [])
            first = not members
            members.append(client.nick)
            self._send(client, f":{self._prefix(client)} JOIN {name}")
            names = " ".join(
                ("@" if first and n == client.nick else "") + n for n in members
            )
            self._send(client, f":fake 353 {client.nick} = {name} :{names}")
            self._send(client, f":fake 366 {client.nick} {name} :End of NAMES")
            if "draft/read-marker" in client.caps:
                marker = self.markers.get(name.lower())
                value = f"timestamp={marker}" if marker else "*"
                self._send(client, f":fake MARKREAD {name} {value}")

    def _chathistory(self, client: _Client, params: list[str]) -> None:
        if len(params) < 4 or params[0].upper() != "AFTER":
            return
        channel, after = params[1].lower(), params[2]
        lines = self.history.get(channel, [])
        if after.startswith("timestamp="):
            stamp = after.removeprefix("timestamp=")
            lines = [item for item in lines if parse(item).tags.get("time", "") > stamp]
        elif after.startswith("msgid="):
            ids = [parse(item).tags.get("msgid") for item in lines]
            wanted = after.removeprefix("msgid=")
            lines = lines[ids.index(wanted) + 1 :] if wanted in ids else []
        page = lines[: int(params[3])]
        self._batch += 1
        ref = f"h{self._batch}"
        self._send(client, f":fake BATCH +{ref} chathistory {params[1]}")
        for item in page:
            tags, _, rest = item.partition(" ")
            self._send(client, f"{tags};batch={ref} {rest}")
        self._send(client, f":fake BATCH -{ref}")
