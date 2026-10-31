"""Unit tests for the Email collaboration bridge adapter."""

from __future__ import annotations

import asyncio
import imaplib
import smtplib
from email.message import EmailMessage
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.email.adapter import (
    EmailAdapter,
    EmailConnectionConfig,
    clean_email_body,
    clean_message_id,
    is_sender_allowed,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    ChannelCreationUnsupported,
    InboundCommand,
    InboundMessage,
)


@pytest.fixture
def valid_config() -> EmailConnectionConfig:
    return EmailConnectionConfig(
        email_address="agent@switch.ai",
        sender_name="Switch Assistant",
        imap_host="imap.example.com",
        imap_port=993,
        imap_username="agent@switch.ai",
        imap_password="secret-imap-password",
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_username="agent@switch.ai",
        smtp_password="secret-smtp-password",
        smtp_use_tls=True,
        smtp_use_ssl=False,
    )


# ── Configuration Validation ──────────────────────────────────────────────────


def test_valid_config_parses(valid_config: EmailConnectionConfig) -> None:
    assert valid_config.email_address == "agent@switch.ai"
    assert valid_config.imap_port == 993
    assert valid_config.smtp_port == 587
    assert valid_config.poll_interval_seconds == 15


def test_invalid_email_address_is_refused() -> None:
    with pytest.raises(ValidationError, match="Invalid email address"):
        EmailConnectionConfig(
            email_address="invalid-email-address",
            imap_host="imap.example.com",
            imap_username="user",
            imap_password="pwd",
            smtp_host="smtp.example.com",
            smtp_username="user",
            smtp_password="pwd",
        )


def test_conflicting_smtp_ssl_and_tls_is_refused() -> None:
    with pytest.raises(ValidationError, match="both direct SSL and STARTTLS"):
        EmailConnectionConfig(
            email_address="agent@switch.ai",
            imap_host="imap.example.com",
            imap_username="user",
            imap_password="pwd",
            smtp_host="smtp.example.com",
            smtp_username="user",
            smtp_password="pwd",
            smtp_use_ssl=True,
            smtp_use_tls=True,
        )


def test_exclusive_resource_keys_by_mailbox(
    valid_config: EmailConnectionConfig,
) -> None:
    res = EmailAdapter.exclusive_resource(valid_config.model_dump())
    assert res == "email:agent@switch.ai"


# ── Failure Classification ────────────────────────────────────────────────────


def test_classify_failure() -> None:
    auth_err = smtplib.SMTPAuthenticationError(535, b"Authentication failed")
    assert EmailAdapter.classify_failure(auth_err) == "auth_failed"

    imap_auth = imaplib.IMAP4.error("LOGIN failed: bad credentials")
    assert EmailAdapter.classify_failure(imap_auth) == "auth_failed"

    conn_err = smtplib.SMTPConnectError(421, b"Connection refused")
    assert EmailAdapter.classify_failure(conn_err) == "network"

    generic_smtp = smtplib.SMTPException("Mailbox full")
    assert EmailAdapter.classify_failure(generic_smtp) == "platform_error"

    assert EmailAdapter.classify_failure(ValueError("other")) is None


# ── Credential Verification ───────────────────────────────────────────────────


async def test_verify_credentials_success(valid_config: EmailConnectionConfig) -> None:
    with (
        patch("imaplib.IMAP4_SSL") as mock_imap_cls,
        patch("smtplib.SMTP") as mock_smtp_cls,
    ):
        mock_imap = MagicMock()
        mock_imap_cls.return_value = mock_imap

        mock_smtp = MagicMock()
        mock_smtp_cls.return_value = mock_smtp

        await EmailAdapter.verify_credentials(valid_config.model_dump())

        mock_imap.login.assert_called_once_with(
            "agent@switch.ai", "secret-imap-password"
        )
        mock_imap.select.assert_called_once_with("INBOX")
        mock_smtp.starttls.assert_called_once()
        mock_smtp.login.assert_called_once_with(
            "agent@switch.ai", "secret-smtp-password"
        )


async def test_verify_credentials_imap_failure(
    valid_config: EmailConnectionConfig,
) -> None:
    with patch(
        "imaplib.IMAP4_SSL", side_effect=imaplib.IMAP4.error("Authentication failed")
    ):
        with pytest.raises(BridgeCredentialError, match="IMAP login failed"):
            await EmailAdapter.verify_credentials(valid_config.model_dump())


async def test_verify_credentials_smtp_failure(
    valid_config: EmailConnectionConfig,
) -> None:
    with (
        patch("imaplib.IMAP4_SSL") as mock_imap_cls,
        patch("smtplib.SMTP") as mock_smtp_cls,
    ):
        mock_imap_cls.return_value = MagicMock()
        mock_smtp = MagicMock()
        mock_smtp.login.side_effect = smtplib.SMTPAuthenticationError(
            535, b"Invalid auth"
        )
        mock_smtp_cls.return_value = mock_smtp

        with pytest.raises(BridgeCredentialError, match="SMTP login failed"):
            await EmailAdapter.verify_credentials(valid_config.model_dump())


# ── Text Cleaning & Helper Unit Tests ─────────────────────────────────────────


def test_clean_message_id() -> None:
    assert clean_message_id("<foo@bar.com>") == "foo@bar.com"
    assert clean_message_id("  <foo@bar.com> \n") == "foo@bar.com"
    assert clean_message_id("foo@bar.com") == "foo@bar.com"
    assert clean_message_id(None) is None


def test_clean_email_body_strips_quotes_and_signatures() -> None:
    text = (
        "Hello agent!\n\nPlease inspect issue 123.\n\n-- \nAlice Smith\nLead Engineer"
    )
    cleaned = clean_email_body(text)
    assert cleaned == "Hello agent!\n\nPlease inspect issue 123."


def test_clean_email_body_strips_reply_history() -> None:
    text = (
        "Here is the updated status.\n"
        "\n"
        "On Thu, Oct 29, 2026 at 10:00 AM Bob wrote:\n"
        "> What is the status of the deployment?\n"
        "> Thanks!"
    )
    cleaned = clean_email_body(text)
    assert cleaned == "Here is the updated status."


def test_is_sender_allowed() -> None:
    assert is_sender_allowed("alice@company.com", []) is True
    assert is_sender_allowed("alice@company.com", ["*@company.com"]) is True
    assert is_sender_allowed("alice@other.com", ["*@company.com"]) is False
    assert (
        is_sender_allowed("bob@partner.org", ["*@company.com", "bob@partner.org"])
        is True
    )


# ── Inbound Email Processing ──────────────────────────────────────────────────


async def test_inbound_message_dispatched(valid_config: EmailConnectionConfig) -> None:
    adapter = EmailAdapter(config=valid_config)

    received_messages: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received_messages.append(msg)

    async def on_command(cmd: InboundCommand) -> None:
        pass

    await adapter.start(
        on_message=on_message,
        on_command=on_command,
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    msg = EmailMessage()
    msg["From"] = "Alice Smith <alice@example.com>"
    msg["To"] = "agent@switch.ai"
    msg["Subject"] = "Project Questions"
    msg["Message-ID"] = "<msg-001@example.com>"
    msg.set_content("Could you explain the system architecture?")

    adapter._process_email(msg)
    await asyncio.sleep(0.01)

    assert len(received_messages) == 1
    inbound = received_messages[0]
    assert inbound.channel_id == "alice@example.com"
    assert inbound.channel_type == "direct"
    assert inbound.sender_id == "alice@example.com"
    assert inbound.sender_name == "Alice Smith"
    assert inbound.content == "Could you explain the system architecture?"
    assert inbound.message_ref == "msg-001@example.com"
    assert inbound.root_id is None

    await adapter.stop()


async def test_inbound_threaded_reply(valid_config: EmailConnectionConfig) -> None:
    adapter = EmailAdapter(config=valid_config)
    received: list[InboundMessage] = []

    await adapter.start(
        on_message=lambda m: received.append(m) or asyncio.sleep(0),
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    msg = EmailMessage()
    msg["From"] = "Bob <bob@example.com>"
    msg["To"] = "agent@switch.ai"
    msg["Subject"] = "Re: Project Questions"
    msg["Message-ID"] = "<msg-002@example.com>"
    msg["In-Reply-To"] = "<msg-001@example.com>"
    msg["References"] = "<msg-001@example.com>"
    msg.set_content("Yes, that makes total sense.")

    adapter._process_email(msg)
    await asyncio.sleep(0.01)

    assert len(received) == 1
    assert received[0].message_ref == "msg-002@example.com"
    assert received[0].root_id == "msg-001@example.com"

    await adapter.stop()


async def test_inbound_command_dispatched(valid_config: EmailConnectionConfig) -> None:
    adapter = EmailAdapter(config=valid_config)
    commands: list[InboundCommand] = []

    await adapter.start(
        on_message=MagicMock(),
        on_command=lambda c: commands.append(c) or asyncio.sleep(0),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    msg = EmailMessage()
    msg["From"] = "alice@example.com"
    msg["To"] = "agent@switch.ai"
    msg["Subject"] = "Status Check"
    msg["Message-ID"] = "<cmd-001@example.com>"
    msg.set_content("!status active-runs")

    adapter._process_email(msg)
    await asyncio.sleep(0.01)

    assert len(commands) == 1
    cmd = commands[0]
    assert cmd.command == "status"
    assert cmd.args == "active-runs"
    assert cmd.message_ref == "cmd-001@example.com"

    await adapter.stop()


async def test_inbound_plus_addressing_routes_to_channel(
    valid_config: EmailConnectionConfig,
) -> None:
    adapter = EmailAdapter(config=valid_config)
    received: list[InboundMessage] = []

    await adapter.start(
        on_message=lambda m: received.append(m) or asyncio.sleep(0),
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    msg = EmailMessage()
    msg["From"] = "alice@example.com"
    msg["To"] = "agent+room-dev@switch.ai"
    msg["Subject"] = "Team Chat"
    msg["Message-ID"] = "<msg-plus-01@example.com>"
    msg.set_content("Hello room dev!")

    adapter._process_email(msg)
    await asyncio.sleep(0.01)

    assert len(received) == 1
    assert received[0].channel_id == "room-dev"
    assert received[0].channel_type == "channel_public"

    await adapter.stop()


async def test_inbound_attachment_and_oversize_handling(
    valid_config: EmailConnectionConfig,
) -> None:
    adapter = EmailAdapter(config=valid_config)
    received: list[InboundMessage] = []

    await adapter.start(
        on_message=lambda m: received.append(m) or asyncio.sleep(0),
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    msg = EmailMessage()
    msg["From"] = "alice@example.com"
    msg["To"] = "agent@switch.ai"
    msg["Subject"] = "Files"
    msg["Message-ID"] = "<files-01@example.com>"
    msg.set_content("Here are the logs and big file.")

    # Normal attachment (5 bytes)
    msg.add_attachment(b"hello", maintype="text", subtype="plain", filename="log.txt")

    # Big attachment (100 bytes, exceeding custom 50 byte limit)
    adapter.config = valid_config.model_copy(update={"max_attachment_size_bytes": 50})
    msg.add_attachment(
        b"x" * 100, maintype="application", subtype="octet-stream", filename="big.bin"
    )

    adapter._process_email(msg)
    await asyncio.sleep(0.01)

    assert len(received) == 1
    assert len(received[0].attachments) == 1
    assert received[0].attachments[0].filename == "log.txt"
    assert received[0].attachments[0].data == b"hello"

    assert len(received[0].attachment_failures) == 1
    assert received[0].attachment_failures[0].filename == "big.bin"
    assert "exceeds" in received[0].attachment_failures[0].reason

    await adapter.stop()


async def test_disallowed_sender_is_dropped(
    valid_config: EmailConnectionConfig,
) -> None:
    adapter = EmailAdapter(
        config=valid_config.model_copy(update={"allowed_senders": ["*@trusted.com"]})
    )
    received: list[InboundMessage] = []

    await adapter.start(
        on_message=lambda m: received.append(m) or asyncio.sleep(0),
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    msg = EmailMessage()
    msg["From"] = "spammer@untrusted.com"
    msg["To"] = "agent@switch.ai"
    msg["Subject"] = "Promo"
    msg["Message-ID"] = "<spam-01@example.com>"
    msg.set_content("Spam offer")

    adapter._process_email(msg)
    await asyncio.sleep(0.01)

    assert len(received) == 0

    await adapter.stop()


# ── Outbound Sending ──────────────────────────────────────────────────────────


async def test_send_message_dispatches_smtp(
    valid_config: EmailConnectionConfig,
) -> None:
    adapter = EmailAdapter(config=valid_config)

    with patch.object(adapter, "_create_smtp_client") as mock_create_smtp:
        mock_smtp = MagicMock()
        mock_create_smtp.return_value = mock_smtp

        msg_id = await adapter.send_message(
            channel_id="alice@example.com",
            sender_name="Claude Agent",
            content="Hello from Claude!",
        )

        assert msg_id is not None
        assert "@switch.ai" in msg_id
        mock_smtp.send_message.assert_called_once()
        sent_msg = mock_smtp.send_message.call_args[0][0]

        assert sent_msg["From"] == "Claude Agent <agent@switch.ai>"
        assert sent_msg["To"] == "alice@example.com"
        assert "Hello from Claude!" in sent_msg.get_content()


async def test_send_message_in_thread_sets_headers(
    valid_config: EmailConnectionConfig,
) -> None:
    adapter = EmailAdapter(config=valid_config)
    adapter._thread_recipients["root-123@example.com"] = "bob@example.com"
    adapter._thread_subjects["root-123@example.com"] = "Project Plan"

    with patch.object(adapter, "_create_smtp_client") as mock_create_smtp:
        mock_smtp = MagicMock()
        mock_create_smtp.return_value = mock_smtp

        msg_id = await adapter.send_message(
            channel_id="bob@example.com",
            sender_name="Claude Agent",
            content="Here is the revised plan.",
            thread_root_id="root-123@example.com",
        )

        assert msg_id is not None
        mock_smtp.send_message.assert_called_once()
        sent_msg = mock_smtp.send_message.call_args[0][0]

        assert sent_msg["To"] == "bob@example.com"
        assert sent_msg["Subject"] == "Re: Project Plan"
        assert sent_msg["In-Reply-To"] == "<root-123@example.com>"
        assert sent_msg["References"] == "<root-123@example.com>"


# ── Capabilities ──────────────────────────────────────────────────────────────


def test_capabilities(valid_config: EmailConnectionConfig) -> None:
    adapter = EmailAdapter(config=valid_config)
    assert adapter.supports_channel_creation is False
    assert adapter.supports_directory_search is False
    assert adapter.renders_custom_url_schemes is False
    assert adapter.supports_activity_reactions is False
    assert adapter.keeps_quiet_unless_listening is True
    assert adapter.channel_on_delete == "kept"


async def test_create_channel_raises_unsupported(
    valid_config: EmailConnectionConfig,
) -> None:
    adapter = EmailAdapter(config=valid_config)
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("new-channel", "general topic")
