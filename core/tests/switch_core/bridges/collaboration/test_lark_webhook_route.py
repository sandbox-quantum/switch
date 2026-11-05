"""Lark deliveries through Switch's own webhook route, end to end.

The route, the receipt store and Postgres are real; only Lark's API is faked.
Each delivery is encrypted and signed the way Lark sends it.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lark.adapter import (
    LarkAdapter,
    LarkConnectionConfig,
)
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import (
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.renderers import position_action
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
    webhook_path,
)
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore

from .test_lark_adapter import (
    ALICE,
    CHAT,
    CONFIG,
    VERIFICATION_TOKEN,
    FakeLark,
    _delivery,
    _event,
    _message,
)
from .test_lifecycle_tenant_binding import _service
from .test_platform_self_contained import _hook_bridge, _RunningBridge

Hook = tuple[httpx.AsyncClient, str, list[object]]


@pytest.fixture
async def hook(session_factory: async_sessionmaker[AsyncSession]) -> Hook:
    lifecycle: CollaborationBridgeLifecycleService = _service(session_factory)
    lifecycle._config.messaging_public_url = "https://switch.example"
    lifecycle.register_adapter("lark", LarkAdapter, LarkConnectionConfig)
    bridge_id = await _hook_bridge(session_factory, bridge_type="lark")

    adapter = LarkAdapter(
        config=LarkConnectionConfig.model_validate(CONFIG),
        transport=httpx.MockTransport(FakeLark()),
    )
    heard: list[object] = []

    async def hear(event: Any) -> None:
        heard.append(event)

    await adapter.start(hear, hear, hear, hear, hear)
    adapter.set_interaction_handler(hear)
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
    return client, bridge_id, heard


async def _post(
    client: httpx.AsyncClient, bridge_id: str, delivery: Any
) -> httpx.Response:
    return await client.post(
        webhook_path(bridge_id), content=delivery.body, headers=dict(delivery.headers)
    )


async def test_larks_address_check_gets_its_challenge_back(hook: Hook) -> None:
    client, bridge_id, heard = hook
    check = {
        "type": "url_verification",
        "challenge": "c-77",
        "token": VERIFICATION_TOKEN,
    }

    response = await _post(client, bridge_id, _delivery(check, signed=False))

    assert response.status_code == 200
    assert json.loads(response.text) == {"challenge": "c-77"}
    assert heard == []


async def test_a_message_reaches_the_room_side_once_however_often_lark_sends_it(
    hook: Hook,
) -> None:
    client, bridge_id, heard = hook
    delivery = _delivery(_event("im.message.receive_v1", _message("deploy it"), "ev-9"))

    first = await _post(client, bridge_id, delivery)
    retry = await _post(client, bridge_id, delivery)

    assert (first.status_code, retry.status_code) == (200, 200)
    assert [m.content for m in heard if isinstance(m, InboundMessage)] == ["deploy it"]


async def test_a_delivery_signed_with_another_key_is_401(hook: Hook) -> None:
    client, bridge_id, heard = hook
    delivery = _delivery(_event("im.message.receive_v1", _message()), key="not-ours")

    response = await _post(client, bridge_id, delivery)

    assert response.status_code == 401
    assert heard == []


async def test_a_press_on_a_card_button_answers_the_request(hook: Hook) -> None:
    client, bridge_id, heard = hook
    press = _event(
        "card.action.trigger",
        {
            "operator": {"open_id": ALICE},
            "action": {
                "tag": "button",
                "value": {"switch_token": "tok-1", "switch_position": 1},
            },
            "context": {"open_message_id": "om_card", "open_chat_id": CHAT},
        },
        "ev-press",
    )

    response = await _post(client, bridge_id, _delivery(press))

    assert response.status_code == 200
    [interaction] = heard
    assert isinstance(interaction, InboundInteraction)
    assert interaction.action_id == position_action(1)
    assert interaction.value == "tok-1"
    assert interaction.sender_name == "Alice"
