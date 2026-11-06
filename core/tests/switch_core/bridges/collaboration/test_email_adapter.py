from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default

import pytest

from switch_core.bridges.collaboration.email.adapter import (
    EmailAdapter,
    EmailConnectionConfig,
    _announces_mail,
    _body_parts,
    _channel_id,
    _decode_thread_ref,
    _normal_subject,
    _render_html,
    _split_outbound_body,
    _strip_quoted_history,
    _thread_headers,
    _thread_ref,
)
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelCreationUnsupported,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.session.text import parse_text_answer


def _config(**overrides: object) -> EmailConnectionConfig:
    values = {
        "imap_host": "imap.example.test",
        "imap_username": "switch@example.test",
        "imap_password": "imap-secret",
        "smtp_host": "smtp.example.test",
        "smtp_username": "switch@example.test",
        "smtp_password": "smtp-secret",
        "from_address": "switch@example.test",
        "allowed_senders": "mina@example.test",
        "authentication_server": "mx.google.com",
    }
    values.update(overrides)
    return EmailConnectionConfig(**values)


def _message(
    *,
    sender: str = "Mina <mina@example.test>",
    subject: str = "Project update",
    message_id: str | None = "<root@example.test>",
    body: str = "Hello Switch",
    references: str | None = None,
    authentication_results: str | None = (
        "mx.google.com; dmarc=pass header.from=example.test"
    ),
    auto_submitted: str | None = None,
    list_id: str | None = None,
    return_path: str | None = None,
) -> bytes:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = "switch@example.test"
    message["Subject"] = subject
    if message_id is not None:
        message["Message-ID"] = message_id
    if authentication_results is not None:
        message["Authentication-Results"] = authentication_results
    if auto_submitted is not None:
        message["Auto-Submitted"] = auto_submitted
    if list_id is not None:
        message["List-Id"] = list_id
    if return_path is not None:
        message["Return-Path"] = return_path
    if references:
        message["References"] = references
        message["In-Reply-To"] = references.split()[-1]
    message.set_content(body)
    return message.as_bytes()


async def _ignore_app_join(_):
    return None


def test_email_is_registered_and_declares_mailbox_capabilities() -> None:
    registration = next(item for item in PLATFORMS if item.key == "email")
    assert registration.adapter is EmailAdapter
    assert registration.config is EmailConnectionConfig
    assert EmailAdapter.icon_svg() is not None
    assert EmailAdapter.supports_channel_creation is False
    assert EmailAdapter.supports_directory_search is False
    assert EmailAdapter.keeps_quiet_unless_listening is True


def test_config_masks_passwords_and_rejects_invalid_sender_address() -> None:
    config = _config()
    schema = EmailConnectionConfig.model_json_schema()
    assert "password" in schema["properties"]["imap_password"]["title"].lower()
    assert "password" in schema["properties"]["smtp_password"]["title"].lower()
    with pytest.raises(ValueError, match="valid email address"):
        _config(from_address="not-an-address")
    with pytest.raises(ValueError, match="valid email addresses"):
        _config(allowed_senders="")
    with pytest.raises(ValueError, match="valid server identifier"):
        _config(authentication_server="mx.google.com; dmarc=pass")
    assert config.imap_security == "ssl"
    assert config.smtp_security == "starttls"


@pytest.mark.asyncio
async def test_outbound_attempt_store_is_required() -> None:
    adapter = EmailAdapter(config=_config())
    with pytest.raises(RuntimeError, match="Outbound attempt store is not configured"):
        await adapter.load_outbound_attempts("$transport-event")
    with pytest.raises(RuntimeError, match="Outbound attempt store is not configured"):
        await adapter.persist_outbound_attempts("$transport-event", {}, False)


def test_email_threads_use_message_id_and_references() -> None:
    root = BytesParser(policy=default).parsebytes(_message())
    reply = BytesParser(policy=default).parsebytes(
        _message(
            subject="Re: Project update",
            message_id="<reply@example.test>",
            references="<root@example.test> <middle@example.test>",
        )
    )
    assert _thread_headers(root) is None
    assert _thread_headers(reply) == "<root@example.test>"
    assert _normal_subject("Re: Fwd: Project update") == "Project update"
    assert _channel_id("Mina@example.test") == _channel_id("mina@example.test")
    assert _channel_id("mina@example.test") != _channel_id("other@example.test")
    assert _decode_thread_ref(
        _thread_ref("<root@example.test>", "mina@example.test", "Project")
    ) == {
        "message_id": "<root@example.test>",
        "sender": "mina@example.test",
        "subject": "Project",
    }


def test_quoted_history_and_signatures_are_removed() -> None:
    body = "New information\n\nOn Tuesday, Mina wrote:\n> old text\n\n-- \nMina"
    assert _strip_quoted_history(body) == "New information"
    assert _strip_quoted_history("Keep this\n> quoted line") == "Keep this"


def test_long_outbound_body_splits_at_readable_boundaries_without_losing_text() -> None:
    paragraphs = [f"Paragraph {index}. " + "x" * 6000 for index in range(4)]
    original = "\n\n".join(paragraphs)
    chunks = _split_outbound_body(original)
    assert len(chunks) > 1
    assert all(len(chunk) <= 18_000 for chunk in chunks)
    assert "".join(chunks) == original


def test_inbound_attachments_are_decoded_and_oversize_is_visible() -> None:
    message = EmailMessage()
    message["From"] = "mina@example.test"
    message.set_content("Please review")
    message.add_attachment(
        b"abc", maintype="text", subtype="plain", filename="note.txt"
    )
    parsed = BytesParser(policy=default).parsebytes(message.as_bytes())
    body, attachments, failures = _body_parts(parsed, 4)
    assert body == "Please review"
    assert attachments[0].filename == "note.txt"
    assert attachments[0].data == b"abc"
    assert failures == []
    _, attachments, failures = _body_parts(parsed, 2)
    assert attachments == []
    assert failures[0].filename == "note.txt"


def test_outbound_html_is_formatted_and_rejects_unsafe_links() -> None:
    rendered = _render_html(
        "**bold** [safe](https://example.test) [bad](javascript:alert(1))"
    )
    assert "<strong>bold</strong>" in rendered
    assert 'href="https://example.test"' in rendered
    assert "javascript:" not in rendered


@pytest.mark.asyncio
async def test_email_dispatch_maps_thread_and_attachments_to_room_message() -> None:
    adapter = EmailAdapter(
        config=_config(allowed_senders="mina@example.test,other@example.test")
    )
    adapter.set_listening(False)
    received = []
    commands = []
    rooms = []

    async def on_message(value):
        received.append(value)

    async def on_command(value):
        commands.append(value)

    async def on_app_join(value):
        rooms.append(value)

    async def no_listen():
        return None

    adapter._listen = no_listen
    adapter.set_listening(True)
    await adapter.start(
        on_message, on_command, _ignore_app_join, _ignore_app_join, on_app_join
    )
    await adapter._dispatch_email("7", "42", _message(body="New answer"))
    await adapter._dispatch_email(
        "7",
        "43",
        _message(
            subject="Re: Project update",
            message_id="<reply@example.test>",
            body="Follow up",
            references="<root@example.test>",
        ),
    )
    await adapter._dispatch_email(
        "7",
        "44",
        _message(subject="Different topic", body="Another root"),
    )
    await adapter._dispatch_email(
        "7",
        "45",
        _message(sender="Other <other@example.test>", body="From another sender"),
    )
    assert received[0].channel_id == received[1].channel_id
    assert received[0].channel_id == received[2].channel_id
    assert received[0].channel_id == received[3].channel_id
    assert received[0].root_id is None
    assert received[1].root_id is not None
    assert received[0].content == "New answer"
    assert received[1].content == "Follow up"
    assert received[0].sender_id == "mina@example.test"
    assert received[3].sender_id == "other@example.test"
    assert received[0].message_ref != received[2].message_ref
    assert len(rooms) == 1
    assert rooms[0].channel_id == _channel_id("switch@example.test")
    adapter.set_listening(False)
    await adapter.stop()


@pytest.mark.asyncio
async def test_email_without_message_id_gets_a_stable_content_reference() -> None:
    adapter = EmailAdapter(config=_config())
    adapter.set_listening(False)
    received = []

    async def on_message(value):
        received.append(value)

    async def unused(_):
        pytest.fail("unexpected callback")

    await adapter.start(on_message, unused, unused, unused, _ignore_app_join)
    raw = _message(message_id=None)
    await adapter._dispatch_email("7", "42", raw)
    await adapter._dispatch_email("8", "17", raw)

    assert received[0].message_ref == received[1].message_ref
    await adapter.stop()


@pytest.mark.asyncio
async def test_email_threaded_approval_and_question_answers_reach_shared_answer_flow() -> (
    None
):
    adapter = EmailAdapter(config=_config())
    adapter.set_listening(False)
    received = []

    async def on_message(value):
        received.append(value)

    async def unused(_):
        pytest.fail("unexpected callback")

    await adapter.start(on_message, unused, unused, unused, _ignore_app_join)
    await adapter._dispatch_email(
        "7",
        "44",
        _message(
            message_id="<decision@example.test>",
            body="A7 yes",
            references="<approval-card@example.test>",
        ),
    )
    await adapter._dispatch_email(
        "7",
        "45",
        _message(
            message_id="<answer@example.test>",
            body='A8 q1="staging"',
            references="<question-card@example.test>",
        ),
    )
    approval, question = received
    assert parse_text_answer(approval.content).handle == "A7"
    assert approval.root_id is not None
    assert parse_text_answer(question.content).handle == "A8"
    assert parse_text_answer(question.content).parts[0].question == 1
    assert question.root_id is not None
    await adapter.stop()


@pytest.mark.asyncio
async def test_email_commands_are_dispatched_as_switch_commands() -> None:
    adapter = EmailAdapter(config=_config())
    adapter.set_listening(False)
    commands = []

    async def on_command(value):
        commands.append(value)

    async def unused(_):
        pytest.fail("unexpected callback")

    await adapter.start(unused, on_command, unused, unused, _ignore_app_join)
    await adapter._dispatch_email("1", "5", _message(body="!help rooms"))
    assert commands[0].command == "help"
    assert commands[0].args == "rooms"
    await adapter.stop()


@pytest.mark.asyncio
async def test_email_rejects_missing_or_untrusted_sender_authentication() -> None:
    adapter = EmailAdapter(config=_config())
    adapter.set_listening(False)
    received = []

    async def on_message(value):
        received.append(value)

    async def unused(_):
        pytest.fail("unexpected callback")

    await adapter.start(on_message, unused, unused, unused, _ignore_app_join)
    await adapter._dispatch_email(
        "7",
        "42",
        _message(authentication_results=None),
    )
    await adapter._dispatch_email(
        "7",
        "43",
        _message(authentication_results="attacker.example; dmarc=pass"),
    )
    await adapter._dispatch_email(
        "7",
        "44",
        _message(
            authentication_results=(
                "attacker.example; dmarc=pass, mx.google.com; dmarc=pass"
            )
        ),
    )
    await adapter._dispatch_email(
        "7",
        "45",
        _message(authentication_results="mx.google.com; dkim=pass header.d=other.test"),
    )
    await adapter._dispatch_email(
        "7",
        "46",
        _message(
            sender="Other <other@example.test>",
            authentication_results=(
                "mx.google.com; dmarc=pass header.from=example.test"
            ),
        ),
    )
    await adapter._dispatch_email(
        "7",
        "48",
        _message(
            authentication_results="mx.google.com; dkim=pass header.d=example.test"
        ),
    )
    await adapter._dispatch_email(
        "7",
        "49",
        _message(
            authentication_results=(
                "mx.google.com; spf=pass smtp.mailfrom=mina@example.test"
            )
        ),
    )
    assert len(received) == 2
    await adapter.stop()

    adapter = EmailAdapter(
        config=_config(require_authenticated_senders=False, authentication_server=None)
    )
    adapter.set_listening(False)
    received.clear()
    await adapter.start(on_message, unused, unused, unused, _ignore_app_join)
    await adapter._dispatch_email(
        "7",
        "47",
        _message(authentication_results=None),
    )
    assert len(received) == 1
    await adapter.stop()


@pytest.mark.asyncio
async def test_email_ignores_automated_mail_and_marks_outbound_replies(
    monkeypatch,
) -> None:
    received = []
    sent = []

    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def ehlo(self):
            return None

        def starttls(self, **kwargs):
            return None

        def login(self, username, password):
            return None

        def send_message(self, message):
            sent.append(message)
            return {}

        def quit(self):
            return None

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter.smtplib.SMTP", FakeSMTP
    )
    adapter = EmailAdapter(config=_config())
    adapter.set_listening(False)

    async def on_message(value):
        received.append(value)

    async def unused(_):
        pytest.fail("unexpected callback")

    await adapter.start(on_message, unused, unused, unused, unused)
    await adapter._dispatch_email(
        "7",
        "42",
        _message(
            message_id="<auto@example.test>",
            body="Automatic reply",
            auto_submitted="auto-replied",
        ),
    )
    await adapter._dispatch_email(
        "7",
        "43",
        _message(
            message_id="<list@example.test>",
            body="Mailing list message",
            list_id="Switch updates <updates.example.test>",
        ),
    )
    await adapter._dispatch_email(
        "7",
        "44",
        _message(
            message_id="<bounce@example.test>",
            body="Delivery failed",
            return_path="<>",
        ),
    )
    assert received == []

    adapter._send_email(
        _channel_id("switch@example.test"),
        "Avery",
        "Here is the answer.",
        None,
        [],
    )
    assert sent[0]["Auto-Submitted"] == "auto-generated"
    assert sent[0]["X-Switch-Email-Bridge"] == "1"
    await adapter.stop()


@pytest.mark.asyncio
async def test_quiet_pod_does_not_start_the_imap_poller() -> None:
    adapter = EmailAdapter(config=_config())

    async def unused(_):
        return None

    adapter.set_listening(False)
    await adapter.start(unused, unused, unused, unused, _ignore_app_join)
    assert adapter._listener is None
    await adapter.stop()


def test_email_connection_time_is_persisted_once() -> None:
    config = _config()
    prepared = asyncio.run(EmailAdapter.prepare_config(config.model_dump()))
    assert prepared["connected_at"]
    assert datetime.fromisoformat(prepared["connected_at"]).tzinfo == UTC
    assert asyncio.run(EmailAdapter.prepare_config(prepared)) == prepared


def test_handled_mail_uses_private_keyword_when_available(caplog) -> None:
    adapter = EmailAdapter(config=_config())
    assert adapter._handled_flag({b"PERMANENTFLAGS": (b"\\Seen", b"\\*")}) == (
        b"$SwitchSeen"
    )
    assert adapter._handled_flag({b"PERMANENTFLAGS": (b"\\Seen",)}) is None
    assert "rescan mail received since connection setup" in caplog.text


def test_idle_response_detection() -> None:
    assert _announces_mail((3, b"EXISTS"))
    assert _announces_mail((b"1", b"RECENT"))
    assert not _announces_mail((3, b"FETCH"))
    assert not _announces_mail(b"EXISTS")


def test_imap_idle_wakes_on_new_mail_and_closes_the_idle_window(monkeypatch) -> None:
    class FakeIMAP:
        def __init__(self) -> None:
            self.started = False
            self.finished = False

        def idle(self) -> None:
            self.started = True

        def idle_check(self, timeout: int) -> list[tuple[int, bytes]]:
            assert timeout == 15
            return [(1, b"EXISTS")]

        def idle_done(self) -> None:
            self.finished = True

    client = FakeIMAP()
    adapter = EmailAdapter(config=_config())
    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter._IDLE_SECONDS", 30
    )
    adapter._idle(client)
    assert client.started
    assert client.finished


@pytest.mark.asyncio
async def test_imap_cursor_marks_only_old_or_successfully_delivered_messages() -> None:
    adapter = EmailAdapter(config=_config(connected_at="2026-11-05T00:00:00+00:00"))
    adapter.set_listening(False)
    delivered = []

    class FakeIMAP:
        def __init__(self) -> None:
            self.search_criteria = None
            self.flags = []

        def search(self, criteria):
            self.search_criteria = criteria
            return [1, 2, 3]

        def fetch(self, uids, fields):
            dates = {
                1: datetime(2026, 11, 4, tzinfo=UTC),
                2: datetime(2026, 11, 5, 1, tzinfo=UTC),
                3: datetime(2026, 11, 5, 2, tzinfo=UTC),
            }
            return {
                uid: {
                    b"BODY[]": b"test",
                    b"INTERNALDATE": dates[uid],
                }
                for uid in uids
            }

        def add_flags(self, uids, flags):
            self.flags.extend((uid, flag) for uid in uids for flag in flags)

    client = FakeIMAP()

    async def dispatch(uidvalidity, uid, raw):
        delivered.append(uid)
        if uid == "3":
            raise RuntimeError("transport unavailable")

    adapter._dispatch_email = dispatch
    retry = await adapter._handle_waiting(
        client,
        b"$SwitchSeen",
        {b"UIDVALIDITY": 12, b"PERMANENTFLAGS": (b"\\*",)},
    )

    assert retry is True
    assert client.search_criteria == ["UNKEYWORD", b"$SwitchSeen"]
    assert delivered == ["2", "3"]
    assert client.flags == [(1, b"$SwitchSeen"), (2, b"$SwitchSeen")]


@pytest.mark.asyncio
async def test_imap_fallback_rescans_read_messages_without_changing_flags() -> None:
    adapter = EmailAdapter(config=_config(connected_at="2026-11-05T00:00:00+00:00"))
    delivered = []

    class FakeIMAP:
        def __init__(self) -> None:
            self.search_criteria = None
            self.flags = []

        def search(self, criteria):
            self.search_criteria = criteria
            return [1]

        def fetch(self, uids, fields):
            return {
                uid: {
                    b"BODY[]": _message(message_id="<already-read@example.test>"),
                    b"INTERNALDATE": datetime(2026, 11, 5, 1, tzinfo=UTC),
                }
                for uid in uids
            }

        def add_flags(self, uids, flags):
            self.flags.extend((uid, flag) for uid in uids for flag in flags)

    client = FakeIMAP()

    async def dispatch(uidvalidity, uid, raw):
        delivered.append((uidvalidity, uid, raw))

    adapter._dispatch_email = dispatch
    retry = await adapter._handle_waiting(
        client,
        None,
        {b"UIDVALIDITY": 12, b"PERMANENTFLAGS": (b"\\Seen",)},
    )

    assert retry is False
    assert client.search_criteria == ["SINCE", datetime(2026, 11, 5).date()]
    assert len(delivered) == 1
    assert client.flags == []


def test_email_reply_uses_smtp_from_agent_and_sets_thread_headers(
    monkeypatch,
) -> None:
    sent = []

    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def ehlo(self):
            return None

        def starttls(self, **kwargs):
            return None

        def login(self, username, password):
            return None

        def send_message(self, message):
            sent.append(message)
            return {}

        def quit(self):
            return None

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter.smtplib.SMTP", FakeSMTP
    )
    adapter = EmailAdapter(config=_config())
    root = _thread_ref("<root@example.test>", "mina@example.test", "Project update")
    adapter._send_email(
        _channel_id("switch@example.test"),
        "Avery",
        "Here is the **answer**.",
        root,
        [],
    )
    message = sent[0]
    assert message["To"] == "mina@example.test"
    assert message["From"] == "Avery <switch@example.test>"
    assert message["Auto-Submitted"] == "auto-generated"
    assert message["X-Switch-Email-Bridge"] == "1"
    assert message["In-Reply-To"] == "<root@example.test>"
    assert message["References"] == "<root@example.test>"
    plain_part = message.get_body(preferencelist=("plain",))
    assert plain_part.get_content().strip() == "Here is the **answer**."
    html_part = message.get_body(preferencelist=("html",))
    assert "<strong>answer</strong>" in html_part.get_content()


@pytest.mark.asyncio
async def test_ambiguous_smtp_send_is_persisted_and_never_automatically_retried(
    monkeypatch,
) -> None:
    submitted = []

    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def ehlo(self):
            return None

        def starttls(self, **kwargs):
            return None

        def login(self, username, password):
            return None

        def send_message(self, message):
            submitted.append(message)
            raise OSError("connection dropped after submission")

        def quit(self):
            return None

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter.smtplib.SMTP", FakeSMTP
    )

    async def run_inline(function, *args):
        return function(*args)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter.asyncio.to_thread",
        run_inline,
    )

    persisted: dict[str, dict[str, dict[str, str]]] = {}
    uncertain: dict[str, bool] = {}

    async def load(event_id):
        return persisted.get(event_id, {})

    async def save(event_id, attempts, is_uncertain):
        persisted[event_id] = attempts
        uncertain[event_id] = is_uncertain

    adapter = EmailAdapter(config=_config())
    adapter.set_outbound_attempt_store(load, save)
    key = "$transport-event-1"
    args = (
        key,
        _channel_id("switch@example.test"),
        "Avery",
        "A reply that may already have reached SMTP.",
        _thread_ref("<root@example.test>", "mina@example.test", "Project update"),
    )

    with pytest.raises(BridgeOperationError, match="will not resend it automatically"):
        await adapter.send_message_with_idempotency_key(*args)

    restarted = EmailAdapter(config=_config())
    restarted.set_outbound_attempt_store(load, save)
    with pytest.raises(BridgeOperationError, match="outcome is uncertain"):
        await restarted.send_message_with_idempotency_key(*args)

    assert len(submitted) == 1
    assert persisted[key]["message"]["status"] == "attempting"
    assert uncertain[key] is True


@pytest.mark.asyncio
async def test_confirmed_email_is_reused_after_restart_until_transport_settles_it(
    monkeypatch,
) -> None:
    sent = []

    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def ehlo(self):
            return None

        def starttls(self, **kwargs):
            return None

        def login(self, username, password):
            return None

        def send_message(self, message):
            sent.append(message)
            return {}

        def quit(self):
            return None

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter.smtplib.SMTP", FakeSMTP
    )

    async def run_inline(function, *args):
        return function(*args)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter.asyncio.to_thread",
        run_inline,
    )

    persisted: dict[str, dict[str, dict[str, str]]] = {}
    uncertain: dict[str, bool] = {}

    async def load(event_id):
        return persisted.get(event_id, {})

    async def save(event_id, attempts, is_uncertain):
        persisted[event_id] = attempts
        uncertain[event_id] = is_uncertain

    adapter = EmailAdapter(config=_config())
    adapter.set_outbound_attempt_store(load, save)
    args = (
        "$transport-event-2",
        _channel_id("switch@example.test"),
        "Avery",
        "A confirmed reply.",
        _thread_ref("<root@example.test>", "mina@example.test", "Project update"),
    )
    message_id = await adapter.send_message_with_idempotency_key(*args)
    assert message_id is not None
    assert persisted[args[0]]["message"]["status"] == "sent"
    assert uncertain[args[0]] is False

    restarted = EmailAdapter(config=_config())
    restarted.set_outbound_attempt_store(load, save)
    assert await restarted.send_message_with_idempotency_key(*args) == message_id
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_long_email_replies_are_split_and_follow_the_first_part_thread(
    monkeypatch,
) -> None:
    sent = []

    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def ehlo(self):
            return None

        def starttls(self, **kwargs):
            return None

        def login(self, username, password):
            return None

        def send_message(self, message):
            sent.append(message)
            return {}

        def quit(self):
            return None

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter.smtplib.SMTP", FakeSMTP
    )

    async def run_inline(function, *args):
        return function(*args)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.email.adapter.asyncio.to_thread",
        run_inline,
    )
    adapter = EmailAdapter(config=_config())
    attempts: dict[str, dict[str, dict[str, str]]] = {}

    async def load(event_id):
        return attempts.get(event_id, {})

    async def save(event_id, saved_attempts, uncertain):
        attempts[event_id] = saved_attempts

    adapter.set_outbound_attempt_store(load, save)
    content = "\n\n".join(f"Paragraph {index}. " + "x" * 6000 for index in range(4))
    first_id = await adapter.send_message(
        _channel_id("switch@example.test"), "Avery", content
    )
    assert len(sent) > 1
    assert sent[0]["Message-ID"] == first_id
    assert sent[0]["Subject"].startswith("Paragraph 0.")
    assert sent[1]["In-Reply-To"] == first_id
    assert sent[1]["References"] == first_id
    assert (
        sent[0]
        .get_body(preferencelist=("plain",))
        .get_content()
        .startswith("Part 1 of")
    )
    assert (
        sent[-1]
        .get_body(preferencelist=("plain",))
        .get_content()
        .startswith(f"Part {len(sent)} of {len(sent)}")
    )


@pytest.mark.asyncio
async def test_email_cannot_create_switch_rooms() -> None:
    adapter = EmailAdapter(config=_config())
    with pytest.raises(ChannelCreationUnsupported, match="created when someone emails"):
        await adapter.create_channel("ignored", "ignored")
    await adapter.stop()
