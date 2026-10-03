"""A cloud agent's worker attached through its machine's controller.

The worker opens its stream on the controller's relay; the relay asks Core
to admit it on the controller's connection. From then on the worker's
protocol-7 frames ride the controller stream as `agent.worker`, and its
up-calls come through the relay with the controller's token and
`X-Switch-Agent-Id`, fenced on the relay's connection id and incarnation.
Idle reports from such a worker are the evidence idle stop reads.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.hosted_workers import WorkerBinding
from switch_core.db.models import TENANT_ZERO_ID, HostedLaunch, HostedOperation
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.gateway.hosted_relay import dispatch_read_only
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    bearer,
    open_connection,
    open_stream,
    parse_frame,
)
from tests.switch_core.management.hosted_harness import (
    BOOT_ID,
    INSTANCE_ID,
    CloudAgent,
    CloudMachine,
    add_cloud_agent,
    add_cloud_machine,
    assignment,
    build_hosted_harness,
    enrolled_token,
    fixture_heartbeat,
    host_headers,
    launch_row,
)

LOCAL_CONNECTION = "00000000-0000-4000-8000-0000000000c9"
LOCAL_GENERATION = 41


@pytest.fixture
def harness(
    session_factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> Harness:
    return build_hosted_harness(session_factory, tmp_path)


class Placed:
    """A cloud agent on an enrolled machine controller with its stream open."""

    def __init__(
        self,
        machine: CloudMachine,
        agent: CloudAgent,
        controller: EnrolledController,
        opened: dict[str, Any],
        stream: AsyncIterator[bytes],
        capability: str,
    ) -> None:
        self.machine = machine
        self.agent = agent
        self.controller = controller
        self.opened = opened
        self.stream = stream
        self.capability = capability

    def worker_body(self, **overrides: Any) -> dict[str, Any]:
        worker = {
            "connection_id": LOCAL_CONNECTION,
            "generation": LOCAL_GENERATION,
            "spawn_capable": True,
            "protocol": 7,
            "protocol_accepts": 1,
            "capability": self.capability,
            "boot_id": BOOT_ID,
            "instance_id": INSTANCE_ID,
            "state_version": 1,
            **overrides,
        }
        return {
            "connection_id": self.opened["connection_id"],
            "generation": self.opened["generation"],
            "worker": worker,
        }

    @property
    def worker_path(self) -> str:
        return (
            f"/v1/controllers/{self.controller.controller_id}/agents/"
            f"{self.agent.agent_id}/worker"
        )

    def act_as(self) -> dict[str, str]:
        return {
            **self.controller.headers,
            "X-Switch-Agent-Id": self.agent.agent_id,
        }


async def place(harness: Harness, client: Any) -> Placed:
    machine = await add_cloud_machine(harness)
    agent = await add_cloud_agent(harness, machine)
    controller_id, token = await enrolled_token(client, machine)
    body = await assignment(client, controller_id, token)
    capability = body["agents"][0]["definition"]["hosted"]["worker_capability"]
    controller = EnrolledController(
        controller_id=controller_id,
        credential="",
        access_token=token,
        owner=machine.owner,
    )
    opened = await open_connection(client, controller, {agent.agent_id: "head"})
    stream = await open_stream(harness, controller, opened)
    return Placed(machine, agent, controller, opened, stream, capability)


async def frames_until(
    stream: AsyncIterator[bytes], event: str, timeout: float = 3.0
) -> dict[str, Any]:
    """Read the controller stream until a frame named `event`; its data."""

    async def pump() -> dict[str, Any]:
        while True:
            raw = await anext(stream)
            if raw.startswith(b":"):
                continue
            name, data = parse_frame(raw)
            if name == event:
                return data

    return await asyncio.wait_for(pump(), timeout=timeout)


async def attach(client: Any, placed: Placed, **overrides: Any) -> Any:
    return await client.post(
        placed.worker_path,
        json=placed.worker_body(**overrides),
        headers=placed.controller.headers,
    )


class TestAttach:
    async def test_the_relay_attaches_the_worker_on_the_controller_connection(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            attached = await attach(client, placed)
        assert attached.status_code == 200, attached.text
        payload = attached.json()["attached"]
        assert payload["launch_revision"] == 1
        assert payload["limits"] == {"sessions_per_agent": 8}
        assert set(payload) == {
            "launch_revision",
            "limits",
            "idle",
            "credential_revision",
            "queued_operations",
            "relay_fence",
            "cancelled",
        }
        worker = harness.protocol.connections.attached_worker(placed.agent.agent_id)
        assert worker is not None
        assert worker.id == LOCAL_CONNECTION
        assert worker.stream_generation == LOCAL_GENERATION
        assert worker.holder == (
            f"controller:{placed.controller.controller_id}:{placed.agent.agent_id}"
        )
        assert worker.worker == WorkerBinding(
            launch_id=placed.agent.launch_id,
            launch_revision=1,
            boot_id=BOOT_ID,
            instance_id=INSTANCE_ID,
        )

    async def test_the_worker_marks_its_launch_ready(self, harness: Harness) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            body = fixture_heartbeat()
            body["agents"] = [
                {
                    **body["agents"][0],
                    "launch_id": placed.agent.launch_id,
                    "agent_id": placed.agent.agent_id,
                    "revision": 1,
                    "process_state": "running",
                }
            ]
            beat = await client.post(
                f"/hosted/machines/{placed.machine.machine_id}/heartbeat",
                json=body,
                headers={**host_headers(), **bearer(placed.machine.capability)},
            )
        assert beat.status_code == 200, beat.text
        assert (await launch_row(harness, placed.agent.launch_id)).state == "ready"

    @pytest.mark.parametrize(
        ("overrides", "status", "code"),
        [
            (
                {"capability": "not-the-capability-0123456789"},
                403,
                "worker_capability_obsolete",
            ),
            ({"capability": None}, 403, "worker_capability_required"),
            ({"protocol": 6}, 426, "upgrade_required"),
            ({"state_version": 0}, 426, "upgrade_required"),
        ],
    )
    async def test_the_worker_admission_is_core_s_and_passed_back_as_it_came(
        self, harness: Harness, overrides: dict, status: int, code: str
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            refused = await attach(client, placed, **overrides)
        assert refused.status_code == status, refused.text
        assert refused.json()["detail"]["code"] == code
        assert harness.protocol.connections.worker_of(placed.agent.agent_id) is None

    async def test_a_worker_from_another_boot_is_refused_while_one_is_attached(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            refused = await attach(
                client,
                placed,
                connection_id=str(uuid4()),
                boot_id="00000000-0000-4000-8000-00000000b002",
            )
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "worker_already_attached"

    async def test_a_controller_connection_that_is_not_open_is_refused(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            body = placed.worker_body()
            body["generation"] += 1
            refused = await client.post(
                placed.worker_path, json=body, headers=placed.controller.headers
            )
        assert refused.status_code == 409
        assert refused.json()["error"]["code"] == "stale_generation"

    async def test_an_agent_on_another_controller_is_refused(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            other_machine = await add_cloud_machine(harness, slot_id="slot-b")
            other = await add_cloud_agent(harness, other_machine, name="other-helper")
            refused = await client.post(
                f"/v1/controllers/{placed.controller.controller_id}/agents/"
                f"{other.agent_id}/worker",
                json=placed.worker_body(),
                headers=placed.controller.headers,
            )
        assert refused.status_code == 403
        assert refused.json()["error"]["code"] == "not_assigned"

    async def test_detach_lets_the_worker_go_and_fails_its_relays(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            worker = harness.protocol.connections.attached_worker(placed.agent.agent_id)
            assert worker is not None
            relay = dispatch_read_only(
                harness.protocol, TENANT_ZERO_ID, worker, {"list": {}}, 30_000
            )
            detached = await client.post(
                f"{placed.worker_path}/detach",
                json={
                    "connection_id": placed.opened["connection_id"],
                    "generation": placed.opened["generation"],
                    "worker": {
                        "connection_id": LOCAL_CONNECTION,
                        "generation": LOCAL_GENERATION,
                    },
                },
                headers=placed.controller.headers,
            )
        assert detached.status_code == 204
        assert harness.protocol.connections.worker_of(placed.agent.agent_id) is None
        assert relay.future.done()
        assert relay.future.exception() is not None


class TestFramesRideTheControllerStream:
    async def test_a_doorbell_reaches_the_relay_as_agent_worker(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            assert harness.protocol.connections.ring_worker(
                placed.agent.agent_id, "operation", {"id": "op-1"}
            )
            data = await frames_until(placed.stream, "agent.worker")
        assert data == {
            "agent_id": placed.agent.agent_id,
            "connection_id": LOCAL_CONNECTION,
            "generation": LOCAL_GENERATION,
            "event": "operation",
            "data": {"id": "op-1"},
        }

    async def test_a_relay_is_dispatched_on_the_controller_stream(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            worker = harness.protocol.connections.attached_worker(placed.agent.agent_id)
            assert worker is not None
            relay = dispatch_read_only(
                harness.protocol, TENANT_ZERO_ID, worker, {"list": {}}, 30_000
            )
            data = await frames_until(placed.stream, "agent.worker")
            assert data["event"] == "relay"
            assert data["data"]["id"] == relay.id
            replied = await client.post(
                f"/agents/{placed.agent.agent_id}/connection/relay/{relay.id}",
                json={
                    "connection_id": LOCAL_CONNECTION,
                    "generation": LOCAL_GENERATION,
                    "ok": True,
                    "value": {"sessions": []},
                },
                headers=placed.act_as(),
            )
        assert replied.status_code == 200, replied.text
        assert relay.future.result() == {"ok": True, "value": {"sessions": []}}

    async def test_a_new_launch_revision_closes_the_worker(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            harness.protocol.connections.supersede(placed.agent.agent_id, 2)
            data = await frames_until(placed.stream, "agent.worker_closed")
        assert data["code"] == "launch_superseded"
        assert data["connection_id"] == LOCAL_CONNECTION
        assert harness.protocol.connections.worker_of(placed.agent.agent_id) is None


class TestUpCallsThroughTheRelay:
    async def test_an_idle_report_counts_as_idle_evidence(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            reported = await client.post(
                f"/agents/{placed.agent.agent_id}/connection/idle",
                json={
                    "connection_id": LOCAL_CONNECTION,
                    "generation": LOCAL_GENERATION,
                    "report_seq": 1,
                    "relays_through": 0,
                    "busy": False,
                    "reasons": [],
                    "sessions": {"total": 0, "live": 0, "parked": 0, "failed": 0},
                },
                headers=placed.act_as(),
            )
        assert reported.status_code == 200, reported.text
        async with harness.session_factory() as session:
            launch = await session.get(
                HostedLaunch, (TENANT_ZERO_ID, placed.agent.launch_id)
            )
            assert launch is not None
            evidence = await HostedLaunchStore().idle_evidence(
                session, launch, harness.protocol.connections
            )
        assert evidence.report is not None
        assert "no_fresh_report" not in evidence.reasons

    async def test_an_up_call_from_another_incarnation_is_refused(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            refused = await client.post(
                f"/agents/{placed.agent.agent_id}/connection/idle",
                json={
                    "connection_id": LOCAL_CONNECTION,
                    "generation": LOCAL_GENERATION + 1,
                    "report_seq": 1,
                    "relays_through": 0,
                    "busy": False,
                    "reasons": [],
                    "sessions": {"total": 0, "live": 0, "parked": 0, "failed": 0},
                },
                headers=placed.act_as(),
            )
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "generation_changed"

    async def test_the_connection_surface_is_still_the_relay_s_own(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            refused = await client.post(
                f"/agents/{placed.agent.agent_id}/connection/beat",
                json={"connection_id": LOCAL_CONNECTION, "cursor": 0},
                headers=placed.act_as(),
            )
        assert refused.status_code == 409
        assert refused.json()["error"]["code"] == "managed_by_controller"

    async def test_the_provider_credential_is_fetched_as_the_agent(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            fetched = await client.post(
                "/hosted/provider-credential", headers=placed.act_as()
            )
            nameless = await client.post(
                "/hosted/provider-credential", headers=placed.controller.headers
            )
        assert fetched.status_code == 200, fetched.text
        assert fetched.json()["status"] == "connected"
        assert fetched.json()["credential"] == "SYNTHETIC-CLAUDE"
        assert nameless.status_code == 400
        assert nameless.json()["error"]["code"] == "validation_error"

    async def test_a_controller_cannot_fetch_another_machine_s_credential(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            other_machine = await add_cloud_machine(harness, slot_id="slot-b")
            other = await add_cloud_agent(harness, other_machine, name="other-helper")
            refused = await client.post(
                "/hosted/provider-credential",
                headers={
                    **placed.controller.headers,
                    "X-Switch-Agent-Id": other.agent_id,
                },
            )
        assert refused.status_code == 403
        assert refused.json()["error"]["code"] == "not_assigned"

    async def test_an_operation_is_claimed_under_the_controller_holder(
        self, harness: Harness
    ) -> None:
        async with harness.client() as client:
            placed = await place(harness, client)
            await attach(client, placed)
            operation_id = str(uuid4())
            async with harness.session_factory() as session:
                session.add(
                    HostedOperation(
                        id=operation_id,
                        launch_id=placed.agent.launch_id,
                        launch_revision=1,
                        session_id=str(uuid4()),
                        action="start",
                    )
                )
                await session.commit()
            claimed = await client.post(
                f"/hosted/operations/{operation_id}/claim",
                json={
                    "connection_id": LOCAL_CONNECTION,
                    "generation": LOCAL_GENERATION,
                },
                headers=placed.act_as(),
            )
        assert claimed.status_code == 200, claimed.text
        async with harness.session_factory() as session:
            operation = await session.get(
                HostedOperation, (TENANT_ZERO_ID, operation_id)
            )
            assert operation is not None
            assert operation.claimed_boot_id == BOOT_ID
            assert operation.claimed_by is not None
            assert (
                f":controller:{placed.controller.controller_id}:"
                f"{placed.agent.agent_id}:" in operation.claimed_by
            )
