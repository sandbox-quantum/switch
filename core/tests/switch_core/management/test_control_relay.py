"""Console relays to an agent's controller, end to end.

Against Postgres, through the real gateway and management routes: the Console
asks at `/gateway/management/agents/{id}/control`, the request reaches the
controller's own stream as `agent.control`, and the controller answers at
`/v1/management/controllers/{id}/control/{relay_id}`. Streams are read from
the routes' own generators, since the in-process transport collects a
response whole.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.control_relay import (
    CONTROL_CANCEL_FRAME,
    CONTROL_FRAME,
    CONTROL_QUEUE_FRAMES,
    ConsoleView,
    ControlRelays,
    RelayError,
)
from switch_core.db.models import TENANT_ZERO_ID, AgentController, HostedMachine
from switch_core.gateway.controller_relay import control_events
from tests.switch_core.hosted_machine_helpers import seed_machine
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
    fixture,
    open_connection,
    open_stream,
    place_agent,
    take,
)
from tests.switch_core.management.test_contract_fixtures import assert_same_shape

SESSION_ID = "8d0c7a52-3b8f-4c1e-9d25-6f0a1b2c3d4e"


def recorded(event: str) -> dict[str, Any]:
    """The frame as recorded for the controller's contract tests."""
    return next(
        entry for entry in fixture("stream_frames.json") if entry["event"] == event
    )


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def relays_of(harness: Harness) -> ControlRelays:
    return harness.management.control_relays


async def ask(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    agent_id: str,
    message: dict[str, Any],
    timeout_ms: int = 5000,
) -> httpx.Response:
    return await client.post(
        f"/gateway/management/agents/{agent_id}/control",
        json={"message": message, "timeout_ms": timeout_ms},
        cookies=cookies_for(controller.owner),
    )


async def reply(
    client: httpx.AsyncClient,
    controller: EnrolledController,
    relay_id: str,
    body: dict[str, Any],
) -> httpx.Response:
    return await client.post(
        f"/v1/management/controllers/{controller.controller_id}/control/{relay_id}",
        json=body,
        headers=controller.headers,
    )


async def live_agent(
    harness: Harness, client: httpx.AsyncClient, name: str = "laptop"
) -> tuple[EnrolledController, str, AsyncIterator[bytes]]:
    """A controller with one running agent and its stream open, past the
    stream's opening frames."""
    owner = await add_member(harness.session_factory, f"owner-{name}")
    controller = await enroll_console(harness, client, owner, name=name)
    agent_id = await place_agent(client, controller, name=f"agent-{name}")
    opened = await open_connection(client, controller)
    stream = await open_stream(harness, controller, opened)
    await take(stream, 2)
    return controller, agent_id, stream


class TestAccess:
    async def test_another_users_agent_is_not_found(self, harness: Harness) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            stranger = await add_member(harness.session_factory, "mallory")
            asked = await client.post(
                f"/gateway/management/agents/{agent_id}/control",
                json={"message": {"list": True}, "timeout_ms": 1000},
                cookies=cookies_for(stranger),
            )
            watched = await client.get(
                f"/gateway/management/agents/{agent_id}/control/stream",
                cookies=cookies_for(stranger),
            )
        await stream.aclose()

        assert asked.status_code == 404
        assert watched.status_code == 404
        assert relays_of(harness).pending_control_relays(controller.controller_id) == 0

    async def test_a_message_off_the_allow_list_is_refused_unsent(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            refused = await ask(client, controller, agent_id, {"room": {}})
            unknown = await ask(client, controller, agent_id, {"shell": "ls"})
        await stream.aclose()

        assert refused.status_code == 400
        assert refused.json()["error"]["code"] == "refused_message"
        assert unknown.status_code == 400
        assert relays_of(harness).pending_control_relays(controller.controller_id) == 0

    async def test_a_session_start_is_relayed_to_the_controller(
        self, harness: Harness
    ) -> None:
        start = {
            "ensure": {
                "config": {},
                "resuming": False,
                "restart": True,
                "startSource": None,
            }
        }
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            asking = asyncio.create_task(ask(client, controller, agent_id, start))
            ((_, frame),) = await take(stream, 1)
            await reply(client, controller, frame["relay_id"], {"ok": True})
            response = await asking
        await stream.aclose()

        assert frame["message"] == start
        assert response.json()["ok"] is True

    async def test_an_oversized_request_is_refused(self, harness: Harness) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            response = await client.post(
                f"/gateway/management/agents/{agent_id}/control",
                content=b'{"message": {"list": "' + b"x" * (2 * 1024 * 1024) + b'"}}',
                headers={"Content-Type": "application/json"},
                cookies=cookies_for(controller.owner),
            )
        await stream.aclose()

        assert response.status_code == 413
        assert response.json()["error"]["code"] == "too_large"


class TestReplies:
    async def test_the_controller_answer_is_the_console_answer(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            asking = asyncio.create_task(
                ask(client, controller, agent_id, {"list": True})
            )
            ((event, frame),) = await take(stream, 1)
            assert (
                relays_of(harness).pending_control_relays(controller.controller_id) == 1
            )
            answered = await reply(
                client, controller, frame["relay_id"], {"ok": True, "result": [1, 2]}
            )
            response = await asking
            again = await reply(
                client, controller, frame["relay_id"], {"ok": True, "result": []}
            )
        await stream.aclose()

        assert_same_shape({"event": event, "data": frame}, recorded(CONTROL_FRAME))
        assert frame["agent_id"] == agent_id
        assert frame["message"] == {"list": True}
        assert isinstance(frame["deadline_ms"], int)
        assert answered.status_code == 200, answered.text
        assert answered.json() == {"ok": True}
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["ok"] is True
        assert body["value"] == [1, 2]
        assert body["worker"]["launch_revision"] is None
        assert body["worker"]["boot_id"] is None
        assert isinstance(body["worker"]["generation"], int)
        assert again.status_code == 409
        assert again.json()["error"]["code"] == "relay_resolved"
        assert relays_of(harness).pending_control_relays(controller.controller_id) == 0

    async def test_a_failed_answer_reaches_the_console_as_its_error(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            asking = asyncio.create_task(
                ask(client, controller, agent_id, {"command": {"text": "hi"}})
            )
            ((_, frame),) = await take(stream, 1)
            await reply(
                client,
                controller,
                frame["relay_id"],
                {"ok": False, "error": {"code": "no_session", "message": "Gone."}},
            )
            response = await asking
        await stream.aclose()

        assert response.status_code == 200
        assert response.json()["ok"] is False
        assert response.json()["error"] == {"code": "no_session", "message": "Gone."}

    async def test_another_controller_cannot_answer(self, harness: Harness) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            other = await enroll_console(
                harness, client, controller.owner, name="desktop"
            )
            asking = asyncio.create_task(
                ask(client, controller, agent_id, {"list": True}, timeout_ms=2000)
            )
            ((_, frame),) = await take(stream, 1)
            own_path = await reply(
                client, other, frame["relay_id"], {"ok": True, "result": "forged"}
            )
            borrowed_path = await client.post(
                f"/v1/management/controllers/{controller.controller_id}"
                f"/control/{frame['relay_id']}",
                json={"ok": True, "result": "forged"},
                headers=other.headers,
            )
            await reply(client, controller, frame["relay_id"], {"ok": True})
            response = await asking
        await stream.aclose()

        assert own_path.status_code == 403
        assert borrowed_path.status_code == 403
        assert response.json()["ok"] is True
        assert response.json()["value"] is None

    async def test_an_unknown_relay_is_not_found(self, harness: Harness) -> None:
        async with harness.client() as client:
            controller, _, stream = await live_agent(harness, client)
            response = await reply(client, controller, "no-such-relay", {"ok": True})
        await stream.aclose()

        assert response.status_code == 404

    async def test_a_malformed_answer_is_refused(self, harness: Harness) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            asking = asyncio.create_task(
                ask(client, controller, agent_id, {"list": True}, timeout_ms=2000)
            )
            ((_, frame),) = await take(stream, 1)
            failed_without_error = await reply(
                client, controller, frame["relay_id"], {"ok": False}
            )
            await reply(client, controller, frame["relay_id"], {"ok": True})
            await asking
        await stream.aclose()

        assert failed_without_error.status_code == 422
        assert failed_without_error.json()["error"]["code"] == "validation_error"


class TestDeadlines:
    async def test_an_unanswered_relay_times_out_and_is_cancelled(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            asking = asyncio.create_task(
                ask(client, controller, agent_id, {"list": True}, timeout_ms=200)
            )
            ((_, frame),) = await take(stream, 1)
            response = await asking
            ((cancel_event, cancel),) = await take(stream, 1)
            late = await reply(client, controller, frame["relay_id"], {"ok": True})
        await stream.aclose()

        assert response.status_code == 504
        assert response.json()["ok"] is False
        assert response.json()["error"]["code"] == "relay_timeout"
        assert (cancel_event, cancel) == (
            CONTROL_CANCEL_FRAME,
            {"relay_id": frame["relay_id"]},
        )
        assert_same_shape(
            {"event": cancel_event, "data": cancel}, recorded(CONTROL_CANCEL_FRAME)
        )
        assert late.status_code == 409
        assert relays_of(harness).pending_control_relays(controller.controller_id) == 0


class TestOffline:
    async def test_no_connection_is_controller_offline(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            response = await ask(client, controller, agent_id, {"list": True})

        assert response.status_code == 503
        assert response.json()["error"]["code"] == "controller_offline"
        assert response.json()["worker"]["generation"] is None
        assert relays_of(harness).pending_control_relays(controller.controller_id) == 0

    async def _asleep(
        self, harness: Harness, client: httpx.AsyncClient, stop_reason: str
    ) -> tuple[EnrolledController, str, str]:
        """A placed agent whose controller is ec2, on a machine stopped for
        `stop_reason`."""
        owner = await add_member(harness.session_factory, "ada")
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="reviewer")
        async with harness.session_factory() as session:
            await session.execute(
                update(AgentController)
                .where(AgentController.id == controller.controller_id)
                .values(kind="ec2")
            )
            machine = await seed_machine(
                session,
                owner_id=owner.id,
                slot_id="slot-a",
                state="stopped",
                desired_state="stopped",
                stop_reason=stop_reason,
                revision=4,
                generation=1,
            )
            machine.runtime = "controller"
            machine.controller_id = controller.controller_id
            await session.commit()
            return controller, agent_id, machine.id

    async def test_a_sleeping_cloud_machine_is_woken_and_machine_asleep(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            controller, agent_id, machine_id = await self._asleep(
                harness, client, "idle"
            )
            response = await ask(client, controller, agent_id, {"list": True})

        assert response.status_code == 503
        assert response.json()["error"]["code"] == "machine_asleep"
        assert response.json()["retryable"] is True
        async with harness.session_factory() as session:
            machine = await session.get(HostedMachine, (TENANT_ZERO_ID, machine_id))
        assert machine is not None
        assert (machine.desired_state, machine.stop_reason, machine.revision) == (
            "running",
            None,
            5,
        )

    async def test_a_machine_its_owner_stopped_is_not_woken(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            controller, agent_id, machine_id = await self._asleep(
                harness, client, "owner"
            )
            response = await ask(client, controller, agent_id, {"list": True})

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "machine_stopped"
        async with harness.session_factory() as session:
            machine = await session.get(HostedMachine, (TENANT_ZERO_ID, machine_id))
        assert machine is not None
        assert (machine.desired_state, machine.revision) == ("stopped", 4)

    async def test_an_unplaced_agent_has_no_controller(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            created = await client.post(
                "/gateway/management/agents",
                json={
                    "name": "floating",
                    "description": "floating description",
                    "controller_id": None,
                    "desired_state": "running",
                    "definition": {
                        "provider": "claude",
                        "model": None,
                        "instructions": "",
                        "auto_approve": False,
                        "directory": None,
                        "isolation": "shared",
                    },
                },
                cookies=cookies_for(owner),
            )
            assert created.status_code == 201, created.text
            response = await ask(
                client, controller, created.json()["agent_id"], {"list": True}
            )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "agent_unplaced"


class TestPushes:
    async def test_pushes_reach_the_console_view_in_sequence(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            view = ConsoleView(frozenset({SESSION_ID}))
            events = control_events(
                harness.protocol.connections.controllers,
                relays_of(harness),
                TENANT_ZERO_ID,
                agent_id,
                view,
                30.0,
            )
            ((worker_event, worker),) = await take(events, 1)
            current = relays_of(harness).generation(controller.controller_id)
            arriving = asyncio.create_task(take(events, 4))
            ((_, subscribe),) = await take(stream, 1)
            await reply(client, controller, subscribe["relay_id"], {"ok": True})
            pushed = await client.post(
                f"/v1/management/controllers/{controller.controller_id}/control/push",
                json={
                    "agent_id": agent_id,
                    "subscription": SESSION_ID,
                    "events": [
                        {"seq": 1, "event": {"type": "text", "text": "hello"}},
                        {"seq": 2, "failure": None},
                        {"seq": 2, "event": {"type": "text", "text": "again"}},
                        {"seq": 4, "event": {"type": "text", "text": "after"}},
                    ],
                },
                headers=controller.headers,
            )
            frames = await arriving
            await events.aclose()  # type: ignore[attr-defined]
            ((_, unsubscribe),) = await take(stream, 1)
            stale = await client.post(
                f"/v1/management/controllers/{controller.controller_id}/control/push",
                json={
                    "agent_id": agent_id,
                    "subscription": SESSION_ID,
                    "events": [{"seq": 5, "event": {"type": "text", "text": "late"}}],
                },
                headers=controller.headers,
            )
        await stream.aclose()

        assert worker_event == "worker"
        assert current is not None
        assert worker["generation"] == current
        assert subscribe["message"] == {"subscribe": SESSION_ID}
        assert pushed.status_code == 200, pushed.text
        assert pushed.json() == {"unsubscribe": False}
        assert frames == [
            (
                "event",
                {"sessionId": SESSION_ID, "event": {"type": "text", "text": "hello"}},
            ),
            ("failure", {"sessionId": SESSION_ID, "failure": None}),
            ("resync", {"sessionId": SESSION_ID, "reason": "gap"}),
            (
                "event",
                {"sessionId": SESSION_ID, "event": {"type": "text", "text": "after"}},
            ),
        ]
        assert unsubscribe["message"] == {"unsubscribe": SESSION_ID}
        assert stale.json() == {"unsubscribe": True}

    async def test_a_push_for_an_agent_it_does_not_run_is_forbidden(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            _, agent_id, stream = await live_agent(harness, client, name="laptop")
            other, _, other_stream = await live_agent(harness, client, name="desktop")
            response = await client.post(
                f"/v1/management/controllers/{other.controller_id}/control/push",
                json={"agent_id": agent_id, "subscription": "health", "events": []},
                headers=other.headers,
            )
        await stream.aclose()
        await other_stream.aclose()

        assert response.status_code == 403

    async def test_a_push_must_carry_exactly_one_kind(self, harness: Harness) -> None:
        async with harness.client() as client:
            controller, agent_id, stream = await live_agent(harness, client)
            response = await client.post(
                f"/v1/management/controllers/{controller.controller_id}/control/push",
                json={
                    "agent_id": agent_id,
                    "subscription": "health",
                    "events": [{"seq": 1, "event": {}, "health": {}}],
                },
                headers=controller.headers,
            )
        await stream.aclose()

        assert response.status_code == 422


class TestControlRelays:
    async def test_frames_go_only_to_the_newest_stream(self) -> None:
        relays = ControlRelays()
        old = relays.open_outlet("c1", asyncio.Event())
        new_wake = asyncio.Event()
        new = relays.open_outlet("c1", new_wake)
        relay = relays.dispatch(
            tenant_id=TENANT_ZERO_ID,
            controller_id="c1",
            agent_id="a1",
            message={"list": True},
            timeout_ms=1000,
        )

        assert relay.generation == new.generation
        assert new_wake.is_set()
        assert relays.take_frames(old) == []
        ((event, frame),) = relays.take_frames(new)
        assert_same_shape({"event": event, "data": frame}, recorded(CONTROL_FRAME))
        assert frame["relay_id"] == relay.id
        assert relays.pending_control_relays("c1") == 1
        assert relays.pending_control_relays("c2") == 0
        relays.resolve(relay, {"ok": True, "value": None})
        assert relays.pending_control_relays("c1") == 0

    async def test_an_unsent_relay_that_expires_is_dropped_not_cancelled(
        self,
    ) -> None:
        relays = ControlRelays()
        relay = relays.dispatch(
            tenant_id=TENANT_ZERO_ID,
            controller_id="c1",
            agent_id="a1",
            message={"list": True},
            timeout_ms=20,
        )
        with pytest.raises(RelayError) as raised:
            await relay.future
        outlet = relays.open_outlet("c1", asyncio.Event())

        assert raised.value.code == "relay_timeout"
        assert relays.take_frames(outlet) == []
        assert relays.pending_control_relays("c1") == 0

    async def test_a_full_queue_is_controller_busy(self) -> None:
        relays = ControlRelays()
        for _ in range(CONTROL_QUEUE_FRAMES):
            relays.dispatch(
                tenant_id=TENANT_ZERO_ID,
                controller_id="c1",
                agent_id="a1",
                message={"list": True},
                timeout_ms=1000,
            )
        with pytest.raises(RelayError) as raised:
            relays.dispatch(
                tenant_id=TENANT_ZERO_ID,
                controller_id="c1",
                agent_id="a1",
                message={"list": True},
                timeout_ms=1000,
            )

        assert raised.value.code == "controller_busy"
        assert raised.value.status == 503
