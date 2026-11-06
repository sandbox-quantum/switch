"""Independent services/adapters against real PostgreSQL, without live pods."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select

from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.platforms import PLATFORMS
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
from switch_core.db.models import (
    TENANT_ZERO_ID,
    CollaborationBridge,
    Message,
    MessagingEventReceipt,
    Room,
)
from switch_core.db.stores.bridge_message_map_store import BridgeMessageMapStore
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.gateway.collaborations import list_bridge_types
from switch_core.transport import InboundMessage as TransportMessage
from switch_core.transport import RoomRef
from switch_core.trust.client import NullTrustClient
from tests.switch_core.bridges.collaboration.test_lifecycle_tenant_binding import (
    _service,
)
from tests.switch_core.bridges.collaboration.test_webhook_adapter import (
    CONFIG,
    POLICY,
    event,
)
from tests.switch_core.transport.test_postgres_transport import _make_room, _transport


@pytest.fixture
async def delivery(session_factory, monkeypatch):
    sent = []

    async def receiver(req):
        sent.append(json.loads(req.content))
        return httpx.Response(200)

    from switch_core.bridges.collaboration.webhook import adapter as module

    monkeypatch.setattr(
        module,
        "guarded_async_client",
        lambda policy, **kw: httpx.AsyncClient(
            transport=httpx.MockTransport(receiver), **kw
        ),
    )
    async with session_factory() as session:
        room_id, room, human_id, human_user = await _make_room(session)
        bridge = CollaborationBridge(
            type="webhook",
            display_name="Custom app",
            client_id=human_id,
            status="active",
            connection_config=CONFIG,
        )
        session.add(bridge)
        await session.flush()
        bridge_id = bridge.id
        row = await session.get(Room, room_id)
        row.bridge_id, row.external_channel_id = bridge_id, "channel-1"
        await session.commit()

    transports = []
    copies = []
    clients = []
    heard = []
    fail = {"before": False, "after": False}

    async def make_copy():
        transport = _transport(session_factory, client_id=human_id, user_id=human_user)
        transports.append(transport)

        async def human_send(room, content, **kwargs):
            result = await transport.send_message(
                room, content, sender_name="Ada", **kwargs
            )
            return result.event_id

        async def human_upload(data, mimetype, filename):
            return (await transport.upload_media(data, mimetype, filename)).uri

        async def human_media(*args, **kwargs):
            return (
                await transport.send_media(*args, sender_name="Ada", **kwargs)
            ).event_id

        human = SimpleNamespace(
            client_id=human_id,
            transport_user_id=human_user,
            send_message=human_send,
            upload_media=human_upload,
            send_media=human_media,
        )
        adapter = WebhookAdapter(config=WebhookConnectionConfig(**CONFIG))
        adapter.set_outbound_policy(POLICY)
        adapter.set_listening(not copies)
        core = CollaborationCore.__new__(CollaborationCore)
        core._adapter = adapter
        core._bridge_id, core._bridge_tenant_id, core._bridge_type = (
            bridge_id,
            TENANT_ZERO_ID,
            "webhook",
        )
        core._session_factory = session_factory
        core._bridge_message_map_store = BridgeMessageMapStore()
        core._channel_to_room = {"channel-1": (room_id, room)}
        core._room_to_channel = {room_id: "channel-1", room: "channel-1"}
        core._room_tenants = {room_id: TENANT_ZERO_ID}
        core._pending_message_maps = {}
        core._trust_client = NullTrustClient()
        core._handle_text_answer = AsyncMock()
        core._is_registered_agent = AsyncMock(return_value=False)
        core._repair_placeholder_username = AsyncMock()
        core._ensure_human_in_room = AsyncMock(return_value=human)
        core._human_user_ids = {human_user}
        core._workspace_consumer_transport_user_id = "@bridge:test"
        core._move_indicator_for_sender = AsyncMock()
        core._is_human_sender = AsyncMock(return_value=False)
        core._channel_for_room = AsyncMock(return_value="channel-1")

        async def on_message(message):
            heard.append(message.message_ref)
            if fail["before"]:
                fail["before"] = False
                raise RuntimeError("simulated failure before transport write")
            await core._traced("message", core._handle_inbound_message)(message)
            if fail["after"]:
                fail["after"] = False
                raise RuntimeError("simulated failure after transport commit")

        await adapter.start(
            on_message, AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
        )
        target = BridgeWebhookTarget(
            tenant_id=TENANT_ZERO_ID,
            bridge_id=bridge_id,
            bridge_type="webhook",
            adapter=adapter,
        )
        service = BridgeWebhookService(
            lifecycle=SimpleNamespace(webhook_target=AsyncMock(return_value=target)),
            session_factory=session_factory,
            receipts=MessagingEventReceiptStore(),
        )
        app = FastAPI()
        app.include_router(create_bridge_webhook_router(service))
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://switch.example"
        )
        clients.append(client)
        copies.append((adapter, core, client, service, target))
        return copies[-1]

    await make_copy()
    await make_copy()

    async def post(copy=0, payload=None, token=None):
        return await copies[copy][2].post(
            webhook_path(bridge_id),
            json=payload or event(),
            headers={"authorization": f"Bearer {token or CONFIG['inbound_token']}"},
        )

    async def messages():
        async with session_factory() as session:
            return list(
                (
                    await session.scalars(
                        select(Message)
                        .where(Message.room_id == room_id)
                        .order_by(Message.seq)
                    )
                ).all()
            )

    yield SimpleNamespace(
        copies=copies,
        post=post,
        messages=messages,
        make_copy=make_copy,
        heard=heard,
        fail=fail,
        sent=sent,
        room=room,
        session_factory=session_factory,
    )
    for adapter, _, _, _, _ in copies:
        await adapter.stop()
    for client in clients:
        await client.aclose()


async def test_concurrent_services_and_restart_deduplicate_in_postgres(delivery):
    assert delivery.copies[0][0]._listening is True
    assert delivery.copies[1][0]._listening is False
    responses = await asyncio.gather(delivery.post(0), delivery.post(1))
    assert [r.status_code for r in responses] == [200, 200]
    assert delivery.heard == ["message-1"]
    assert len(await delivery.messages()) == 1
    await delivery.make_copy()
    assert (await delivery.post(2)).status_code == 200
    assert delivery.heard == ["message-1"]
    async with delivery.session_factory() as session:
        receipts = list((await session.scalars(select(MessagingEventReceipt))).all())
    assert len(receipts) == 1 and receipts[0].handled_at is not None


@pytest.mark.parametrize("failure", ["room", "sender", "write"])
async def test_unconfirmed_transport_failure_is_visible_and_retryable(
    delivery, failure
):
    core = delivery.copies[0][1]
    if failure == "room":
        core._channel_to_room = {}
        core._channel_locks = {}
        core._create_room_for_channel = AsyncMock(return_value=None)
    elif failure == "sender":
        core._ensure_human_in_room.return_value = None
    else:
        core._ensure_human_in_room.return_value.send_message = AsyncMock(
            return_value=None
        )
    assert (await delivery.post()).status_code == 503
    assert await delivery.messages() == []
    assert (await delivery.post(1)).status_code == 200
    assert len(await delivery.messages()) == 1


@pytest.mark.parametrize("when", ["before", "after"])
async def test_failure_rolls_back_receipt_and_retry_does_not_repeat_write(
    delivery, when
):
    delivery.fail[when] = True
    assert (await delivery.post()).status_code == 503
    async with delivery.session_factory() as session:
        assert list((await session.scalars(select(MessagingEventReceipt))).all()) == []
    # Another service instance accepts the retry, using the same durable ids.
    assert (await delivery.post(1)).status_code == 200
    assert len(await delivery.messages()) == 1
    assert delivery.heard == ["message-1", "message-1"]


async def test_transport_deduplicates_even_after_receipt_is_removed(delivery):
    assert (await delivery.post()).status_code == 200
    async with delivery.session_factory() as session:
        await session.execute(delete(MessagingEventReceipt))
        await session.commit()
    assert (await delivery.post(1)).status_code == 200
    assert len(await delivery.messages()) == 1
    # A genuinely different event carrying another post is not deduplicated by text.
    assert (
        await delivery.post(1, event(event_id="event-2", message_id="message-2"))
    ).status_code == 200
    assert len(await delivery.messages()) == 2


async def test_out_of_order_thread_reply_is_retried_instead_of_flattened(delivery):
    reply = event(
        event_id="reply-event", message_id="reply-post", thread_id="message-1"
    )
    assert (await delivery.post(payload=reply)).status_code == 503
    assert await delivery.messages() == []
    assert (await delivery.post(1)).status_code == 200
    assert (await delivery.post(0, reply)).status_code == 200
    rows = await delivery.messages()
    assert rows[1].content["m.relates_to"]["event_id"] == rows[0].transport_event_id


async def test_attachment_retry_writes_one_room_message(delivery):
    payload = event(
        attachments=[
            {
                "filename": "hello.txt",
                "mimetype": "text/plain",
                "data_base64": "aGVsbG8=",
            }
        ]
    )
    delivery.fail["after"] = True
    assert (await delivery.post(payload=payload)).status_code == 503
    assert (await delivery.post(1, payload)).status_code == 200
    rows = await delivery.messages()
    assert len(rows) == 1
    assert rows[0].content["msgtype"] == "m.file"
    assert rows[0].content["filename"] == "hello.txt"
    assert rows[0].content["body"] == "@agent hello"


async def test_mutation_notices_preserve_history_and_thread_mapping(delivery):
    assert (await delivery.post()).status_code == 200
    for kind, text in (("message.updated", "corrected"), ("message.deleted", "")):
        payload = event(type=kind, text=text, event_id=kind)
        assert (await delivery.post(1, payload)).status_code == 200
        assert (await delivery.post(0, payload)).status_code == 200
    rows = await delivery.messages()
    assert len(rows) == 3
    assert rows[0].body == "@agent hello"
    assert "edited" in rows[1].body and "deleted" in rows[2].body
    assert all(
        row.content["m.relates_to"]["event_id"] == rows[0].transport_event_id
        for row in rows[1:]
    )


async def test_thread_mapping_survives_new_adapter_and_signed_outbound(delivery):
    assert (await delivery.post()).status_code == 200
    assert (
        await delivery.post(
            1,
            event(
                event_id="event-2",
                message_id="message-2",
                thread_id="message-1",
            ),
        )
    ).status_code == 200
    rows = await delivery.messages()
    assert rows[1].content["m.relates_to"]["event_id"] == rows[0].transport_event_id
    _, core, _, _, _ = await delivery.make_copy()
    outgoing = TransportMessage(
        room_id=delivery.room,
        event_id="agent-reply",
        sender="@helper:test",
        timestamp=0,
        content={
            "m.relates_to": {
                "rel_type": "m.thread",
                "event_id": rows[0].transport_event_id,
            }
        },
        body="Hello Ada",
        sender_name="helper",
        thread_root_id=rows[0].transport_event_id,
    )
    await core.handle_outbound_message(RoomRef(delivery.room), outgoing)
    assert delivery.sent[-1]["sender_name"] == "helper"
    assert delivery.sent[-1]["thread_id"] == "message-1"
    assert delivery.sent[-1]["text"] == "Hello Ada"
    # The durable outbound map suppresses a second processing of the same row.
    await delivery.copies[0][1].handle_outbound_message(
        RoomRef(delivery.room), outgoing
    )
    assert len(delivery.sent) == 1


async def test_wrong_connection_token_and_payload_limit_over_http(delivery):
    assert (await delivery.post(token="another-connection-token")).status_code == 401
    assert (await delivery.post(payload=event(version=999))).status_code == 400
    adapter, _, client, _, target = delivery.copies[0]
    adapter.webhook_body_limit = 16
    response = await client.post(
        webhook_path(target.bridge_id),
        content=b"x" * 17,
        headers={"authorization": "Bearer " + CONFIG["inbound_token"]},
    )
    assert response.status_code == 413
    assert await delivery.messages() == []


async def test_gateway_registration_and_masked_console_fields(session_factory):
    lifecycle = _service(session_factory)
    registration = next(p for p in PLATFORMS if p.key == "webhook")
    lifecycle.register_adapter(*registration)
    platforms = {p.key: p for p in await list_bridge_types(lifecycle, MagicMock())}
    webhook = platforms["webhook"]
    assert webhook.display_name == "Custom app (webhook)"
    assert webhook.receives_webhooks and webhook.icon_svg
    assert not webhook.channel_creation_supported
    assert not webhook.directory_search_supported
    assert set(webhook.config_schema["required"]) == {
        "outbound_url",
        "inbound_token",
        "signing_secret",
    }
    # Field names are the Console's established masking contract.
    assert WebhookAdapter.outbound_urls(CONFIG) == [CONFIG["outbound_url"]]
