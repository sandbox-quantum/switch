from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from switch_core.bridges.collaboration.webhook.adapter import (
    WebhookAdapter,
    WebhookConnectionConfig,
)
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    BridgeWebhookTarget,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.models import CollaborationBridge, MessagingEventReceipt
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.outbound import OutboundPolicy

from .test_platform_self_contained import _hook_bridge
from .test_webhook_adapter import CONFIG, TOKEN, event


async def setup_pod(session_factory, bridge_id, tenant_id, callback):
    adapter = WebhookAdapter(config=WebhookConnectionConfig(**CONFIG))
    adapter.set_outbound_policy(OutboundPolicy.parse(""))
    adapter.set_webhook_url("https://switch.example" + webhook_path(bridge_id))
    await adapter.start(callback, *[AsyncMock() for _ in range(4)])
    target = BridgeWebhookTarget(
        tenant_id=tenant_id, bridge_id=bridge_id, bridge_type="webhook", adapter=adapter
    )
    lifecycle = SimpleNamespace(webhook_target=AsyncMock(return_value=target))
    service = BridgeWebhookService(
        lifecycle=lifecycle,
        session_factory=session_factory,
        receipts=MessagingEventReceiptStore(),
    )
    app = FastAPI()
    app.include_router(create_bridge_webhook_router(service))
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
    ), adapter


@pytest.fixture
async def bridge(session_factory):
    bridge_id = await _hook_bridge(session_factory, bridge_type="webhook")
    async with session_factory() as db, db.begin():
        await db.execute(
            update(CollaborationBridge)
            .where(CollaborationBridge.id == bridge_id)
            .values(connection_config=CONFIG)
        )
        tenant_id = await db.scalar(
            select(CollaborationBridge.tenant_id).where(
                CollaborationBridge.id == bridge_id
            )
        )
    return bridge_id, tenant_id


@pytest.fixture
async def single_connection_factory(postgres_url):
    engine = create_async_engine(postgres_url, pool_size=1, max_overflow=0)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def test_concurrent_deliveries_to_two_pods_are_dispatched_once(
    single_connection_factory, bridge
):
    session_factory = single_connection_factory
    bridge_id, tenant_id = bridge
    entered, release = asyncio.Event(), asyncio.Event()
    heard = []

    async def callback(message):
        heard.append(message)
        entered.set()
        await release.wait()

    a, aa = await setup_pod(session_factory, bridge_id, tenant_id, callback)
    b, ab = await setup_pod(session_factory, bridge_id, tenant_id, callback)
    headers = {"authorization": f"Bearer {TOKEN}"}
    try:
        first = asyncio.create_task(
            a.post(webhook_path(bridge_id), json=event(), headers=headers)
        )
        await asyncio.wait_for(entered.wait(), 3)
        second = asyncio.create_task(
            b.post(webhook_path(bridge_id), json=event(), headers=headers)
        )
        response = await asyncio.wait_for(second, 3)
        assert response.status_code == 503
        assert not first.done()
        async with session_factory() as db:
            receipt = await db.scalar(
                select(MessagingEventReceipt).where(
                    MessagingEventReceipt.platform == "webhook"
                )
            )
            assert receipt is not None and receipt.handled_at is None
        release.set()
        assert (await asyncio.wait_for(first, 3)).status_code == 200
        assert (
            await b.post(webhook_path(bridge_id), json=event(), headers=headers)
        ).status_code == 200
        assert len(heard) == 1
        async with session_factory() as db:
            receipts = list(
                (
                    await db.scalars(
                        select(MessagingEventReceipt).where(
                            MessagingEventReceipt.platform == "webhook"
                        )
                    )
                ).all()
            )
            assert len(receipts) == 1 and receipts[0].handled_at is not None
    finally:
        release.set()
        await a.aclose()
        await b.aclose()
        await aa.stop()
        await ab.stop()


async def test_a_failed_callback_is_retryable_on_a_restarted_pod(
    session_factory, bridge
):
    bridge_id, tenant_id = bridge
    failed = AsyncMock(side_effect=RuntimeError("temporary routing failure"))
    a, aa = await setup_pod(session_factory, bridge_id, tenant_id, failed)
    headers = {"authorization": f"Bearer {TOKEN}"}
    assert (
        await a.post(webhook_path(bridge_id), json=event(), headers=headers)
    ).status_code == 503
    async with session_factory() as db:
        assert (
            await db.scalar(
                select(MessagingEventReceipt).where(
                    MessagingEventReceipt.platform == "webhook"
                )
            )
            is None
        )
    await a.aclose()
    await aa.stop()
    heard = AsyncMock()
    b, ab = await setup_pod(session_factory, bridge_id, tenant_id, heard)
    try:
        assert (
            await b.post(webhook_path(bridge_id), json=event(), headers=headers)
        ).status_code == 200
        assert (
            await b.post(webhook_path(bridge_id), json=event(), headers=headers)
        ).status_code == 200
        heard.assert_awaited_once()
    finally:
        await b.aclose()
        await ab.stop()


async def test_unauthorized_malformed_and_oversized_events_do_not_dispatch(
    session_factory, bridge
):
    bridge_id, tenant_id = bridge
    callback = AsyncMock()
    client, adapter = await setup_pod(session_factory, bridge_id, tenant_id, callback)
    try:
        assert (
            await client.post(webhook_path(bridge_id), json=event())
        ).status_code == 401
        headers = {"authorization": f"Bearer {TOKEN}"}
        assert (
            await client.post(
                webhook_path(bridge_id), content=b"not json", headers=headers
            )
        ).status_code == 400
        adapter.webhook_body_limit = 100
        assert (
            await client.post(
                webhook_path(bridge_id), content=b"x" * 101, headers=headers
            )
        ).status_code == 413
        callback.assert_not_awaited()
    finally:
        await client.aclose()
        await adapter.stop()
