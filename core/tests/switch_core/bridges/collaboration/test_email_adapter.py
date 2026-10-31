from __future__ import annotations

from email.message import EmailMessage
from email.parser import BytesParser
from email.policy import default

import pytest

from switch_core.bridges.collaboration.email.adapter import (
    EmailAdapter,
    EmailConnectionConfig,
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
from switch_core.bridges.collaboration.models import ChannelCreationUnsupported
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
    }
    values.update(overrides)
    return EmailConnectionConfig(**values)


def _message(
    *,
    sender: str = "Mina <mina@example.test>",
    subject: str = "Project update",
    message_id: str = "<root@example.test>",
    body: str = "Hello Switch",
    references: str | None = None,
) -> bytes:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = "switch@example.test"
    message["Subject"] = subject
    message["Message-ID"] = message_id
    if references:
        message["References"] = references
        message["In-Reply-To"] = references.split()[-1]
    message.set_content(body)
    return message.as_bytes()


def test_email_is_registered_and_declares_mailbox_capabilities() -> None:
    registration = next(item for item in PLATFORMS if item.key == "email")
    assert registration.adapter is EmailAdapter
    assert registration.config is EmailConnectionConfig
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
    assert config.imap_security == "ssl"
    assert config.smtp_security == "starttls"


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
    assert _channel_id("Mina@example.test", "Re: Project update") == _channel_id(
        "mina@example.test", "Project update"
    )
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
    adapter = EmailAdapter(config=_config())
    adapter.set_listening(False)
    received = []
    commands = []

    async def on_message(value):
        received.append(value)

    async def on_command(value):
        commands.append(value)

    async def unused(_):
        pytest.fail("unexpected join callback")

    await adapter.start(on_message, on_command, unused, unused, unused)
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
    await adapter._dispatch_email("7", "44", _message(body="New answer"))
    assert received[0].channel_id == received[1].channel_id
    assert received[0].root_id is None
    assert received[1].root_id is not None
    assert received[0].content == "New answer"
    assert received[1].content == "Follow up"
    assert received[0].sender_id == "mina@example.test"
    assert received[0].message_ref == received[2].message_ref
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

    await adapter.start(on_message, unused, unused, unused, unused)
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

    await adapter.start(unused, on_command, unused, unused, unused)
    await adapter._dispatch_email("1", "5", _message(body="!help rooms"))
    assert commands[0].command == "help"
    assert commands[0].args == "rooms"
    await adapter.stop()


@pytest.mark.asyncio
async def test_quiet_pod_does_not_start_the_imap_poller() -> None:
    adapter = EmailAdapter(config=_config())

    async def unused(_):
        return None

    adapter.set_listening(False)
    await adapter.start(unused, unused, unused, unused, unused)
    assert adapter._poll_task is None
    await adapter.stop()


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
        _channel_id("mina@example.test", "Project update"),
        "Avery",
        "Here is the **answer**.",
        root,
        [],
    )
    message = sent[0]
    assert message["To"] == "mina@example.test"
    assert message["From"] == "Avery <switch@example.test>"
    assert message["In-Reply-To"] == "<root@example.test>"
    assert message["References"] == "<root@example.test>"
    plain_part = message.get_body(preferencelist=("plain",))
    assert plain_part.get_content().strip() == "Here is the **answer**."
    html_part = message.get_body(preferencelist=("html",))
    assert "<strong>answer</strong>" in html_part.get_content()


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
    content = "\n\n".join(f"Paragraph {index}. " + "x" * 6000 for index in range(4))
    first_id = await adapter.send_message(
        _channel_id("mina@example.test", "Project update"), "Avery", content
    )
    assert len(sent) > 1
    assert sent[0]["Message-ID"] == first_id
    assert sent[0]["Subject"] == "Project update"
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
