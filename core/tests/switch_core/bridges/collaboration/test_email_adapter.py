from __future__ import annotations

import asyncio
import imaplib
import smtplib
from email.message import EmailMessage
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from switch_core.bridges.collaboration.email.adapter import (
    EmailAdapter,
    EmailConnectionConfig,
    clean_email_body,
    clean_message_id,
    is_auto_submitted_or_bounce,
    is_sender_allowed,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    InboundCommand,
    InboundMessage,
)


def _make_config(**kwargs: Any) -> EmailConnectionConfig:
    defaults = {
        "email_address": "support@example.com",
        "imap_host": "imap.example.com",
        "imap_port": 993,
        "imap_username": "support@example.com",
        "imap_password": "secret-imap-password",
        "imap_use_ssl": True,
        "imap_folder": "INBOX",
        "smtp_host": "smtp.example.com",
        "smtp_port": 587,
        "smtp_username": "support@example.com",
        "smtp_password": "secret-smtp-password",
        "smtp_use_ssl": False,
        "smtp_use_starttls": True,
        "allowed_senders": ["*@trusted.com", "alice@example.com"],
        "poll_interval_seconds": 15.0,
        "max_attachment_size_bytes": 1024 * 1024,
    }
    defaults.update(kwargs)
    return EmailConnectionConfig(**defaults)


# ── Config Validation ─────────────────────────────────────────────────────────


def test_config_valid() -> None:
    cfg = _make_config()
    assert cfg.email_address == "support@example.com"
    assert cfg.imap_port == 993
    assert cfg.smtp_port == 587


def test_config_smtp_ssl_and_starttls_rejected() -> None:
    with pytest.raises(ValueError, match="Cannot enable both direct SSL and STARTTLS"):
        _make_config(smtp_use_ssl=True, smtp_use_starttls=True)


# ── Credential Verification ───────────────────────────────────────────────────


async def test_verify_credentials_success() -> None:
    cfg = _make_config().model_dump()
    with (
        patch("imaplib.IMAP4_SSL") as mock_imap_ssl,
        patch("smtplib.SMTP") as mock_smtp,
    ):
        mock_imap_instance = MagicMock()
        mock_imap_ssl.return_value = mock_imap_instance

        mock_smtp_instance = MagicMock()
        mock_smtp.return_value = mock_smtp_instance

        await EmailAdapter.verify_credentials(cfg)

        mock_imap_instance.login.assert_called_once_with(
            "support@example.com", "secret-imap-password"
        )
        mock_smtp_instance.login.assert_called_once_with(
            "support@example.com", "secret-smtp-password"
        )


async def test_verify_credentials_imap_auth_failed() -> None:
    cfg = _make_config().model_dump()
    with patch("imaplib.IMAP4_SSL") as mock_imap_ssl:
        mock_imap_instance = MagicMock()
        mock_imap_instance.login.side_effect = imaplib.IMAP4.error(
            "Invalid credentials"
        )
        mock_imap_ssl.return_value = mock_imap_instance

        with pytest.raises(BridgeCredentialError, match="IMAP authentication failed"):
            await EmailAdapter.verify_credentials(cfg)


async def test_verify_credentials_smtp_auth_failed() -> None:
    cfg = _make_config().model_dump()
    with (
        patch("imaplib.IMAP4_SSL") as mock_imap_ssl,
        patch("smtplib.SMTP") as mock_smtp,
    ):
        mock_imap_instance = MagicMock()
        mock_imap_ssl.return_value = mock_imap_instance

        mock_smtp_instance = MagicMock()
        mock_smtp_instance.login.side_effect = smtplib.SMTPAuthenticationError(
            535, b"Auth failed"
        )
        mock_smtp.return_value = mock_smtp_instance

        with pytest.raises(BridgeCredentialError, match="SMTP authentication failed"):
            await EmailAdapter.verify_credentials(cfg)


# ── Helpers & Cleaning ────────────────────────────────────────────────────────


def test_clean_message_id() -> None:
    assert clean_message_id("<foo@bar.com>") == "foo@bar.com"
    assert clean_message_id("  <baz@qux.org>  ") == "baz@qux.org"
    assert clean_message_id("plain-id") == "plain-id"
    assert clean_message_id(None) is None
    assert clean_message_id("") is None


def test_is_sender_allowed() -> None:
    patterns = ["*@trusted.com", "alice@example.com", "@domain.org"]
    assert is_sender_allowed("bob@trusted.com", patterns) is True
    assert is_sender_allowed("alice@example.com", patterns) is True
    assert is_sender_allowed("charlie@sub.domain.org", patterns) is True
    assert is_sender_allowed("mallory@evil.com", patterns) is False
    assert is_sender_allowed("anyone@anywhere.com", []) is True


def test_clean_email_body_strips_quoted_and_signatures() -> None:
    text = (
        "Hello agent!\n\n"
        "Can you assist with deployment?\n\n"
        "-- \n"
        "Alice Smith\n"
        "VP Engineering\n\n"
        "On 2026-10-30 someone wrote:\n"
        "> Earlier quoted message\n"
    )
    cleaned = clean_email_body(text)
    assert cleaned == "Hello agent!\n\nCan you assist with deployment?"


def test_is_auto_submitted_or_bounce() -> None:
    msg1 = EmailMessage()
    msg1["Auto-Submitted"] = "auto-replied"
    assert is_auto_submitted_or_bounce(msg1) is True

    msg2 = EmailMessage()
    msg2["Precedence"] = "bulk"
    assert is_auto_submitted_or_bounce(msg2) is True

    msg3 = EmailMessage()
    msg3["Return-Path"] = "<>"
    assert is_auto_submitted_or_bounce(msg3) is True

    msg4 = EmailMessage()
    msg4["From"] = "alice@example.com"
    assert is_auto_submitted_or_bounce(msg4) is False


# ── Adapter Capabilities & Lifecycle ──────────────────────────────────────────


def test_adapter_capabilities() -> None:
    adapter = EmailAdapter(config=_make_config())
    assert adapter.display_name == "Email"
    assert adapter.keeps_quiet_unless_listening is True
    assert adapter.supports_channel_creation is False
    assert adapter.supports_directory_search is False
    assert adapter.channel_on_delete == "kept"


async def test_exclusive_resource() -> None:
    cfg = _make_config(email_address="Ops@Example.Com").model_dump()
    res = EmailAdapter.exclusive_resource(cfg)
    assert res == "email:ops@example.com"


async def test_create_channel_raises_operation_error() -> None:
    adapter = EmailAdapter(config=_make_config())
    with pytest.raises(BridgeOperationError, match="cannot provision new rooms"):
        await adapter.create_channel("new-room", "topic")


def test_set_listening_starts_stops_poller() -> None:
    adapter = EmailAdapter(config=_make_config())
    with (
        patch.object(adapter, "_start_poller") as mock_start,
        patch.object(adapter, "_stop_poller") as mock_stop,
    ):
        adapter._running = True
        adapter.set_listening(True)
        assert adapter._listening is True
        mock_start.assert_called_once()

        adapter.set_listening(False)
        assert adapter._listening is False
        mock_stop.assert_called_once()


# ── Inbound Message Processing ────────────────────────────────────────────────


async def test_inbound_message_dispatches_cleanly() -> None:
    adapter = EmailAdapter(config=_make_config())
    received_messages: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received_messages.append(msg)

    await adapter.start(
        on_message=on_message,
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    raw = EmailMessage()
    raw["From"] = "Alice <alice@example.com>"
    raw["To"] = "support@example.com"
    raw["Subject"] = "Test Question"
    raw["Message-ID"] = "<msg-1001@example.com>"
    raw.set_content("Please help me restart server.")

    adapter._process_email(raw)
    await asyncio.sleep(0.05)

    assert len(received_messages) == 1
    inbound = received_messages[0]
    assert inbound.sender_id == "alice@example.com"
    assert inbound.sender_name == "Alice"
    assert inbound.message_ref == "msg-1001@example.com"
    assert inbound.content == "Please help me restart server."
    assert inbound.channel_id == "support@example.com"


async def test_inbound_command_dispatches_cleanly() -> None:
    adapter = EmailAdapter(config=_make_config())
    received_commands: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        received_commands.append(cmd)

    await adapter.start(
        on_message=MagicMock(),
        on_command=on_command,
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    raw = EmailMessage()
    raw["From"] = "Alice <alice@example.com>"
    raw["To"] = "support@example.com"
    raw["Subject"] = "Execute Command"
    raw["Message-ID"] = "<cmd-2002@example.com>"
    raw.set_content("!status --verbose")

    adapter._process_email(raw)
    await asyncio.sleep(0.05)

    assert len(received_commands) == 1
    cmd = received_commands[0]
    assert cmd.command == "status"
    assert cmd.args == "--verbose"
    assert cmd.sender_id == "alice@example.com"


async def test_inbound_disallowed_sender_dropped() -> None:
    adapter = EmailAdapter(config=_make_config(allowed_senders=["@trusted.com"]))
    received_messages: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received_messages.append(msg)

    await adapter.start(
        on_message=on_message,
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    raw = EmailMessage()
    raw["From"] = "Eve <eve@untrusted.com>"
    raw["To"] = "support@example.com"
    raw["Subject"] = "Spam"
    raw["Message-ID"] = "<spam-999@untrusted.com>"
    raw.set_content("Buy crypto now!")

    adapter._process_email(raw)
    await asyncio.sleep(0.05)
    assert len(received_messages) == 0


async def test_inbound_attachment_and_oversize_failure() -> None:
    adapter = EmailAdapter(
        config=_make_config(max_attachment_size_bytes=50)  # low cap for test
    )
    received_messages: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received_messages.append(msg)

    await adapter.start(
        on_message=on_message,
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    raw = EmailMessage()
    raw["From"] = "Alice <alice@example.com>"
    raw["To"] = "support@example.com"
    raw["Subject"] = "Attachments Test"
    raw["Message-ID"] = "<attach-123@example.com>"
    raw.set_content("Here are files.")

    # Small file (ok)
    raw.add_attachment(
        b"small content", filename="small.txt", maintype="text", subtype="plain"
    )
    # Large file (fails limit)
    raw.add_attachment(
        b"x" * 200, filename="big.bin", maintype="application", subtype="octet-stream"
    )

    adapter._process_email(raw)
    await asyncio.sleep(0.05)

    assert len(received_messages) == 1
    msg = received_messages[0]
    assert len(msg.attachments) == 1
    assert msg.attachments[0].filename == "small.txt"
    assert len(msg.attachment_failures) == 1
    assert msg.attachment_failures[0].filename == "big.bin"
    assert "exceeds" in msg.attachment_failures[0].reason


# ── Outbound Dispatch ─────────────────────────────────────────────────────────


async def test_send_message_sets_threading_and_loop_headers() -> None:
    adapter = EmailAdapter(config=_make_config())
    mock_smtp = MagicMock()

    with patch.object(adapter, "_create_smtp_client", return_value=mock_smtp):
        sent_ref = await adapter.send_message(
            channel_id="alice@example.com",
            sender_name="Claude Agent",
            content="Task completed successfully.",
            thread_root_id="root-555@example.com",
        )

        assert sent_ref is not None
        mock_smtp.send_message.assert_called_once()
        sent_msg: EmailMessage = mock_smtp.send_message.call_args[0][0]

        assert sent_msg["To"] == "alice@example.com"
        assert "Claude Agent" in sent_msg["From"]
        assert sent_msg["In-Reply-To"] == "<root-555@example.com>"
        assert sent_msg["References"] == "<root-555@example.com>"
        assert sent_msg["Auto-Submitted"] == "auto-replied"
        assert sent_msg.get_content().strip() == "Task completed successfully."


async def test_send_attachment() -> None:
    adapter = EmailAdapter(config=_make_config())
    mock_smtp = MagicMock()

    with patch.object(adapter, "_create_smtp_client", return_value=mock_smtp):
        sent_ref = await adapter.send_attachment(
            channel_id="alice@example.com",
            sender_name="Claude Agent",
            filename="report.pdf",
            mimetype="application/pdf",
            data=b"%PDF-1.4 dummy data",
            caption="Here is your report.",
            thread_root_id="root-555@example.com",
        )

        assert sent_ref is not None
        mock_smtp.send_message.assert_called_once()
        sent_msg: EmailMessage = mock_smtp.send_message.call_args[0][0]

        attachments = list(sent_msg.iter_attachments())
        assert len(attachments) == 1
        assert attachments[0].get_filename() == "report.pdf"
        assert attachments[0].get_payload(decode=True) == b"%PDF-1.4 dummy data"
