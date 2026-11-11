from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from typing import Any

import pytest

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
)
from switch_core.bridges.collaboration.whatsapp.adapter import (
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
)


def _adapter() -> WhatsAppAdapter:
    config = WhatsAppConnectionConfig(
        access_token="access",
        phone_number_id="test-phone-number-id",
        app_secret="app-secret",
        verify_token="verify",
    )
    return WhatsAppAdapter(config=config)


def _signature(body: bytes) -> str:
    digest = hmac.new(b"app-secret", body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def test_verifies_address_challenge_and_parses_echo() -> None:
    adapter = _adapter()
    request = WebhookRequest(
        method="GET",
        headers={},
        query={
            "hub.mode": "subscribe",
            "hub.verify_token": "verify",
            "hub.challenge": "abc",
        },
        body=b"",
    )

    asyncio.run(adapter.verify_webhook(request))
    event = adapter.parse_webhook(request)
    assert event.handshake == "abc"
    assert event.external_event_id is None


def test_rejects_bad_signature_before_reading_payload() -> None:
    adapter = _adapter()
    request = WebhookRequest(method="POST", headers={}, query={}, body=b"not json")

    with pytest.raises(WebhookAuthenticityError, match="signature"):
        asyncio.run(adapter.verify_webhook(request))


def test_uses_provider_message_id_for_deduplication_and_dispatches_direct_text() -> (
    None
):
    adapter = _adapter()
    body = json.dumps(
        {
            "object": "whatsapp_business_account",
            "entry": [
                {
                    "changes": [
                        {
                            "field": "messages",
                            "value": {
                                "metadata": {"phone_number_id": "test-phone-number-id"},
                                "contacts": [
                                    {
                                        "wa_id": "test-wa-user",
                                        "profile": {"name": "Ada"},
                                    }
                                ],
                                "messages": [
                                    {
                                        "id": "wamid.1",
                                        "from": "test-wa-user",
                                        "timestamp": str(int(time.time())),
                                        "type": "text",
                                        "text": {"body": "hello"},
                                    }
                                ],
                            },
                        }
                    ]
                }
            ],
        }
    ).encode()
    request = WebhookRequest(
        method="POST",
        headers={"x-hub-signature-256": _signature(body)},
        query={},
        body=body,
    )
    event = adapter.parse_webhook(request)
    assert event.external_event_id == "wamid.1"
    assert adapter.parse_webhook(request).external_event_id == event.external_event_id

    received: list[Any] = []

    async def on_message(message: Any) -> None:
        received.append(message)

    adapter._on_message = on_message
    asyncio.run(
        adapter.dispatch_event(
            envelope_type=event.envelope_type,
            payload=event.payload,
        )
    )

    assert len(received) == 1
    assert received[0].channel_id == "test-wa-user"
    assert received[0].channel_type == "direct"
    assert received[0].sender_name == "Ada"
    assert received[0].content == "hello"


def test_ignores_messages_for_a_different_phone_number() -> None:
    adapter = _adapter()
    payload = {
        "entry": [
            {
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "metadata": {"phone_number_id": "other-phone-number"},
                            "messages": [
                                {
                                    "id": "wamid.other-number",
                                    "from": "test-wa-user",
                                    "timestamp": str(int(time.time())),
                                    "type": "text",
                                    "text": {"body": "should not dispatch"},
                                }
                            ],
                        },
                    }
                ]
            }
        ]
    }
    received: list[Any] = []

    async def on_message(message: Any) -> None:
        received.append(message)

    adapter._on_message = on_message
    asyncio.run(adapter.dispatch_event(envelope_type="messages", payload=payload))

    assert received == []
    assert "test-wa-user" not in adapter._last_inbound


def test_missing_provider_timestamp_does_not_open_the_customer_service_window() -> None:
    adapter = _adapter()
    payload = {
        "entry": [
            {
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "metadata": {"phone_number_id": "test-phone-number-id"},
                            "messages": [
                                {
                                    "id": "wamid.no-timestamp",
                                    "from": "test-wa-user",
                                    "type": "text",
                                    "text": {"body": "hello"},
                                }
                            ],
                        },
                    }
                ]
            }
        ]
    }

    async def on_message(message: Any) -> None:
        return None

    adapter._on_message = on_message
    asyncio.run(adapter.dispatch_event(envelope_type="messages", payload=payload))

    assert "test-wa-user" not in adapter._last_inbound


def test_refuses_outbound_text_when_24_hour_window_is_closed() -> None:
    adapter = _adapter()
    adapter._last_inbound["test-wa-user"] = time.time() - 24 * 60 * 60

    with pytest.raises(BridgeOperationError, match="24-hour customer service window"):
        asyncio.run(adapter.send_message("test-wa-user", "agent", "reply"))


def test_sends_free_form_text_inside_open_window() -> None:
    adapter = _adapter()
    adapter._last_inbound["test-wa-user"] = time.time()

    class Response:
        is_error = False

        def json(self) -> dict[str, Any]:
            return {"messages": [{"id": "wamid.out"}]}

    class Client:
        request: dict[str, Any] = {}

        async def post(self, url: str, **kwargs: Any) -> Response:
            self.request = {"url": url, **kwargs}
            return Response()

    client = Client()
    adapter._http = client  # type: ignore[assignment]
    assert (
        asyncio.run(adapter.send_message("test-wa-user", "agent", "reply"))
        == "wamid.out"
    )
    assert client.request["json"]["to"] == "test-wa-user"
    assert client.request["json"]["text"]["body"] == "reply"


def test_connection_config_rejects_malformed_api_version() -> None:
    with pytest.raises(ValueError, match="api_version"):
        WhatsAppConnectionConfig(
            access_token="access",
            phone_number_id="test-phone-number-id",
            app_secret="secret",
            verify_token="verify",
            api_version="latest",
        )


def test_bad_cloud_api_credentials_raise_operator_facing_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Response:
        is_error = True
        status_code = 401

        def json(self) -> dict[str, Any]:
            return {"error": {"message": "Invalid OAuth access token"}}

    class Client:
        def __init__(self, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> Client:
            return self

        async def __aexit__(self, *args: Any) -> None:
            return None

        async def get(self, url: str, **kwargs: Any) -> Response:
            assert url == "https://graph.facebook.com/v25.0/test-phone-number-id"
            assert kwargs["params"] == {"fields": "id"}
            return Response()

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.whatsapp.adapter.httpx.AsyncClient",
        Client,
    )
    with pytest.raises(BridgeCredentialError, match="Meta rejected"):
        asyncio.run(
            WhatsAppAdapter.verify_credentials(
                {
                    "access_token": "access",
                    "phone_number_id": "test-phone-number-id",
                    "app_secret": "secret",
                    "verify_token": "verify",
                    "api_version": "v25.0",
                }
            )
        )
