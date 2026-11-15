"""A signed WhatsApp webhook through the connection's own address, end to end.

The route, the receipt that makes a retried delivery count once, and the
adapter, with only Graph mocked: what Meta would see answered, and what the
room side of the bridge would be handed.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.bridges.collaboration.whatsapp.adapter import (
    SIGNATURE_HEADER,
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
    sign,
)
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore

from .test_lifecycle_tenant_binding import _service
from .test_whatsapp_adapter import CONFIG, FakeGraph, Heard, envelope, graph, text

__all__ = ["graph"]


class _RunningBridge:
    def __init__(self, adapter: WhatsAppAdapter) -> None:
        self.adapter = adapter


def _lifecycle(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    lifecycle: CollaborationBridgeLifecycleService = _service(session_factory)
    lifecycle._config.messaging_public_url = "https://switch.example"
    lifecycle.register_adapter("whatsapp", WhatsAppAdapter, WhatsAppConnectionConfig)
    return lifecycle


async def _whatsapp_bridge(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    """A WhatsApp connection's rows in a workspace of its own: the workspace's
    id and the bridge's."""
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
            connection_config=dict(CONFIG),
        )
        session.add(bridge)
        await session.flush()
        bridge_id = bridge.id
        await session.commit()
    return tenant, bridge_id


def _client(
    lifecycle: CollaborationBridgeLifecycleService,
    session_factory: async_sessionmaker[AsyncSession],
) -> httpx.AsyncClient:
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
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
    )


@pytest.fixture
async def route(
    session_factory: async_sessionmaker[AsyncSession], graph: FakeGraph
) -> Any:
    lifecycle = _lifecycle(session_factory)
    _, bridge_id = await _whatsapp_bridge(session_factory)

    adapter = WhatsAppAdapter(config=WhatsAppConnectionConfig.model_validate(CONFIG))
    adapter.set_webhook_url(f"https://switch.example{webhook_path(bridge_id)}")
    heard = Heard()

    async def ignore(_: Any) -> None:
        return None

    await adapter.start(heard.message, heard.command, ignore, ignore, ignore)
    lifecycle._bridges[bridge_id] = _RunningBridge(adapter)  # type: ignore[assignment]

    client = _client(lifecycle, session_factory)
    yield client, bridge_id, heard
    await client.aclose()
    await adapter.stop()


class TestAWhatsAppWebhookEndToEnd:
    async def test_metas_address_check_is_answered_with_the_challenge(
        self, route: Any
    ) -> None:
        client, bridge_id, heard = route
        response = await client.get(
            webhook_path(bridge_id),
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": CONFIG["verify_token"],
                "hub.challenge": "1158201444",
            },
        )
        assert response.status_code == 200
        assert response.text == "1158201444"
        assert heard.messages == []

    async def test_a_wrong_verify_token_is_refused(self, route: Any) -> None:
        client, bridge_id, _heard = route
        response = await client.get(
            webhook_path(bridge_id),
            params={
                "hub.mode": "subscribe",
                "hub.verify_token": "guess",
                "hub.challenge": "1",
            },
        )
        assert response.status_code == 401

    async def test_a_signed_message_reaches_the_room_side_once(
        self, route: Any
    ) -> None:
        client, bridge_id, heard = route
        body = json.dumps(text("wamid.e2e1", "hello from WhatsApp")).encode()
        headers = {SIGNATURE_HEADER: sign(CONFIG["app_secret"], body)}

        first = await client.post(
            webhook_path(bridge_id), content=body, headers=headers
        )
        again = await client.post(
            webhook_path(bridge_id), content=body, headers=headers
        )

        assert (first.status_code, again.status_code) == (200, 200)
        assert [m.content for m in heard.messages] == ["hello from WhatsApp"]

    async def test_a_message_signed_with_another_secret_is_refused(
        self, route: Any
    ) -> None:
        client, bridge_id, heard = route
        body = json.dumps(text("wamid.e2e2", "forged")).encode()
        response = await client.post(
            webhook_path(bridge_id),
            content=body,
            headers={SIGNATURE_HEADER: sign("not-the-app-secret", body)},
        )
        assert response.status_code == 401
        assert heard.messages == []

    async def test_an_unreadable_signed_body_is_a_400(self, route: Any) -> None:
        client, bridge_id, _heard = route
        body = b"not json"
        response = await client.post(
            webhook_path(bridge_id),
            content=body,
            headers={SIGNATURE_HEADER: sign(CONFIG["app_secret"], body)},
        )
        assert response.status_code == 400

    async def test_a_field_the_bridge_does_not_read_is_answered_so_meta_stops(
        self, route: Any
    ) -> None:
        client, bridge_id, heard = route
        payload = envelope({"event": "VERIFIED"})
        payload["entry"][0]["changes"][0]["field"] = "account_update"
        body = json.dumps(payload).encode()
        response = await client.post(
            webhook_path(bridge_id),
            content=body,
            headers={SIGNATURE_HEADER: sign(CONFIG["app_secret"], body)},
        )
        assert response.status_code == 200
        assert heard.messages == []


class TestAConnectionThatIsNotRunning:
    """Meta is told to try again while the connection is down for a while,
    and its events are dropped while its workspace is archived, which a
    retry would find the same."""

    async def _post(
        self, session_factory: async_sessionmaker[AsyncSession], *, archived: bool
    ) -> int:
        lifecycle = _lifecycle(session_factory)
        tenant, bridge_id = await _whatsapp_bridge(session_factory)
        if archived:
            async with session_factory() as session:
                await session.execute(
                    update(Tenant)
                    .where(Tenant.id == tenant)
                    .values(archived_at=func.now())
                )
                await session.commit()
        body = json.dumps(text("wamid.down", "hello")).encode()
        async with _client(lifecycle, session_factory) as client:
            response = await client.post(
                webhook_path(bridge_id),
                content=body,
                headers={SIGNATURE_HEADER: sign(CONFIG["app_secret"], body)},
            )
        return response.status_code

    async def test_one_merely_stopped_is_a_503(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert await self._post(session_factory, archived=False) == 503

    async def test_one_in_an_archived_workspace_is_dropped_with_a_200(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        assert await self._post(session_factory, archived=True) == 200
