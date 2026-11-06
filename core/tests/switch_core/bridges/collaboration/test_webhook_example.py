from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from switch_core.bridges.collaboration.webhook.protocol import signature
from switch_core.bridges.collaboration.webhooks import webhook_path
from switch_core.transport import InboundMessage as TransportMessage
from switch_core.transport import RoomRef
from tests.switch_core.bridges.collaboration.test_webhook_adapter import CONFIG
from tests.switch_core.bridges.collaboration.test_webhook_delivery import (
    delivery as postgres_delivery,
)

delivery = postgres_delivery

EXAMPLE = Path(__file__).resolve().parents[5] / "examples/webhook-chat/app.py"
UI_PASSWORD = "demo-ui-" + "c" * 40


@pytest.fixture
def example(tmp_path):
    spec = importlib.util.spec_from_file_location("webhook_example", EXAMPLE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    database = str(tmp_path / "chat.sqlite3")

    def app(switch_url="https://switch.example/messaging/bridges/bridge/events"):
        return module.create_app(
            database=database,
            signing_secret=CONFIG["signing_secret"],
            inbound_token=CONFIG["inbound_token"],
            switch_url=switch_url,
            ui_password=UI_PASSWORD,
        )

    return module, app


def signed(payload, *, timestamp=None):
    body = json.dumps(payload).encode()
    ts = str(int(time.time())) if timestamp is None else str(timestamp)
    return body, {
        "x-switch-timestamp": ts,
        "x-switch-signature": signature(CONFIG["signing_secret"], ts, body),
        "content-type": "application/json",
    }


def outbound(**changes):
    return {
        "version": 1,
        "event_id": "event",
        "type": "message.created",
        "channel_id": "channel",
        "message_id": "message",
        "sender_name": "helper",
        "text": "<script>text, never HTML</script>",
        "part": 1,
        "parts": 1,
        **changes,
    }


async def test_example_verifies_signature_timestamp_and_restarts(example):
    _, make_app = example
    for attempt in range(2):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=make_app()),
            base_url="https://example",
            auth=("demo", UI_PASSWORD),
        ) as client:
            body, headers = signed(outbound())
            response = await client.post("/events", content=body, headers=headers)
            assert response.status_code == 200
            assert response.json().get("duplicate", False) == bool(attempt)
            assert len((await client.get("/state")).json()) == 1
            assert (
                await client.post("/events", content=body + b" ", headers=headers)
            ).status_code == 401
            for ts in (int(time.time()) - 301, int(time.time()) + 301):
                body, headers = signed(outbound(), timestamp=ts)
                assert (
                    await client.post("/events", content=body, headers=headers)
                ).status_code == 401
            body, headers = signed(outbound(version=999))
            assert (
                await client.post("/events", content=body, headers=headers)
            ).status_code == 400


async def test_example_challenge_proof_multipart_edits_and_deletes(example):
    _, make_app = example
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=make_app()),
        base_url="https://example",
        auth=("demo", UI_PASSWORD),
    ) as client:
        body, headers = signed(
            {
                "version": 1,
                "event_id": "check",
                "type": "connection.check",
                "challenge": "abc",
            }
        )
        proof = await client.post("/events", content=body, headers=headers)
        assert (
            proof.text
            == hmac.new(
                CONFIG["signing_secret"].encode(),
                b"switch-webhook-check-v1.abc",
                hashlib.sha256,
            ).hexdigest()
        )
        for part in (2, 1):
            body, headers = signed(
                outbound(event_id=f"part-{part}", text=str(part), part=part, parts=2)
            )
            assert (
                await client.post("/events", content=body, headers=headers)
            ).status_code == 200
            state = (await client.get("/state")).json()
            assert state == [] if part == 2 else state[0]["text"] == "12"
        body, headers = signed(
            outbound(type="message.updated", event_id="edit", text="new")
        )
        await client.post("/events", content=body, headers=headers)
        assert (await client.get("/state")).json()[0]["text"] == "new"
        body, headers = signed(outbound(type="message.deleted", event_id="delete"))
        await client.post("/events", content=body, headers=headers)
        assert (await client.get("/state")).json() == []


async def test_example_ui_requires_its_own_credentials(example):
    _, make_app = example
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=make_app()), base_url="https://example"
    ) as client:
        assert (await client.get("/")).status_code == 401
        assert (await client.get("/state")).status_code == 401
        assert (
            await client.post("/send", json={"text": "hi", "message_id": "new"})
        ).status_code == 401
        assert (
            await client.get("/", auth=("demo", CONFIG["inbound_token"]))
        ).status_code == 401
        assert (await client.get("/", auth=("demo", UI_PASSWORD))).status_code == 200


async def test_example_core_round_trip_with_real_room_transport(
    example, delivery, monkeypatch
):
    """ASGI HTTP + actual room storage; the agent's reply is supplied by this test."""
    module, make_app = example
    adapter, core, bridge_client, _, target = delivery.copies[0]
    # The example's sender calls the real bridge route, without external networking.
    original_client = httpx.AsyncClient

    def to_switch(**kwargs):
        return original_client(
            transport=bridge_client._transport,
            base_url="https://switch.example",
            **kwargs,
        )

    monkeypatch.setattr(
        module,
        "httpx",
        SimpleNamespace(AsyncClient=to_switch, HTTPError=httpx.HTTPError),
    )
    # Configure the actual bridge address into the example's closure.
    app = make_app("https://switch.example" + webhook_path(target.bridge_id))
    await adapter._client.aclose()
    adapter._client = original_client(transport=httpx.ASGITransport(app=app))
    async with original_client(
        transport=httpx.ASGITransport(app=app),
        base_url="https://receiver.example",
        auth=("demo", UI_PASSWORD),
    ) as client:
        response = await client.post(
            "/send",
            json={
                "channel_id": "channel-1",
                "message_id": "example-post",
                "text": "@helper hello",
            },
        )
        assert response.status_code == 200
        rows = await delivery.messages()
        assert rows[0].body == "@helper hello"
        root = rows[0].transport_event_id
        await core.handle_outbound_message(
            RoomRef(delivery.room),
            TransportMessage(
                room_id=delivery.room,
                event_id="example-reply",
                sender="@helper:test",
                timestamp=0,
                content={"m.relates_to": {"rel_type": "m.thread", "event_id": root}},
                body="Hello from helper",
                sender_name="helper",
                thread_root_id=root,
            ),
        )
        messages = (await client.get("/state")).json()
        assert messages[0]["text"] == "Hello from helper"
        assert messages[0]["sender_name"] == "helper"
        assert messages[0]["thread_id"] == "example-post"
