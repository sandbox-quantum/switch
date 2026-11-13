from __future__ import annotations

import asyncio
import logging
import smtplib
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from typing import Any

import pytest
from imapclient.exceptions import IMAPClientError, LoginError
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import (
    PlatformAdapter,
    RequestCard,
    RichContentFailed,
    TurnActivity,
)
from switch_core.bridges.collaboration.email import adapter as adapter_module
from switch_core.bridges.collaboration.email.adapter import (
    HANDLED_KEYWORD,
    EmailAdapter,
    EmailConnectionConfig,
)
from switch_core.bridges.collaboration.email.mime import SWITCH_HEADER
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
    OutboundAttachment,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.outbound import OutboundPolicy, OutboundURLRefused
from switch_core.sessions.contract import TurnUpsert
from tests.switch_core.bridges.collaboration.session_fixtures import open_request

MAILBOX = "room@acme.test"
CONNECTED = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
AFTER = CONNECTED + timedelta(hours=1)
AUTHENTICATED = "mx.acme.test; dmarc=pass header.from=example.com"


def _settings(**overrides: object) -> dict[str, object]:
    return {
        "email_address": MAILBOX,
        "password": "pw",
        "imap_host": "imap.acme.test",
        "smtp_host": "smtp.acme.test",
        "allowed_senders": "ada@example.com, bob@example.com, @partner.test",
        "connected_at": CONNECTED.isoformat(),
        **overrides,
    }


def _mail(
    *,
    sender: str = "Ada <ada@example.com>",
    message_id: str = "<one@example.com>",
    subject: str = "Deploy failed",
    body: str = "Please look.",
    headers: dict[str, str] | None = None,
    authenticated: bool = True,
) -> bytes:
    message = EmailMessage()
    if authenticated:
        message["Authentication-Results"] = AUTHENTICATED
    message["From"] = sender
    message["To"] = MAILBOX
    message["Subject"] = subject
    message["Message-ID"] = message_id
    for name, value in (headers or {}).items():
        message[name] = value
    message.set_content(body)
    return message.as_bytes()


class FakeIMAP:
    """A mailbox, behind the same calls `IMAPClient` offers."""

    def __init__(self, server: FakeServer) -> None:
        self.server = server
        self.normalise_times = True

    def starttls(self, context: Any) -> None:
        self.server.starttls += 1

    def login(self, user: str, password: str) -> None:
        if self.server.login_error is not None:
            raise self.server.login_error
        self.server.logins.append(user)

    def select_folder(self, folder: str, readonly: bool = False) -> dict[bytes, Any]:
        if folder != "INBOX":
            raise IMAPClientError("no such folder")
        return {b"PERMANENTFLAGS": self.server.permanent_flags}

    def capabilities(self) -> tuple[bytes, ...]:
        return self.server.capabilities

    def search(self, criteria: list[Any]) -> list[int]:
        self.server.searches.append(criteria)
        if criteria[0] == b"OR":
            root = criteria[3]
            return [
                uid
                for uid, stored in self.server.mail.items()
                if root.encode() in stored.raw
            ]
        if criteria[0] == b"UNSEEN":
            return [
                uid
                for uid, stored in self.server.mail.items()
                if b"\\Seen" not in stored.flags
            ]
        keyword = criteria[1]
        return [
            uid
            for uid, stored in self.server.mail.items()
            if keyword not in stored.flags
        ]

    def fetch(self, uids: list[int], parts: list[bytes]) -> dict[int, dict[bytes, Any]]:
        result: dict[int, dict[bytes, Any]] = {}
        for uid in uids:
            stored = self.server.mail[uid]
            if b"BODY.PEEK[HEADER]" in parts:
                head = stored.raw.split(b"\n\n", 1)[0].split(b"\r\n\r\n", 1)[0]
                result[uid] = {b"BODY[HEADER]": head + b"\r\n\r\n"}
            else:
                result[uid] = {b"BODY[]": stored.raw, b"INTERNALDATE": stored.arrived}
        return result

    def add_flags(self, uids: list[int], flags: list[bytes]) -> None:
        for uid in uids:
            self.server.mail[uid].flags.update(flags)
            self.server.flag_order.append(uid)

    def logout(self) -> None:
        self.server.closed += 1

    def shutdown(self) -> None:
        self.server.closed += 1

    def idle(self) -> None:
        return None

    def idle_check(self, timeout: int) -> list[Any]:
        return []

    def idle_done(self) -> None:
        return None


class StoredMail:
    def __init__(self, raw: bytes, arrived: datetime) -> None:
        self.raw = raw
        self.arrived = arrived
        self.flags: set[bytes] = set()


class FakeSMTP:
    """An SMTP server, behind the same calls `smtplib.SMTP` offers."""

    def __init__(self, server: FakeServer) -> None:
        self.server = server
        self.esmtp_features = (
            {"size": str(server.smtp_size)} if server.smtp_size else {}
        )

    def starttls(self, context: Any) -> None:
        self.server.starttls += 1

    def login(self, user: str, password: str) -> None:
        if self.server.smtp_login_error is not None:
            raise self.server.smtp_login_error

    def send_message(self, message: EmailMessage) -> None:
        if self.server.smtp_error is not None:
            raise self.server.smtp_error
        self.server.sent.append(
            BytesParser(policy=policy.default).parsebytes(message.as_bytes())  # type: ignore[arg-type]
        )

    def quit(self) -> None:
        return None

    def close(self) -> None:
        return None


class FakeServer:
    def __init__(self) -> None:
        self.mail: dict[int, StoredMail] = {}
        self.permanent_flags: tuple[bytes, ...] = (b"\\Seen", b"\\*")
        self.capabilities: tuple[bytes, ...] = (b"IMAP4REV1", b"IDLE")
        self.login_error: Exception | None = None
        self.smtp_login_error: Exception | None = None
        self.smtp_error: Exception | None = None
        self.smtp_size = 0
        self.logins: list[str] = []
        self.searches: list[list[Any]] = []
        self.flag_order: list[int] = []
        self.sent: list[EmailMessage] = []
        self.starttls = 0
        self.closed = 0
        self.connections = 0

    def deliver(self, raw: bytes, arrived: datetime = AFTER) -> int:
        uid = len(self.mail) + 1
        self.mail[uid] = StoredMail(raw, arrived)
        return uid

    def imap(self, *args: Any, **kwargs: Any) -> FakeIMAP:
        self.connections += 1
        return FakeIMAP(self)

    def smtp(self, *args: Any, **kwargs: Any) -> FakeSMTP:
        return FakeSMTP(self)


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeServer]:
    fake = FakeServer()
    monkeypatch.setattr(adapter_module, "IMAPClient", fake.imap)
    monkeypatch.setattr(adapter_module.smtplib, "SMTP", fake.smtp)
    monkeypatch.setattr(adapter_module.smtplib, "SMTP_SSL", fake.smtp)
    yield fake


class _Open:
    """Lets every host through, as a deployment's policy does a public one."""

    async def resolve(self, hostname: str, port: int) -> list[str]:
        return ["203.0.113.1"]


class Room:
    """What the bridge core is, to an adapter: the callbacks it was given."""

    def __init__(self, *, fail_messages: bool = False) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.apps: list[InboundAppJoin] = []
        self.fail_messages = fail_messages

    async def on_message(self, message: InboundMessage) -> None:
        if self.fail_messages:
            raise RuntimeError("the database is away")
        self.messages.append(message)

    async def on_command(self, command: InboundCommand) -> None:
        self.commands.append(command)

    async def on_app(self, join: InboundAppJoin) -> None:
        self.apps.append(join)

    async def ignore(self, *_: Any) -> None:
        return None


def _adapter(room: Room | None = None, **settings: object) -> EmailAdapter:
    adapter = EmailAdapter(
        config=EmailConnectionConfig.model_validate(_settings(**settings))
    )
    adapter.set_outbound_policy(_Open())  # type: ignore[arg-type]
    adapter.set_bridge_id("bridge-1")
    if room is not None:
        adapter._on_message = room.on_message
        adapter._on_command = room.on_command
    return adapter


async def _pass(adapter: EmailAdapter, keyword: bytes = HANDLED_KEYWORD) -> None:
    """One look through the mailbox, as the listener makes after every wake."""
    await adapter._handle_waiting(adapter_module._open_imap(adapter.config), keyword)


# ── The connection config ────────────────────────────────────────────────────


def test_email_is_a_registered_platform() -> None:
    assert ("email", EmailAdapter) in [(p.key, p.adapter) for p in PLATFORMS]
    assert PLATFORMS[-1].config is EmailConnectionConfig


def test_a_config_is_normalised() -> None:
    config = EmailConnectionConfig.model_validate(
        _settings(
            email_address=" Room@ACME.test ",
            allowed_senders="ADA@example.com; @Partner.test",
            username="",
            authentication_server="  ",
        )
    )
    assert config.email_address == MAILBOX
    assert config.allowed == ("ada@example.com", "@partner.test")
    assert config.login == MAILBOX
    assert config.authentication_server is None


def test_ports_arrive_as_text_from_the_form() -> None:
    config = EmailConnectionConfig.model_validate(_settings(imap_port="143"))
    assert config.imap_port == 143
    assert config.smtp_port == 465


@pytest.mark.parametrize(
    "bad",
    [
        {"email_address": "not-an-address"},
        {"allowed_senders": "  "},
        {"allowed_senders": "not-an-address"},
        {"imap_host": "  "},
        {"imap_port": 0},
        {"smtp_port": 70000},
        {"imap_security": "tls"},
    ],
)
def test_an_unusable_config_is_refused(bad: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        EmailConnectionConfig.model_validate(_settings(**bad))


def test_the_password_never_appears_in_a_refusal() -> None:
    with pytest.raises(ValidationError) as refused:
        EmailConnectionConfig.model_validate(
            _settings(password="hunter2", imap_port="nope")
        )
    assert "hunter2" not in str(refused.value)


def test_the_form_shows_the_fields_a_person_fills_in() -> None:
    schema = EmailConnectionConfig.model_json_schema()
    assert "connected_at" not in schema["properties"]
    assert set(schema["required"]) == {
        "email_address",
        "password",
        "imap_host",
        "smtp_host",
        "allowed_senders",
    }


async def test_the_connection_time_is_stamped_once() -> None:
    stamped = await EmailAdapter.prepare_config({"email_address": MAILBOX})
    assert isinstance(stamped["connected_at"], str)
    assert await EmailAdapter.prepare_config(stamped) == stamped


def test_a_mailbox_can_only_be_connected_once() -> None:
    assert (
        EmailAdapter.claimed_workspace({"email_address": " Room@Acme.test "})
        == f"mailbox {MAILBOX}"
    )


def test_both_mail_servers_are_checked_against_the_outbound_policy() -> None:
    assert EmailAdapter.outbound_urls(_settings(imap_port=143)) == [
        "https://imap.acme.test:143",
        "https://smtp.acme.test:465",
    ]


async def test_a_mail_server_on_an_internal_address_is_refused() -> None:
    urls = EmailAdapter.outbound_urls(
        _settings(imap_host="127.0.0.1", smtp_host="10.0.0.5")
    )
    with pytest.raises(OutboundURLRefused):
        await OutboundPolicy.parse("").check_url(urls[0])


def test_what_email_cannot_do_is_declared() -> None:
    assert EmailAdapter.supports_channel_creation is False
    assert EmailAdapter.supports_directory_search is False
    assert EmailAdapter.renders_custom_url_schemes is False
    assert EmailAdapter.supports_activity_reactions is False
    assert EmailAdapter.keeps_quiet_unless_listening is True
    assert EmailAdapter.draws_session_activity is True


def test_it_describes_itself_with_its_own_icon() -> None:
    assert EmailAdapter.icon_svg() is not None
    assert EmailAdapter.describe("email").display_name == "Email"


# ── Checking credentials ─────────────────────────────────────────────────────


async def test_good_credentials_log_in_to_both_servers(server: FakeServer) -> None:
    await EmailAdapter.verify_credentials(_settings())
    assert server.logins == [MAILBOX]
    assert server.closed == 1


async def test_a_refused_imap_login_says_what_the_server_said(
    server: FakeServer,
) -> None:
    server.login_error = LoginError("Invalid credentials (Failure)")
    with pytest.raises(BridgeCredentialError, match="Invalid credentials"):
        await EmailAdapter.verify_credentials(_settings())


async def test_the_servers_answer_is_shown_as_words_not_as_bytes(
    server: FakeServer,
) -> None:
    server.login_error = LoginError("b'LOGIN failed. Invalid login'")
    with pytest.raises(BridgeCredentialError) as refused:
        await EmailAdapter.verify_credentials(_settings())
    assert str(refused.value).endswith(": LOGIN failed. Invalid login")


async def test_a_refused_smtp_login_says_what_the_server_said(
    server: FakeServer,
) -> None:
    server.smtp_login_error = smtplib.SMTPAuthenticationError(535, b"Bad login")
    with pytest.raises(BridgeCredentialError, match="535 Bad login"):
        await EmailAdapter.verify_credentials(_settings())


async def test_a_folder_that_does_not_exist_is_refused(server: FakeServer) -> None:
    with pytest.raises(BridgeCredentialError, match="Archive"):
        await EmailAdapter.verify_credentials(_settings(folder="Archive"))


async def test_a_server_that_cannot_be_reached_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(*_: Any, **__: Any) -> None:
        raise ConnectionRefusedError("connection refused")

    monkeypatch.setattr(adapter_module, "IMAPClient", refuse)
    with pytest.raises(BridgeCredentialError, match="connection refused"):
        await EmailAdapter.verify_credentials(_settings())


async def test_starttls_is_used_on_both_when_asked(server: FakeServer) -> None:
    await EmailAdapter.verify_credentials(
        _settings(imap_security="starttls", smtp_security="starttls")
    )
    assert server.starttls == 2


# ── Starting ─────────────────────────────────────────────────────────────────


async def _start(adapter: EmailAdapter, room: Room) -> None:
    await adapter.start(
        room.on_message, room.on_command, room.ignore, room.ignore, room.on_app
    )


async def test_a_quiet_process_opens_nothing(server: FakeServer) -> None:
    adapter, room = _adapter(), Room()
    adapter.set_listening(False)
    await _start(adapter, room)
    assert server.connections == 0
    assert room.apps == []
    await adapter.stop()


async def test_a_quiet_process_can_still_send(server: FakeServer) -> None:
    adapter = _adapter()
    adapter.set_listening(False)
    await _start(adapter, Room())
    assert await adapter.send_message(MAILBOX, "Scout", "Hello")
    assert len(server.sent) == 1


async def test_the_holder_announces_the_mailbox_so_the_room_exists(
    server: FakeServer,
) -> None:
    adapter, room = _adapter(), Room()
    await _start(adapter, room)
    await adapter.stop()
    assert room.apps == [
        InboundAppJoin(
            channel_id=MAILBOX,
            channel_type="channel_private",
            channel_name=MAILBOX,
        )
    ]


async def test_stopping_ends_the_listener(server: FakeServer) -> None:
    adapter, room = _adapter(), Room()
    await _start(adapter, room)
    await asyncio.sleep(0)
    await asyncio.wait_for(adapter.stop(), timeout=5)
    assert adapter._listener is None


async def test_the_listener_reads_mail_that_was_waiting(server: FakeServer) -> None:
    server.deliver(_mail())
    adapter, room = _adapter(), Room()
    await _start(adapter, room)
    for _ in range(100):
        if room.messages:
            break
        await asyncio.sleep(0.01)
    await adapter.stop()
    assert [m.message_ref for m in room.messages] == ["<one@example.com>"]


async def test_a_login_refused_while_running_is_reported_as_an_error(
    server: FakeServer, caplog: pytest.LogCaptureFixture
) -> None:
    server.login_error = LoginError("password changed")
    adapter, room = _adapter(), Room()
    with caplog.at_level(logging.ERROR):
        await _start(adapter, room)
        for _ in range(100):
            if "cannot read mail" in caplog.text:
                break
            await asyncio.sleep(0.01)
        await adapter.stop()
    assert "password changed" in caplog.text


async def test_a_server_with_no_keywords_marks_mail_read_and_says_so(
    server: FakeServer, caplog: pytest.LogCaptureFixture
) -> None:
    adapter = _adapter()
    with caplog.at_level(logging.WARNING):
        flag = adapter._handled_flag({b"PERMANENTFLAGS": (b"\\Seen",)})
    assert flag == b"\\Seen"
    assert "keeps no custom keywords" in caplog.text
    assert (
        adapter._handled_flag({b"PERMANENTFLAGS": (b"\\Seen", b"\\*")})
        == HANDLED_KEYWORD
    )


async def test_marking_mail_read_finds_only_unread_mail(server: FakeServer) -> None:
    uid = server.deliver(_mail())
    room = Room()
    await _pass(_adapter(room), b"\\Seen")
    await _pass(_adapter(room), b"\\Seen")
    assert len(room.messages) == 1
    assert b"\\Seen" in server.mail[uid].flags


# ── Inbound ──────────────────────────────────────────────────────────────────


async def test_a_new_email_starts_a_thread_in_the_room(server: FakeServer) -> None:
    server.deliver(_mail(subject="Re: Deploy failed", body="Please look.\n\n-- \nAda"))
    room = Room()
    await _pass(_adapter(room))
    assert room.messages == [
        InboundMessage(
            channel_id=MAILBOX,
            channel_type="channel_private",
            sender_id="ada@example.com",
            sender_name="Ada",
            content="**Deploy failed**\n\nPlease look.",
            message_ref="<one@example.com>",
            root_id=None,
            channel_name=MAILBOX,
        )
    ]


async def test_a_reply_lands_in_its_thread_without_the_subject_or_history(
    server: FakeServer,
) -> None:
    server.deliver(
        _mail(
            message_id="<two@example.com>",
            subject="Re: Deploy failed",
            body="Yes, go.\n\nOn Thu Scout <room@acme.test> wrote:\n> Shall I?",
            headers={"In-Reply-To": "<out@acme.test>", "References": "<one@x> <out@x>"},
        )
    )
    room = Room()
    await _pass(_adapter(room))
    assert room.messages[0].content == "Yes, go."
    assert room.messages[0].root_id == "<one@x>"


async def test_a_message_is_marked_only_after_the_room_has_it(
    server: FakeServer,
) -> None:
    uid = server.deliver(_mail())
    room = Room(fail_messages=True)
    await _pass(_adapter(room))
    assert HANDLED_KEYWORD not in server.mail[uid].flags
    room.fail_messages = False
    await _pass(_adapter(room))
    assert HANDLED_KEYWORD in server.mail[uid].flags
    assert len(room.messages) == 1


async def test_one_bad_message_does_not_stop_the_next(
    server: FakeServer,
) -> None:
    first = server.deliver(_mail())
    second = server.deliver(_mail(message_id="<two@example.com>"))
    posted: list[str] = []

    async def fails_once(message: InboundMessage) -> None:
        if message.message_ref == "<one@example.com>":
            raise RuntimeError("no")
        posted.append(message.message_ref)

    adapter = _adapter(Room())
    adapter._on_message = fails_once
    await _pass(adapter)
    assert posted == ["<two@example.com>"]
    assert HANDLED_KEYWORD not in server.mail[first].flags
    assert HANDLED_KEYWORD in server.mail[second].flags


async def test_a_restart_picks_up_exactly_where_the_last_one_stopped(
    server: FakeServer,
) -> None:
    server.deliver(_mail())
    room = Room()
    await _pass(_adapter(room))
    server.deliver(_mail(message_id="<two@example.com>"))
    await _pass(_adapter(room))
    assert [m.message_ref for m in room.messages] == [
        "<one@example.com>",
        "<two@example.com>",
    ]


async def test_mail_from_before_the_connection_is_passed_over_and_marked(
    server: FakeServer,
) -> None:
    uid = server.deliver(_mail(), arrived=CONNECTED - timedelta(minutes=1))
    room = Room()
    await _pass(_adapter(room))
    assert room.messages == []
    assert HANDLED_KEYWORD in server.mail[uid].flags


async def test_the_search_only_asks_for_days_since_the_connection(
    server: FakeServer,
) -> None:
    await _pass(_adapter(Room()))
    assert server.searches[-1] == [
        b"UNKEYWORD",
        HANDLED_KEYWORD,
        b"SINCE",
        CONNECTED.date(),
    ]


async def test_reading_mail_does_not_mark_it_read(server: FakeServer) -> None:
    uid = server.deliver(_mail())
    await _pass(_adapter(Room()))
    assert b"\\Seen" not in server.mail[uid].flags


async def test_a_stranger_is_not_posted_and_it_is_logged(
    server: FakeServer, caplog: pytest.LogCaptureFixture
) -> None:
    uid = server.deliver(_mail(sender="Eve <eve@evil.test>"))
    room = Room()
    with caplog.at_level(logging.WARNING):
        await _pass(_adapter(room))
    assert room.messages == []
    assert "eve@evil.test" in caplog.text
    assert HANDLED_KEYWORD in server.mail[uid].flags


async def test_a_whole_domain_can_write_in(server: FakeServer) -> None:
    server.deliver(_mail(sender="carol@partner.test", authenticated=False))
    room = Room()
    await _pass(_adapter(room, require_authenticated_senders=False))
    assert [m.sender_id for m in room.messages] == ["carol@partner.test"]


async def test_a_forged_sender_is_not_posted(
    server: FakeServer, caplog: pytest.LogCaptureFixture
) -> None:
    server.deliver(_mail(authenticated=False))
    room = Room()
    with caplog.at_level(logging.WARNING):
        await _pass(_adapter(room))
    assert room.messages == []
    assert "did not verify the sender" in caplog.text


async def test_the_check_can_be_turned_off_for_a_server_that_adds_no_header(
    server: FakeServer,
) -> None:
    server.deliver(_mail(authenticated=False))
    room = Room()
    await _pass(_adapter(room, require_authenticated_senders=False))
    assert len(room.messages) == 1


async def test_the_named_receiving_server_is_the_one_believed(
    server: FakeServer,
) -> None:
    server.deliver(_mail())
    room = Room()
    await _pass(_adapter(room, authentication_server="mx.other.test"))
    assert room.messages == []
    server.deliver(_mail(message_id="<two@example.com>"))
    await _pass(_adapter(room, authentication_server="mx.acme.test"))
    assert [m.message_ref for m in room.messages] == ["<two@example.com>"]


@pytest.mark.parametrize(
    "headers",
    [
        {"Auto-Submitted": "auto-replied"},
        {"Precedence": "bulk"},
        {"List-Id": "<team.example.com>"},
        {"Return-Path": "<>"},
    ],
)
async def test_automated_mail_is_never_posted(
    server: FakeServer, headers: dict[str, str]
) -> None:
    uid = server.deliver(_mail(headers=headers))
    room = Room()
    await _pass(_adapter(room))
    assert room.messages == []
    assert HANDLED_KEYWORD in server.mail[uid].flags


async def test_switchs_own_mail_is_never_posted(server: FakeServer) -> None:
    server.deliver(_mail(sender=MAILBOX))
    server.deliver(_mail(message_id="<c@x>", headers={SWITCH_HEADER: "bridge-1"}))
    room = Room()
    await _pass(_adapter(room))
    assert room.messages == []


async def test_a_command_is_a_command(server: FakeServer) -> None:
    server.deliver(
        _mail(
            body="!interrupt scout now\n\n-- \nAda",
            headers={"References": "<root@x>"},
        )
    )
    room = Room()
    await _pass(_adapter(room))
    assert room.messages == []
    assert room.commands == [
        InboundCommand(
            channel_id=MAILBOX,
            channel_type="channel_private",
            sender_id="ada@example.com",
            sender_name="Ada",
            command="interrupt",
            args="scout now",
            message_ref="<one@example.com>",
            root_id="<root@x>",
            channel_name=MAILBOX,
        )
    ]


async def test_a_card_answer_arrives_as_the_words_the_person_wrote(
    server: FakeServer,
) -> None:
    server.deliver(
        _mail(
            subject="Re: Permission",
            body="A1 1\n\nOn Thu Scout wrote:\n> Reply with A1",
            headers={"References": "<root@x> <card@x>"},
        )
    )
    room = Room()
    await _pass(_adapter(room))
    assert room.messages[0].content == "A1 1"


async def test_attachments_reach_the_room_and_oversized_ones_are_named(
    server: FakeServer,
) -> None:
    message = EmailMessage()
    message["Authentication-Results"] = AUTHENTICATED
    message["From"] = "ada@example.com"
    message["Subject"] = "Files"
    message["Message-ID"] = "<files@x>"
    message.set_content("See attached.")
    message.add_attachment(
        b"small", maintype="application", subtype="pdf", filename="a.pdf"
    )
    message.add_attachment(
        b"x" * 4096, maintype="application", subtype="pdf", filename="big.pdf"
    )
    server.deliver(message.as_bytes())
    room = Room()
    adapter = _adapter(room)
    adapter.set_max_attachment_bytes(1024)
    await _pass(adapter)
    assert [a.filename for a in room.messages[0].attachments] == ["a.pdf"]
    assert [f.filename for f in room.messages[0].attachment_failures] == ["big.pdf"]


async def test_mail_with_no_message_id_gets_a_stable_one(server: FakeServer) -> None:
    raw = (
        b"Authentication-Results: mx.acme.test; dmarc=pass\r\n"
        b"From: ada@example.com\r\nSubject: Hi\r\n\r\nHello\r\n"
    )
    server.deliver(raw)
    server.deliver(raw)
    room = Room()
    await _pass(_adapter(room))
    assert len(room.messages) == 2
    assert room.messages[0].message_ref == room.messages[1].message_ref


# ── Outbound ─────────────────────────────────────────────────────────────────


async def test_a_reply_goes_to_the_people_in_its_thread(server: FakeServer) -> None:
    server.deliver(
        _mail(headers={"Cc": "bob@example.com, eve@evil.test"}, subject="Deploy failed")
    )
    adapter = _adapter()
    ref = await adapter.send_message(MAILBOX, "Scout", "Done.", "<one@example.com>")
    sent = server.sent[0]
    assert sent["To"].addresses[0].addr_spec == "ada@example.com"
    assert [a.addr_spec for a in sent["To"].addresses] == [
        "ada@example.com",
        "bob@example.com",
    ]
    assert sent["Subject"] == "Re: Deploy failed"
    assert sent["In-Reply-To"] == "<one@example.com>"
    assert sent["Message-ID"] == ref
    assert sent["From"].addresses[0].display_name == "Scout"
    assert sent["From"].addresses[0].addr_spec == MAILBOX


async def test_a_new_message_goes_to_the_addresses_on_the_list(
    server: FakeServer,
) -> None:
    await _adapter().send_message(MAILBOX, "Scout", "## Daily report\n\nAll good.")
    sent = server.sent[0]
    assert [a.addr_spec for a in sent["To"].addresses] == [
        "ada@example.com",
        "bob@example.com",
    ]
    assert sent["Subject"] == "Daily report"
    assert sent["In-Reply-To"] is None


async def test_a_thread_nobody_has_answered_goes_to_the_list(
    server: FakeServer,
) -> None:
    await _adapter().send_message(MAILBOX, "Scout", "Second.", "<mine@acme.test>")
    assert len(server.sent[0]["To"].addresses) == 2
    assert server.sent[0]["In-Reply-To"] == "<mine@acme.test>"


async def test_a_long_first_line_is_cut_for_the_subject(server: FakeServer) -> None:
    await _adapter().send_message(MAILBOX, "Scout", "x" * 200)
    assert len(str(server.sent[0]["Subject"])) == 78


async def test_with_nobody_to_write_to_it_fails_out_loud(server: FakeServer) -> None:
    adapter = _adapter(allowed_senders="@partner.test")
    with pytest.raises(BridgeOperationError, match="Nobody to send this to"):
        await adapter.send_message(MAILBOX, "Scout", "Hello")


async def test_a_refused_message_says_what_the_server_said(server: FakeServer) -> None:
    server.smtp_error = smtplib.SMTPDataError(552, b"Message too large")
    with pytest.raises(BridgeOperationError, match="552 Message too large"):
        await _adapter().send_message(MAILBOX, "Scout", "Hello")


async def test_refused_recipients_are_named(server: FakeServer) -> None:
    server.smtp_error = smtplib.SMTPRecipientsRefused(
        {"ada@example.com": (550, b"No such user")}
    )
    with pytest.raises(BridgeOperationError, match="ada@example.com: 550"):
        await _adapter().send_message(MAILBOX, "Scout", "Hello")


async def test_a_message_over_the_servers_limit_is_refused_before_sending(
    server: FakeServer,
) -> None:
    server.smtp_size = 100
    with pytest.raises(BridgeOperationError, match="takes at most"):
        await _adapter().send_message(MAILBOX, "Scout", "Hello")
    assert server.sent == []


async def test_nothing_is_sent_to_a_server_the_policy_refuses(
    server: FakeServer,
) -> None:
    class Refusing:
        async def resolve(self, hostname: str, port: int) -> list[str]:
            raise OutboundURLRefused(f"{hostname} is internal")

    adapter = _adapter()
    adapter.set_outbound_policy(Refusing())  # type: ignore[arg-type]
    with pytest.raises(OutboundURLRefused):
        await adapter.send_message(MAILBOX, "Scout", "Hello")
    assert server.sent == []


async def test_several_files_are_one_email(server: FakeServer) -> None:
    files = [
        OutboundAttachment(filename=name, mimetype="text/plain", data=b"data")
        for name in ("a.txt", "b.txt")
    ]
    await _adapter().send_attachments(MAILBOX, "Scout", files, caption="Here")
    assert len(server.sent) == 1
    assert [p.get_filename() for p in server.sent[0].iter_attachments()] == [
        "a.txt",
        "b.txt",
    ]


async def test_a_file_too_large_to_send_is_named_in_the_email(
    server: FakeServer,
) -> None:
    adapter = _adapter()
    adapter.set_max_attachment_bytes(10)
    await adapter.send_attachment(
        MAILBOX, "Scout", "big.bin", "application/pdf", b"x" * 11
    )
    sent = server.sent[0]
    assert list(sent.iter_attachments()) == []
    body = sent.get_body(preferencelist=("plain",))
    assert body is not None and "Not attached: big.bin" in body.get_content()


async def test_room_wide_words_are_defused_on_the_way_out(server: FakeServer) -> None:
    adapter = _adapter()
    assert "@everyone" not in adapter.translate_outbound("hello @everyone")


async def test_an_edit_and_a_delete_say_email_cannot(server: FakeServer) -> None:
    adapter = _adapter()
    with pytest.raises(BridgeOperationError, match="cannot change"):
        await adapter.update_message(MAILBOX, "<x@y>", "new")
    with pytest.raises(BridgeOperationError, match="cannot take back"):
        await adapter.delete_message(MAILBOX, "<x@y>")


async def test_there_is_no_channel_to_create() -> None:
    with pytest.raises(ChannelCreationUnsupported, match="one mailbox and one room"):
        await _adapter().create_channel("x", "y")


async def test_only_people_on_the_list_count_as_added() -> None:
    assert await _adapter().add_users_to_channel(
        MAILBOX, ["Ada", "Eve"], ["ada@example.com", "eve@evil.test"]
    ) == ["eve@evil.test"]


# ── Cards and turns ──────────────────────────────────────────────────────────


def _card() -> RequestCard:
    return RequestCard(open_request(), RequestReference(token="tok", handle="A1"))


def _turn(status: str, error: str | None = None) -> TurnActivity:
    turn = TurnUpsert.model_validate(
        {"type": "turn.upsert", "turnId": "t1", "status": status, "commandId": None}
    )
    return TurnActivity(items=[], turn=turn, error_summary=error)


async def test_a_card_is_an_email_that_says_how_to_answer(server: FakeServer) -> None:
    ref = await _adapter().post_rich(MAILBOX, "Scout", _card(), "<root@x>")
    sent = server.sent[0]
    assert sent["Message-ID"] == ref
    assert sent["In-Reply-To"] == "<root@x>"
    body = sent.get_body(preferencelist=("plain",))
    assert body is not None and "A1" in body.get_content()


async def test_posting_a_card_again_is_the_same_message(server: FakeServer) -> None:
    adapter = _adapter()
    first = await adapter.post_rich(MAILBOX, "Scout", _card(), "<root@x>")
    second = await adapter.post_rich(MAILBOX, "Scout", _card(), "<root@x>")
    assert first == second


async def test_a_card_that_cannot_be_sent_reports_it(server: FakeServer) -> None:
    server.smtp_error = smtplib.SMTPDataError(451, b"try later")
    with pytest.raises(RichContentFailed):
        await _adapter().post_rich(MAILBOX, "Scout", _card(), "<root@x>")


async def test_a_redrawn_card_sends_nothing(server: FakeServer) -> None:
    await _adapter().update_rich(MAILBOX, "Scout", "<ref@x>", _card(), "<root@x>")
    assert server.sent == []


async def test_a_turns_status_is_not_mailed(server: FakeServer) -> None:
    adapter = _adapter()
    ref = await adapter.post_rich(MAILBOX, "Scout", _turn("running"), "<root@x>")
    await adapter.update_rich(MAILBOX, "Scout", ref, _turn("running"), "<root@x>")
    await adapter.update_rich(MAILBOX, "Scout", ref, _turn("completed"), "<root@x>")
    assert ref
    assert server.sent == []


async def test_a_turn_that_failed_is_said(server: FakeServer) -> None:
    adapter = _adapter()
    failed = _turn("error", "The agent could not finish.")
    await adapter.update_rich(MAILBOX, "Scout", "<ref@x>", failed, "<root@x>")
    body = server.sent[0].get_body(preferencelist=("plain",))
    assert body is not None and "could not finish" in body.get_content()


async def test_a_failure_redrawn_is_the_same_message(server: FakeServer) -> None:
    adapter = _adapter()
    failed = _turn("error", "Stopped.")
    await adapter.update_rich(MAILBOX, "Scout", "<ref@x>", failed, "<root@x>")
    await adapter.update_rich(MAILBOX, "Scout", "<ref@x>", failed, "<root@x>")
    assert server.sent[0]["Message-ID"] == server.sent[1]["Message-ID"]


async def test_typing_is_nothing_at_all() -> None:
    assert await _adapter().send_typing(MAILBOX, "Scout", True) is None


def test_the_adapter_implements_everything_the_platform_needs() -> None:
    assert issubclass(EmailAdapter, PlatformAdapter)
    assert not EmailAdapter.__abstractmethods__
