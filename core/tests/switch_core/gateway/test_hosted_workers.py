"""A hosted agent's worker: attaching with its capability, and the up-calls only it may make."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from switch_core.bridges.agent.api.handlers import connection_placements, poll_events
from switch_core.bridges.agent.api.schemas import ConnectionPlacementsRequest
from switch_core.bridges.agent.protocol.connections import TAKEN_OVER
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import (
    Agent,
    Client,
    HostedLaunch,
    Message,
    Room,
    require_tenant_id,
)
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    TOKEN,
    controller_app,
)

HEADERS = {"Authorization": "Bearer " + TOKEN}


@pytest.fixture
async def worker_app(controller_app):  # noqa: F811
    client, request_id, agent_id, service, factory, settings = controller_app
    service.event_buffer = EventBuffer(sequence_base=1 << 32)
    service.approval_outcomes = None
    service.config.jwt_secret_key = "test-secret"
    service.config.hosted_sessions_per_agent = 8
    prepared = await client.post(
        f"/hosted-controller/{request_id}/prepare", headers=HEADERS
    )
    assert prepared.status_code == 200, prepared.text
    return client, request_id, agent_id, service, factory, prepared.json()


async def _agent(factory, agent_id: str) -> Agent:
    async with factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        return agent


async def _open(
    service,
    agent: Agent,
    *,
    capability: str | None,
    connection_id: str | None = None,
    boot_id: str = "boot-a",
    speaks: int = 7,
    expected_generation: int | None = None,
) -> Any:
    return await poll_events(
        agent.id,
        agent,
        service,
        service.config,
        accept="text/event-stream",
        connection_id=connection_id or str(uuid4()),
        scope="all",
        spawn_capable=True,
        protocol_version=speaks,
        expected_generation=expected_generation,
        worker_capability=capability,
        host_boot_id=boot_id,
        host_instance_id="instance-a",
    )


async def _refusal(coro) -> tuple[int, str]:
    with pytest.raises(HTTPException) as caught:
        await coro
    detail = caught.value.detail
    return caught.value.status_code, detail["code"] if isinstance(detail, dict) else ""


async def _first_frames(response, count: int) -> list[tuple[str, dict]]:
    frames = []
    iterator = response.body_iterator
    while len(frames) < count:
        chunk = await asyncio.wait_for(anext(iterator), timeout=2)
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        if text.startswith(":"):
            continue
        fields = dict(
            line.split(": ", 1) for line in text.strip().splitlines() if ": " in line
        )
        frames.append((fields["event"], json.loads(fields["data"])))
    return frames


async def _bump(factory, request_id: str) -> None:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.revision += 1
        await session.commit()


async def test_prepare_idempotent_by_revision(worker_app):
    client, request_id, agent_id, service, factory, prepared = worker_app
    again = await client.post(
        f"/hosted-controller/{request_id}/prepare", headers=HEADERS
    )
    assert again.json()["worker_capability"] == prepared["worker_capability"]
    assert again.json()["revision"] == prepared["revision"]
    await _bump(factory, request_id)
    third = await client.post(
        f"/hosted-controller/{request_id}/prepare", headers=HEADERS
    )
    assert third.status_code == 200
    assert third.json()["worker_capability"] != prepared["worker_capability"]
    agent = await _agent(factory, agent_id)
    assert await _refusal(
        _open(service, agent, capability=prepared["worker_capability"])
    ) == (403, "worker_capability_obsolete")
    await _open(service, agent, capability=third.json()["worker_capability"])
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert prepared["worker_capability"] not in (
            launch.worker_capability_encrypted or ""
        )


async def test_worker_attach_requires_current_capability(worker_app):
    _, request_id, agent_id, service, factory, prepared = worker_app
    capability = prepared["worker_capability"]
    agent = await _agent(factory, agent_id)
    assert await _refusal(_open(service, agent, capability=None)) == (
        403,
        "worker_capability_required",
    )
    assert await _refusal(_open(service, agent, capability="not-it")) == (
        403,
        "worker_capability_obsolete",
    )
    assert await _refusal(_open(service, agent, capability=capability, speaks=6)) == (
        426,
        "upgrade_required",
    )
    assert service.connections.for_agent(agent_id) == []

    response = await _open(service, agent, capability=capability)
    (conn,) = service.connections.for_agent(agent_id)
    assert conn.worker is not None and conn.worker.launch_revision == 1
    frames = await _first_frames(response, 2)
    assert frames[0][0] == "connection_state"
    assert frames[1][0] == "worker_attached"
    assert frames[1][1]["launch_revision"] == 1
    assert frames[1][1]["cancelled"] == []

    await _bump(factory, request_id)
    service.connections.supersede(agent_id, 2)
    assert service.connections.get(conn.id) is None
    assert not service.connections.ring_worker(agent_id, "operation", {"id": "x"})
    assert await _refusal(
        _open(service, agent, capability=capability, connection_id=conn.id)
    ) == (403, "worker_capability_obsolete")


async def test_local_console_cannot_take_over_hosted_stream(worker_app):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    worker_id = str(uuid4())
    await _open(
        service,
        agent,
        capability=prepared["worker_capability"],
        connection_id=worker_id,
    )
    worker = service.connections.get(worker_id)
    generation = worker.stream_generation

    assert (await _refusal(_open(service, agent, capability=None)))[0] == 403
    assert (
        await _refusal(_open(service, agent, capability=None, connection_id=worker_id))
    )[0] == 403
    local_id = str(uuid4())
    placements = ConnectionPlacementsRequest(
        connection_id=local_id, generation=0, placements={}
    )
    assert await _refusal(
        connection_placements(agent_id, placements, agent, service)
    ) == (403, "hosted_worker_only")
    assert await _refusal(_poll(service, agent)) == (403, "hosted_worker_only")
    assert worker.stream_generation == generation
    assert service.connections.get(worker_id) is worker


async def _poll(service, agent: Agent) -> Any:
    return await poll_events(
        agent.id, agent, service, service.config, timeout=0, accept="application/json"
    )


async def test_second_worker_refused_while_first_alive(worker_app):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    capability = prepared["worker_capability"]
    first = str(uuid4())
    await _open(service, agent, capability=capability, connection_id=first)
    assert await _refusal(
        _open(service, agent, capability=capability, boot_id="boot-b")
    ) == (
        409,
        "worker_already_attached",
    )
    assert [conn.id for conn in service.connections.for_agent(agent_id)] == [first]


async def test_same_boot_takeover_evicts_old(worker_app):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    capability = prepared["worker_capability"]
    first = str(uuid4())
    await _open(service, agent, capability=capability, connection_id=first)
    old = service.connections.get(first)
    second = str(uuid4())
    await _open(service, agent, capability=capability, connection_id=second)
    assert service.connections.get(first) is None
    assert old.closure is not None and old.closure.code == TAKEN_OVER.code
    assert service.connections.attached_worker(agent_id).id == second


async def test_same_connection_reattach_keeps_the_generation_fence(worker_app):
    _, _, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    capability = prepared["worker_capability"]
    conn_id = str(uuid4())
    await _open(service, agent, capability=capability, connection_id=conn_id)
    held = service.connections.get(conn_id).stream_generation
    await _open(
        service,
        agent,
        capability=capability,
        connection_id=conn_id,
        expected_generation=held,
    )
    conn = service.connections.get(conn_id)
    assert conn.stream_generation != held and conn.worker is not None
    status, code = await _refusal(
        _open(
            service,
            agent,
            capability=capability,
            connection_id=conn_id,
            expected_generation=held,
        )
    )
    assert status == 409


async def test_idle_report_answers_catch_up(worker_app):
    client, request_id, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    conn_id = str(uuid4())
    await _open(
        service, agent, capability=prepared["worker_capability"], connection_id=conn_id
    )
    conn = service.connections.get(conn_id)
    body = {
        "connection_id": conn_id,
        "generation": conn.stream_generation,
        "report_seq": 1,
        "relays_through": 0,
        "busy": False,
        "reasons": [],
        "sessions": {"total": 0, "live": 0, "parked": 0, "failed": 0},
    }
    response = await client.post(f"/agents/{agent_id}/connection/idle", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["queued_operations"] == []
    assert response.json()["credential_revision"] is not None
    assert service.connections.fresh_idle_report(agent_id, request_id, 1) is not None
    stale = await client.post(
        f"/agents/{agent_id}/connection/idle",
        json={**body, "generation": conn.stream_generation + 1},
    )
    assert stale.status_code == 409


async def test_relay_reply_is_fenced(worker_app):
    client, request_id, agent_id, service, factory, prepared = worker_app
    agent = await _agent(factory, agent_id)
    conn_id = str(uuid4())
    await _open(
        service, agent, capability=prepared["worker_capability"], connection_id=conn_id
    )
    conn = service.connections.get(conn_id)
    relay = service.connections.relays.register(
        tenant_id=require_tenant_id(),
        agent_id=agent_id,
        binding=conn.worker,
        relay_seq=None,
        core_boot=1,
        connection_id=conn_id,
        generation=conn.stream_generation,
        timeout_ms=5000,
    )
    fence = {"connection_id": conn_id, "generation": conn.stream_generation}
    path = f"/agents/{agent_id}/connection/relay/{relay.id}"
    unknown = await client.post(
        f"/agents/{agent_id}/connection/relay/{uuid4()}",
        json={**fence, "ok": True, "value": 1},
    )
    assert unknown.status_code == 404
    stale = await client.post(
        path, json={**fence, "generation": conn.stream_generation + 1, "ok": True}
    )
    assert stale.status_code == 409
    too_large = await client.post(
        path,
        content=json.dumps({**fence, "ok": True, "value": "x" * (2 * 1024 * 1024)}),
        headers={"content-type": "application/json"},
    )
    assert too_large.status_code == 413
    answered = await client.post(path, json={**fence, "ok": True, "value": {"a": 1}})
    assert answered.status_code == 200, answered.text
    assert (await relay.future) == {"ok": True, "value": {"a": 1}}
    again = await client.post(path, json={**fence, "ok": True, "value": 2})
    assert again.status_code == 409


async def test_room_notice_requires_the_worker(worker_app):
    client, _, agent_id, service, factory, prepared = worker_app
    response = await client.post(
        f"/agents/{agent_id}/room-notices",
        json={
            "connection_id": str(uuid4()),
            "generation": 0,
            "room_id": "!room:example.com",
            "message_id": "$event",
            "thread_id": None,
            "reason": "startup",
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "generation_changed"


async def _ready_worker(worker_app) -> Any:
    _, request_id, agent_id, service, factory, prepared = worker_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.state = "ready"
        await session.commit()
    agent = await _agent(factory, agent_id)
    conn_id = str(uuid4())
    await _open(
        service, agent, capability=prepared["worker_capability"], connection_id=conn_id
    )
    conn = service.connections.get(conn_id)
    conn.worker_frames.drain()
    return conn


async def _answer_relays(client, conn, value: Any, seen: list[dict]) -> None:
    while True:
        for event, data in conn.worker_frames.drain():
            if event != "relay":
                continue
            seen.append(data)
            await client.post(
                f"/agents/{conn.agent_id}/connection/relay/{data['id']}",
                json={
                    "connection_id": conn.id,
                    "generation": conn.stream_generation,
                    "ok": True,
                    "value": value,
                },
            )
        await asyncio.sleep(0.01)


async def _launch(factory, request_id: str) -> HostedLaunch:
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch is not None
        return launch


async def test_read_only_relay_does_not_renew_activity(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    before = await _launch(factory, request_id)
    seen: list[dict] = []
    answering = asyncio.create_task(_answer_relays(client, conn, {"health": 1}, seen))
    try:
        response = await client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"health": True}, "timeout_ms": 5000},
        )
    finally:
        answering.cancel()
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["value"] == {"health": 1}
    assert response.json()["worker"]["generation"] == conn.stream_generation
    assert seen[0]["relay_seq"] is None
    after = await _launch(factory, request_id)
    assert after.relay_seq == before.relay_seq
    assert after.active_at == before.active_at


async def test_mutating_relay_takes_a_sequence(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    seen: list[dict] = []
    answering = asyncio.create_task(_answer_relays(client, conn, {"accepted": 1}, seen))
    try:
        response = await client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"forget": str(uuid4())}, "timeout_ms": 5000},
        )
    finally:
        answering.cancel()
    assert response.status_code == 200, response.text
    assert seen[0]["relay_seq"] == 1
    assert seen[0]["deadline_ms"] > 0
    assert (await _launch(factory, request_id)).relay_seq == 1


async def test_relay_queue_refusal_takes_no_sequence(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    slots = [conn.worker_frames.reserve(1) for _ in range(64)]
    response = await client.post(
        f"/hosted-launches/{request_id}/relay",
        json={"message": {"forget": str(uuid4())}, "timeout_ms": 5000},
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "worker_busy"
    assert (await _launch(factory, request_id)).relay_seq == 0
    for slot in slots:
        slot.release()


async def test_gateway_cancel_after_commit_still_enqueues(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    request = asyncio.create_task(
        client.post(
            f"/hosted-launches/{request_id}/relay",
            json={"message": {"forget": str(uuid4())}, "timeout_ms": 5000},
        )
    )
    for _ in range(200):
        if (await _launch(factory, request_id)).relay_seq == 1:
            break
        await asyncio.sleep(0.01)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request
    await asyncio.sleep(0.05)
    frames = [data for event, data in conn.worker_frames.drain() if event == "relay"]
    assert [frame["relay_seq"] for frame in frames] == [1]


async def test_relay_refusals(worker_app):
    client, request_id, agent_id, service, factory, _ = worker_app
    path = f"/hosted-launches/{request_id}/relay"
    missing = await client.post(
        f"/hosted-launches/{uuid4()}/relay",
        json={"message": {"health": True}, "timeout_ms": 1000},
    )
    assert missing.status_code == 404
    not_attached = await client.post(
        path, json={"message": {"health": True}, "timeout_ms": 1000}
    )
    assert not_attached.status_code == 409
    await _ready_worker(worker_app)
    for message in ({"ensure": {}}, {"room": {}}, {"approvals": {}}):
        refused = await client.post(path, json={"message": message, "timeout_ms": 1000})
        assert refused.status_code == 400
        assert refused.json()["error"]["code"] == "refused_message"
    too_large = await client.post(
        path,
        content=json.dumps({"message": {"health": "x" * (2 * 1024 * 1024)}}),
        headers={"content-type": "application/json"},
    )
    assert too_large.status_code == 413
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.sleeping = True
        launch.desired_state = "stopped"
        launch.state = "stopped"
        await session.commit()
    sleeping = await client.post(
        path, json={"message": {"health": True}, "timeout_ms": 1000}
    )
    assert sleeping.status_code == 409
    assert sleeping.json()["error"]["code"] == "worker_sleeping"
    assert sleeping.json()["wake_available"] is True


async def test_relay_timeout_cancels_on_the_worker(worker_app):
    client, request_id, _, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    response = await client.post(
        f"/hosted-launches/{request_id}/relay",
        json={"message": {"health": True}, "timeout_ms": 50},
    )
    assert response.status_code == 504
    events = [event for event, _ in conn.worker_frames.drain()]
    assert events == ["relay", "relay_cancel"]


async def test_auto_start_off_notice_is_posted_once(worker_app):
    client, _, agent_id, service, factory, _ = worker_app
    conn = await _ready_worker(worker_app)
    async with factory() as session:
        room = Room(
            matrix_room_id=f"!{uuid4().hex[:8]}:example.com", name="r", description=""
        )
        session.add(room)
        await session.flush()
        room_id = room.id
        session.add(
            Message(
                seq=1,
                room_id=room_id,
                transport_event_id="$addressed",
                sender_id="@someone:example.com",
                event_type="m.room.message",
                msgtype="m.text",
                body="hello",
                content={"body": "hello"},
            )
        )
        sender = await session.scalar(
            select(Client.matrix_user_id)
            .join(Agent, Agent.client_id == Client.id)
            .where(Agent.id == agent_id)
        )
        await session.commit()
    sent: list[tuple[str, str]] = []

    async def send_message(agent, room, body, *, thread_id, extra_content):
        sent.append((room, body))
        async with factory() as session:
            session.add(
                Message(
                    seq=2 + len(sent),
                    room_id=room,
                    transport_event_id=f"$notice{len(sent)}",
                    sender_id=sender,
                    event_type="m.room.message",
                    msgtype="m.notice",
                    body=body,
                    content={"body": body, **extra_content},
                )
            )
            await session.commit()

    service.send_message = send_message
    notice = {
        "connection_id": conn.id,
        "generation": conn.stream_generation,
        "room_id": room_id,
        "message_id": "$addressed",
        "thread_id": None,
        "reason": "auto_start_off",
    }
    first = await client.post(f"/agents/{agent_id}/room-notices", json=notice)
    second = await client.post(f"/agents/{agent_id}/room-notices", json=notice)
    assert first.status_code == 200, first.text
    assert first.json()["posted"] is True
    assert second.json()["posted"] is False
    assert len(sent) == 1
    assert "not set to start one automatically" in sent[0][1]
