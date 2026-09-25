"""The wake mailbox end to end: addressed while asleep, woken, delivered once."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import insert, select

from switch_core.bridges.agent.hosted_mailbox import mailbox_upkeep
from switch_core.bridges.agent.protocol.connections import (
    TAKEN_OVER,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    MessagePayload,
    TaskDelegatePayload,
)
from switch_core.clients.agent_client import AgentClient
from switch_core.db.models import (
    Agent,
    Client,
    HostedLaunch,
    HostedWakeMailbox,
    Message,
    ProviderConnection,
    Room,
    require_tenant_id,
)
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_mailbox_store import MAILBOX_LIMIT
from tests.switch_core.gateway.test_hosted_controller import (  # noqa: F401
    controller_app,
)
from tests.switch_core.gateway.test_hosted_workers import (  # noqa: F401
    HEADERS,
    _agent,
    _first_frames,
    _launch,
    _open,
    worker_app,
)


@pytest.fixture
async def mailbox_app(worker_app):  # noqa: F811
    """The worker app plus a room with addressed messages and a recorded send."""
    client, request_id, agent_id, service, factory, _ = worker_app
    async with factory() as session:
        rooms = []
        for index in range(2):
            room = Room(
                matrix_room_id=f"!{uuid4().hex[:8]}:example.com",
                name=f"r{index}",
                description="",
            )
            session.add(room)
            await session.flush()
            rooms.append(room.id)
            names = ("$m1", "$m2", "$m3") if index == 0 else ("$n1", "$n2", "$n3")
            for seq, message_id in enumerate(names, start=1):
                session.add(
                    Message(
                        seq=seq,
                        room_id=room.id,
                        transport_event_id=message_id,
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
    sent: list[tuple[str, str | None, str]] = []

    async def send_message(agent, room, body, *, thread_id, extra_content):
        sent.append((room, thread_id, body))
        async with factory() as session:
            session.add(
                Message(
                    seq=100 + len(sent),
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
    return SimpleNamespace(
        client=client,
        request_id=request_id,
        agent_id=agent_id,
        service=service,
        factory=factory,
        rooms=rooms,
        sent=sent,
    )


def addressed(room_id: str, message_id: str, thread_id: str | None = None):
    return AgentEvent(
        type="message",
        room_id=room_id,
        bridge_id=None,
        channel_type=None,
        payload=MessagePayload(
            addressed=True,
            sender="@someone:example.com",
            sender_name="Someone",
            message_id=message_id,
            body="hello",
            timestamp=1700000000000,
            thread_id=thread_id,
        ),
    )


async def address(app, event: AgentEvent | None) -> Any:
    """`AgentClient._note_hosted_addressed`, as the agent's Matrix client runs it."""
    client = SimpleNamespace(
        _hosted_launch_store=HostedLaunchStore(),
        session_factory=app.factory,
        tenant_id=require_tenant_id(),
        _connections=app.service.connections,
        _event_buffer=app.service.event_buffer,
    )
    agent = await _agent(app.factory, app.agent_id)
    return await AgentClient._note_hosted_addressed(client, agent, event)  # type: ignore[arg-type]


async def set_launch(app, **values: Any) -> None:
    async with app.factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), app.request_id))
        assert launch is not None
        for key, value in values.items():
            setattr(launch, key, value)
        await session.commit()


async def rows(app) -> dict[tuple[str, str], str]:
    async with app.factory() as session:
        found = await session.execute(
            select(
                HostedWakeMailbox.room_id,
                HostedWakeMailbox.message_id,
                HostedWakeMailbox.state,
            ).where(HostedWakeMailbox.tenant_id == require_tenant_id())
        )
        return {(room, message): state for room, message, state in found}


async def capability(app) -> str:
    prepared = await app.client.post(
        f"/hosted-controller/{app.request_id}/prepare", headers=HEADERS
    )
    assert prepared.status_code == 200, prepared.text
    return prepared.json()["worker_capability"]


def restart_core(app, boot: int) -> None:
    """A new Core process: nothing in memory survives, the database does."""
    app.service.connections = ConnectionRegistry()
    app.service.event_buffer = EventBuffer(sequence_base=boot << 32)


async def attach(app, *, boot_id: str = "boot-a") -> tuple[Any, list[tuple[str, dict]]]:
    agent = await _agent(app.factory, app.agent_id)
    connection_id = str(uuid4())
    response = await _open(
        app.service,
        agent,
        capability=await capability(app),
        connection_id=connection_id,
        boot_id=boot_id,
    )
    conn = app.service.connections.get(connection_id)
    return response, conn.worker_frames.drain()


async def ack(app, conn, *entries: tuple[str, str, str]):
    return await app.client.post(
        f"/agents/{app.agent_id}/connection/mailbox/ack",
        json={
            "connection_id": conn.id,
            "generation": conn.stream_generation,
            "entries": [
                {"room_id": room, "message_id": message, "outcome": outcome}
                for room, message, outcome in entries
            ],
        },
    )


def wake_entries(frames: list[tuple[str, dict]]) -> list[tuple[str, str]]:
    return [
        (entry["room_id"], entry["message_id"])
        for event, data in frames
        if event == "wake"
        for entry in data["entries"]
    ]


def attached_conn(app):
    conn = app.service.connections.attached_worker(app.agent_id)
    assert conn is not None
    return conn


async def sleep_launch(app) -> None:
    await set_launch(app, desired_state="stopped", state="stopped", sleeping=True)


@pytest.mark.parametrize("restart", ["before_attach", "after_wake", "after_ack"])
async def test_sleep_mention_wake_delivers_once(mailbox_app, restart):
    app = mailbox_app
    room = app.rooms[0]
    await sleep_launch(app)
    noted = await address(app, addressed(room, "$m1", "$thread"))
    assert noted.deliver is True and noted.refusal is None
    woken = await _launch(app.factory, app.request_id)
    assert (woken.desired_state, woken.state, woken.revision) == (
        "running",
        "queued",
        2,
    )
    assert await rows(app) == {(room, "$m1"): "pending"}

    if restart == "before_attach":
        restart_core(app, 2)
    _, frames = await attach(app)
    assert [event for event, _ in frames] == ["worker_attached", "wake"]
    (wake,) = [data for event, data in frames if event == "wake"]
    assert wake["entries"][0]["thread_id"] == "$thread"
    assert wake["entries"][0]["event"]["type"] == "message"
    assert wake["entries"][0]["event"]["payload"]["message_id"] == "$m1"
    assert await rows(app) == {(room, "$m1"): "offered"}

    if restart == "after_wake":
        restart_core(app, 3)
        await mailbox_upkeep(app.service, datetime.now(UTC))
        assert await rows(app) == {(room, "$m1"): "pending"}
        _, frames = await attach(app)
        assert wake_entries(frames) == [(room, "$m1")]

    conn = attached_conn(app)
    journaled = await ack(app, conn, (room, "$m1", "journaled"))
    assert journaled.status_code == 200, journaled.text
    assert journaled.json()["entries"] == [
        {"room_id": room, "message_id": "$m1", "state": "accepted"}
    ]

    if restart == "after_ack":
        restart_core(app, 4)
    await mailbox_upkeep(app.service, datetime.now(UTC))
    _, frames = await attach(app)
    assert wake_entries(frames) == []
    conn = attached_conn(app)
    admitted = await ack(
        app, conn, (room, "$m1", "admitted"), (room, "$m1", "journaled")
    )
    assert [e["state"] for e in admitted.json()["entries"]] == ["admitted", "admitted"]
    assert await rows(app) == {(room, "$m1"): "admitted"}
    assert app.sent == []


async def test_core_crash_after_offer_reclaims(mailbox_app):
    app = mailbox_app
    room = app.rooms[0]
    _, frames = await attach(app)
    assert wake_entries(frames) == []
    noted = await address(app, addressed(room, "$m1"))
    assert noted.deliver is True
    assert await rows(app) == {(room, "$m1"): "offered"}
    async with app.factory() as session:
        row = await session.get(
            HostedWakeMailbox, (require_tenant_id(), app.agent_id, room, "$m1")
        )
        assert row is not None and row.offered_to is not None
        assert row.offered_to.startswith("1:")

    restart_core(app, 2)
    await mailbox_upkeep(app.service, datetime.now(UTC))
    assert await rows(app) == {(room, "$m1"): "pending"}
    _, frames = await attach(app)
    assert wake_entries(frames) == [(room, "$m1")]


async def test_stream_killed_before_journal_is_offered_again(mailbox_app):
    app = mailbox_app
    room = app.rooms[0]
    _, _ = await attach(app)
    first = attached_conn(app)
    await address(app, addressed(room, "$m1"))
    app.service.connections.close(first.id, TAKEN_OVER)
    await mailbox_upkeep(app.service, datetime.now(UTC))
    assert await rows(app) == {(room, "$m1"): "pending"}
    _, frames = await attach(app, boot_id="boot-b")
    assert wake_entries(frames) == [(room, "$m1")]
    stale = await ack(app, first, (room, "$m1", "journaled"))
    assert stale.status_code == 409


async def test_live_upkeep_reoffers_a_lapsed_lease(mailbox_app):
    app = mailbox_app
    room = app.rooms[0]
    await attach(app)
    conn = attached_conn(app)
    await address(app, addressed(room, "$m1"))
    async with app.factory() as session:
        row = await session.get(
            HostedWakeMailbox, (require_tenant_id(), app.agent_id, room, "$m1")
        )
        assert row is not None
        row.offered_until = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    await mailbox_upkeep(app.service, datetime.now(UTC))
    assert await rows(app) == {(room, "$m1"): "offered"}
    assert wake_entries(conn.worker_frames.drain()) == [(room, "$m1")]


async def test_redelivered_event_is_not_delivered_twice(mailbox_app):
    app = mailbox_app
    room = app.rooms[0]
    assert (await address(app, addressed(room, "$m1"))).deliver is True
    assert (await address(app, addressed(room, "$m1"))).deliver is False


async def test_task_delegate_is_written_under_its_hash(mailbox_app):
    app = mailbox_app
    room = app.rooms[0]
    event = AgentEvent(
        type="task_delegate",
        room_id=room,
        bridge_id=None,
        channel_type=None,
        payload=TaskDelegatePayload(
            task_id="task-1",
            requester_agent_id="agent-a",
            performer_agent_id=app.agent_id,
            summary="Do it",
            description="",
        ),
    )
    await address(app, event)
    ((key, state),) = (await rows(app)).items()
    assert key[1].startswith("task_delegate:") and state == "pending"


async def test_commands_are_never_written(mailbox_app):
    app = mailbox_app
    await sleep_launch(app)
    noted = await address(app, None)
    assert noted.launch.revision == 2
    assert await rows(app) == {}


@pytest.mark.parametrize(
    "state",
    [
        {"desired_state": "stopped", "state": "stopped", "sleeping": False},
        {"desired_state": "deleted", "state": "deleting"},
        {"state": "error"},
    ],
)
async def test_not_written_when_stopped_deleted_or_failed(mailbox_app, state):
    app = mailbox_app
    await set_launch(app, **state)
    noted = await address(app, addressed(app.rooms[0], "$m1"))
    assert noted.refusal is None
    assert await rows(app) == {}


async def test_wake_refused_while_provider_revoked(mailbox_app):
    app = mailbox_app
    await sleep_launch(app)
    async with app.factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), app.request_id))
        assert launch is not None
        connection = await session.get(
            ProviderConnection, (require_tenant_id(), launch.owner_id, "claude")
        )
        await session.delete(connection)
        await session.commit()
    noted = await address(app, addressed(app.rooms[0], "$m1"))
    assert noted.deliver is False
    assert "reconnect the provider" in noted.refusal
    launch = await _launch(app.factory, app.request_id)
    assert (launch.desired_state, launch.revision, launch.sleeping) == (
        "stopped",
        1,
        True,
    )
    assert await rows(app) == {}


async def test_full_mailbox_refuses_loudly(mailbox_app):
    app = mailbox_app
    now = datetime.now(UTC)
    async with app.factory() as session:
        await session.execute(
            insert(HostedWakeMailbox),
            [
                {
                    "tenant_id": require_tenant_id(),
                    "agent_id": app.agent_id,
                    "room_id": app.rooms[1],
                    "message_id": f"$filler{index}",
                    "launch_id": app.request_id,
                    "event": {},
                    "addressed_at": now,
                    "updated_at": now,
                    "expires_at": now + timedelta(hours=24),
                }
                for index in range(MAILBOX_LIMIT)
            ],
        )
        await session.commit()
    noted = await address(app, addressed(app.rooms[0], "$m1"))
    assert noted.deliver is False
    assert f"{MAILBOX_LIMIT} messages waiting" in noted.refusal
    assert (app.rooms[0], "$m1") not in await rows(app)


async def test_attach_leaves_what_does_not_fit_pending(mailbox_app, monkeypatch):
    app = mailbox_app
    room = app.rooms[0]
    for message_id in ("$m1", "$m2", "$m3"):
        await address(app, addressed(room, message_id))
    monkeypatch.setattr(
        "switch_core.bridges.agent.hosted_mailbox.WAKE_ENTRIES_PER_FRAME", 1
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.protocol.hosted_workers.FRAME_QUEUE_FRAMES", 2
    )
    _, frames = await attach(app)
    assert wake_entries(frames) == [(room, "$m1"), (room, "$m2")]
    assert await rows(app) == {
        (room, "$m1"): "offered",
        (room, "$m2"): "offered",
        (room, "$m3"): "pending",
    }
    await mailbox_upkeep(app.service, datetime.now(UTC))
    assert wake_entries(attached_conn(app).worker_frames.drain()) == [(room, "$m3")]


async def test_idle_evidence_counts_the_mailbox(mailbox_app):
    app = mailbox_app
    room = app.rooms[0]
    await attach(app)
    await address(app, addressed(room, "$m1"))

    async def reasons() -> list[str]:
        async with app.factory() as session:
            launch = await session.get(
                HostedLaunch, (require_tenant_id(), app.request_id)
            )
            evidence = await HostedLaunchStore().idle_evidence(
                session, launch, app.service.connections
            )
            return evidence.reasons

    assert "mailbox_pending" in await reasons()
    conn = attached_conn(app)
    await ack(app, conn, (room, "$m1", "journaled"))
    assert "mailbox_pending" in await reasons()
    await ack(app, conn, (room, "$m1", "held"))
    assert "mailbox_pending" not in await reasons()


async def test_ack_is_the_attached_workers_alone(mailbox_app):
    app = mailbox_app
    await attach(app)
    conn = attached_conn(app)
    wrong = await app.client.post(
        f"/agents/{app.agent_id}/connection/mailbox/ack",
        json={"connection_id": str(uuid4()), "generation": 0, "entries": []},
    )
    assert wrong.status_code == 409
    too_many = await app.client.post(
        f"/agents/{app.agent_id}/connection/mailbox/ack",
        json={
            "connection_id": conn.id,
            "generation": conn.stream_generation,
            "entries": [
                {"room_id": "r", "message_id": f"$m{i}", "outcome": "journaled"}
                for i in range(201)
            ],
        },
    )
    assert too_many.status_code == 422
    unknown = await ack(app, conn, (app.rooms[0], "$nothing", "journaled"))
    assert unknown.json()["entries"] == [
        {"room_id": app.rooms[0], "message_id": "$nothing", "state": None}
    ]


async def stop(app) -> Any:
    launch = await _launch(app.factory, app.request_id)
    response = await app.client.post(
        f"/hosted-launches/{app.request_id}/lifecycle",
        json={"action": "stop", "revision": launch.revision},
    )
    assert response.status_code == 200, response.text
    return response


async def test_stop_splits_the_mailbox_and_hard_stop_wins(mailbox_app):
    app = mailbox_app
    first, second = app.rooms
    # Never offered: addressed while the worker is away.
    await address(app, addressed(first, "$m1", "$thread-1"))
    await address(app, addressed(first, "$m2", "$thread-2"))
    await address(app, addressed(second, "$n1"))
    agent = await _agent(app.factory, app.agent_id)
    response = await _open(app.service, agent, capability=await capability(app))
    opened = await _first_frames(response, 3)
    assert [event for event, _ in opened] == [
        "connection_state",
        "worker_attached",
        "wake",
    ]
    assert len(wake_entries(opened)) == 3
    conn = attached_conn(app)
    await ack(app, conn, (first, "$m1", "journaled"))
    await ack(app, conn, (second, "$n1", "journaled"), (second, "$n1", "admitted"))
    # Offered to the worker, not yet journaled; plus one it never saw.
    await address(app, addressed(first, "$m3"))
    async with app.factory() as session:
        session.add(
            HostedWakeMailbox(
                agent_id=app.agent_id,
                room_id=second,
                message_id="$n2",
                launch_id=app.request_id,
                thread_id="$thread-x",
                event={},
                addressed_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
                expires_at=datetime.now(UTC) + timedelta(hours=24),
            )
        )
        await session.commit()

    await stop(app)
    closing = await _first_frames(response, 2)
    assert [event for event, _ in closing] == ["mailbox_cancel", "evicted"]
    assert sorted(
        (e["room_id"], e["message_id"]) for e in closing[0][1]["entries"]
    ) == sorted([(first, "$m1"), (first, "$m2"), (first, "$m3")])
    assert await rows(app) == {
        (first, "$m1"): "cancel_requested",
        (first, "$m2"): "cancel_requested",
        (first, "$m3"): "cancel_requested",
        (second, "$n1"): "admitted",
        (second, "$n2"): "cancelled",
    }
    assert [(room, thread) for room, thread, _ in app.sent] == [(second, "$thread-x")]
    assert "stopped before I processed" in app.sent[0][2]

    # Addressed after a hard Stop: never woken, never queued.
    noted = await address(app, addressed(first, "$m9"))
    assert noted.launch.desired_state == "stopped"
    assert (first, "$m9") not in await rows(app)

    launch = await _launch(app.factory, app.request_id)
    started = await app.client.post(
        f"/hosted-launches/{app.request_id}/lifecycle",
        json={"action": "start", "revision": launch.revision},
    )
    assert started.status_code == 200, started.text
    _, frames = await attach(app)
    (attached,) = [data for event, data in frames if event == "worker_attached"]
    assert sorted(
        (e["room_id"], e["message_id"], e["reason"]) for e in attached["cancelled"]
    ) == sorted(
        [
            (first, "$m1", "stopped"),
            (first, "$m2", "stopped"),
            (first, "$m3", "stopped"),
        ]
    )
    assert wake_entries(frames) == []
    conn = attached_conn(app)
    app.sent.clear()
    settled = await ack(
        app,
        conn,
        (first, "$m1", "admitted"),
        (first, "$m2", "cancelled"),
        (first, "$m3", "cancelled"),
    )
    assert [e["state"] for e in settled.json()["entries"]] == [
        "admitted",
        "cancelled",
        "cancelled",
    ]
    bodies = sorted(body for _, _, body in app.sent)
    assert len(bodies) == 2
    assert any("already started processing" in body for body in bodies)
    assert any("stopped before I processed" in body for body in bodies)
    _, frames = await attach(app, boot_id="boot-a")
    (attached,) = [data for event, data in frames if event == "worker_attached"]
    assert attached["cancelled"] == []


async def test_stop_of_a_sleeping_launch_never_wakes(mailbox_app):
    app = mailbox_app
    await sleep_launch(app)
    await set_launch(app, revision=2)
    async with app.factory() as session:
        session.add(
            HostedWakeMailbox(
                agent_id=app.agent_id,
                room_id=app.rooms[0],
                message_id="$m1",
                launch_id=app.request_id,
                event={},
                addressed_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
                expires_at=datetime.now(UTC) + timedelta(hours=24),
            )
        )
        await session.commit()
    response = await app.client.post(
        f"/hosted-launches/{app.request_id}/lifecycle",
        json={"action": "stop", "revision": 1},
    )
    assert response.status_code == 200, response.text
    launch = await _launch(app.factory, app.request_id)
    assert (launch.desired_state, launch.sleeping) == ("stopped", False)
    assert await rows(app) == {(app.rooms[0], "$m1"): "cancelled"}
    assert len(app.sent) == 1


async def test_remove_deletes_the_mailbox(mailbox_app):
    app = mailbox_app
    await address(app, addressed(app.rooms[0], "$m1"))
    await stop(app)
    await set_launch(app, state="stopped")
    launch = await _launch(app.factory, app.request_id)
    removed = await app.client.post(
        f"/hosted-launches/{app.request_id}/lifecycle",
        json={"action": "remove", "revision": launch.revision},
    )
    assert removed.status_code == 200, removed.text
    assert await rows(app) == {}
