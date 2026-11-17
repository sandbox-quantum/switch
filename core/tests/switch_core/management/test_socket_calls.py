"""An operation a controller calls on its socket answers what the same call
over HTTP with the controller's token answers, and is authorized the same way.

Each case is sent through both doors, the HTTP one through the real bearer
middleware, and the two answers compared. Against Postgres.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any, cast

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import ControllerPrincipal
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.operations import registry
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.management import socket_calls
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    add_room,
    archive_changed,
    build_harness,
    cookies_for,
    enroll_console,
    place_agent,
    set_archived,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


@pytest.fixture
def where_am_i(harness: Harness) -> Iterator[None]:
    """An operation that answers with the caller's room, or refuses."""

    async def where_am_i(refuse: bool = False, stamped: bool = False) -> dict[str, Any]:
        if refuse:
            raise PermissionError("not here")
        answer: dict[str, Any] = {"room_id": await op_context.require_connected_room()}
        if stamped:
            # Not JSON as it is: encoded for the socket as the route encodes it.
            answer["at"] = datetime(2026, 11, 1, 12, 30, tzinfo=UTC)
        return answer

    registry._REGISTRY["where_am_i"] = registry.Operation(
        name="where_am_i",
        fn=where_am_i,
        description="test",
        input_schema=registry._input_schema(where_am_i),
    )
    previous = op_context._protocol
    op_context.init_operations_protocol(harness.protocol)
    try:
        yield
    finally:
        registry._REGISTRY.pop("where_am_i", None)
        op_context._protocol = previous


def _principal(controller: EnrolledController) -> ControllerPrincipal:
    return ControllerPrincipal(
        controller_id=controller.controller_id,
        owner_id=controller.owner.id,
        tenant_id=TENANT_ZERO_ID,
    )


async def _both(
    harness: Harness,
    controller: EnrolledController,
    agent_id: str,
    operation: str,
    arguments: dict[str, Any],
    room_id: str | None,
) -> tuple[tuple[int, Any], tuple[int, Any]]:
    """The answer over HTTP and the answer on the socket, each as (status, body)."""
    headers = dict(controller.headers)
    if room_id is not None:
        headers["X-Switch-Room-Id"] = room_id
    async with harness.client() as client:
        response = await client.post(
            f"/agents/{agent_id}/ops/{operation}", json=arguments, headers=headers
        )
    answer = await socket_calls.answer(
        {
            "type": "call",
            "id": "c-1",
            "agent_id": agent_id,
            "operation": operation,
            "arguments": arguments,
            "room_id": room_id,
        },
        "c-1",
        principal=_principal(controller),
        protocol=harness.protocol,
        authenticator=harness.management.authenticator,
    )
    assert answer["event"] == "call.result"
    assert answer["data"]["id"] == "c-1"
    return (response.status_code, response.json()), (
        answer["data"]["status"],
        answer["data"]["body"],
    )


class TestACallAnswersWhatHttpAnswers:
    async def test_for_each_outcome_of_an_operation(
        self, harness: Harness, where_am_i: None
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        member_room = await add_room(harness.session_factory, agent_id)
        other_room = await add_room(harness.session_factory, name="elsewhere")

        cases: list[tuple[str, dict[str, Any], str | None]] = [
            ("where_am_i", {}, member_room),
            ("where_am_i", {"stamped": True}, member_room),
            ("where_am_i", {}, other_room),
            ("where_am_i", {}, "no-such-room"),
            ("where_am_i", {}, None),
            ("where_am_i", {"refuse": True}, member_room),
            ("where_am_i", {"unexpected": 1}, member_room),
            ("no_such_operation", {}, member_room),
        ]
        statuses = []
        for operation, arguments, room_id in cases:
            over_http, on_socket = await _both(
                harness, controller, agent_id, operation, arguments, room_id
            )
            assert on_socket == over_http, (operation, arguments, room_id)
            statuses.append(on_socket[0])

        assert statuses == [200, 200, 403, 404, 400, 403, 400, 404]


class TestACallIsAuthorizedAsTheControllersRequestIs:
    async def test_an_agent_bound_to_another_controller_is_not_assigned(
        self, harness: Harness, where_am_i: None
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            mine = await enroll_console(harness, client, owner, "mine")
            theirs = await enroll_console(harness, client, owner, "theirs")
            agent_id = await place_agent(client, theirs, name="theirs-agent")

        over_http, on_socket = await _both(
            harness, mine, agent_id, "where_am_i", {}, None
        )

        assert on_socket == over_http
        assert on_socket[0] == 403
        assert on_socket[1]["error"]["code"] == "not_assigned"

    async def test_a_revoked_controller_is_refused(
        self, harness: Harness, where_am_i: None
    ) -> None:
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
            room_id = await add_room(harness.session_factory, agent_id)
            await client.delete(
                f"/gateway/management/controllers/{controller.controller_id}",
                cookies=cookies_for(owner),
            )

        over_http, on_socket = await _both(
            harness, controller, agent_id, "where_am_i", {}, room_id
        )

        assert on_socket == over_http
        assert on_socket[0] == 401
        assert on_socket[1]["error"]["code"] == "controller_revoked"

    async def test_an_agent_in_an_archived_workspace_is_refused_until_restored(
        self, harness: Harness, where_am_i: None
    ) -> None:
        """Its binding stops with the archive, and its controller may not act
        for it through either door, as its own key may not."""
        owner = await add_member(harness.session_factory, "ada")
        async with harness.client() as client:
            controller = await enroll_console(harness, client, owner)
            agent_id = await place_agent(client, controller, name="reviewer")
        room_id = await add_room(harness.session_factory, agent_id)

        await set_archived(harness, archived=True)
        await archive_changed(harness)
        over_http, on_socket = await _both(
            harness, controller, agent_id, "where_am_i", {}, room_id
        )
        await set_archived(harness, archived=False)
        await archive_changed(harness)
        restored = await _both(harness, controller, agent_id, "where_am_i", {}, room_id)

        assert on_socket == over_http
        assert on_socket[0] == 403
        assert on_socket[1]["error"]["code"] == "workspace_archived"
        assert [answer[0] for answer in restored] == [200, 200]


@pytest.mark.parametrize(
    ("change", "detail"),
    [
        ({"agent_id": None}, "agent_id"),
        ({"agent_id": ""}, "agent_id"),
        ({"operation": 7}, "operation"),
        ({"arguments": ["body"]}, "arguments"),
        ({"room_id": 3}, "room_id"),
    ],
)
async def test_a_call_that_cannot_be_run_as_sent_is_a_400(
    harness: Harness, change: dict[str, Any], detail: str
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="reviewer")
    call = {
        "type": "call",
        "id": "c-1",
        "agent_id": agent_id,
        "operation": "where_am_i",
        "arguments": {},
        **change,
    }

    answer = await socket_calls.answer(
        call,
        "c-1",
        principal=_principal(controller),
        protocol=harness.protocol,
        authenticator=harness.management.authenticator,
    )

    assert answer["data"]["status"] == 400
    assert detail in answer["data"]["body"]["detail"]


async def test_a_call_that_fails_is_still_answered() -> None:
    """With a 500, as the HTTP route answers a failure, so the controller is
    not left waiting on it until the socket closes."""

    class _Failing:
        async def current(self, principal: ControllerPrincipal) -> ControllerPrincipal:
            raise RuntimeError("the database went away")

    answer = await socket_calls.answer(
        {"agent_id": "a1", "operation": "post_message"},
        "c-1",
        principal=ControllerPrincipal(
            controller_id="c1", owner_id="o1", tenant_id=TENANT_ZERO_ID
        ),
        protocol=cast(Any, None),
        authenticator=cast(Any, _Failing()),
    )

    assert answer["data"] == {
        "id": "c-1",
        "status": 500,
        "body": {"detail": "Internal Server Error"},
    }
