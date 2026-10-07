"""The wake mailbox end to end: addressed while asleep, woken, delivered once."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import insert, select

from switch_core.bridges.agent.api.hosted_worker_routes import post_mailbox_notices
from switch_core.bridges.agent.hosted_mailbox import mailbox_upkeep
from switch_core.bridges.agent.protocol.agent_connections import (
    TAKEN_OVER,
    AgentConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    MessagePayload,
    TaskDelegatePayload,
)
from switch_core.clients.agent_consumer import (
    _HOSTED_ERROR_MESSAGE,
    _HOSTED_MACHINE_ERROR_MESSAGE,
    _HOSTED_MACHINE_STOPPED_MESSAGE,
    _HOSTED_REMOVED_MESSAGE,
    _HOSTED_STOPPED_MESSAGE,
    AUTO_REPLY_FLAG,
    AgentConsumer,
    _GateOutcome,
    _hosted_unavailable,
)
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    HostedLaunch,
    HostedWakeMailbox,
    Message,
    ProviderConnection,
    Room,
    require_tenant_id,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_mailbox_store import MAILBOX_LIMIT, HostedMailboxStore
from switch_core.events import TaskDelegate
from switch_core.transport import InboundMedia, InboundMessage, RoomRef
from tests.switch_core.connections.github_seed import github_vendor  # noqa: F401
from tests.switch_core.gateway.test_hosted_workers import (  # noqa: F401
    _agent,
    _first_frames,
    _launch,
    _machine,
    _open,
    issue_capability,
    set_machine,
    worker_app,
)


@pytest.fixture
async def mailbox_app(worker_app):  # noqa: F811
    """The worker app plus a room with addressed messages and a recorded send."""
    client, request_id, agent_id, service, factory, prepared = worker_app
    async with factory() as session:
        rooms = []
        for index in range(2):
            room = Room(
                transport_room_id=f"!{uuid4().hex[:8]}:example.com",
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
            select(Client.transport_user_id)
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
        machine_id=prepared["machine_id"],
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
    """`AgentConsumer._note_hosted_addressed`, as the agent's Matrix client runs it."""
    client = SimpleNamespace(
        _hosted_launch_store=HostedLaunchStore(),
        session_factory=app.factory,
        tenant_id=require_tenant_id(),
        _connections=app.service.connections,
        _event_buffer=app.service.event_buffer,
    )
    agent = await _agent(app.factory, app.agent_id)
    return await AgentConsumer._note_hosted_addressed(client, agent, event)  # type: ignore[arg-type]


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
    return await issue_capability(app.factory, app.request_id)


def restart_core(app, boot: int) -> None:
    """A new Core process: nothing in memory survives, the database does."""
    app.service.connections = AgentConnectionRegistry()
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


async def sleep_machine(app) -> None:
    """The machine idled out: stopped for idleness, its launch left running."""
    await set_machine(
        app.factory,
        app.machine_id,
        desired_state="stopped",
        stop_reason="idle",
        state="stopped",
        revision=2,
    )
    await set_launch(app, state="stopped")


@pytest.mark.parametrize("restart", ["before_attach", "after_wake", "after_ack"])
async def test_sleep_mention_wake_delivers_once(mailbox_app, restart):
    app = mailbox_app
    room = app.rooms[0]
    await sleep_machine(app)
    noted = await address(app, addressed(room, "$m1", "$thread"))
    assert noted.deliver is True and noted.refusal is None
    woken = await _machine(app.factory, app.machine_id)
    assert (woken.desired_state, woken.stop_reason, woken.revision) == (
        "running",
        None,
        3,
    )
    launch = await _launch(app.factory, app.request_id)
    assert (launch.desired_state, launch.revision) == ("running", 1)
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
    await sleep_machine(app)
    noted = await address(app, None)
    assert noted.machine.desired_state == "running"
    assert noted.machine.revision == 3
    assert await rows(app) == {}


@pytest.mark.parametrize(
    ("state", "refusal"),
    [
        ({"desired_state": "stopped", "state": "stopped"}, _HOSTED_STOPPED_MESSAGE),
        ({"desired_state": "deleted", "state": "deleting"}, _HOSTED_REMOVED_MESSAGE),
        ({"state": "error"}, _HOSTED_ERROR_MESSAGE),
    ],
)
async def test_not_written_when_stopped_deleted_or_failed(mailbox_app, state, refusal):
    app = mailbox_app
    await set_launch(app, **state)
    noted = await address(app, addressed(app.rooms[0], "$m1"))
    assert (noted.refusal, noted.deliver) == (refusal, False)
    assert await rows(app) == {}


async def test_wake_refused_while_provider_revoked(mailbox_app):
    app = mailbox_app
    await sleep_machine(app)
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
    machine = await _machine(app.factory, app.machine_id)
    assert (machine.desired_state, machine.stop_reason, machine.revision) == (
        "stopped",
        "idle",
        2,
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


async def test_stop_on_a_sleeping_machine_never_wakes_it(mailbox_app):
    app = mailbox_app
    await sleep_machine(app)
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
    assert response.json()["state"] == "stopped"
    assert response.json()["sleeping"] is True
    launch = await _launch(app.factory, app.request_id)
    assert (launch.desired_state, launch.revision) == ("stopped", 2)
    machine = await _machine(app.factory, app.machine_id)
    assert (machine.desired_state, machine.revision) == ("stopped", 2)
    assert await rows(app) == {(app.rooms[0], "$m1"): "cancelled"}
    assert len(app.sent) == 1
    await address(app, addressed(app.rooms[0], "$m2"))
    assert (await _machine(app.factory, app.machine_id)).desired_state == "stopped"
    assert (app.rooms[0], "$m2") not in await rows(app)


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


async def test_remove_of_a_running_agent_is_synchronous(mailbox_app):
    app = mailbox_app
    first, second = app.rooms
    await address(app, addressed(first, "$m1", "$thread-1"))
    await address(app, addressed(first, "$m2"))
    await address(app, addressed(second, "$n1"))
    agent = await _agent(app.factory, app.agent_id)
    key_id = agent.api_key_id
    before = await _machine(app.factory, app.machine_id)
    removed = await app.client.post(
        f"/hosted-launches/{app.request_id}/lifecycle",
        json={"action": "remove", "revision": 1},
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["state"] == "deleted"
    assert removed.json()["desired_state"] == "deleted"
    assert removed.json()["name"] == "removed:" + app.request_id
    assert await rows(app) == {}
    assert sorted(room for room, _, _ in app.sent) == sorted([first, second])
    assert all("removed before I processed" in body for _, _, body in app.sent)
    async with app.factory() as session:
        assert await session.get(Agent, app.agent_id) is None
        assert await session.scalar(select(ApiKey).where(ApiKey.id == key_id)) is None
    machine = await _machine(app.factory, app.machine_id)
    assert machine.desired_state == "retained"
    assert machine.revision == before.revision + 1
    assert machine.agents_version > before.agents_version
    retention = machine.retain_until - datetime.now(UTC)
    assert timedelta(days=7) - timedelta(minutes=1) < retention <= timedelta(days=7)
    again = await app.client.post(
        f"/hosted-launches/{app.request_id}/lifecycle",
        json={"action": "remove", "revision": 2},
    )
    assert again.status_code == 409


async def test_mention_to_an_owner_stopped_machine_is_refused_not_queued(
    mailbox_app,
):
    app = mailbox_app
    await set_machine(
        app.factory,
        app.machine_id,
        desired_state="stopped",
        stop_reason="owner",
        state="stopped",
        revision=2,
    )
    noted = await address(app, addressed(app.rooms[0], "$m1"))
    assert await rows(app) == {}
    assert _hosted_unavailable(noted.launch, noted.machine) == (
        _HOSTED_MACHINE_STOPPED_MESSAGE
    )
    machine = await _machine(app.factory, app.machine_id)
    assert (machine.desired_state, machine.revision) == ("stopped", 2)


async def test_mention_to_an_errored_owner_stopped_machine_reports_machine_error(
    mailbox_app,
):
    app = mailbox_app
    await set_machine(
        app.factory,
        app.machine_id,
        desired_state="stopped",
        stop_reason="owner",
        state="error",
        revision=2,
    )
    noted = await address(app, addressed(app.rooms[0], "$m1"))
    assert await rows(app) == {}
    assert _hosted_unavailable(noted.launch, noted.machine) == (
        _HOSTED_MACHINE_ERROR_MESSAGE
    )
    machine = await _machine(app.factory, app.machine_id)
    assert machine.state == "error"


async def test_mention_to_an_errored_running_machine_is_refused_not_queued(
    mailbox_app,
):
    app = mailbox_app
    await set_machine(
        app.factory,
        app.machine_id,
        desired_state="running",
        state="error",
        revision=2,
    )
    noted = await address(app, addressed(app.rooms[0], "$m1"))
    assert await rows(app) == {}
    assert _hosted_unavailable(noted.launch, noted.machine) == (
        _HOSTED_MACHINE_ERROR_MESSAGE
    )
    machine = await _machine(app.factory, app.machine_id)
    assert (machine.state, machine.desired_state, machine.revision) == (
        "error",
        "running",
        2,
    )


async def agent_client(app) -> SimpleNamespace:
    """An `AgentConsumer` addressed by everything, with no live session, that
    records what it posts and what it hands the live buffer."""
    agent = await _agent(app.factory, app.agent_id)
    meta = SimpleNamespace(
        room_id=app.rooms[0], name="r0", bridge_id=None, channel_type=None
    )
    posted: list[str] = []
    enqueued: list[AgentEvent] = []

    async def send_message(_room_id: str, body: str, **_kwargs: Any) -> str:
        posted.append(body)
        return "$sent"

    async def resolve_room_meta(_matrix_room_id: str) -> Any:
        return meta

    async def yes(*_args: Any) -> bool:
        return True

    async def no(*_args: Any) -> bool:
        return False

    async def fresh_agent(_session: Any) -> Any:
        return agent

    async def gate_addressed(*_args: Any) -> _GateOutcome:
        return _GateOutcome(addressed=True, refusal=None)

    async def reply_when_unavailable_here(*_args: Any) -> str:
        return "I don't have a session connected to this room."

    client = SimpleNamespace(
        agent=agent,
        _hosted_launch_store=HostedLaunchStore(),
        session_factory=app.factory,
        tenant_id=require_tenant_id(),
        _connections=app.service.connections,
        _event_buffer=SimpleNamespace(
            boot=app.service.event_buffer.boot,
            enqueue=lambda _agent_id, _room_id, event: enqueued.append(event),
        ),
        _resolve_room_meta=resolve_room_meta,
        _addressed=yes,
        _addressed_without_lookup=lambda _event, _meta: True,
        _compute_addressed=yes,
        _fresh_agent=fresh_agent,
        _gate_addressed=gate_addressed,
        _is_available=no,
        _reply_when_unavailable_here=reply_when_unavailable_here,
        _triggered_by_auto_reply=AgentConsumer._triggered_by_auto_reply,
        _waking_notice_revisions={},
        _unreachable_notice_revisions={},
        actor=SimpleNamespace(send_message=send_message),
        posted=posted,
        enqueued=enqueued,
    )
    for name in (
        "_note_hosted_addressed",
        "_emit_media",
        "_post_auto_reply",
        "_sender_handle",
    ):
        setattr(client, name, getattr(AgentConsumer, name).__get__(client))
    return client


async def error_the_running_machine(app) -> None:
    await set_machine(
        app.factory,
        app.machine_id,
        desired_state="running",
        state="error",
        revision=2,
    )


async def test_media_to_an_errored_running_machine_is_refused_not_queued(
    mailbox_app,
):
    app = mailbox_app
    await error_the_running_machine(app)
    client = await agent_client(app)
    media = InboundMedia(
        room_id="!room:example.com",
        event_id="$m1",
        sender="@someone:example.com",
        timestamp=1700000000000,
        content={"msgtype": "m.file", "body": "notes.md", "sender_name": "someone"},
        body="notes.md",
        sender_name="someone",
        msgtype="m.file",
        uri="mxc://example.com/abc",
        mimetype="text/markdown",
        size=5,
    )
    await AgentConsumer.on_media(client, RoomRef(room_id="!room:example.com"), media)  # type: ignore[arg-type]
    assert await rows(app) == {}
    assert client.posted == [f"@someone {_HOSTED_MACHINE_ERROR_MESSAGE}"]
    assert client.enqueued == []


async def test_task_delegate_to_an_errored_running_machine_is_refused(mailbox_app):
    app = mailbox_app
    await error_the_running_machine(app)
    client = await agent_client(app)
    delegate = TaskDelegate(
        task_id="task-1",
        requester_agent_id="agent-a",
        performer_agent_id=app.agent_id,
        summary="Do it",
        description="",
    )
    await AgentConsumer.on_task_delegate(
        client,  # type: ignore[arg-type]
        RoomRef(room_id="!room:example.com"),
        delegate,
    )
    assert await rows(app) == {}
    assert client.posted == [_HOSTED_MACHINE_ERROR_MESSAGE]
    assert client.enqueued == []


async def test_mention_to_an_errored_running_machine_is_answered_once(mailbox_app):
    app = mailbox_app
    await error_the_running_machine(app)
    client = await agent_client(app)
    message = InboundMessage(
        room_id="!room:example.com",
        event_id="$m1",
        sender="@someone:example.com",
        timestamp=1700000000000,
        content={"sender_name": "someone"},
        body="@agent hello",
        sender_name="someone",
    )
    await AgentConsumer.on_message(
        client, RoomRef(room_id="!room:example.com"), message
    )  # type: ignore[arg-type]
    assert await rows(app) == {}
    assert client.posted == [f"@someone {_HOSTED_MACHINE_ERROR_MESSAGE}"]
    assert client.enqueued == []


@pytest.mark.parametrize(
    ("content", "posted"),
    [
        ({"sender_name": "other"}, [f"@other {_HOSTED_MACHINE_STOPPED_MESSAGE}"]),
        ({"sender_name": "other", AUTO_REPLY_FLAG: True}, []),
    ],
)
async def test_auto_reply_to_an_owner_stopped_machine_is_not_answered(
    mailbox_app, content, posted
):
    app = mailbox_app
    await set_machine(
        app.factory,
        app.machine_id,
        desired_state="stopped",
        stop_reason="owner",
        state="stopped",
        revision=2,
    )
    client = await agent_client(app)
    message = InboundMessage(
        room_id="!room:example.com",
        event_id="$m1",
        sender="@other:example.com",
        timestamp=1700000000000,
        content=content,
        body=f"@agent {_HOSTED_MACHINE_STOPPED_MESSAGE}",
        sender_name="other",
    )
    await AgentConsumer.on_message(
        client, RoomRef(room_id="!room:example.com"), message
    )  # type: ignore[arg-type]
    assert await rows(app) == {}
    assert client.posted == posted
    assert client.enqueued == []


def fail_first_send(app) -> None:
    """The homeserver refuses the next notice once, then takes them again."""
    send = app.service.send_message
    failures = [RuntimeError("homeserver unreachable")]

    async def flaky(*args: Any, **kwargs: Any) -> None:
        if failures:
            raise failures.pop()
        await send(*args, **kwargs)

    app.service.send_message = flaky


async def owed(app) -> dict[tuple[str, str], str | None]:
    async with app.factory() as session:
        found = await session.execute(
            select(
                HostedWakeMailbox.room_id,
                HostedWakeMailbox.message_id,
                HostedWakeMailbox.notice_owed,
            ).where(HostedWakeMailbox.tenant_id == require_tenant_id())
        )
        return {(room, message): notice for room, message, notice in found}


async def add_row(app, message_id: str, **values: Any) -> None:
    now = datetime.now(UTC)
    async with app.factory() as session:
        session.add(
            HostedWakeMailbox(
                agent_id=app.agent_id,
                room_id=app.rooms[0],
                message_id=message_id,
                launch_id=app.request_id,
                thread_id="$thread",
                event={},
                addressed_at=now,
                updated_at=now,
                expires_at=now + timedelta(hours=24),
                **values,
            )
        )
        await session.commit()


async def assert_retried_once(app, key: tuple[str, str], body: str) -> None:
    assert app.sent == []
    await mailbox_upkeep(app.service, datetime.now(UTC))
    assert [(room, thread) for room, thread, _ in app.sent] == [(key[0], "$thread")]
    assert body in app.sent[0][2]
    assert (await owed(app))[key] is None
    await mailbox_upkeep(app.service, datetime.now(UTC))
    assert len(app.sent) == 1


async def test_stop_notice_failed_send_is_retried_by_upkeep(mailbox_app):
    app = mailbox_app
    await add_row(app, "$m1")
    fail_first_send(app)
    await stop(app)
    key = (app.rooms[0], "$m1")
    assert await rows(app) == {key: "cancelled"}
    assert await owed(app) == {key: "stopped"}
    await assert_retried_once(app, key, "stopped before I processed")


@pytest.mark.parametrize(
    ("outcome", "reason", "body"),
    [
        ("cancelled", "stopped", "stopped before I processed"),
        ("admitted", "started_before_stop", "already started processing"),
    ],
)
async def test_ack_notice_failed_send_is_retried_by_upkeep(
    mailbox_app, outcome, reason, body
):
    app = mailbox_app
    await add_row(
        app, "$m1", state="cancel_requested", cancel_reason="stopped", ever_offered=True
    )
    await attach(app)
    fail_first_send(app)
    key = (app.rooms[0], "$m1")
    acked = await ack(app, attached_conn(app), (*key, outcome))
    assert acked.status_code == 200, acked.text
    assert await rows(app) == {key: outcome}
    assert await owed(app) == {key: reason}
    # A repeated ack finds the row terminal and owes nothing new.
    await ack(app, attached_conn(app), (*key, outcome))
    await assert_retried_once(app, key, body)


async def test_expiry_notice_failed_send_is_retried_by_upkeep(mailbox_app):
    app = mailbox_app
    await add_row(app, "$m1")
    await sleep_machine(app)
    async with app.factory() as session:
        row = await session.get(
            HostedWakeMailbox,
            (require_tenant_id(), app.agent_id, app.rooms[0], "$m1"),
        )
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    fail_first_send(app)
    await mailbox_upkeep(app.service, datetime.now(UTC))
    key = (app.rooms[0], "$m1")
    assert await rows(app) == {key: "expired"}
    assert await owed(app) == {key: "expired"}
    await assert_retried_once(app, key, "could not process this message in time")


async def test_a_deleted_agents_notice_is_dropped_not_posted(mailbox_app, caplog):
    app = mailbox_app
    await add_row(app, "$m1", state="cancelled", notice_owed="stopped")
    async with app.factory() as session:
        await AgentStore().delete(session, app.agent_id)
        await session.commit()
    store = HostedMailboxStore()
    async with app.factory() as session:
        notices = await store.owed_notices(session, 10)
    assert len(notices) == 1

    await post_mailbox_notices(app.service, notices)

    key = (app.rooms[0], "$m1")
    assert app.sent == []
    assert await owed(app) == {key: "stopped"}
    async with app.factory() as session:
        row = await session.get(
            HostedWakeMailbox, (require_tenant_id(), app.agent_id, *key)
        )
        assert row is not None
        assert row.notice_dropped == "agent_deleted"
        assert await store.owed_notices(session, 10) == []
    assert any("was deleted" in record.message for record in caplog.records)
