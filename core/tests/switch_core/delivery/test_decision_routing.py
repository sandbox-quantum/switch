"""Decision routing, end to end through the router: which messages the
decision service is asked about, what it is sent, and what the agent it names
is given (`delivery/decision.py`).

Messages are written the way production writes them, through a client's
transport, so the router decides each as it is written and asks the decision
service once it has committed. The service is a stub behind the decision
client's HTTP transport, recording every request; what each agent was given
is read back from `agent_events`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import httpx
import pytest
from sqlalchemy import Text, cast, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.protocol.event_buffer import is_notifiable
from switch_core.bridges.agent.protocol.message_events import message_event
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentEventRow,
    ClientRoom,
    Message,
    PendingDecision,
    RoleLease,
    Room,
    RoomRole,
)
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.pending_decision_store import PendingDecisionStore
from switch_core.db.stores.room_store import DECISION_NOTICE_AT_KEY, RoomStore
from switch_core.db.tenant_lookup import tenants_with_pending_decisions
from switch_core.decision.client import DynamicDecisionClient
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.delivery.decision import DECISION_NOTICE, THREAD_CONTEXT
from switch_core.delivery.recipient import AgentRecipient
from switch_core.delivery.router import sweep_pending_decisions
from switch_core.logging_config import JsonFormatter
from switch_core.logging_context import STRUCTURED_FIELDS, LogContextFilter
from switch_core.observability.catalogue import (
    DECISION_NOTICES,
    DECISION_SETTLED,
    DECISION_WAIT,
)
from switch_core.outbound import OutboundPolicy
from switch_core.tenant_context import current_tenant_id, no_tenant
from switch_core.transport import InboundMessage
from tests.conftest import TEST_KEYRING
from tests.metric_readings import Readings, recording_metrics
from tests.routing import process_on
from tests.switch_core.delivery.test_conversation_journeys import ON, Journey
from tests.switch_core.delivery.world import World


def decision_records(caplog: pytest.LogCaptureFixture) -> list[dict[str, Any]]:
    """The decision records the router logged, one per settled message."""
    return [
        getattr(r, STRUCTURED_FIELDS)["decision"]
        for r in caplog.records
        if isinstance(getattr(r, STRUCTURED_FIELDS, None), dict)
    ]


class DecisionService:
    """A stub decision service: records each request, and names `pick`, or
    answers with `status`, or fails with `error`."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.pick: str | None = None
        self.status = 200
        self.error: Exception | None = None
        self.during: Callable[[], Awaitable[None]] | None = None
        self.headers: list[dict[str, str]] = []

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(json.loads(request.content))
        self.headers.append(dict(request.headers))
        if self.during is not None:
            await self.during()
        if self.error is not None:
            raise self.error
        return httpx.Response(
            self.status,
            json={
                "agent": self.pick,
                "model_choice": self.pick or "none",
                "confidence": 0.9,
                "threshold": 0.6,
                "reason": "stub",
                "model": "stub",
                "latency_ms": 5,
            },
        )

    def client(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> DynamicDecisionClient:
        """A decision client whose server default is this stub, reading each
        workspace's settings afresh on every decision."""
        return DynamicDecisionClient(
            session_factory=session_factory,
            availability=DecisionAvailability(
                enabled=True,
                server=ServerDefault(
                    endpoint_url="http://decision.test/decide",
                    api_key=None,
                    bedrock_enabled=False,
                ),
                store=DecisionSettingsStore(),
            ),
            keyring=TEST_KEYRING,
            client=httpx.AsyncClient(transport=httpx.MockTransport(self.handle)),
            guarded_client=httpx.AsyncClient(
                transport=httpx.MockTransport(self.handle)
            ),
            outbound_policy=OutboundPolicy.parse("10.9.0.0/16"),
            timeout_seconds=1.0,
            telemetry=None,
            cache_seconds=0,
        )


@pytest.fixture
def service() -> DecisionService:
    return DecisionService()


@pytest.fixture
async def room(world: World, service: DecisionService) -> Journey:
    journey = await Journey(world, ON, service.client(world.session_factory)).start()
    reply = await journey.command("alice", "auto-route", "on", at=0)
    assert "Automatic routing is **on**" in reply
    return journey


async def _own_event(world: World, agent: str, event_id: str) -> AgentEventRow:
    async with world.session_factory() as session:
        row = await session.scalar(
            select(AgentEventRow).where(
                AgentEventRow.agent_id == world.agents[agent].id,
                AgentEventRow.message_key == event_id,
            )
        )
    assert row is not None
    return row


async def _owner_only(world: World, agent: str) -> None:
    """Make `agent` answer only its owner, who has claimed alice, not bob."""
    async with world.session_factory() as session:
        await session.execute(
            update(Agent)
            .where(Agent.id == world.agents[agent].id)
            .values(addressing_policy=owner_only_policy([]).model_dump(mode="json"))
        )
        await session.commit()


class TestWhichMessagesAreAsked:
    async def test_an_untagged_question_is_asked(
        self, room: Journey, service: DecisionService
    ) -> None:
        told = await room.say("bob", "can someone check why the deploy failed?", at=10)

        [request] = service.requests
        assert request["message"] == {
            "sender": "bob",
            "text": "can someone check why the deploy failed?",
            "thread_id": None,
        }
        assert {agent["name"] for agent in request["agents"]} == {"helper", "reviewer"}
        assert await room.reached(told) == set()

    async def test_a_thread_reply_is_asked_with_the_thread(
        self, room: Journey, service: DecisionService
    ) -> None:
        root = await room.say("alice", "@helper what does just up do?", at=10)
        answer = await room.post("helper", "It starts the stack", at=20, thread=root)

        told = await room.say(
            "alice", "ok can you rerun it with the cache cleared?", at=30, thread=root
        )

        [request] = service.requests
        assert request["message"]["thread_id"] == root
        assert request["thread"] == [
            {
                "sender": "alice",
                "sender_kind": "person",
                "text": "@helper what does just up do?",
                "addressed": ["helper"],
            },
            {
                "sender": "helper",
                "sender_kind": "agent",
                "text": "It starts the stack",
                "addressed": [],
            },
        ]
        # The thread follow-up would have given it to helper; it is off here.
        assert answer
        assert await room.reached(told) == set()

    async def test_a_channel_follow_up_wins(
        self, room: Journey, service: DecisionService
    ) -> None:
        await room.say("alice", "@helper what does just migrate do?", at=10)
        await room.post("helper", "It applies migrations", at=20)

        told = await room.say("alice", "and what does just down do?", at=40)

        assert await room.reached(told) == {"helper"}
        assert service.requests == []

    async def test_the_assigned_agent_wins(
        self, room: Journey, service: DecisionService
    ) -> None:
        await room.command("alice", "assign-agent", "@reviewer", at=5)

        told = await room.say("bob", "can someone check why the deploy failed?", at=10)

        assert await room.reached(told) == {"reviewer"}
        assert service.requests == []

    async def test_an_agent_is_not_asked_about(
        self, room: Journey, service: DecisionService
    ) -> None:
        told = await room.say("helper", "Deploy finished, all green", at=10)

        assert await room.reached(told) == set()
        assert service.requests == []

    async def test_a_mention_of_a_person_is_not_asked_about(
        self, room: Journey, service: DecisionService
    ) -> None:
        told = await room.say("alice", "@bob can you approve my PR?", at=10)

        assert await room.reached(told) == set()
        assert service.requests == []

    async def test_thanks_is_not_asked_about(
        self, room: Journey, service: DecisionService
    ) -> None:
        told = await room.say("alice", "thanks!", at=10)

        assert await room.reached(told) == set()
        assert service.requests == []

    async def test_a_file_without_words_is_not_asked_about(
        self, room: Journey, service: DecisionService
    ) -> None:
        told = await room.process.send_file(
            room.room, "deploy.log", sender=room.clients["alice"]
        )
        await room.process.idle()

        assert await room.reached(told) == set()
        assert service.requests == []

    async def test_a_file_in_an_agents_thread_is_not_followed_or_asked_about(
        self, room: Journey, service: DecisionService
    ) -> None:
        # A post of files follows the conversation as a text message does
        # (CHOO-4067), so in an auto-route room the thread follow-up is off
        # for it too. The decision service is asked about text alone.
        root = await room.say("alice", "@helper which log do you need?", at=10)
        answer = await room.post("helper", "The deploy log", at=20, thread=root)

        told = await room.send_file(
            "alice", "deploy.log", at=30, caption="here it is", thread=root
        )

        assert answer
        assert await room.reached(told) == set()
        assert service.requests == []

    async def test_a_room_without_auto_route_is_not_asked_about(
        self, room: Journey, service: DecisionService
    ) -> None:
        await room.command("alice", "auto-route", "off", at=5)
        answer = await room.post("helper", "It starts the stack", at=6)

        told = await room.say("bob", "can someone check why the deploy failed?", at=10)
        in_thread = await room.say("alice", "why?", at=20, thread=answer)

        assert await room.reached(told) == set()
        assert await room.reached(in_thread) == {"helper"}
        assert service.requests == []

    async def test_with_the_flag_off_nothing_is_asked_and_threads_follow_up(
        self, world: World
    ) -> None:
        room = await Journey(world, ON).start()
        async with world.session_factory() as session:
            await RoomStore().set_auto_route_on(session, world.room_id, True)
            await session.commit()
        answer = await room.post("helper", "It starts the stack", at=0)

        told = await room.say("bob", "can someone check why the deploy failed?", at=10)
        in_thread = await room.say("alice", "why?", at=20, thread=answer)
        reply = await room.command("alice", "auto-route", "", at=30)

        assert await room.reached(told) == set()
        assert await room.reached(in_thread) == {"helper"}
        assert "isn't switched on" in reply


class TestWhatTheServiceIsSent:
    async def test_the_rooms_context(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        now = datetime.now(UTC)
        async with world.session_factory() as session:
            await session.execute(
                update(Room)
                .where(Room.id == world.room_id)
                .values(instructions="Deploy questions go to helper.")
            )
            await session.execute(
                update(Agent)
                .where(Agent.id == world.agents["helper"].id)
                .values(description="Runs and debugs deploys")
            )
            role = RoomRole(room_id=world.room_id, name="oncall", instructions="Page.")
            session.add(role)
            await session.flush()
            session.add(
                RoleLease(
                    role_id=role.id,
                    room_id=world.room_id,
                    agent_id=world.agents["reviewer"].id,
                    transport_session_id="session-1",
                    last_seen_at=now,
                )
            )
            await session.commit()
        await room.say(
            "alice", "@reviewer can you add a section on rate limits?", at=10
        )
        await room.post("reviewer", "Added it", at=20)
        await room.say("bob", "lunch at 1 anyone?", at=30)

        await room.say("alice", "one more thing, the deploy is red", at=40)

        request = service.requests[-1]
        assert request["room"] == {
            "name": "room",
            "instructions": "Deploy questions go to helper.",
        }
        assert sorted(request["agents"], key=lambda agent: agent["name"]) == [
            {"name": "helper", "description": "Runs and debugs deploys", "role": None},
            {"name": "reviewer", "description": "d", "role": "oncall"},
        ]
        assert request["thread"] == []
        people = [m for m in request["recent"] if m["text"] != "Added it"]
        assert {"sender": "reviewer", "sender_kind": "agent"} in [
            {"sender": m["sender"], "sender_kind": m["sender_kind"]}
            for m in request["recent"]
        ]
        assert people[-2:] == [
            {
                "sender": "alice",
                "sender_kind": "person",
                "text": "@reviewer can you add a section on rate limits?",
                "addressed": ["reviewer"],
            },
            {
                "sender": "bob",
                "sender_kind": "person",
                "text": "lunch at 1 anyone?",
                "addressed": [],
            },
        ]
        # Oldest first, and nothing written after the message itself.
        assert request["recent"][-1]["text"] == "lunch at 1 anyone?"
        # Switch's own notices (the `!auto-route` answer) are not context.
        assert not any(
            "Automatic routing" in message["text"] for message in request["recent"]
        )

    async def test_a_mention_by_role_or_alias_addresses_the_agent(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        async with world.session_factory() as session:
            await RoomStore().set_alias(
                session, world.room_id, world.agents["helper"].id, "ops"
            )
            await session.commit()
        await room.say("alice", "@ops is the stack up? cc @bob", at=10)
        await room.post("helper", "It is", at=20)

        await room.say("bob", "and the gateway?", at=30)

        first = next(
            m for m in service.requests[-1]["recent"] if m["text"].startswith("@ops")
        )
        assert first["addressed"] == ["bob", "helper"]

    async def test_at_most_the_last_thirty_thread_messages(
        self, room: Journey, service: DecisionService
    ) -> None:
        root = await room.post("helper", "Release checklist", at=10)
        for n in range(THREAD_CONTEXT + 4):
            await room.post("helper", f"step {n}", at=11 + n, thread=root)
        service.pick = None

        await room.say("alice", "which step failed?", at=60, thread=root)

        thread = service.requests[-1]["thread"]
        assert len(thread) == THREAD_CONTEXT
        assert thread[-1]["text"] == f"step {THREAD_CONTEXT + 3}"
        assert thread[0]["text"] == "step 4"

    async def test_an_agent_that_may_not_answer_the_sender_is_no_candidate(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        await _owner_only(world, "helper")

        await room.say("bob", "can someone check why the deploy failed?", at=10)
        await room.say("alice", "can someone check the release notes?", at=20)

        from_bob, from_alice = service.requests
        assert [agent["name"] for agent in from_bob["agents"]] == ["reviewer"]
        assert {agent["name"] for agent in from_alice["agents"]} == {
            "helper",
            "reviewer",
        }

    async def test_with_no_candidates_the_service_is_not_asked(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        await _owner_only(world, "helper")
        await _owner_only(world, "reviewer")

        with caplog.at_level(logging.INFO):
            told = await room.say("bob", "can someone check the deploy?", at=10)

        assert service.requests == []
        assert await room.reached(told) == set()
        assert "the decision service is not asked" in caplog.text


class TestWhatTheAgentIsGiven:
    async def test_the_chosen_agent_receives_the_persons_own_message(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        service.pick = "helper"

        with caplog.at_level(logging.INFO):
            told = await room.say(
                "bob", "can someone check why the deploy failed?", at=10
            )

        assert await room.reached(told) == {"helper"}
        own = await _own_event(world, "helper", told)
        assert own.notifiable
        event = AgentEvent.model_validate(own.payload)
        assert isinstance(event.payload, MessagePayload)
        assert event.payload.routed
        assert event.payload.addressed
        assert event.payload.message_id == told
        assert event.payload.body == "can someone check why the deploy failed?"
        assert own.room_seq > 0
        [record] = decision_records(caplog)
        assert record["outcome"] == "delivered"
        assert record["choice"] == "helper"
        assert record["candidates"] == 2
        assert record["model_choice"] == "helper"
        assert record["confidence"] == 0.9
        assert record["threshold"] == 0.6
        assert record["backend"] == "server_default"
        assert isinstance(record["latency_ms"], int)
        assert record["decision_id"]
        assert event.payload.routed_reason == "decided"

    async def test_what_follows_a_delivery_runs_in_the_rooms_workspace(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Once the decision is delivered, the follow-up work (is the agent
        connected, wake its machine if not) reads the database. The decision
        worker has no request to take a workspace from, so it binds the room's
        own; under a restricted role Postgres otherwise refuses that read, and
        the decision is logged as failed after the agent already has it."""
        workspaces: list[str | None] = []
        is_available = AgentRecipient._is_available

        async def recording(
            recipient: AgentRecipient, session: AsyncSession, agent: Agent, room_id: str
        ) -> bool:
            workspaces.append(current_tenant_id())
            return await is_available(recipient, session, agent, room_id)

        monkeypatch.setattr(AgentRecipient, "_is_available", recording)
        _stop_waking(room)
        service.pick = "helper"
        told = await room.say("bob", "can someone check why the deploy failed?", at=10)

        with no_tenant():
            assert await room.process.router.decide_pending(TENANT_ZERO_ID) == 1

        assert await room.reached(told) == {"helper"}
        assert workspaces == [TENANT_ZERO_ID]

    async def test_a_mention_is_not_marked_routed(
        self, world: World, room: Journey
    ) -> None:
        told = await room.say("alice", "@helper what does just up do?", at=10)

        own = await _own_event(world, "helper", told)
        assert not AgentEvent.model_validate(own.payload).payload.routed  # type: ignore[union-attr]

    async def test_nobody_chosen_delivers_nothing(
        self, room: Journey, service: DecisionService
    ) -> None:
        service.pick = None

        told = await room.say("bob", "what's the weather in London tomorrow?", at=10)

        assert len(service.requests) == 1
        assert await room.reached(told) == set()

    @pytest.mark.parametrize(
        "failure",
        [
            httpx.ConnectError("connection refused"),
            httpx.ReadTimeout("timed out"),
            502,
        ],
    )
    async def test_a_service_failure_delivers_nothing_with_a_warning(
        self,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
        failure: Exception | int,
    ) -> None:
        service.pick = "helper"
        if isinstance(failure, int):
            service.status = failure
        else:
            service.error = failure

        with caplog.at_level(logging.WARNING):
            told = await room.say("bob", "can someone check the deploy?", at=10)
            after = await room.say("alice", "is anyone around?", at=20)

        assert await room.reached(told) == set()
        assert await room.reached(after) == set()
        warnings = [
            r
            for r in caplog.records
            if r.levelno == logging.WARNING and "Decision service" in r.message
        ]
        assert len(warnings) == 2
        assert "gave no answer" in warnings[0].message

    async def test_a_name_that_was_not_a_candidate_delivers_nothing(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        await _owner_only(world, "helper")
        service.pick = "helper"

        with caplog.at_level(logging.WARNING):
            told = await room.say("bob", "can someone check the deploy?", at=10)

        assert await room.reached(told) == set()
        assert any(
            r.levelno == logging.ERROR and "not one of the candidates" in r.message
            for r in caplog.records
        )

    async def test_an_agent_that_stops_admitting_the_sender_is_not_given_it(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        service.pick = "helper"

        async def tighten() -> None:
            await _owner_only(world, "helper")

        service.during = tighten

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert await room.reached(told) == set()

    async def test_an_agent_taken_out_of_the_room_is_not_given_it(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        service.pick = "helper"
        helper = room.clients["helper"]

        async def remove() -> None:
            async with world.session_factory() as session:
                await session.execute(
                    delete(ClientRoom).where(
                        ClientRoom.client_id == helper.id,
                        ClientRoom.room_id == world.room_id,
                    )
                )
                await session.commit()

        service.during = remove

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert await room.reached(told) == set()

    async def test_a_thread_reply_after_a_routed_answer_is_asked_again(
        self, room: Journey, service: DecisionService
    ) -> None:
        service.pick = "helper"
        question = await room.say(
            "alice", "can someone check why last night's deploy failed?", at=10
        )
        assert await room.reached(question) == {"helper"}
        answer = await room.post(
            "helper", "The migration timed out", at=20, thread=question
        )

        reply = await room.say(
            "alice",
            "ok can you rerun it with the cache cleared?",
            at=30,
            thread=question,
        )

        assert answer
        assert len(service.requests) == 2
        thread = service.requests[-1]["thread"]
        assert [m["text"] for m in thread] == [
            "can someone check why last night's deploy failed?",
            "The migration timed out",
        ]
        assert await room.reached(reply) == {"helper"}

    async def test_the_next_channel_message_after_a_routed_answer_is_asked_again(
        self, room: Journey, service: DecisionService
    ) -> None:
        service.pick = "helper"
        question = await room.say("alice", "can someone check the deploy?", at=10)
        await room.post("helper", "It failed on the migration", at=20)
        service.pick = None

        aside = await room.say("alice", "sara, are you joining standup today?", at=30)

        assert await room.reached(question) == {"helper"}
        assert await room.reached(aside) == set()
        assert len(service.requests) == 2


class TestTheRoutedPayload:
    def _event(
        self, *, routed_reason: Literal["decided", "fallback"] | None
    ) -> AgentEvent:
        return message_event(
            room_id="room",
            bridge_id=None,
            channel_type="channel_public",
            event=InboundMessage(
                room_id="!r:test",
                event_id="$m",
                sender="@alice:test",
                timestamp=0,
                body="hi",
            ),
            addressed=True,
            sender_name="alice",
            body="hi",
            thread_id=None,
            routed_reason=routed_reason,
        )

    def test_a_routed_message_is_addressed_and_notifiable(self) -> None:
        event = self._event(routed_reason="decided")

        assert isinstance(event.payload, MessagePayload)
        assert event.payload.routed
        assert event.payload.routed_reason == "decided"
        assert event.payload.addressed
        assert is_notifiable(event)
        assert AgentEvent.model_validate(event.model_dump(mode="json")) == event

    def test_not_routed_unless_said(self) -> None:
        payload = self._event(routed_reason=None).payload
        assert isinstance(payload, MessagePayload)
        assert not payload.routed
        assert payload.routed_reason is None
        assert (
            MessagePayload.model_validate(
                {
                    "addressed": True,
                    "sender": "@a:test",
                    "sender_name": "a",
                    "message_id": "$m",
                    "body": "hi",
                    "timestamp": 0,
                }
            ).routed
            is False
        )


async def _pending(world: World) -> list[PendingDecision]:
    async with world.session_factory() as session:
        return list((await session.scalars(select(PendingDecision))).all())


def _stop_waking(journey: Journey) -> None:
    """The process that writes messages stops before it decides them, as a
    process does when it is restarted with decisions waiting."""
    journey.process.router.wake_decisions = lambda _tenant_id: None  # type: ignore[method-assign]


class TestDecisionsSurviveARestart:
    async def test_the_waiting_message_is_recorded_with_the_message(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        _stop_waking(room)

        told = await room.say("bob", "can someone check the deploy?", at=10)

        [pending] = await _pending(world)
        assert pending.message_key == told
        assert pending.room_id == world.room_id
        async with world.session_factory() as session:
            message = await session.scalar(
                select(Message).where(Message.transport_event_id == told)
            )
        assert message is not None and pending.room_seq == message.seq
        assert service.requests == []

    async def test_after_a_restart_it_is_decided_and_delivered_once(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        _stop_waking(room)
        service.pick = "helper"
        told = await room.say("bob", "can someone check the deploy?", at=10)

        restarted = process_on(
            world.session_factory,
            conversation=ON,
            decisions=service.client(world.session_factory),
        )
        assert await restarted.router.decide_pending(TENANT_ZERO_ID) == 1
        assert await restarted.router.decide_pending(TENANT_ZERO_ID) == 0

        assert await room.reached(told) == {"helper"}
        assert len(service.requests) == 1
        assert await _pending(world) == []
        async with world.session_factory() as session:
            events = (
                await session.scalars(
                    select(AgentEventRow).where(AgentEventRow.message_key == told)
                )
            ).all()
        assert len(events) == 1

    async def test_the_sweep_finds_only_the_workspace_with_a_message_waiting(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        _stop_waking(room)
        service.pick = "helper"
        assert TENANT_ZERO_ID not in await tenants_with_pending_decisions(
            world.session_factory
        )

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert await tenants_with_pending_decisions(world.session_factory) == [
            TENANT_ZERO_ID
        ]
        await sweep_pending_decisions(
            await tenants_with_pending_decisions(world.session_factory),
            room.process.router.decide_pending,
            4,
        )
        assert await room.reached(told) == {"helper"}
        assert await tenants_with_pending_decisions(world.session_factory) == []

    async def test_a_message_waiting_too_long_is_dropped_and_logged(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        _stop_waking(room)
        service.pick = "helper"
        told = await room.say("bob", "can someone check the deploy?", at=10)
        async with world.session_factory() as session:
            await session.execute(
                update(PendingDecision).values(
                    created_at=func.now() - timedelta(minutes=10)
                )
            )
            await session.commit()

        with caplog.at_level(logging.WARNING):
            assert await room.process.router.decide_pending(TENANT_ZERO_ID) == 0

        assert await room.reached(told) == set()
        assert service.requests == []
        assert await _pending(world) == []
        assert "outcome=expired" in caplog.text
        assert told in caplog.text

    async def test_two_processes_never_deliver_it_twice(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        _stop_waking(room)
        service.pick = "helper"
        other = process_on(
            world.session_factory,
            conversation=ON,
            decisions=service.client(world.session_factory),
        )
        told = await room.say("bob", "can someone check the deploy?", at=10)

        first, second = await asyncio.gather(
            room.process.router.decide_pending(TENANT_ZERO_ID),
            other.router.decide_pending(TENANT_ZERO_ID),
        )

        assert sorted([first, second]) == [0, 1]
        assert len(service.requests) == 1
        assert await room.reached(told) == {"helper"}

    async def test_a_claim_whose_process_stopped_is_taken_over(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        _stop_waking(room)
        service.pick = "helper"
        told = await room.say("bob", "can someone check the deploy?", at=10)
        async with world.session_factory() as session:
            claimed = await PendingDecisionStore().claim(
                session, tenant_id=TENANT_ZERO_ID, lease_seconds=60, limit=10
            )
            await session.commit()
        assert [p.message_key for p in claimed] == [told]

        # Leased: nobody else takes it.
        assert await room.process.router.decide_pending(TENANT_ZERO_ID) == 0
        async with world.session_factory() as session:
            await session.execute(
                update(PendingDecision).values(
                    claimed_until=func.now() - timedelta(seconds=1)
                )
            )
            await session.commit()

        assert await room.process.router.decide_pending(TENANT_ZERO_ID) == 1
        assert await room.reached(told) == {"helper"}

    async def test_one_settled_elsewhere_is_not_delivered_again(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        service.pick = "helper"

        async def settled_elsewhere() -> None:
            async with world.session_factory() as session:
                await session.execute(delete(PendingDecision))
                await session.commit()

        service.during = settled_elsewhere

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert await room.reached(told) == set()

    async def test_a_rooms_messages_are_decided_in_order(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        _stop_waking(room)
        first = await room.say("bob", "can someone check the deploy?", at=10)
        second = await room.say("alice", "and the release notes?", at=20)

        await room.process.router.decide_pending(TENANT_ZERO_ID)

        assert [r["message"]["text"] for r in service.requests] == [
            "can someone check the deploy?",
            "and the release notes?",
        ]
        assert first != second


class TestTheRoomIsTold:
    async def test_the_first_failure_tells_the_room(
        self, room: Journey, service: DecisionService
    ) -> None:
        service.status = 502

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert room.room_notices == [DECISION_NOTICE]
        assert await room.reached(told) == set()

    async def test_a_second_failure_within_the_hour_does_not(
        self, room: Journey, service: DecisionService
    ) -> None:
        service.error = httpx.ConnectError("connection refused")

        await room.say("bob", "can someone check the deploy?", at=10)
        await room.say("alice", "is anyone looking at the gateway?", at=600)

        assert room.room_notices == [DECISION_NOTICE]
        assert len(service.requests) == 2

    async def test_a_failure_an_hour_later_tells_it_again(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        service.status = 500
        await room.say("bob", "can someone check the deploy?", at=10)
        async with world.session_factory() as session:
            await session.execute(
                update(Room)
                .where(Room.id == world.room_id)
                .values(
                    metadata_=Room.metadata_.op("||")(
                        func.jsonb_build_object(
                            DECISION_NOTICE_AT_KEY,
                            cast(func.now() - timedelta(minutes=61), Text),
                        )
                    )
                )
            )
            await session.commit()

        await room.say("alice", "is anyone looking at the gateway?", at=20)

        assert room.room_notices == [DECISION_NOTICE, DECISION_NOTICE]

    async def test_a_decision_of_nobody_does_not(
        self, room: Journey, service: DecisionService
    ) -> None:
        service.pick = None

        await room.say("bob", "what's the weather in London tomorrow?", at=10)

        assert room.room_notices == []
        assert len(service.requests) == 1


class TestTheTriageAgent:
    """Naming the triage agent takes the room's owner or a workspace admin;
    alice is claimed by the room's owner here."""

    @pytest.fixture(autouse=True)
    async def _alice_owns_the_room(self, world: World) -> None:
        async with world.session_factory() as session:
            await session.execute(
                update(Room)
                .where(Room.id == world.room_id)
                .values(owner_id=world.owner_id)
            )
            await session.commit()

    async def test_bob_who_does_not_may_not_name_it(
        self, world: World, room: Journey
    ) -> None:
        reply = await room.command("bob", "auto-route", "fallback @reviewer", at=5)

        assert reply.startswith(
            "Only the room's owner, a room admin or a workspace admin"
        )
        async with world.session_factory() as session:
            assert await RoomStore().auto_route_fallback(session, world.room_id) is None

    async def test_it_gets_the_message_while_the_service_fails(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        reply = await room.command("alice", "auto-route", "fallback @reviewer", at=5)
        assert "is now this room's triage agent" in reply
        service.status = 502

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert await room.reached(told) == {"reviewer"}
        event = AgentEvent.model_validate(
            (await _own_event(world, "reviewer", told)).payload
        )
        assert isinstance(event.payload, MessagePayload)
        assert event.payload.routed
        assert event.payload.routed_reason == "fallback"
        assert event.payload.addressed
        assert room.room_notices == [DECISION_NOTICE]

    async def test_not_for_a_decision_of_nobody(
        self, room: Journey, service: DecisionService
    ) -> None:
        await room.command("alice", "auto-route", "fallback @reviewer", at=5)
        service.pick = None

        told = await room.say("bob", "thanks, that sorted it for today then", at=10)

        assert await room.reached(told) == set()
        assert len(service.requests) == 1

    async def test_not_when_its_policy_refuses_the_sender(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        await room.command("alice", "auto-route", "fallback @reviewer", at=5)
        await _owner_only(world, "reviewer")
        service.error = httpx.ReadTimeout("timed out")

        with caplog.at_level(logging.INFO):
            told = await room.say("bob", "can someone check the deploy?", at=10)

        assert await room.reached(told) == set()
        [record] = decision_records(caplog)
        assert record["outcome"] == "dropped_not_allowed"
        assert record["choice"] == "reviewer"
        assert record["failure"] == "timeout"

    async def test_it_cannot_be_the_assigned_agent(self, room: Journey) -> None:
        await room.command("alice", "assign-agent", "@reviewer", at=5)

        reply = await room.command("alice", "auto-route", "fallback @reviewer", at=6)

        assert "assigned agent" in reply
        assert "Nothing was changed" in reply

    async def test_off_clears_it(self, room: Journey, service: DecisionService) -> None:
        await room.command("alice", "auto-route", "fallback @reviewer", at=5)
        reply = await room.command("alice", "auto-route", "fallback off", at=6)
        assert "no longer has a triage agent" in reply
        service.status = 502

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert await room.reached(told) == set()


class TestAWorkspaceWithNoBackend:
    async def test_none_keeps_todays_behaviour_and_asks_nobody(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        async with world.session_factory() as session:
            await DecisionSettingsStore().save(
                session,
                TENANT_ZERO_ID,
                backend="none",
                endpoint=None,
                api_key_encrypted=None,
                threshold=None,
            )
            await session.commit()
        answer = await room.post("helper", "It starts the stack", at=6)

        told = await room.say("bob", "can someone check why the deploy failed?", at=10)
        in_thread = await room.say("alice", "why?", at=20, thread=answer)
        reply = await room.command("alice", "auto-route", "", at=30)

        assert service.requests == []
        assert await _pending(world) == []
        assert await room.reached(told) == set()
        assert await room.reached(in_thread) == {"helper"}
        assert room.room_notices == []
        assert "turned auto-route off" in reply

    async def test_a_workspace_endpoint_is_asked_instead_of_the_default(
        self, world: World, room: Journey, service: DecisionService
    ) -> None:
        own = DecisionService()
        own.pick = "reviewer"
        room.decisions._guarded_client = httpx.AsyncClient(  # type: ignore[union-attr]
            transport=httpx.MockTransport(own.handle)
        )
        room.process.router._decisions = room.decisions
        async with world.session_factory() as session:
            await DecisionSettingsStore().save(
                session,
                TENANT_ZERO_ID,
                backend="endpoint",
                endpoint="http://10.9.0.5/decide",
                api_key_encrypted=TEST_KEYRING.encrypt("own-token"),
                threshold=0.7,
            )
            await session.commit()

        told = await room.say("bob", "can someone check the deploy?", at=10)

        assert service.requests == []
        [request] = own.requests
        assert request["confidence_threshold"] == 0.7
        assert own.headers[-1]["authorization"] == "Bearer own-token"
        assert await room.reached(told) == {"reviewer"}

    async def test_a_workspace_endpoint_the_policy_refuses_is_a_failure(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        service.pick = "helper"
        async with world.session_factory() as session:
            await DecisionSettingsStore().save(
                session,
                TENANT_ZERO_ID,
                backend="endpoint",
                endpoint="http://10.0.0.5:8230",
                api_key_encrypted=None,
                threshold=None,
            )
            await session.commit()

        with caplog.at_level(logging.WARNING):
            told = await room.say("bob", "can someone check the deploy?", at=10)

        assert service.requests == []
        assert await room.reached(told) == set()
        assert room.room_notices == [DECISION_NOTICE]
        assert "refused by Switch's outbound policy" in caplog.text


def test_a_claim_lasts_the_decision_timeout_plus_a_margin():
    """After a crash a claimed message waits out the lease, so the lease must
    stay well inside the default two-minute age limit."""
    from switch_core.delivery.router import decision_lease_seconds

    assert decision_lease_seconds(5) == 15
    assert decision_lease_seconds(30) == 40


class TestTheDecisionRecord:
    """Every undecided message ends in exactly one decision record and one
    `switch.decision.settled` count, whichever way it ended."""

    async def _settles_once(
        self,
        caplog: pytest.LogCaptureFixture,
        registry: Any,
        outcome: str,
    ) -> dict[str, Any]:
        readings = Readings(registry)
        [record] = decision_records(caplog)
        assert record["outcome"] == outcome
        assert readings.total(DECISION_SETTLED.name) == 1
        assert readings.total(DECISION_SETTLED.name, outcome=outcome) == 1
        assert readings.count(DECISION_WAIT.name, outcome=outcome) == 1
        assert isinstance(record["wait_ms"], int) and record["wait_ms"] >= 0
        return record

    async def test_delivered(
        self, room: Journey, service: DecisionService, caplog: pytest.LogCaptureFixture
    ) -> None:
        service.pick = "helper"

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            told = await room.say("bob", "can someone check the deploy?", at=10)
            record = await self._settles_once(caplog, registry, "delivered")

        assert record["message_key"] == told
        assert record["choice"] == "helper"
        assert record["model"] == "stub"
        assert record["model_ms"] == 5
        assert record["reason"] is None

    async def test_nobody_chosen(
        self, room: Journey, service: DecisionService, caplog: pytest.LogCaptureFixture
    ) -> None:
        service.pick = None

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.say("bob", "what's the weather in London tomorrow?", at=10)
            record = await self._settles_once(caplog, registry, "nobody_chosen")

        assert record["choice"] is None
        assert record["model_choice"] == "none"

    async def test_nobody_because_the_service_failed(
        self, room: Journey, service: DecisionService, caplog: pytest.LogCaptureFixture
    ) -> None:
        service.status = 502

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.say("bob", "can someone check the deploy?", at=10)
            record = await self._settles_once(caplog, registry, "nobody_failed")

        assert record["failure"] == "error_status"
        assert "no triage agent" in record["reason"]

    async def test_one_notice_is_counted_for_two_failures_in_an_hour(
        self, room: Journey, service: DecisionService
    ) -> None:
        service.status = 502

        with recording_metrics() as registry:
            await room.say("bob", "can someone check the deploy?", at=10)
            await room.say("alice", "is anyone looking at the gateway?", at=600)
            readings = Readings(registry)

        assert room.room_notices == [DECISION_NOTICE]
        assert readings.total(DECISION_NOTICES.name) == 1
        assert readings.total(DECISION_SETTLED.name, outcome="nobody_failed") == 2

    async def test_sent_to_the_triage_agent(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        async with world.session_factory() as session:
            await session.execute(
                update(Room)
                .where(Room.id == world.room_id)
                .values(owner_id=world.owner_id)
            )
            await session.commit()
        await room.command("alice", "auto-route", "fallback @reviewer", at=5)
        service.error = httpx.ConnectError("connection refused")

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.say("bob", "can someone check the deploy?", at=10)
            record = await self._settles_once(caplog, registry, "triage")

        assert record["choice"] == "reviewer"
        assert record["failure"] == "unreachable"

    async def test_dropped_when_the_agent_left(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        service.pick = "helper"
        helper = room.clients["helper"]

        async def remove() -> None:
            async with world.session_factory() as session:
                await session.execute(
                    delete(ClientRoom).where(
                        ClientRoom.client_id == helper.id,
                        ClientRoom.room_id == world.room_id,
                    )
                )
                await session.commit()

        service.during = remove

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.say("bob", "can someone check the deploy?", at=10)
            await self._settles_once(caplog, registry, "dropped_not_member")

    async def test_dropped_when_the_agent_no_longer_admits_the_sender(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        service.pick = "helper"

        async def tighten() -> None:
            await _owner_only(world, "helper")

        service.during = tighten

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.say("bob", "can someone check the deploy?", at=10)
            record = await self._settles_once(caplog, registry, "dropped_not_allowed")

        assert record["choice"] == "helper"

    async def test_expired(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        _stop_waking(room)
        told = await room.say("bob", "can someone check the deploy?", at=10)
        async with world.session_factory() as session:
            await session.execute(
                update(PendingDecision).values(
                    created_at=func.now() - timedelta(minutes=10)
                )
            )
            await session.commit()

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.process.router.decide_pending(TENANT_ZERO_ID)
            record = await self._settles_once(caplog, registry, "expired")

        [line] = [
            r
            for r in caplog.records
            if isinstance(getattr(r, STRUCTURED_FIELDS, None), dict)
        ]
        assert line.levelno == logging.WARNING
        assert record["message_key"] == told
        assert record["decision_id"] is None
        assert record["wait_ms"] >= 600_000

    async def test_an_expired_record_names_the_workspace(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        _stop_waking(room)
        await room.say("bob", "can someone check the deploy?", at=10)
        async with world.session_factory() as session:
            await session.execute(
                update(PendingDecision).values(
                    created_at=func.now() - timedelta(minutes=10)
                )
            )
            await session.commit()
        caplog.handler.addFilter(LogContextFilter("placeholder-tenant"))

        with caplog.at_level(logging.INFO):
            await room.process.router.decide_pending(TENANT_ZERO_ID)

        [line] = [
            r
            for r in caplog.records
            if isinstance(getattr(r, STRUCTURED_FIELDS, None), dict)
        ]
        rendered = json.loads(
            JsonFormatter(
                service="switch-core", environment=None, version=None, process_id="p"
            ).format(line)
        )
        assert rendered["tenant_id"] == TENANT_ZERO_ID
        assert rendered["room_id"] == world.room_id

    async def test_the_wait_is_measured_on_the_databases_clock(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        _stop_waking(room)
        service.pick = "helper"
        await room.say("bob", "can someone check the deploy?", at=10)
        async with world.session_factory() as session:
            await session.execute(
                update(PendingDecision).values(
                    created_at=func.now() - timedelta(seconds=30)
                )
            )
            await session.commit()

        with caplog.at_level(logging.INFO):
            await room.process.router.decide_pending(TENANT_ZERO_ID)

        [record] = decision_records(caplog)
        assert record["outcome"] == "delivered"
        assert 30_000 <= record["wait_ms"] < 40_000

    async def test_settled_elsewhere(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        service.pick = "helper"

        async def settled_elsewhere() -> None:
            async with world.session_factory() as session:
                await session.execute(delete(PendingDecision))
                await session.commit()

        service.during = settled_elsewhere

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.say("bob", "can someone check the deploy?", at=10)
            await self._settles_once(caplog, registry, "settled_elsewhere")

    async def test_unavailable_when_auto_route_was_turned_off(
        self,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        _stop_waking(room)
        await room.say("bob", "can someone check the deploy?", at=10)
        await room.command("alice", "auto-route", "off", at=20)

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            await room.process.router.decide_pending(TENANT_ZERO_ID)
            record = await self._settles_once(caplog, registry, "unavailable")

        assert record["reason"] == "auto-route was turned off"
        assert service.requests == []

    async def test_every_line_of_a_decision_carries_the_room_tenant_and_decision(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        service.status = 502
        caplog.handler.addFilter(LogContextFilter("placeholder-tenant"))

        with caplog.at_level(logging.INFO):
            await room.say("bob", "can someone check the deploy?", at=10)

        formatter = JsonFormatter(
            service="switch-core", environment=None, version=None, process_id="p-1"
        )
        [record] = decision_records(caplog)
        [warning] = [r for r in caplog.records if "gave no answer" in r.getMessage()]
        for line in (
            warning,
            *[r for r in caplog.records if "Decision routing:" in r.getMessage()],
        ):
            rendered = json.loads(formatter.format(line))
            assert rendered["room_id"] == world.room_id
            assert rendered["tenant_id"] == TENANT_ZERO_ID
            assert rendered["decision_id"] == record["decision_id"]
        assert service.headers[-1]["x-request-id"] == record["decision_id"]
        [decision_line] = [
            r
            for r in caplog.records
            if isinstance(getattr(r, STRUCTURED_FIELDS, None), dict)
        ]
        assert json.loads(formatter.format(decision_line))["decision"] == record


class TestNoContentIsRecorded:
    async def test_message_text_instructions_and_keys_reach_no_log_or_metric(
        self,
        world: World,
        room: Journey,
        service: DecisionService,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        sentinel = "zebra-quartz-sentinel"
        own = DecisionService()
        room.decisions._guarded_client = httpx.AsyncClient(  # type: ignore[union-attr]
            transport=httpx.MockTransport(own.handle)
        )
        room.process.router._decisions = room.decisions
        async with world.session_factory() as session:
            await session.execute(
                update(Room)
                .where(Room.id == world.room_id)
                .values(instructions=f"Always mention {sentinel} first.")
            )
            await DecisionSettingsStore().save(
                session,
                TENANT_ZERO_ID,
                backend="endpoint",
                endpoint="http://10.9.0.5/decide",
                api_key_encrypted=TEST_KEYRING.encrypt(f"key-{sentinel}"),
                threshold=None,
            )
            await session.commit()
        caplog.handler.addFilter(LogContextFilter("placeholder-tenant"))
        formatter = JsonFormatter(
            service="switch-core", environment=None, version=None, process_id="p-1"
        )

        with caplog.at_level(logging.INFO), recording_metrics() as registry:
            own.pick = "helper"
            await room.say("bob", f"is {sentinel} deployed?", at=10)
            own.pick = None
            await room.say("bob", f"and {sentinel} on staging?", at=20)
            own.status = 502
            await room.say("bob", f"what about {sentinel} in prod?", at=30)
            readings = Readings(registry)

        assert len(own.requests) == 3
        assert sentinel in own.requests[0]["message"]["text"]
        assert len(decision_records(caplog)) == 3
        for line in caplog.records:
            assert sentinel not in formatter.format(line), line.name
        assert not any(sentinel in value for value in readings.attribute_values())
