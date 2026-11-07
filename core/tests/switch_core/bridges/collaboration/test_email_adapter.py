import pytest
from switch_core.bridges.collaboration.email.adapter import (
    EmailAdapter,
    EmailConnectionConfig,
)
from switch_core.bridges.collaboration.models import ChannelCreationUnsupported


@pytest.fixture
def email_config() -> EmailConnectionConfig:
    return EmailConnectionConfig(
        email_address="agent@switch.local",
        smtp_host="smtp.switch.local",
        smtp_port=587,
        smtp_user="agent",
        smtp_password="password",
    )


@pytest.fixture
def email_adapter(email_config: EmailConnectionConfig) -> EmailAdapter:
    return EmailAdapter(email_config)


def test_email_config_validation(email_config: EmailConnectionConfig) -> None:
    assert email_config.email_address == "agent@switch.local"
    assert email_config.smtp_port == 587
    assert email_config.use_tls is True


def test_email_adapter_capabilities(email_adapter: EmailAdapter) -> None:
    assert email_adapter.display_name == "Email"
    assert email_adapter.receives_webhooks is True
    assert email_adapter.supports_channel_creation is False
    assert email_adapter.supports_directory_search is False


@pytest.mark.asyncio
async def test_email_adapter_send_message(email_adapter: EmailAdapter) -> None:
    msg_id = await email_adapter.send_message(
        channel_id="user@example.com",
        sender_name="SRE Bot",
        content="Incident INC-8892 is resolved.",
    )
    assert msg_id is not None
    assert "@switch.local" in msg_id
    assert len(email_adapter._sent_messages) == 1


@pytest.mark.asyncio
async def test_email_adapter_channel_creation_unsupported(email_adapter: EmailAdapter) -> None:
    with pytest.raises(ChannelCreationUnsupported):
        await email_adapter.create_channel("incident-channel", "Incident war room")


def test_email_inbound_translation(email_adapter: EmailAdapter) -> None:
    raw_email = (
        "Hello team,\n\n"
        "Can you look into checkout 500 errors?\n\n"
        "On Fri, Nov 6, 2026 at 10:00 AM Switch <agents@switch.local> wrote:\n"
        "> System healthy\n"
        "--\n"
        "Best regards,\n"
        "Sam"
    )
    translated = email_adapter.translate_inbound(raw_email)
    assert translated == "Hello team,\n\nCan you look into checkout 500 errors?"
