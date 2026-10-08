"""The recorded wire messages are what the routes actually send and accept.

`core/tests/switch_core/fixtures/agent_controllers/` holds one JSON file per
message between a controller and Management. The controller's TypeScript
tests parse the same files with its own schemas, so these files are where
the two sides meet: a response that drifts from its fixture breaks this test,
and a request fixture the routes refuse breaks it too.

A response is compared by shape — the same keys at every level, and the same
JSON type for every value — because ids, secrets and times differ on every
run. `null` is a type of its own here, so a field the fixture records as null
must be null in the response the test provokes, and the other way round.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import room_control_frame
from switch_core.bridges.agent.protocol.event_buffer import Reader
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.stores.agent_store import AgentStore
from switch_core.management.schemas import (
    ControllerBeatRequest,
    ControllerConnectionRequest,
    EnrollRequest,
    OperationResultRequest,
    StatusReport,
    TokenRequest,
)
from tests.switch_core.management.harness import (
    FIXTURES,
    Harness,
    add_member,
    add_room,
    build_harness,
    cookies_for,
    create_managed_agent,
    definition,
    enroll_console,
    fixture,
    open_connection,
    open_stream,
    place_agent,
    provider,
    report_status,
    take,
)


def _fixture(name: str) -> Any:
    return fixture(name)


def assert_same_shape(actual: Any, expected: Any, where: str = "$") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{where}: expected an object, got {actual!r}"
        assert set(actual) == set(expected), (
            f"{where}: keys differ; extra {sorted(set(actual) - set(expected))}, "
            f"missing {sorted(set(expected) - set(actual))}"
        )
        for key, value in expected.items():
            assert_same_shape(actual[key], value, f"{where}.{key}")
    elif isinstance(expected, list):
        assert isinstance(actual, list), f"{where}: expected an array, got {actual!r}"
        if expected:
            assert actual, f"{where}: expected a non-empty array"
            for index, item in enumerate(actual):
                assert_same_shape(item, expected[0], f"{where}[{index}]")
    else:
        assert type(actual) is type(expected), (
            f"{where}: expected {type(expected).__name__} like {expected!r}, "
            f"got {actual!r}"
        )


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


class TestRequestFixturesParse:
    def test_each_request_fixture_is_a_valid_request(self) -> None:
        EnrollRequest.model_validate(_fixture("enroll_request.json"))
        TokenRequest.model_validate(_fixture("token_request.json"))
        StatusReport.model_validate(_fixture("status_request.json"))
        OperationResultRequest.model_validate(
            _fixture("operation_result_succeeded.json")
        )
        OperationResultRequest.model_validate(_fixture("operation_result_failed.json"))
        ControllerConnectionRequest.model_validate(
            _fixture("controller_connection_request.json")
        )
        ControllerBeatRequest.model_validate(_fixture("controller_beat_request.json"))


class TestEnrollmentAndTokens:
    async def test_enroll_token_and_rotate(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            code = (
                await client.post(
                    "/gateway/management/enrollment-codes", cookies=cookies_for(owner)
                )
            ).json()["code"]
            enroll_body = _fixture("enroll_request.json")
            enroll_body["proof"]["code"] = code
            enrolled = await client.post(
                "/v1/management/controllers/enroll", json=enroll_body
            )
            controller_id = enrolled.json()["controller_id"]

            token_body = _fixture("token_request.json")
            token_body["credential"] = enrolled.json()["credential"]
            token = await client.post(
                f"/v1/management/controllers/{controller_id}/token", json=token_body
            )
            rotated = await client.post(
                f"/v1/management/controllers/{controller_id}/credential/rotate",
                headers={"Authorization": f"Bearer {token.json()['access_token']}"},
            )

        assert enrolled.status_code == 201, enrolled.text
        assert_same_shape(enrolled.json(), _fixture("enroll_response.json"))
        assert enrolled.json()["credential"].startswith("swcc_")
        assert token.status_code == 200, token.text
        assert_same_shape(token.json(), _fixture("token_response.json"))
        assert token.json()["access_token"].startswith("swct_")
        assert token.json()["expires_at"].endswith("Z")
        assert rotated.status_code == 200
        assert_same_shape(rotated.json(), _fixture("credential_rotate_response.json"))


class TestControllerMessages:
    async def test_assignment_status_and_operations(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await report_status(client, controller, 1, providers=[provider("claude")])
            created = await create_managed_agent(
                client,
                owner,
                name="reviewer",
                controller_id=controller.controller_id,
                definition_body=definition(
                    model="opus",
                    advanced_config={"effort": "high"},
                    instructions="Review pull requests.",
                    directory="/home/example/src/project",
                ),
            )
            agent_id = created.json()["agent_id"]
            async with harness.session_factory() as session:
                await AgentStore().update(
                    session,
                    agent_id,
                    display_name="Reviewer",
                    icon_url="https://example.com/icons/reviewer.png",
                )
                await session.commit()

            assignment = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )
            status = await client.put(
                f"/v1/management/controllers/{controller.controller_id}/status",
                json=_fixture("status_request.json"),
                headers=controller.headers,
            )

            recheck = await client.post(
                "/gateway/management/operations",
                json={
                    "controller_id": controller.controller_id,
                    "kind": "provider.recheck",
                    "params": {"provider": "claude"},
                },
                cookies=cookies_for(owner),
            )
            listed = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/operations",
                params={"state": "pending"},
                headers=controller.headers,
            )
            restart = await client.post(
                "/gateway/management/operations",
                json={
                    "controller_id": controller.controller_id,
                    "kind": "agent.restart",
                    "agent_id": agent_id,
                },
                cookies=cookies_for(owner),
            )
            claimed = await client.post(
                f"/v1/management/operations/{restart.json()['id']}/claim",
                headers=controller.headers,
            )
            await client.post(
                f"/v1/management/operations/{recheck.json()['id']}/claim",
                headers=controller.headers,
            )
            succeeded = await client.post(
                f"/v1/management/operations/{restart.json()['id']}/result",
                json=_fixture("operation_result_succeeded.json"),
                headers=controller.headers,
            )
            failed = await client.post(
                f"/v1/management/operations/{recheck.json()['id']}/result",
                json=_fixture("operation_result_failed.json"),
                headers=controller.headers,
            )

        assert assignment.status_code == 200
        assert_same_shape(assignment.json(), _fixture("assignment_response.json"))
        assert status.status_code == 200, status.text
        assert_same_shape(status.json(), _fixture("status_response.json"))
        assert status.json()["report_within_s"] == 60
        assert_same_shape(listed.json(), _fixture("operations_response.json"))
        assert claimed.status_code == 200
        assert_same_shape(claimed.json(), _fixture("operation.json"))
        assert succeeded.status_code == 204
        assert failed.status_code == 204

    async def test_the_error_envelope(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            refused = await client.get(
                f"/v1/management/controllers/{controller.controller_id}/assignment",
                headers=controller.headers,
            )
        assert refused.status_code == 401
        assert refused.json() == _fixture("error_response.json")


class TestTheControllerConnection:
    async def test_open_and_beat(self, harness: Harness) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            body = _fixture("controller_connection_request.json")
            body["cursors"] = {agent_id: 0, "not-bound": "head"}
            opened = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection",
                json=body,
                headers=controller.headers,
            )
            stream = await open_stream(harness, controller, opened.json())
            await take(stream, 2)
            beat_body = _fixture("controller_beat_request.json")
            beat_body.update(
                connection_id=opened.json()["connection_id"],
                generation=opened.json()["generation"],
                cursors={agent_id: 0},
            )
            beat = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection/beat",
                json=beat_body,
                headers=controller.headers,
            )
            present = harness.protocol.connections.controllers.live_rooms(agent_id)
            await stream.aclose()

        assert opened.status_code == 201, opened.text
        assert_same_shape(
            opened.json(), _fixture("controller_connection_response.json")
        )
        assert beat.status_code == 200, beat.text
        assert_same_shape(beat.json(), _fixture("controller_beat_response.json"))
        assert harness.protocol.connections.controllers.live_rooms(agent_id) == set()
        assert present == {room_id}

    async def test_placements_are_refused_on_open_and_beat(
        self, harness: Harness
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            body = _fixture("controller_connection_request.json")
            body["cursors"] = {agent_id: 0}
            refused_open = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection",
                json={**body, "placements": {agent_id: [room_id]}},
                headers=controller.headers,
            )
            opened = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection",
                json=body,
                headers=controller.headers,
            )
            stream = await open_stream(harness, controller, opened.json())
            await take(stream, 2)
            beat_body = _fixture("controller_beat_request.json")
            beat_body.update(
                connection_id=opened.json()["connection_id"],
                generation=opened.json()["generation"],
                cursors={agent_id: 0},
                placements={agent_id: [room_id]},
            )
            refused_beat = await client.post(
                f"/v1/controllers/{controller.controller_id}/connection/beat",
                json=beat_body,
                headers=controller.headers,
            )
            await stream.aclose()

        for refused in (refused_open, refused_beat):
            assert refused.status_code == 422, refused.text
            assert refused.json()["error"]["code"] == "validation_error"
            assert "placements" in refused.json()["error"]["message"]


class _Outcomes:
    """Approval outcomes owed to one agent, as the listener would push them."""

    def __init__(self, outcome: dict[str, Any]) -> None:
        self._outcome = outcome

    def subscribe(self, tenant_id, agent_id, on_outcome, on_resync):  # type: ignore[no-untyped-def]
        return lambda: None

    async def undelivered(self, agent_id: str) -> list[dict[str, Any]]:
        return [self._outcome]


class TestStreamFrames:
    async def test_each_frame_matches(self, harness: Harness) -> None:
        recorded = {entry["event"]: entry for entry in _fixture("stream_frames.json")}
        harness.protocol.approval_outcomes = _Outcomes(  # type: ignore[assignment]
            recorded["agent.approval_outcome"]["data"]["outcome"]
        )
        presence = harness.protocol.connections.controllers
        owner = await add_member(harness.session_factory, "ada")
        provoked: list[tuple[str, dict[str, Any]]] = []
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            second = await enroll_console(harness, client, owner, "second")
            await report_status(client, second, 1, providers=[provider("claude")])
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            opened = await open_connection(client, controller, {agent_id: 41})
            stream = await open_stream(harness, controller, opened)
            # connection_state, agent.attached, agent.gap (a cursor from
            # before a restart), agent.approval_outcome
            provoked += await take(stream, 4)

            # The restart left the room's count unknown; a read through the
            # head gives it a baseline again, as `read_context` would.
            binding = presence.binding(agent_id)
            assert binding is not None
            buffer = harness.protocol.event_buffer
            buffer.caught_up(
                agent_id,
                Reader(id=presence.holder_id(binding), is_session=False),
                room_id,
                buffer.head(agent_id),
                None,
            )
            harness.protocol.event_buffer.enqueue(
                agent_id,
                room_id,
                AgentEvent(
                    type="message",
                    room_id=room_id,
                    payload=MessagePayload(
                        addressed=True,
                        sender="@ada:test",
                        sender_name="Ada",
                        message_id="$event-1",
                        body="@reviewer can you look at this?",
                        timestamp=0,
                    ),
                ),
            )
            provoked += await take(stream, 1)

            presence.relay_session_command(
                agent_id,
                room_control_frame(
                    agent_id=agent_id,
                    session_id=None,
                    room_id=room_id,
                    action="reset",
                    actor_id="@ada:test",
                    message_id="$reset-command",
                    thread_id=None,
                    surface="slack",
                    requester_name="Ada",
                ),
            )
            provoked += await take(stream, 1)

            other_room = await add_room(harness.session_factory, agent_id, name="new")
            presence.room_joined(agent_id, other_room)
            provoked += await take(stream, 1)

            harness.management.service.notifier.operation_pending(
                controller.controller_id,
                operation_id="op",
                kind="provider.recheck",
                agent_id=None,
            )
            provoked += await take(stream, 1)

            moved = await client.patch(
                f"/gateway/management/agents/{agent_id}",
                json={"controller_id": second.controller_id},
                cookies=cookies_for(owner),
            )
            assert moved.status_code == 200, moved.text
            # assignment.changed and agent.detached
            provoked += await take(stream, 2)

            revoked = await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )
            assert revoked.status_code == 200, revoked.text
            provoked += await take(stream, 1)

            first = await open_connection(client, second)
            first_stream = await open_stream(harness, second, first)
            await take(first_stream, 1)
            await open_connection(client, second)
            provoked += await take(first_stream, 1)

        names = [name for name, _ in provoked]
        assert sorted(names) == sorted(recorded), names
        for name, data in provoked:
            assert_same_shape(
                {"event": name, "data": data}, recorded[name], f"$[{name}]"
            )


def test_every_fixture_is_exercised() -> None:
    """Every file on disk is read by a test in this module, and nothing here
    reads a file that is not there."""
    referenced = set(re.findall(r'_fixture\("([^"]+)"\)', Path(__file__).read_text()))
    on_disk = {path.name for path in FIXTURES.glob("*.json")}
    assert on_disk == referenced, (
        f"unexercised: {sorted(on_disk - referenced)}; "
        f"missing: {sorted(referenced - on_disk)}"
    )
