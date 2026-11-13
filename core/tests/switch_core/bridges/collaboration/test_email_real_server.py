"""The email bridge against a real IMAP and SMTP server (GreenMail).

The adapter's other tests fake the mail server, so they can only assume what
one does. These prove it: that IDLE really wakes the listener, that a keyword
stays on a message across connections, that a thread can be found by searching
its headers, and that a person's mail client threads what comes back.
"""

from __future__ import annotations

import asyncio
import smtplib
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from typing import Any

import pytest
from imapclient import IMAPClient
from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import LogMessageWaitStrategy

from switch_core.bridges.collaboration.email.adapter import (
    HANDLED_KEYWORD,
    EmailAdapter,
    EmailConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    OutboundAttachment,
)

ROOM = "room@acme.test"
ADA = "ada@example.test"
PASSWORD = "secret"
IMAP_PORT = 3143
SMTP_PORT = 3025


class Server:
    def __init__(self, host: str, imap_port: int, smtp_port: int) -> None:
        self.host = host
        self.imap_port = imap_port
        self.smtp_port = smtp_port

    def settings(self, **overrides: object) -> dict[str, object]:
        return {
            "email_address": ROOM,
            "password": PASSWORD,
            "imap_host": self.host,
            "imap_port": self.imap_port,
            "imap_security": "none",
            "smtp_host": self.host,
            "smtp_port": self.smtp_port,
            "smtp_security": "none",
            "allowed_senders": ADA,
            # GreenMail is the receiving server here and adds no verdict.
            "require_authenticated_senders": False,
            "connected_at": (datetime.now(UTC) - timedelta(minutes=5)).isoformat(),
            **overrides,
        }

    def imap(self, user: str) -> IMAPClient:
        client = IMAPClient(self.host, port=self.imap_port, ssl=False, timeout=10)
        client.login(user, PASSWORD)
        client.select_folder("INBOX")
        return client

    def send_as_ada(
        self,
        body: str,
        *,
        subject: str = "Deploy failed",
        message_id: str = "<first@example.test>",
        references: str | None = None,
        attachment: tuple[str, bytes] | None = None,
    ) -> None:
        message = EmailMessage()
        message["From"] = f"Ada <{ADA}>"
        message["To"] = ROOM
        message["Subject"] = subject
        message["Message-ID"] = message_id
        if references:
            message["References"] = references
            message["In-Reply-To"] = references.split()[-1]
        message.set_content(body)
        if attachment:
            message.add_attachment(
                attachment[1],
                maintype="application",
                subtype="octet-stream",
                filename=attachment[0],
            )
        with smtplib.SMTP(self.host, self.smtp_port, timeout=10) as smtp:
            smtp.send_message(message)

    def inbox_of_ada(self) -> list[EmailMessage]:
        client = self.imap(ADA)
        try:
            uids = client.search(["ALL"])
            fetched = client.fetch(uids, [b"BODY.PEEK[]"]) if uids else {}
        finally:
            client.logout()
        parser = BytesParser(policy=policy.default)
        return [parser.parsebytes(fetched[uid][b"BODY[]"]) for uid in sorted(fetched)]  # type: ignore[misc]

    def empty(self) -> None:
        for user in (ROOM, ADA):
            client = self.imap(user)
            uids = client.search(["ALL"])
            if uids:
                client.delete_messages(uids)
                client.expunge()
            client.logout()


@pytest.fixture(scope="module")
def mail_server() -> Iterator[Server]:
    options = (
        "-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap "
        "-Dgreenmail.hostname=0.0.0.0 "
        f"-Dgreenmail.users={ROOM.split('@')[0]}:{PASSWORD}@acme.test,"
        f"{ADA.split('@')[0]}:{PASSWORD}@example.test "
        "-Dgreenmail.users.login=email"
    )
    container = (
        DockerContainer("greenmail/standalone:2.1.3")
        .with_env("GREENMAIL_OPTS", options)
        .with_exposed_ports(IMAP_PORT, SMTP_PORT)
        .waiting_for(LogMessageWaitStrategy("Starting GreenMail"))
    )
    with container:
        server = Server(
            # Not "localhost": Docker Desktop does not answer on ::1, and each
            # connection would wait that attempt out first.
            container.get_container_host_ip().replace("localhost", "127.0.0.1"),
            int(container.get_exposed_port(IMAP_PORT)),
            int(container.get_exposed_port(SMTP_PORT)),
        )
        _wait_for_imap(server)
        yield server


def _wait_for_imap(server: Server) -> None:
    deadline = time.monotonic() + 30
    while True:
        try:
            server.imap(ROOM).logout()
            return
        except Exception:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.5)


@pytest.fixture
def server(mail_server: Server) -> Server:
    mail_server.empty()
    return mail_server


class _Open:
    async def resolve(self, hostname: str, port: int) -> list[str]:
        return ["127.0.0.1"]


class Room:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []

    async def on_message(self, message: InboundMessage) -> None:
        self.messages.append(message)

    async def on_command(self, command: InboundCommand) -> None:
        self.commands.append(command)

    async def ignore(self, _: Any) -> None:
        return None

    async def on_app(self, _: InboundAppJoin) -> None:
        return None


async def _running(
    server: Server, room: Room, *, listening: bool = True, **settings: object
) -> EmailAdapter:
    adapter = EmailAdapter(
        config=EmailConnectionConfig.model_validate(server.settings(**settings))
    )
    adapter.set_outbound_policy(_Open())  # type: ignore[arg-type]
    adapter.set_bridge_id("bridge-1")
    adapter.set_listening(listening)
    await adapter.start(
        room.on_message, room.on_command, room.ignore, room.ignore, room.on_app
    )
    return adapter


async def _until(condition: Any, seconds: float = 15) -> None:
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("timed out waiting")
        await asyncio.sleep(0.05)


async def _until_idling(adapter: EmailAdapter) -> None:
    """Give the listener time to log in, look, and go into IDLE."""
    await asyncio.sleep(1.5)


async def test_good_credentials_are_accepted(server: Server) -> None:
    await EmailAdapter.verify_credentials(server.settings())


async def test_a_wrong_password_is_refused_with_the_servers_answer(
    server: Server,
) -> None:
    with pytest.raises(BridgeCredentialError, match="refused the login"):
        await EmailAdapter.verify_credentials(server.settings(password="wrong"))


async def test_a_folder_that_is_not_there_is_refused(server: Server) -> None:
    with pytest.raises(BridgeCredentialError, match="no folder"):
        await EmailAdapter.verify_credentials(server.settings(folder="Nope"))


async def test_idle_brings_mail_to_the_room_as_it_arrives(server: Server) -> None:
    room = Room()
    adapter = await _running(server, room)
    await _until_idling(adapter)
    started = time.monotonic()
    server.send_as_ada("Please look.")
    await _until(lambda: room.messages)
    arrived_after = time.monotonic() - started
    await adapter.stop()
    # Well under the 30 seconds polling would take.
    assert arrived_after < 10
    assert room.messages[0].content == "**Deploy failed**\n\nPlease look."
    assert room.messages[0].sender_id == ADA


async def test_the_keyword_stays_on_the_message_and_it_stays_unread(
    server: Server,
) -> None:
    room = Room()
    server.send_as_ada("Please look.")
    adapter = await _running(server, room)
    await _until(lambda: room.messages)
    await asyncio.sleep(0.5)
    await adapter.stop()
    client = server.imap(ROOM)
    flags = client.get_flags(client.search(["ALL"]))
    client.logout()
    assert [HANDLED_KEYWORD in f for f in flags.values()] == [True]
    assert [b"\\Seen" in f for f in flags.values()] == [False]


async def test_a_restart_loses_nothing_and_repeats_nothing(server: Server) -> None:
    room = Room()
    server.send_as_ada("One.", message_id="<one@example.test>")
    adapter = await _running(server, room)
    await _until(lambda: len(room.messages) == 1)
    await asyncio.sleep(0.5)
    await adapter.stop()

    server.send_as_ada("Two, while nobody was listening.", message_id="<two@x.test>")
    adapter = await _running(server, room)
    await _until(lambda: len(room.messages) == 2)
    await asyncio.sleep(1)
    await adapter.stop()
    assert [m.message_ref for m in room.messages] == [
        "<one@example.test>",
        "<two@x.test>",
    ]


async def test_mail_from_before_the_connection_stays_out_of_the_room(
    server: Server,
) -> None:
    server.send_as_ada("Old news.")
    room = Room()
    adapter = await _running(
        server,
        room,
        connected_at=(datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
    )
    await asyncio.sleep(2)
    await adapter.stop()
    assert room.messages == []


async def test_a_stranger_stays_out_of_the_room(server: Server) -> None:
    room = Room()
    adapter = await _running(server, room, allowed_senders="other@example.test")
    server.send_as_ada("Let me in.")
    await asyncio.sleep(2)
    await adapter.stop()
    assert room.messages == []


async def test_a_conversation_stays_one_thread_on_both_sides(server: Server) -> None:
    room = Room()
    adapter = await _running(server, room)
    server.send_as_ada("Please look.")
    await _until(lambda: room.messages)
    root = room.messages[0].message_ref

    reply_id = await adapter.send_message(ROOM, "Scout", "On it.", root)
    await _until(lambda: server.inbox_of_ada())
    reply = server.inbox_of_ada()[0]
    assert reply["From"].addresses[0].display_name == "Scout"
    assert reply["From"].addresses[0].addr_spec == ROOM
    assert reply["Subject"] == "Re: Deploy failed"
    assert reply["In-Reply-To"] == root
    assert reply["Message-ID"] == reply_id

    # What a mail client sends when Ada presses Reply on the agent's answer.
    server.send_as_ada(
        "Thanks!\n\nOn Sat, Scout <room@acme.test> wrote:\n> On it.",
        subject="Re: Deploy failed",
        message_id="<second@example.test>",
        references=f"{root} {reply_id}",
    )
    await _until(lambda: len(room.messages) == 2)
    await adapter.stop()
    assert room.messages[1].root_id == root
    assert room.messages[1].content == "Thanks!"


async def test_the_agents_own_mail_does_not_come_back_into_the_room(
    server: Server,
) -> None:
    room = Room()
    adapter = await _running(server, room, allowed_senders=f"{ADA}, {ROOM}")
    await _until_idling(adapter)
    await adapter.send_message(ROOM, "Scout", "A note to everyone.")
    await asyncio.sleep(2)
    await adapter.stop()
    assert room.messages == []


async def test_a_command_works_by_email(server: Server) -> None:
    room = Room()
    adapter = await _running(server, room)
    server.send_as_ada("!status")
    await _until(lambda: room.commands)
    await adapter.stop()
    assert room.commands[0].command == "status"


async def test_attachments_travel_both_ways(server: Server) -> None:
    room = Room()
    adapter = await _running(server, room)
    server.send_as_ada("See attached.", attachment=("in.bin", b"\x00\x01binary"))
    await _until(lambda: room.messages)
    assert room.messages[0].attachments[0].filename == "in.bin"
    assert room.messages[0].attachments[0].data == b"\x00\x01binary"

    await adapter.send_attachments(
        ROOM,
        "Scout",
        [
            OutboundAttachment(
                filename="out.bin",
                mimetype="application/octet-stream",
                data=b"\x02\x03more",
            )
        ],
        caption="Here it is",
        thread_root_id=room.messages[0].message_ref,
    )
    await _until(lambda: server.inbox_of_ada())
    await adapter.stop()
    attached = list(server.inbox_of_ada()[0].iter_attachments())
    assert attached[0].get_filename() == "out.bin"
    assert attached[0].get_content() == b"\x02\x03more"


async def test_a_process_not_holding_the_bridge_reads_nothing_but_can_send(
    server: Server,
) -> None:
    room = Room()
    quiet = await _running(server, room, listening=False)
    server.send_as_ada("Please look.")
    await asyncio.sleep(2)
    assert room.messages == []
    await quiet.send_message(ROOM, "Scout", "From the other pod.")
    await _until(lambda: server.inbox_of_ada())
    await quiet.stop()
