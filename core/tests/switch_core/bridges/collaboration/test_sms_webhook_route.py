"""A signed Twilio webhook through the connection's own address, end to end.

The route, the receipt that makes a retried delivery count once, and the
adapter, with only Twilio mocked: what Twilio would see answered, and what the
room side of the bridge would be handed.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.sms.adapter import SmsAdapter
from switch_core.bridges.collaboration.sms.config import SmsConnectionConfig
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore

from .test_lifecycle_tenant_binding import _service
from .test_sms_adapter import CONFIG, Heard, inbound, signed


class _RunningBridge:
    def __init__(self, adapter: SmsAdapter) -> None:
        self.adapter = adapter


@pytest.fixture
async def route(session_factory: async_sessionmaker[AsyncSession]) -> Any:
    lifecycle: CollaborationBridgeLifecycleService = _service(session_factory)
    lifecycle._config.messaging_public_url = "https://switch.example"
    lifecycle.register_adapter("sms", SmsAdapter, SmsConnectionConfig)
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
            connection_config=dict(CONFIG),
        )
        session.add(bridge)
        await session.flush()
        bridge_id = bridge.id
        await session.commit()

    url = f"https://switch.example{webhook_path(bridge_id)}"
    adapter = SmsAdapter(config=SmsConnectionConfig.model_validate(CONFIG))
    adapter.set_webhook_url(url)
    heard = Heard()

    async def ignore(_: Any) -> None:
        return None

    await adapter.start(heard.message, heard.command, ignore, ignore, ignore)
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
    client_ = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
    )
    yield client_, bridge_id, url, heard
    await client_.aclose()
    await adapter.stop()


async def _post(client: httpx.AsyncClient, path: str, request: Any) -> httpx.Response:
    return await client.post(
        path,
        content=request.body,
        headers={
            **request.headers,
            "content-type": "application/x-www-form-urlencoded",
        },
    )


async def test_signed_text_reaches_the_room_side(route: Any) -> None:
    client, bridge_id, url, heard = route
    response = await _post(client, webhook_path(bridge_id), signed(inbound(), url=url))
    assert response.status_code == 200
    assert response.content == b""
    assert [m.content for m in heard.messages] == ["hello"]


async def test_retried_delivery_is_handled_once(route: Any) -> None:
    client, bridge_id, url, heard = route
    request = signed(inbound(MessageSid="SM-retry"), url=url)
    assert (await _post(client, webhook_path(bridge_id), request)).status_code == 200
    assert (await _post(client, webhook_path(bridge_id), request)).status_code == 200
    assert len(heard.messages) == 1


async def test_bad_signature_gets_401_and_reaches_nothing(route: Any) -> None:
    client, bridge_id, url, heard = route
    response = await _post(
        client, webhook_path(bridge_id), signed(inbound(), url=url, token="other")
    )
    assert response.status_code == 401
    assert heard.messages == []


async def test_signed_body_with_no_sid_gets_400(route: Any) -> None:
    client, bridge_id, url, heard = route
    fields = {k: v for k, v in inbound().items() if k != "MessageSid"}
    response = await _post(client, webhook_path(bridge_id), signed(fields, url=url))
    assert response.status_code == 400
    assert heard.messages == []
