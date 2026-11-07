"""WhatsApp end to end: registered, listed, and taking deliveries on its address.

Through the real webhook route and the receipts it keeps in Postgres, so a
retried delivery is shown to be handled once whichever process takes it.
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.platforms import register_platforms
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.bridges.collaboration.whatsapp.adapter import (
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
)
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.gateway.collaborations import list_bridge_types

from .test_lifecycle_tenant_binding import _service
from .whatsapp_fakes import (
    CONFIG,
    VERIFY,
    FakeMeta,
    Inbox,
    delivery,
    install_fake_meta,
    signed,
    text,
)


class _RunningBridge:
    def __init__(self, adapter: WhatsAppAdapter) -> None:
        self.adapter = adapter


@pytest.fixture(autouse=True)
def meta(monkeypatch: pytest.MonkeyPatch) -> FakeMeta:
    return install_fake_meta(monkeypatch)


@pytest.fixture
def lifecycle(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    service = _service(session_factory)
    service._config.messaging_public_url = "https://switch.example"
    register_platforms(service)
    return service


async def _bridge_row(session_factory: async_sessionmaker[AsyncSession]) -> str:
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
            type="whatsapp",
            display_name="WhatsApp",
            client_id=client.id,
            status="active",
            connection_config=CONFIG,
        )
        session.add(bridge)
        await session.flush()
        bridge_id = bridge.id
        await session.commit()
    return bridge_id


@pytest.fixture
async def route(
    lifecycle: CollaborationBridgeLifecycleService,
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[httpx.AsyncClient, str, Inbox]:
    bridge_id = await _bridge_row(session_factory)
    adapter = WhatsAppAdapter(config=WhatsAppConnectionConfig.model_validate(CONFIG))
    adapter.set_webhook_url(f"https://switch.example{webhook_path(bridge_id)}")
    inbox = Inbox()
    await adapter.start(
        inbox.message, inbox.command, inbox.ignore, inbox.ignore, inbox.ignore
    )
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
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
    )
    return client, bridge_id, inbox


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    request = signed(payload)
    return {"content": request.body, "headers": dict(request.headers)}


async def test_the_gateway_lists_whatsapp_with_its_name_icon_and_limits(
    lifecycle: CollaborationBridgeLifecycleService,
) -> None:
    types = {t.key: t for t in await list_bridge_types(lifecycle, MagicMock())}

    whatsapp = types["whatsapp"]
    assert whatsapp.display_name == "WhatsApp"
    assert whatsapp.icon_svg is not None and whatsapp.icon_svg.startswith("<svg")
    assert whatsapp.receives_webhooks is True
    assert whatsapp.channel_creation_supported is False
    assert whatsapp.directory_search_supported is False
    assert set(whatsapp.config_schema["required"]) == {
        "app_id",
        "phone_number_id",
        "access_token",
        "app_secret",
        "verify_token",
    }


async def test_a_signed_delivery_reaches_the_bridge(
    route: tuple[httpx.AsyncClient, str, Inbox],
) -> None:
    client, bridge_id, inbox = route

    response = await client.post(webhook_path(bridge_id), **_post(delivery(text("hi"))))

    assert response.status_code == 200
    assert [m.content for m in inbox.messages] == ["hi"]


async def test_a_retried_delivery_is_handled_once(
    route: tuple[httpx.AsyncClient, str, Inbox],
) -> None:
    client, bridge_id, inbox = route
    payload = delivery(text("only once", wamid="wamid.RETRY"))

    first = await client.post(webhook_path(bridge_id), **_post(payload))
    again = await client.post(webhook_path(bridge_id), **_post(payload))

    assert (first.status_code, again.status_code) == (200, 200)
    assert [m.content for m in inbox.messages] == ["only once"]


async def test_a_delivery_signed_with_another_secret_is_a_401(
    route: tuple[httpx.AsyncClient, str, Inbox],
) -> None:
    client, bridge_id, inbox = route
    request = signed(delivery(text("hi")), secret="someone-elses")

    response = await client.post(
        webhook_path(bridge_id), content=request.body, headers=dict(request.headers)
    )

    assert response.status_code == 401
    assert inbox.messages == []


async def test_meta_s_address_check_is_echoed_and_nothing_dispatched(
    route: tuple[httpx.AsyncClient, str, Inbox],
) -> None:
    client, bridge_id, inbox = route

    response = await client.get(
        webhook_path(bridge_id),
        params={
            "hub.mode": "subscribe",
            "hub.verify_token": VERIFY,
            "hub.challenge": "1158201444",
        },
    )

    assert response.status_code == 200
    assert response.text == "1158201444"
    assert inbox.messages == []
