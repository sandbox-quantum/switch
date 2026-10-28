"""Replacing a messaging app's token with one the platform refuses changes nothing.

The edit used to be stored and the bridge restarted before anything asked the
platform, so Console reported the token replaced while the connection went
down in the background. Run through the real lifecycle service and Telegram
adapter, with only Telegram's answer canned.
"""

from __future__ import annotations

import json
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from telegram.request import HTTPXRequest

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.telegram.adapter import (
    TelegramAdapter,
    TelegramConnectionConfig,
)
from switch_core.db.models import Client, CollaborationBridge, User
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.collaborations import update_bridge
from switch_core.gateway.schemas import BridgeUpdateRequest
from tests.ownership import SoleOwner

OLD_TOKEN = "123456789:placeholder-old-secret"
NEW_SECRET = "placeholder-new-secret"
NEW_TOKEN = f"123456789:{NEW_SECRET}"


def _lifecycle(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    service = CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=ClientStore(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        provisioning=MagicMock(),
        session_factory=session_factory,
        config=MagicMock(),
        client_factory=MagicMock(),
        session_activity_listener=MagicMock(),
        session_activity_service=MagicMock(),
        connections=MagicMock(),
        ownership=SoleOwner(),
        cursor_writer=SoleOwner.cursor_writer(session_factory),
    )
    service.register_adapter("telegram", TelegramAdapter, TelegramConnectionConfig)
    service.restart = AsyncMock()  # type: ignore[method-assign]
    return service


async def _telegram_bridge(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:12]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type="telegram",
            display_name="Acme",
            client_id=client.id,
            status="active",
            connection_config={"bot_token": OLD_TOKEN, "bot_username": "switch_bot"},
        )
        session.add(bridge)
        await session.commit()
        return bridge.id


async def test_a_token_telegram_refuses_is_refused_and_nothing_changes(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unauthorized(self: HTTPXRequest, *args: Any, **kwargs: Any) -> Any:
        body = {"ok": False, "error_code": 401, "description": "Unauthorized"}
        return 401, json.dumps(body).encode()

    monkeypatch.setattr(HTTPXRequest, "do_request", unauthorized)
    bridge_id = await _telegram_bridge(session_factory)
    lifecycle = _lifecycle(session_factory)

    async with session_factory() as session:
        with pytest.raises(HTTPException) as refused:
            await update_bridge(
                bridge_id=bridge_id,
                payload=BridgeUpdateRequest(connection_config={"bot_token": NEW_TOKEN}),
                session=session,
                bridge_store=CollaborationBridgeStore(),
                room_store=RoomStore(),
                collab_lifecycle=lifecycle,
                user=User(
                    id="admin", name="admin", email="admin@example.test", role="admin"
                ),
            )

    assert refused.value.status_code == 400
    assert "rejected the bot token" in str(refused.value.detail)
    assert NEW_SECRET not in str(refused.value.detail)
    async with session_factory() as session:
        bridge = await CollaborationBridgeStore().get(session, bridge_id)
    assert bridge is not None
    assert (bridge.connection_config or {})["bot_token"] == OLD_TOKEN
    lifecycle.restart.assert_not_awaited()  # type: ignore[attr-defined]
