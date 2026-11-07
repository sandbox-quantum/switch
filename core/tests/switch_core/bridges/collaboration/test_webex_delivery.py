from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.bridges.collaboration.webex.adapter import WebexAdapter
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    BridgeWebhookTarget,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.models import CollaborationBridge, MessagingEventReceipt
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.outbound import OutboundPolicy

from .test_platform_self_contained import _hook_bridge
from .test_webex_adapter import api as api
from .test_webex_adapter import delivery, start


@pytest.fixture
async def pods(api, session_factory) -> AsyncIterator[dict[str, Any]]:
    bridge_id = await _hook_bridge(session_factory, bridge_type="webex")
    async with session_factory() as db:
        tenant_id = await db.scalar(
            select(CollaborationBridge.tenant_id).where(
                CollaborationBridge.id == bridge_id
            )
        )
    owner = await start(api)
    quiet = WebexAdapter(config=owner.config)
    quiet.set_listening(False)
    quiet.set_outbound_policy(OutboundPolicy.parse(""))
    quiet.set_webhook_url(owner.webhook_url)
    await quiet.start(*(AsyncMock() for _ in range(5)))
    heard = AsyncMock()
    owner._on_message = quiet._on_message = heard
    clients: list[httpx.AsyncClient] = []
    for adapter in (owner, quiet):
        target = BridgeWebhookTarget(
            tenant_id=tenant_id,
            bridge_id=bridge_id,
            bridge_type="webex",
            adapter=adapter,
        )
        lifecycle = AsyncMock()
        lifecycle.webhook_target.return_value = target
        service = BridgeWebhookService(
            lifecycle=lifecycle,
            session_factory=session_factory,
            receipts=MessagingEventReceiptStore(),
        )
        app = FastAPI()
        app.include_router(create_bridge_webhook_router(service))
        clients.append(
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="https://switch.example",
            )
        )
    yield {
        "clients": clients,
        "owner": owner,
        "quiet": quiet,
        "heard": heard,
        "tenant_id": tenant_id,
        "bridge_id": bridge_id,
    }
    for client in clients:
        await client.aclose()
    await owner.stop()
    await quiet.stop()


async def post(pods, pod: int, **changes: Any) -> httpx.Response:
    request = delivery(pods["owner"], **changes)
    return await pods["clients"][pod].post(
        webhook_path(pods["bridge_id"]), content=request.body, headers=request.headers
    )


async def test_concurrent_deliveries_across_pods_route_once(
    pods, session_factory
) -> None:
    responses = await asyncio.gather(post(pods, 0), post(pods, 1))
    assert all(response.status_code in (200, 503) for response in responses)
    assert 200 in [response.status_code for response in responses]
    assert pods["heard"].await_count == 1
    assert (await post(pods, 1)).status_code == 200
    assert pods["heard"].await_count == 1
    async with tenant_session(session_factory, pods["tenant_id"]) as db:
        receipts = (await db.scalars(select(MessagingEventReceipt))).all()
        assert len(receipts) == 1
        assert receipts[0].handled_at is not None


async def test_registration_id_is_not_an_event_id(pods) -> None:
    assert (await post(pods, 0)).status_code == 200
    assert (await post(pods, 1, data={"id": "second-message"})).status_code == 200
    assert pods["heard"].await_count == 2


async def test_retry_after_fetch_failure_can_land_on_other_pod(
    pods, api, session_factory
) -> None:
    def fail(request: httpx.Request) -> httpx.Response | None:
        if request.url.path == "/v1/messages/incoming":
            return httpx.Response(503)
        return None

    api["respond"] = fail
    assert (await post(pods, 0)).status_code == 503
    async with tenant_session(session_factory, pods["tenant_id"]) as db:
        assert (await db.scalar(select(MessagingEventReceipt.id))) is None
    api.pop("respond")
    assert (await post(pods, 1)).status_code == 200
    assert pods["heard"].await_count == 1


async def test_committed_claim_does_not_block_duplicate_or_hold_dispatch_connection(
    pods, session_factory
) -> None:
    entered, release = asyncio.Event(), asyncio.Event()

    async def route(message) -> None:
        entered.set()
        await release.wait()

    pods["heard"].side_effect = route
    first = asyncio.create_task(post(pods, 0))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        async with tenant_session(session_factory, pods["tenant_id"]) as db:
            receipt = (await db.scalars(select(MessagingEventReceipt))).one()
            assert receipt.handled_at is None
        response = await asyncio.wait_for(post(pods, 1), 2)
        assert response.status_code == 503
    finally:
        release.set()
        await first
    assert (await post(pods, 1)).status_code == 200
    assert pods["heard"].await_count == 1


async def test_bad_signature_does_not_claim_receipt(pods, session_factory) -> None:
    response = await pods["clients"][0].post(
        webhook_path(pods["bridge_id"]),
        content=b"{}",
        headers={"x-spark-signature": "00" * 20},
    )
    assert response.status_code == 401
    async with tenant_session(session_factory, pods["tenant_id"]) as db:
        assert (await db.scalar(select(MessagingEventReceipt.id))) is None
    pods["heard"].assert_not_called()


async def test_restart_uses_committed_receipt_without_memory(pods, api) -> None:
    assert (await post(pods, 0)).status_code == 200
    await pods["owner"].stop()
    assert (await post(pods, 1)).status_code == 200
    assert pods["heard"].await_count == 1
