"""Webex deliveries through Switch's real webhook route and receipt store.

Every delivery Webex makes for one webhook carries that webhook's id at the top,
so these check that what makes a delivery "the same" is the event it is about:
two messages both arrive, a retry of one arrives once, and so does an event
that reaches two switch-core pods.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import InboundMessage
from switch_core.bridges.collaboration.webex.adapter import (
    WebexAdapter,
    WebexConnectionConfig,
)
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore

from .test_lifecycle_tenant_binding import _service
from .test_platform_self_contained import _hook_bridge, _RunningBridge
from .webex_fake import FakeWebex, adapter_for, envelope, spark_signature

Pod = tuple[httpx.AsyncClient, WebexAdapter, list[InboundMessage]]


def _lifecycle(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    service = _service(session_factory)
    service._config.messaging_public_url = "https://switch.example"
    service.register_adapter("webex", WebexAdapter, WebexConnectionConfig)
    return service


async def _pod(
    fake: FakeWebex,
    bridge_id: str,
    session_factory: async_sessionmaker[AsyncSession],
    *,
    listening: bool,
) -> Pod:
    """One switch-core process: its own adapter, lifecycle and route, sharing
    the database with every other."""
    lifecycle = _lifecycle(session_factory)
    adapter = adapter_for(fake, listening=listening)
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
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
    )
    return client, adapter, heard


@pytest.fixture
async def setup(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[FakeWebex, str, Pod]:
    fake = FakeWebex()
    bridge_id = await _hook_bridge(session_factory, bridge_type="webex")
    pod = await _pod(fake, bridge_id, session_factory, listening=True)
    return fake, bridge_id, pod


def _message(fake: FakeWebex, message_id: str, text: str) -> bytes:
    fake.messages[message_id] = {
        "id": message_id,
        "roomId": "room-1",
        "roomType": "group",
        "personId": "person-ada",
        "personEmail": "ada@example.com",
        "text": text,
    }
    return json.dumps(envelope("messages", message_id, personId="person-ada")).encode()


def _signed(body: bytes, secret: str | None = None) -> dict[str, str]:
    return {"x-spark-signature": spark_signature(body, *([secret] if secret else []))}


async def test_two_messages_from_one_webhook_both_reach_the_room(
    setup: tuple[FakeWebex, str, Pod],
) -> None:
    fake, bridge_id, (client, _, heard) = setup
    first = _message(fake, "msg-1", "one")
    second = _message(fake, "msg-2", "two")

    a = await client.post(
        webhook_path(bridge_id), content=first, headers=_signed(first)
    )
    b = await client.post(
        webhook_path(bridge_id), content=second, headers=_signed(second)
    )

    assert (a.status_code, b.status_code) == (200, 200)
    assert [m.content for m in heard] == ["one", "two"]


async def test_a_retried_delivery_is_handled_once(
    setup: tuple[FakeWebex, str, Pod],
) -> None:
    fake, bridge_id, (client, _, heard) = setup
    body = _message(fake, "msg-1", "once")

    for _ in range(3):
        response = await client.post(
            webhook_path(bridge_id), content=body, headers=_signed(body)
        )
        assert response.status_code == 200

    assert [m.content for m in heard] == ["once"]


async def test_an_event_reaching_two_pods_is_handled_by_one(
    setup: tuple[FakeWebex, str, Pod],
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    fake, bridge_id, (holder, _, heard_by_holder) = setup
    quiet, _, heard_by_quiet = await _pod(
        fake, bridge_id, session_factory, listening=False
    )
    body = _message(fake, "msg-1", "hello")

    await holder.post(webhook_path(bridge_id), content=body, headers=_signed(body))
    await quiet.post(webhook_path(bridge_id), content=body, headers=_signed(body))

    assert len(heard_by_holder) + len(heard_by_quiet) == 1


async def test_only_the_pod_holding_the_bridge_registered_webhooks(
    setup: tuple[FakeWebex, str, Pod],
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    fake, bridge_id, _ = setup
    registered = list(fake.webhooks)

    await _pod(fake, bridge_id, session_factory, listening=False)

    assert fake.webhooks == registered
    assert len(registered) == 3


@pytest.mark.parametrize("headers", [{}, {"x-spark-signature": "0" * 40}])
async def test_an_unproven_delivery_is_refused_before_anything_is_fetched(
    setup: tuple[FakeWebex, str, Pod], headers: dict[str, str]
) -> None:
    fake, bridge_id, (client, _, heard) = setup
    body = _message(fake, "msg-1", "forged")

    response = await client.post(webhook_path(bridge_id), content=body, headers=headers)

    assert response.status_code == 401
    assert heard == []
    assert not any(path == "/v1/messages/msg-1" for _, path, _ in fake.calls)


async def test_a_delivery_signed_with_another_secret_is_refused(
    setup: tuple[FakeWebex, str, Pod],
) -> None:
    fake, bridge_id, (client, _, heard) = setup
    body = _message(fake, "msg-1", "forged")

    response = await client.post(
        webhook_path(bridge_id), content=body, headers=_signed(body, "another-secret")
    )

    assert response.status_code == 401
    assert heard == []


async def test_an_unreadable_signed_body_is_a_400(
    setup: tuple[FakeWebex, str, Pod],
) -> None:
    _, bridge_id, (client, _, _) = setup
    body = b"not json"

    response = await client.post(
        webhook_path(bridge_id), content=body, headers=_signed(body)
    )

    assert response.status_code == 400
