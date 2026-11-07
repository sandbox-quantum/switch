"""A text reaching an SMS connection through Switch's own webhook route, from
Twilio's signed POST to the adapter's callback, with Twilio's API mocked."""

from __future__ import annotations

import uuid
from typing import Any
from urllib.parse import urlencode

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.sms.adapter import (
    SIGNATURE_HEADER,
    SmsAdapter,
    SmsConnectionConfig,
    twilio_signature,
)
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore

from .test_lifecycle_tenant_binding import _service
from .test_sms_adapter import ALICE, NUMBER, SID, STRANGER, TOKEN, Twilio

ORIGIN = "https://switch.example"


class _RunningBridge:
    def __init__(self, adapter: Any) -> None:
        self.adapter = adapter


async def _bridge(
    session_factory: async_sessionmaker[AsyncSession], config: dict[str, Any]
) -> str:
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Tenant(id=tenant, slug=tenant, name=tenant))
        await session.flush()
        client = Client(
            tenant_id=tenant,
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            tenant_id=tenant,
            type="sms",
            display_name="SMS",
            client_id=client.id,
            status="active",
            connection_config=config,
        )
        session.add(bridge)
        await session.flush()
        bridge_id = bridge.id
        await session.commit()
    return bridge_id


@pytest.fixture
async def route(
    session_factory: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> tuple[httpx.AsyncClient, str, list[InboundMessage]]:
    monkeypatch.setattr(SmsAdapter, "_transport", httpx.MockTransport(Twilio().handler))
    lifecycle: CollaborationBridgeLifecycleService = _service(session_factory)
    lifecycle._config.messaging_public_url = ORIGIN
    lifecycle.register_adapter("sms", SmsAdapter, SmsConnectionConfig)

    config = {
        "account_sid": SID,
        "auth_token": TOKEN,
        "phone_number": NUMBER,
        "allowed_senders": ALICE,
    }
    bridge_id = await _bridge(session_factory, config)
    adapter = SmsAdapter(config=SmsConnectionConfig.model_validate(config))
    adapter.set_webhook_url(ORIGIN + webhook_path(bridge_id))
    heard: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        heard.append(message)

    async def ignore(_: Any) -> None:
        return None

    await adapter.start(on_message, ignore, ignore, ignore, ignore)
    lifecycle._bridges[bridge_id] = _RunningBridge(adapter)  # type: ignore[assignment]

    app = FastAPI()
    app.include_router(
        create_bridge_webhook_router(
            BridgeWebhookService(
                lifecycle=lifecycle,
                session_factory=session_factory,
                receipts=MessagingEventReceiptStore(),
            )
        )
    )
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=ORIGIN)
    return client, bridge_id, heard


def _post(
    bridge_id: str, sid: str, sender: str = ALICE, token: str = TOKEN
) -> dict[str, Any]:
    params = {
        "MessageSid": sid,
        "AccountSid": SID,
        "From": sender,
        "To": NUMBER,
        "Body": "hello from my phone",
        "NumMedia": "0",
    }
    url = ORIGIN + webhook_path(bridge_id)
    return {
        "url": webhook_path(bridge_id),
        "content": urlencode(params).encode(),
        "headers": {
            SIGNATURE_HEADER: twilio_signature(token, url, params.items()),
            "content-type": "application/x-www-form-urlencoded",
        },
    }


async def test_a_signed_text_reaches_the_room_side(
    route: tuple[httpx.AsyncClient, str, list[InboundMessage]],
) -> None:
    client, bridge_id, heard = route
    response = await client.post(**_post(bridge_id, "SM1"))
    assert response.status_code == 200
    assert [(m.channel_id, m.content) for m in heard] == [
        (ALICE, "hello from my phone")
    ]


async def test_twilio_retrying_a_text_delivers_it_once(
    route: tuple[httpx.AsyncClient, str, list[InboundMessage]],
) -> None:
    client, bridge_id, heard = route
    first = await client.post(**_post(bridge_id, "SM2"))
    again = await client.post(**_post(bridge_id, "SM2"))
    assert (first.status_code, again.status_code) == (200, 200)
    assert len(heard) == 1


async def test_a_text_signed_with_another_token_is_a_401(
    route: tuple[httpx.AsyncClient, str, list[InboundMessage]],
) -> None:
    client, bridge_id, heard = route
    response = await client.post(**_post(bridge_id, "SM3", token="someone-elses"))
    assert response.status_code == 401
    assert heard == []


async def test_a_genuine_text_from_a_stranger_is_accepted_but_goes_nowhere(
    route: tuple[httpx.AsyncClient, str, list[InboundMessage]],
) -> None:
    client, bridge_id, heard = route
    response = await client.post(**_post(bridge_id, "SM4", sender=STRANGER))
    assert response.status_code == 200
    assert heard == []
