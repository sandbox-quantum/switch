import hmac
import hashlib
import time
import pytest
from switch_core.bridges.collaboration.whatsapp.adapter import (
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelCreationUnsupported,
)


@pytest.fixture
def whatsapp_config() -> WhatsAppConnectionConfig:
    return WhatsAppConnectionConfig(
        phone_number_id="1000123456789",
        access_token="EAAB...test_token",
        app_secret="test_secret_key_12345",
        webhook_verify_token="custom_verify_token",
    )


@pytest.fixture
def whatsapp_adapter(whatsapp_config: WhatsAppConnectionConfig) -> WhatsAppAdapter:
    return WhatsAppAdapter(whatsapp_config)


def test_whatsapp_config_validation(whatsapp_config: WhatsAppConnectionConfig) -> None:
    assert whatsapp_config.phone_number_id == "1000123456789"
    assert whatsapp_config.webhook_verify_token == "custom_verify_token"


def test_whatsapp_adapter_capabilities(whatsapp_adapter: WhatsAppAdapter) -> None:
    assert whatsapp_adapter.display_name == "WhatsApp"
    assert whatsapp_adapter.receives_webhooks is True
    assert whatsapp_adapter.supports_channel_creation is False
    assert whatsapp_adapter.supports_directory_search is False


def test_webhook_signature_verification(whatsapp_adapter: WhatsAppAdapter) -> None:
    payload = b'{"object":"whatsapp_business_account","entry":[]}'
    sig = hmac.new(b"test_secret_key_12345", payload, hashlib.sha256).hexdigest()
    header = f"sha256={sig}"

    assert whatsapp_adapter.verify_webhook_signature(payload, header) is True
    assert whatsapp_adapter.verify_webhook_signature(payload, "sha256=invalid") is False


@pytest.mark.asyncio
async def test_whatsapp_send_message(whatsapp_adapter: WhatsAppAdapter) -> None:
    msg_id = await whatsapp_adapter.send_message(
        channel_id="+15551234567",
        sender_name="Incident Assistant",
        content="System incident is being triaged.",
    )
    assert msg_id is not None
    assert msg_id.startswith("wamid.")
    assert len(whatsapp_adapter._sent_messages) == 1


@pytest.mark.asyncio
async def test_whatsapp_24h_window_expired(whatsapp_adapter: WhatsAppAdapter) -> None:
    user = "+15559876543"
    # Simulate activity 25 hours ago
    whatsapp_adapter._last_user_activity[user] = time.time() - 90000

    with pytest.raises(BridgeOperationError) as exc_info:
        await whatsapp_adapter.send_message(
            channel_id=user,
            sender_name="Assistant",
            content="Hello after 25h",
        )
    assert "24-hour customer service window expired" in str(exc_info.value)


@pytest.mark.asyncio
async def test_whatsapp_channel_creation_unsupported(whatsapp_adapter: WhatsAppAdapter) -> None:
    with pytest.raises(ChannelCreationUnsupported):
        await whatsapp_adapter.create_channel("new-group", "Topic")
