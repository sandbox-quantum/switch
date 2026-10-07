"""A cloud machine on the agent controller: when it may sleep, and waking it.

Against Postgres. The machine sleeps only on evidence its controller reported
recently: every agent it runs not busy and quiet for the idle window, and no
Console relay, controller operation or wake mailbox entry waiting on it. An
addressed message or a Console request wakes it, and the mailbox keeps what
was addressed until the controller is back. KMS is stubbed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

from switch_core.bridges.agent.hosted_mailbox import deliver_to_controllers
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.clients.agent_consumer import AgentConsumer
from switch_core.db.models import (
    TENANT_ZERO_ID,
    HostedMachine,
    HostedWakeMailbox,
    User,
    require_tenant_id,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.hosted_machine_store import DISK_FULL_BELOW_BYTES
from switch_core.db.stores.hosted_mailbox_store import HostedMailboxStore, MailboxEntry
from switch_core.gateway.hosted_controller import _should_sleep
from switch_core.gateway.hosted_controller_activity import (
    ControllerIdleEvidence,
    controller_idle_evidence,
)
from tests.switch_core.management.harness import (
    EnrolledController,
    add_member,
    add_room,
    create_managed_agent,
    definition,
    open_connection,
    open_stream,
    provider,
    status_report,
    take,
)
from tests.switch_core.management.test_cloud_controller import (  # noqa: F401
    Cloud,
    cloud,
)

IDLE_AFTER = timedelta(minutes=10)
REPORT_WITHIN = timedelta(seconds=60)


@dataclass
class Placed:
    owner: User
    controller: EnrolledController
    machine_id: str
    agent_id: str
    seq: int = 1


async def _report(
    cloud: Cloud,  # noqa: F811
    placed: Placed,
    activity: list[dict[str, Any]] | None,
) -> None:
    placed.seq += 1
    body = status_report(placed.seq, providers=[provider("claude")])
    if activity is not None:
        body["activity"] = activity
    response = await cloud.client.put(
        f"/v1/management/controllers/{placed.controller.controller_id}/status",
        json=body,
        headers=placed.controller.headers,
    )
    assert response.status_code == 200, response.text


def _quiet(placed: Placed, at: datetime, **overrides: Any) -> list[dict[str, Any]]:
    return [
        {
            "agent_id": placed.agent_id,
            "busy": False,
            "sessions": 0,
            "last_activity_at": (at - timedelta(hours=1)).isoformat(),
            **overrides,
        }
    ]


@pytest.fixture
async def placed(cloud: Cloud) -> Placed:  # noqa: F811
    """An agent placed on its owner's cloud machine, which reported it quiet
    an hour ago and was last addressed as long ago."""
    owner = await add_member(cloud.factory, "ada")
    controller = await cloud.cloud_controller(owner)
    async with cloud.factory() as session:
        machine_id = await session.scalar(
            select(HostedMachine.id).where(
                HostedMachine.controller_id == controller.controller_id
            )
        )
    assert machine_id is not None
    result = Placed(owner, controller, machine_id, "")
    await _report(cloud, result, None)
    created = await create_managed_agent(
        cloud.client,
        owner,
        name="scout",
        controller_id=controller.controller_id,
        definition_body=definition(isolation="isolated"),
    )
    assert created.status_code == 201, created.text
    result.agent_id = created.json()["agent_id"]
    now = cloud.harness.clock()
    await _report(cloud, result, _quiet(result, now))
    await cloud.update_machine(machine_id, active_at=now - timedelta(hours=1))
    return result


async def _evidence(
    cloud: Cloud,  # noqa: F811
    placed: Placed,
    *,
    pending_relays: int = 0,
    later: timedelta = timedelta(),
) -> ControllerIdleEvidence:
    async with cloud.factory() as session:
        machine = await session.get(HostedMachine, (TENANT_ZERO_ID, placed.machine_id))
        assert machine is not None
        return await controller_idle_evidence(
            session,
            machine,
            pending_relays=lambda _controller_id: pending_relays,
            report_within=REPORT_WITHIN,
            idle_after=IDLE_AFTER,
            now=cloud.harness.clock() + later,
        )


class TestIdleEvidence:
    async def test_a_quiet_machine_with_nothing_waiting_is_idle(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        evidence = await _evidence(cloud, placed)

        assert evidence.reasons == ()
        assert evidence.idle

    async def test_a_stale_report_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        evidence = await _evidence(
            cloud, placed, later=REPORT_WITHIN * 2 + timedelta(seconds=1)
        )

        assert evidence.reasons == ("no_fresh_report",)

    async def test_a_report_without_activity_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await _report(cloud, placed, None)

        assert (await _evidence(cloud, placed)).reasons == ("activity_unreported",)

    async def test_an_agent_left_out_of_the_report_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await _report(cloud, placed, [])

        assert (await _evidence(cloud, placed)).reasons == ("agent_unreported",)

    async def test_a_busy_agent_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await _report(
            cloud, placed, _quiet(placed, cloud.harness.clock(), busy=True, sessions=1)
        )

        assert (await _evidence(cloud, placed)).reasons == ("agent_busy",)

    async def test_an_agent_active_within_the_window_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        recent = cloud.harness.clock() - timedelta(minutes=1)
        await _report(
            cloud,
            placed,
            _quiet(placed, cloud.harness.clock(), last_activity_at=recent.isoformat()),
        )

        assert (await _evidence(cloud, placed)).reasons == ("agent_recently_active",)

    async def test_a_recent_address_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(placed.machine_id, active_at=cloud.harness.clock())

        assert (await _evidence(cloud, placed)).reasons == ("recently_addressed",)

    async def test_a_pending_console_relay_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        evidence = await _evidence(cloud, placed, pending_relays=1)

        assert evidence.reasons == ("relay_pending",)

    async def test_a_queued_operation_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        service = cloud.harness.management.service
        async with cloud.factory() as session:
            await service.operations.create(
                session,
                controller_id=placed.controller.controller_id,
                agent_id=placed.agent_id,
                kind="agent.restart",
                params={},
                created_by=placed.owner.id,
            )
            await session.commit()

        assert (await _evidence(cloud, placed)).reasons == ("operation_pending",)

    async def test_a_pending_mailbox_entry_keeps_it_awake(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        room_id = await add_room(cloud.factory, placed.agent_id)
        entry = MailboxEntry.of(_addressed(room_id, "$m1"))
        assert entry is not None
        async with cloud.factory() as session:
            await HostedMailboxStore().write(
                session,
                agent_id=placed.agent_id,
                entry=entry,
            )
            await session.commit()

        assert (await _evidence(cloud, placed)).reasons == ("mailbox_pending",)

    async def test_the_sweep_asks_the_management_relays(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        async with cloud.factory() as session:
            machine = await session.get(
                HostedMachine, (TENANT_ZERO_ID, placed.machine_id)
            )
            assert machine is not None
            idle = await _should_sleep(
                session,
                machine,
                IDLE_AFTER,
                REPORT_WITHIN,
                cloud.harness.clock(),
            )

        assert idle is True


class TestHeartbeat:
    async def test_a_status_report_is_the_machines_heartbeat(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(
            placed.machine_id,
            state="provisioning",
            running_observed_at=cloud.harness.clock() - timedelta(minutes=1),
        )
        await _report(cloud, placed, _quiet(placed, cloud.harness.clock()))

        async with cloud.factory() as session:
            machine = await session.get(
                HostedMachine, (TENANT_ZERO_ID, placed.machine_id)
            )
        assert machine is not None
        assert machine.state == "ready"
        assert machine.heartbeat_at is not None
        assert machine.heartbeat == {
            "disk": {"total_bytes": 107374182400, "available_bytes": 53687091200},
            "memory": {"total_bytes": 17179869184, "available_bytes": 8589934592},
            "sessions_running": 1,
        }

    async def test_a_nearly_full_disk_raises_disk_full_until_there_is_room(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        async def report_free(free: int) -> str | None:
            placed.seq += 1
            body = status_report(placed.seq, providers=[provider("claude")])
            body["machine"]["disk_free_bytes"] = free
            response = await cloud.client.put(
                f"/v1/management/controllers/{placed.controller.controller_id}/status",
                json=body,
                headers=placed.controller.headers,
            )
            assert response.status_code == 200, response.text
            return (await _machine(cloud, placed)).error_code

        full = await report_free(DISK_FULL_BELOW_BYTES - 1)
        room = await report_free(DISK_FULL_BELOW_BYTES)
        await cloud.update_machine(placed.machine_id, error_code="machine_lost")
        other = await report_free(1)

        assert (full, room, other) == ("disk_full", None, "machine_lost")


def _addressed(room_id: str, message_id: str) -> AgentEvent:
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
            thread_id=None,
        ),
    )


async def _address(cloud: Cloud, placed: Placed, event: AgentEvent) -> Any:  # noqa: F811
    """`AgentConsumer._note_hosted_addressed`, as the agent's Matrix client runs it."""
    consumer = SimpleNamespace(
        session_factory=cloud.factory,
        tenant_id=require_tenant_id(),
        _connections=cloud.harness.protocol.connections,
    )
    consumer._note_controller_addressed = lambda agent, binding, event: (
        AgentConsumer._note_controller_addressed(
            consumer,  # type: ignore[arg-type]
            agent,
            binding,
            event,
        )
    )
    async with cloud.factory() as session:
        agent = await AgentStore().get(session, placed.agent_id)
    assert agent is not None
    return await AgentConsumer._note_hosted_addressed(consumer, agent, event)  # type: ignore[arg-type]


async def _machine(cloud: Cloud, placed: Placed) -> HostedMachine:  # noqa: F811
    async with cloud.factory() as session:
        machine = await session.get(HostedMachine, (TENANT_ZERO_ID, placed.machine_id))
    assert machine is not None
    return machine


async def _mailbox(cloud: Cloud, placed: Placed) -> list[tuple[str, str]]:  # noqa: F811
    async with cloud.factory() as session:
        rows = await session.scalars(
            select(HostedWakeMailbox).where(
                HostedWakeMailbox.agent_id == placed.agent_id
            )
        )
        return [(row.message_id, row.state) for row in rows]


class TestWakeOnAddress:
    async def test_an_addressed_message_wakes_the_machine_and_waits_in_the_mailbox(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(
            placed.machine_id, desired_state="stopped", stop_reason="idle", revision=7
        )
        room_id = await add_room(cloud.factory, placed.agent_id)

        note = await _address(cloud, placed, _addressed(room_id, "$m1"))

        assert note is not None
        assert note.refusal is None
        assert note.deliver is False
        machine = await _machine(cloud, placed)
        assert (machine.desired_state, machine.stop_reason, machine.revision) == (
            "running",
            None,
            8,
        )
        assert await _mailbox(cloud, placed) == [("$m1", "pending")]

    async def test_a_machine_its_owner_stopped_takes_no_mail(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(
            placed.machine_id, desired_state="stopped", stop_reason="owner", revision=7
        )
        room_id = await add_room(cloud.factory, placed.agent_id)

        note = await _address(cloud, placed, _addressed(room_id, "$m1"))

        assert note is not None
        machine = await _machine(cloud, placed)
        assert (machine.desired_state, machine.revision) == ("stopped", 7)
        assert await _mailbox(cloud, placed) == []

    async def test_the_mailbox_is_handed_to_the_controller_once_it_is_back(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(
            placed.machine_id, desired_state="stopped", stop_reason="idle"
        )
        room_id = await add_room(cloud.factory, placed.agent_id)
        await _address(cloud, placed, _addressed(room_id, "$m1"))

        protocol = cloud.harness.protocol
        opened = await open_connection(cloud.client, placed.controller)
        stream = await open_stream(cloud.harness, placed.controller, opened)
        try:
            await take(stream, 2)
            handed = await deliver_to_controllers(protocol, [placed.agent_id])
            again = await deliver_to_controllers(protocol, [placed.agent_id])
            ((event, frame),) = await take(stream, 1)
        finally:
            await stream.aclose()

        assert (handed, again) == (1, 0)
        assert event == "agent.event"
        assert frame["agent_id"] == placed.agent_id
        assert frame["event"]["room_id"] == room_id
        assert frame["event"]["payload"]["message_id"] == "$m1"
        assert await _mailbox(cloud, placed) == [("$m1", "admitted")]

    async def test_a_live_controller_gets_the_event_on_its_stream(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        room_id = await add_room(cloud.factory, placed.agent_id)
        opened = await open_connection(cloud.client, placed.controller)
        stream = await open_stream(cloud.harness, placed.controller, opened)
        try:
            await take(stream, 2)
            note = await _address(cloud, placed, _addressed(room_id, "$m1"))
        finally:
            await stream.aclose()

        assert note is None
        assert await _mailbox(cloud, placed) == []


class TestPlacementWhileAsleep:
    async def _place(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> Any:
        cloud.harness.clock.advance(hours=2)
        return await create_managed_agent(
            cloud.client,
            placed.owner,
            name="reviewer",
            controller_id=placed.controller.controller_id,
            definition_body=definition(isolation="isolated"),
        )

    async def test_an_agent_placed_on_a_sleeping_machine_is_accepted_and_wakes_it(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(
            placed.machine_id, desired_state="stopped", stop_reason="idle", revision=7
        )

        created = await self._place(cloud, placed)

        assert created.status_code == 201, created.text
        binding = cloud.harness.protocol.connections.controllers.binding(
            created.json()["agent_id"]
        )
        assert binding is not None
        assert binding.controller_id == placed.controller.controller_id
        machine = await _machine(cloud, placed)
        assert (machine.desired_state, machine.stop_reason, machine.revision) == (
            "running",
            None,
            8,
        )

    async def test_a_machine_already_waking_takes_the_agent(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(placed.machine_id, state="provisioning")

        created = await self._place(cloud, placed)

        assert created.status_code == 201, created.text

    async def test_a_machine_its_owner_stopped_refuses_it(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(
            placed.machine_id, desired_state="stopped", stop_reason="owner", revision=7
        )

        created = await self._place(cloud, placed)

        assert created.status_code == 409, created.text
        assert created.json()["error"]["code"] == "controller_offline"
        machine = await _machine(cloud, placed)
        assert (machine.desired_state, machine.revision) == ("stopped", 7)

    async def test_an_awake_machine_whose_controller_is_silent_refuses_it(
        self,
        cloud: Cloud,  # noqa: F811
        placed: Placed,
    ) -> None:
        await cloud.update_machine(placed.machine_id, state="ready")

        created = await self._place(cloud, placed)

        assert created.status_code == 409, created.text
        assert created.json()["error"]["code"] == "controller_offline"
