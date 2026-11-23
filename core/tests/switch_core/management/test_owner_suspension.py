"""A suspended person's devices (`accounts/suspension.py`).

Suspending the person ends each of their controllers' streams once its
agents' assignments say stopped, and refuses the controller a token and every
route but its assignment while the suspension lasts. Its credential is kept:
lifting the suspension lets the same credential in again.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from switch_core.accounts.suspension import (
    Suspender,
    SuspensionEffects,
    suspend_agent,
    suspend_user,
    unsuspend_user,
)
from switch_core.bridges.agent.protocol.controller_presence import OWNER_SUSPENDED
from switch_core.bridges.agent.protocol.controller_stream import IDLE
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.session_scope import tenant_session
from switch_core.management.notifier import ASSIGNMENT_CHANGED
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    enroll_console,
    open_connection,
    open_stream,
    parse_frame,
    place_agent,
)

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    import httpx
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from tests.switch_core.management.harness import EnrolledController

OPERATOR = Suspender(user_id=None, role="operator")


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _effects(harness: Harness) -> SuspensionEffects:
    return SuspensionEffects(
        session_factory=harness.session_factory,
        connections=harness.protocol.connections,
        api_key_cache=harness.cache,
        broker=harness.broker,
        management=harness.management.service,
    )


async def _to_the_end(
    stream: AsyncIterator[dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    """Every frame the stream sends until it ends, idle ticks skipped."""
    frames: list[tuple[str, dict[str, Any]]] = []
    async for raw in stream:
        if raw is not IDLE:
            frames.append(parse_frame(raw))
    return frames


async def _exchange(
    client: httpx.AsyncClient, controller: EnrolledController
) -> httpx.Response:
    return await client.post(
        f"/v1/management/controllers/{controller.controller_id}/token",
        json={"credential": controller.credential},
    )


def _code(response: httpx.Response) -> str:
    return str(response.json()["error"]["code"])


async def test_their_controller_is_disconnected_and_refused_until_it_is_lifted(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="scout")
        opened = await open_connection(client, controller)
        stream = await open_stream(harness, controller, opened)

        done = await suspend_user(
            harness.session_factory, user_id=owner.id, by=OPERATOR, reason="hold"
        )
        await _effects(harness).committed(done.changes)
        frames = await _to_the_end(stream)

        assert done.changes.controllers == {TENANT_ZERO_ID: [controller.controller_id]}
        # The stopped assignment is nudged before the stream ends, so the
        # controller pulls it, and the stream ends saying why.
        names = [name for name, _ in frames]
        assert ASSIGNMENT_CHANGED in names
        assert names.index(ASSIGNMENT_CHANGED) < names.index("evicted")
        assert frames[-1] == (
            "evicted",
            {"code": OWNER_SUSPENDED.code, "reason": OWNER_SUSPENDED.message},
        )
        presence = harness.protocol.connections.controllers
        assert presence.current_connection(controller.controller_id) is None
        assert not presence.is_revoked(controller.controller_id)

        refused_exchange = await _exchange(client, controller)
        refused_open = await client.post(
            f"/v1/controllers/{controller.controller_id}/connection",
            json={"cursors": {}},
            headers=controller.headers,
        )
        refused_status = await client.put(
            f"/v1/management/controllers/{controller.controller_id}/status",
            json={},
            headers=controller.headers,
        )
        assignment = await client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )

        assert (refused_exchange.status_code, _code(refused_exchange)) == (
            403,
            "account_suspended",
        )
        assert (refused_open.status_code, _code(refused_open)) == (
            403,
            "account_suspended",
        )
        assert (refused_status.status_code, _code(refused_status)) == (
            403,
            "account_suspended",
        )
        # The one route it may still use: it says to stop everything.
        assert assignment.status_code == 200, assignment.text
        assert [
            (entry["agent_id"], entry["desired_state"])
            for entry in assignment.json()["agents"]
        ] == [(agent_id, "stopped")]

        lifted = await unsuspend_user(
            harness.session_factory, user_id=owner.id, by=OPERATOR
        )
        await _effects(harness).committed(lifted.changes)
        exchanged = await _exchange(client, controller)
        assert exchanged.status_code == 200, exchanged.text
        controller.access_token = exchanged.json()["access_token"]
        await open_connection(client, controller)
        assignment = await client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )

    assert [
        (entry["agent_id"], entry["desired_state"])
        for entry in assignment.json()["agents"]
    ] == [(agent_id, "running")]


async def test_suspending_one_of_their_agents_leaves_their_controller_alone(
    harness: Harness,
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="scout")
        await open_connection(client, controller)
        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            changes = await suspend_agent(
                session,
                tenant_id=TENANT_ZERO_ID,
                agent_id=agent_id,
                by=OPERATOR,
                reason="hold",
            )
            await session.commit()
        await _effects(harness).committed(changes)
        exchanged = await _exchange(client, controller)

    assert changes.controllers == {}
    assert exchanged.status_code == 200, exchanged.text
    presence = harness.protocol.connections.controllers
    assert presence.current_connection(controller.controller_id) is not None
