"""The example receiver and a real Core room, joined over the HTTP contract."""

from __future__ import annotations

import asyncio
import json

import httpx
from fastapi import FastAPI
from sqlalchemy import select, update

from switch_core.bridges.collaboration.webhook import adapter as adapter_module
from switch_core.bridges.collaboration.webhook.adapter import (
    WebhookAdapter,
    WebhookConnectionConfig,
)
from switch_core.bridges.collaboration.webhooks import (
    BridgeWebhookService,
    create_bridge_webhook_router,
)
from switch_core.db.models import CollaborationBridge, Message, Room
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.outbound import OutboundPolicy

from .test_bridge_ownership import _process, _say
from .test_bridge_ownership import bridge as ownership_bridge  # noqa: F401
from .test_webhook_adapter import CONFIG
from .test_webhook_example import ADMIN, configure, load_app, state


async def test_example_and_core_room_exchange_threaded_messages_without_a_model(
    postgres_url,
    session_factory,
    ownership_bridge,  # noqa: F811 - imported pytest fixture
    monkeypatch,
    tmp_path,
):
    bridge = ownership_bridge
    demo = load_app(tmp_path / "chat.sqlite3")
    with demo.connect():
        pass
    receiver = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=demo.app), base_url="http://chat.example"
    )
    await configure(receiver)
    async with session_factory() as db, db.begin():
        await db.execute(
            update(CollaborationBridge)
            .where(CollaborationBridge.id == bridge.bridge_id)
            .values(type="webhook", connection_config=CONFIG)
        )
        await db.execute(
            update(Room)
            .where(Room.id == bridge.room_id)
            .values(external_channel_id="demo-chat", channel_type="channel_private")
        )

    async def receive(request):
        response = await receiver.post(
            "/receive", content=request.content, headers=dict(request.headers)
        )
        return httpx.Response(response.status_code, content=response.content)

    def client(policy, **kwargs):
        return httpx.AsyncClient(transport=httpx.MockTransport(receive), **kwargs)

    async def public_dns(self, hostname, port):
        return ["93.184.216.34"]

    monkeypatch.setattr(adapter_module, "guarded_async_client", client)
    monkeypatch.setattr(OutboundPolicy, "resolve", public_dns)
    process = await _process(postgres_url, session_factory)
    process.bridges._config.messaging_public_url = "https://switch.example"
    process.bridges._config.outbound_policy = OutboundPolicy.parse("")
    process.bridges.register_adapter("webhook", WebhookAdapter, WebhookConnectionConfig)
    try:
        await process.boot()
        async with asyncio.timeout(10):
            while not process.bridges.is_connected(bridge.bridge_id):
                await asyncio.sleep(0.02)
        app = FastAPI()
        app.include_router(
            create_bridge_webhook_router(
                BridgeWebhookService(
                    lifecycle=process.bridges,
                    session_factory=session_factory,
                    receipts=MessagingEventReceiptStore(),
                )
            )
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
        ) as switch:
            # Point the persisted demo outbox to this real bridge's HTTP route.
            with demo.connect() as db:
                db.execute(
                    "UPDATE settings SET value = ? WHERE name = 'inbound_url'",
                    (
                        f"https://switch.example/messaging/bridges/{bridge.bridge_id}/events",
                    ),
                )
            outgoing_id = await _say(session_factory, bridge, "Hello custom chat")
            async with asyncio.timeout(10):
                while not any(
                    message["text"] == "Hello custom chat"
                    for message in (await state(receiver))["messages"]
                ):
                    await asyncio.sleep(0.02)
            root = next(
                message["message_id"]
                for message in (await state(receiver))["messages"]
                if message["text"] == "Hello custom chat"
            )
            sent = await receiver.post(
                "/send",
                headers={"authorization": f"Bearer {ADMIN}"},
                json={
                    "text": "Hello Switch room",
                    "thread_id": root,
                    "attachments": [],
                },
            )
            assert sent.status_code == 200
            await demo.flush_once(switch)
            async with session_factory() as db:
                messages = list(
                    (
                        await db.scalars(
                            select(Message).where(
                                Message.room_id == bridge.room_id,
                                Message.body == "Hello Switch room",
                            )
                        )
                    ).all()
                )
            assert len(messages) == 1
            assert messages[0].content["m.relates_to"]["event_id"] == outgoing_id
            sent = await receiver.post(
                "/send",
                headers={"authorization": f"Bearer {ADMIN}"},
                json={"text": "!help", "thread_id": root, "attachments": []},
            )
            assert sent.status_code == 200
            await demo.flush_once(switch)
            async with session_factory() as db:
                commands = list(
                    (
                        await db.scalars(
                            select(Message).where(
                                Message.room_id == bridge.room_id,
                                Message.event_type == "com.switch.command",
                            )
                        )
                    ).all()
                )
            assert len(commands) == 1
            assert commands[0].content["command"] == "help"
            assert commands[0].content["args"] == ""
            assert commands[0].content["m.relates_to"]["event_id"] == outgoing_id
            assert all(
                row["state"] == "delivered" for row in (await state(receiver))["outbox"]
            )
            # A new example process sees the same messages and no pending duplicate.
            restarted = load_app(demo.DB_PATH)
            with restarted.connect() as db:
                assert (
                    db.execute(
                        "SELECT count(*) FROM outbox WHERE state = 'pending'"
                    ).fetchone()[0]
                    == 0
                )
                assert any(
                    json.loads(row[0])["text"] == "Hello Switch room"
                    for row in db.execute("SELECT data FROM messages")
                )
    finally:
        await process.stop()
        await receiver.aclose()
