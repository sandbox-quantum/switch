"""Decision routing on a machine, end to end through the router: a workspace
whose decisions run on one of its admin's machines is asked over the
machine's controller connection, in the process holding its socket
(`decision/machine.py`, `delivery/decision.py`).

The machine's controller is a stand-in answering each `decision.request`
with fixed logprobs (`FakeMachine`); everything else is the production path,
on real Postgres.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import ControllerPresence
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    AgentEventRow,
    PendingDecision,
    TenantMember,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.decision.client import DynamicDecisionClient
from switch_core.decision.machine import MachineDecisions
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.logging_context import STRUCTURED_FIELDS
from switch_core.observability.catalogue import (
    DECISION_BACKEND_ERRORS,
    DECISION_FAILURES,
    DECISION_MODEL_TIME,
    DECISION_REQUESTS,
)
from switch_core.outbound import OutboundPolicy
from tests.conftest import TEST_KEYRING
from tests.metric_readings import Readings, recording_metrics
from tests.routing import process_on
from tests.switch_core.decision.machine_helpers import (
    MODEL,
    FakeMachine,
    add_controller,
    hold,
    status,
)
from tests.switch_core.delivery.test_conversation_journeys import ON, Journey
from tests.switch_core.delivery.world import World

OFFLINE_NOTICE = (
    "Auto-route is unavailable right now (Studio Mac is offline); tag an agent "
    "to reach it."
)


def _no_service(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"no decision service is asked: {request.url}")


def _client(
    session_factory: async_sessionmaker[AsyncSession], presence: ControllerPresence
) -> DynamicDecisionClient:
    """A decision client with no server default, asking the machines whose
    sockets `presence` holds."""
    return DynamicDecisionClient(
        session_factory=session_factory,
        availability=DecisionAvailability(
            enabled=True,
            server=ServerDefault(
                endpoint_url=None, api_key=None, bedrock_enabled=False
            ),
            store=DecisionSettingsStore(),
            controllers=AgentControllerStore(),
        ),
        keyring=TEST_KEYRING,
        client=httpx.AsyncClient(transport=httpx.MockTransport(_no_service)),
        guarded_client=httpx.AsyncClient(transport=httpx.MockTransport(_no_service)),
        outbound_policy=OutboundPolicy.parse(""),
        timeout_seconds=1.0,
        telemetry=None,
        cache_seconds=0,
        machines=MachineDecisions(presence),
    )


def _presence() -> ControllerPresence:
    return ControllerPresence(on_bound=lambda _agent_id: None)


async def _choose_machine(
    world: World, *, ready: bool, reported: dict | None = None
) -> str:
    """The world's owner, a workspace admin, chooses their machine."""
    async with world.session_factory() as session:
        session.add(
            TenantMember(tenant_id=TENANT_ZERO_ID, user_id=world.owner_id, role="admin")
        )
        controller = await add_controller(session, world.owner_id, reported=reported)
        store = DecisionSettingsStore()
        await store.save_machine(
            session,
            TENANT_ZERO_ID,
            controller_id=controller.id,
            model=MODEL,
            threshold=None,
            saved_by=world.owner_id,
        )
        if ready:
            await store.mark_machine_ready(
                session, TENANT_ZERO_ID, controller.id, MODEL
            )
        await session.commit()
        return controller.id


async def _set_owner_role(world: World, role: str) -> None:
    async with world.session_factory() as session:
        await session.execute(
            update(TenantMember)
            .where(
                TenantMember.tenant_id == TENANT_ZERO_ID,
                TenantMember.user_id == world.owner_id,
            )
            .values(role=role)
        )
        await session.commit()


async def _auto_route_on(world: World) -> None:
    async with world.session_factory() as session:
        await RoomStore().set_auto_route_on(session, world.room_id, True)
        await session.commit()


async def _pending(world: World) -> list[PendingDecision]:
    async with world.session_factory() as session:
        return list((await session.scalars(select(PendingDecision))).all())


async def test_an_untagged_question_is_decided_on_the_machine(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    controller = await _choose_machine(world, ready=True)
    presence = _presence()
    machine = FakeMachine(hold(presence, controller, TENANT_ZERO_ID))
    machine.pick = "helper"
    room = await Journey(world, ON, _client(world.session_factory, presence)).start()
    reply = await room.command("alice", "auto-route", "on", at=0)
    assert "Automatic routing is **on**" in reply

    async with machine.running():
        with caplog.at_level(logging.INFO):
            told = await room.say(
                "bob", "can someone check why the deploy failed?", at=10
            )

    assert await room.reached(told) == {"helper"}
    [frame] = machine.requests
    assert frame["data"]["model"] == MODEL
    assert (
        "can someone check why the deploy failed?"
        in (frame["data"]["payload"]["messages"][1]["content"])
    )
    async with world.session_factory() as session:
        row = await session.scalar(
            select(AgentEventRow).where(AgentEventRow.message_key == told)
        )
    assert row is not None
    event = AgentEvent.model_validate(row.payload)
    assert isinstance(event.payload, MessagePayload)
    assert event.payload.routed_reason == "decided"
    assert "backend=machine" in caplog.text
    assert room.room_notices == []


async def test_a_machine_that_picks_nobody_delivers_nothing_and_says_nothing(
    world: World,
) -> None:
    controller = await _choose_machine(world, ready=True)
    presence = _presence()
    machine = FakeMachine(hold(presence, controller, TENANT_ZERO_ID))
    machine.pick = None
    room = await Journey(world, ON, _client(world.session_factory, presence)).start()
    await room.command("alice", "auto-route", "on", at=0)

    async with machine.running():
        told = await room.say("bob", "lunch at one, anyone?", at=10)

    assert await room.reached(told) == set()
    assert room.room_notices == []


async def test_an_offline_machine_is_one_notice_naming_it_and_the_triage_agent_gets_it(
    world: World,
) -> None:
    await _choose_machine(world, ready=True)
    room = await Journey(world, ON, _client(world.session_factory, _presence())).start()
    await room.command("alice", "auto-route", "on", at=0)
    await room.command("alice", "auto-route", "fallback @reviewer", at=1)

    first = await room.say("bob", "can someone check the deploy?", at=10)
    second = await room.say("alice", "is anyone looking at the gateway?", at=20)
    tagged = await room.say("bob", "@helper are you there?", at=30)

    assert room.room_notices == [OFFLINE_NOTICE]
    assert await room.reached(first) == {"reviewer"}
    assert await room.reached(second) == {"reviewer"}
    assert await room.reached(tagged) == {"helper"}
    assert await _pending(world) == []


async def test_a_busy_machine_is_named_as_busy(world: World) -> None:
    controller = await _choose_machine(world, ready=True)
    presence = _presence()
    machine = FakeMachine(hold(presence, controller, TENANT_ZERO_ID))
    machine.error = "busy"
    room = await Journey(world, ON, _client(world.session_factory, presence)).start()
    await room.command("alice", "auto-route", "on", at=0)

    async with machine.running():
        told = await room.say("bob", "can someone check the deploy?", at=10)

    assert await room.reached(told) == set()
    assert room.room_notices == [
        "Auto-route is unavailable right now (Studio Mac is busy); tag an agent "
        "to reach it."
    ]


async def test_while_the_model_gets_ready_nothing_is_asked_and_nothing_is_said(
    world: World,
) -> None:
    reported = status(
        state="downloading", progress={"done_bytes": 1, "total_bytes": 2_740_000_000}
    )
    controller = await _choose_machine(world, ready=False, reported=reported)
    presence = _presence()
    machine = FakeMachine(hold(presence, controller, TENANT_ZERO_ID))
    room = await Journey(world, ON, _client(world.session_factory, presence)).start()
    reply = await room.command("alice", "auto-route", "on", at=0)
    # Already on, as a room can be from before the workspace chose the machine.
    await _auto_route_on(world)

    async with machine.running():
        told = await room.say("bob", "can someone check the deploy?", at=10)

    assert "is getting ready" in reply
    assert await room.reached(told) == set()
    assert machine.requests == []
    assert await _pending(world) == []
    assert room.room_notices == []


async def test_a_removed_machine_asks_nothing_and_says_nothing(world: World) -> None:
    controller = await _choose_machine(world, ready=True)
    room = await Journey(world, ON, _client(world.session_factory, _presence())).start()
    await room.command("alice", "auto-route", "on", at=0)
    async with world.session_factory() as session:
        await session.execute(
            update(AgentController)
            .where(AgentController.id == controller)
            .values(revoked_at=datetime.now(UTC), api_key_id=None)
        )
        await session.commit()

    told = await room.say("bob", "can someone check the deploy?", at=10)
    reply = await room.command("alice", "auto-route", "", at=20)

    assert await room.reached(told) == set()
    assert room.room_notices == []
    assert await _pending(world) == []
    assert "was removed" in reply


async def test_a_demoted_owners_machine_is_sent_nothing_until_they_are_admin_again(
    world: World,
) -> None:
    controller = await _choose_machine(world, ready=True)
    presence = _presence()
    machine = FakeMachine(hold(presence, controller, TENANT_ZERO_ID))
    machine.pick = "helper"
    room = await Journey(world, ON, _client(world.session_factory, presence)).start()
    await room.command("alice", "auto-route", "on", at=0)
    await room.command("alice", "auto-route", "fallback @reviewer", at=1)
    await _set_owner_role(world, "member")

    async with machine.running():
        told = await room.say("bob", "can someone check the deploy?", at=10)
    reply = await room.command("alice", "auto-route", "", at=20)

    assert machine.requests == []
    assert await room.reached(told) == {"reviewer"}
    assert room.room_notices == [
        "Auto-route is unavailable right now (Studio Mac's owner is no longer a "
        "workspace admin); tag an agent to reach it."
    ]
    assert "its owner is no longer an admin of this workspace" in reply
    assert await _pending(world) == []

    await _set_owner_role(world, "admin")
    async with machine.running():
        again = await room.say("bob", "and the gateway?", at=30)

    assert await room.reached(again) == {"helper"}
    assert len(machine.requests) == 1


class TestTheProcessHoldingTheMachine:
    """A connection lives in one process: only that one decides a
    workspace's messages on its machine."""

    async def test_a_message_written_elsewhere_wakes_the_holder_which_decides_it(
        self, world: World
    ) -> None:
        controller = await _choose_machine(world, ready=True)
        # Process A writes the message; process B holds the machine's socket.
        presence_a = _presence()
        presence_a.held_elsewhere(controller, "process-b")
        presence_b = _presence()
        machine = FakeMachine(hold(presence_b, controller, TENANT_ZERO_ID))
        machine.pick = "helper"
        room = await Journey(
            world, ON, _client(world.session_factory, presence_a)
        ).start()
        await room.command("alice", "auto-route", "on", at=0)
        wakes: list[tuple[str, str]] = []
        room.process.router.use_decision_wakes(
            lambda process_id, tenant_id: wakes.append((process_id, tenant_id))
        )
        holder = process_on(
            world.session_factory,
            conversation=ON,
            decisions=_client(world.session_factory, presence_b),
        )

        told = await room.say("bob", "can someone check the deploy?", at=10)

        # A woke B rather than claiming it, and its own sweep claims nothing.
        assert wakes == [("process-b", TENANT_ZERO_ID)]
        assert [p.message_key for p in await _pending(world)] == [told]
        assert await room.process.router.decide_pending(TENANT_ZERO_ID) == 0
        assert machine.requests == []

        async with machine.running():
            holder.router.wake_decisions(TENANT_ZERO_ID)
            await holder.idle()

        assert await room.reached(told) == {"helper"}
        assert len(machine.requests) == 1
        assert await _pending(world) == []
        assert room.room_notices == []

    async def test_held_nowhere_it_fails_at_once_as_offline(self, world: World) -> None:
        await _choose_machine(world, ready=True)
        room = await Journey(
            world, ON, _client(world.session_factory, _presence())
        ).start()
        await room.command("alice", "auto-route", "on", at=0)
        wakes: list[tuple[str, str]] = []
        room.process.router.use_decision_wakes(
            lambda process_id, tenant_id: wakes.append((process_id, tenant_id))
        )

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert wakes == []
        assert await room.reached(told) == set()
        assert room.room_notices == [OFFLINE_NOTICE]
        assert await _pending(world) == []


async def test_the_decision_record_and_metrics_name_the_machine_backend(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    controller = await _choose_machine(world, ready=True)
    presence = _presence()
    machine = FakeMachine(hold(presence, controller, TENANT_ZERO_ID))
    machine.pick = "helper"
    room = await Journey(world, ON, _client(world.session_factory, presence)).start()
    await room.command("alice", "auto-route", "on", at=0)

    async with machine.running():
        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.say("bob", "can someone check why the deploy failed?", at=10)
            readings = Readings(registry)

    [record] = [
        getattr(r, STRUCTURED_FIELDS)["decision"]
        for r in caplog.records
        if isinstance(getattr(r, STRUCTURED_FIELDS, None), dict)
    ]
    [frame] = machine.requests
    assert record["outcome"] == "delivered"
    assert record["backend"] == "machine"
    assert record["decision_id"] == frame["data"]["request_id"]
    assert record["model_ms"] == 412
    assert (
        readings.total(DECISION_REQUESTS.name, backend="machine", outcome="agent") == 1
    )
    assert readings.count(DECISION_MODEL_TIME.name, backend="machine") == 1


async def test_a_busy_machine_counts_as_a_refused_backend(world: World) -> None:
    controller = await _choose_machine(world, ready=True)
    presence = _presence()
    machine = FakeMachine(hold(presence, controller, TENANT_ZERO_ID))
    machine.error = "busy"
    room = await Journey(world, ON, _client(world.session_factory, presence)).start()
    await room.command("alice", "auto-route", "on", at=0)

    async with machine.running():
        with recording_metrics() as registry:
            await room.say("bob", "can someone check the deploy?", at=10)
            readings = Readings(registry)

    assert (
        readings.total(
            DECISION_BACKEND_ERRORS.name, backend="machine", kind="backend_refused"
        )
        == 1
    )
    assert (
        readings.total(DECISION_FAILURES.name, backend="machine", reason="machine_busy")
        == 1
    )
