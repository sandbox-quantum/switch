from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import time
from pathlib import Path

import httpx
import pytest

from .test_webhook_adapter import SECRET, TOKEN

EXAMPLE = Path(__file__).resolve().parents[5] / "examples/webhook-chat/app.py"
ADMIN = "demo-admin-" + "x" * 32


def load_app(path):
    spec = importlib.util.spec_from_file_location("webhook_demo_test", EXAMPLE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.DB_PATH = path
    module.ADMIN_TOKEN = ADMIN
    return module


@pytest.fixture
async def demo(tmp_path):
    module = load_app(tmp_path / "chat.sqlite3")
    with module.connect():
        pass
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=module.app), base_url="http://chat.example"
    ) as client:
        yield module, client


def headers(event, *, secret=SECRET, timestamp=None):
    event = {"channel_id": "demo-chat", **event}
    raw = json.dumps(event).encode()
    timestamp = timestamp or str(int(time.time()))
    sig = (
        "sha256="
        + hmac.new(
            secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256
        ).hexdigest()
    )
    return raw, {
        "x-switch-timestamp": timestamp,
        "x-switch-signature": sig,
        "content-type": "application/json",
    }


async def configure(client):
    response = await client.post(
        "/configure",
        headers={"authorization": f"Bearer {ADMIN}"},
        json={
            "inbound_url": "https://switch.example/messaging/bridges/one/events",
            "inbound_token": TOKEN,
            "signing_secret": SECRET,
        },
    )
    assert response.status_code == 200


async def state(client):
    return (
        await client.get("/messages", headers={"authorization": f"Bearer {ADMIN}"})
    ).json()


async def test_bootstrap_checks_are_noop_and_messages_require_configuration(demo):
    _, client = demo
    probe = {"version": 1, "event_id": "probe", "type": "connection.check"}
    response = await client.post("/receive", json=probe)
    assert response.json() == {"version": 1, "event_id": "probe"}
    assert (await state(client))["messages"] == []
    assert (
        await client.post(
            "/receive",
            json={
                **probe,
                "type": "message.create",
                "channel_id": "demo-chat",
                "message_id": "p1",
                "text": "hello",
            },
        )
    ).status_code == 503


async def test_secrets_and_history_are_not_exposed_to_unauthenticated_browsers(demo):
    _, client = demo
    assert (await client.get("/messages")).status_code == 401
    assert (await client.post("/configure", json={})).status_code == 401
    assert (await client.post("/send", json={"text": "Hello"})).status_code == 401
    page = (await client.get("/")).text
    assert TOKEN not in page and SECRET not in page and ADMIN not in page
    assert "innerHTML" not in page


async def test_signatures_replay_protection_and_idempotent_delivery_survive_restart(
    demo,
):
    module, client = demo
    await configure(client)
    event = {
        "version": 1,
        "event_id": "out-1",
        "type": "message.create",
        "message_id": "post-1",
        "sender_name": "worker",
        "text": "hello",
    }
    raw, signed = headers(event)
    assert (
        await client.post("/receive", content=raw, headers=signed)
    ).status_code == 200
    assert (
        await client.post("/receive", content=raw, headers=signed)
    ).status_code == 200
    assert len((await state(client))["messages"]) == 1
    badraw, badsigned = headers(event, secret="wrong")
    assert (
        await client.post("/receive", content=badraw, headers=badsigned)
    ).status_code == 401
    oldraw, oldsigned = headers(event, timestamp="1")
    assert (
        await client.post("/receive", content=oldraw, headers=oldsigned)
    ).status_code == 401
    fresh = load_app(module.DB_PATH)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=fresh.app), base_url="http://chat.example"
    ) as restarted:
        assert (
            await restarted.post("/receive", content=raw, headers=signed)
        ).status_code == 200
        assert len((await state(restarted))["messages"]) == 1
    changed, signature = headers({**event, "text": "different content"})
    assert (
        await client.post("/receive", content=changed, headers=signature)
    ).status_code == 409


async def test_group_edits_and_deletes_replace_all_continuations(demo):
    _, client = demo
    await configure(client)
    for index in range(3):
        event = {
            "version": 1,
            "event_id": f"e{index}",
            "type": "message.create",
            "message_id": f"p{index}",
            "group_id": "p0" if index else None,
            "text": str(index),
        }
        raw, signed = headers(event)
        assert (
            await client.post("/receive", content=raw, headers=signed)
        ).status_code == 200
    edit = {
        "version": 1,
        "event_id": "edit",
        "type": "message.update",
        "message_id": "p0",
        "text": "edited",
    }
    raw, signed = headers(edit)
    assert (
        await client.post("/receive", content=raw, headers=signed)
    ).status_code == 200
    assert [message["text"] for message in (await state(client))["messages"]] == [
        "edited"
    ]
    raw, signed = headers({**edit, "event_id": "delete", "type": "message.delete"})
    assert (
        await client.post("/receive", content=raw, headers=signed)
    ).status_code == 200
    assert (await state(client))["messages"] == []


async def test_pending_outbox_survives_restart_and_retries_the_same_payload(demo):
    module, client = demo
    await configure(client)
    auth = {"authorization": f"Bearer {ADMIN}"}
    sent = await client.post(
        "/send",
        json={"text": "@worker hello", "thread_id": "root", "attachments": []},
        headers=auth,
    )
    assert sent.status_code == 200
    requests = []
    fail = True

    def receiver(request):
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        requests.append(request.content)
        return httpx.Response(503 if fail else 200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(receiver)) as switch:
        await module.flush_once(switch)
        fresh = load_app(module.DB_PATH)
        fail = False
        await fresh.flush_once(switch)
    # The first pending event is the join; its retry retains the exact bytes.
    assert requests[0] == requests[1]
    assert all(row["state"] == "delivered" for row in (await state(client))["outbox"])
    posted = json.loads(requests[-1])
    assert posted["thread_id"] == "root" and posted["text"] == "@worker hello"
