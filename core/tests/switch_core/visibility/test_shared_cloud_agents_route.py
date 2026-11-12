"""Isolation for `GET /shared-cloud/agents`, end to end against Postgres: two people in one
workspace, each with a shared-cloud box and an agent on it, never see each other's agents, and
nothing the box wrote ever leaves the route."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TenantMember, User
from switch_core.visibility.shared_cloud_agents import (
    router as shared_cloud_agents_router,
)
from tests.switch_core.hosted_machine_helpers import (
    link_controller,
    place_managed_agent,
    seed_machine,
)
from tests.switch_core.management.harness import (
    TENANT_ZERO_ID,
    Harness,
    add_member,
    build_harness,
    cookies_for,
)

ROUTE = "/gateway/shared-cloud/agents"
MARKER = "a planted marker phrase the box wrote"
# Every key the route may send, for the whole answer and for one agent.
ANSWER_KEYS = {"available", "agents"}
AGENT_KEYS = {
    "agent_id", "state", "last_reply_at", "needs_restart", "needs_check", "memory_stopped",
    "waiting_for_room", "box_stopped", "box_starting", "paused", "turned_off", "stop_reason",
    "reset_at",
}  # fmt: skip


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    harness = build_harness(session_factory)
    harness.gateway_app.include_router(shared_cloud_agents_router)
    return harness


async def _box_with_agent(harness: Harness, owner: User, name: str) -> str:
    """A ready shared-cloud box for `owner`, its controller, and one running agent on it whose
    status entry carries the box's own text where a box could put it."""
    async with harness.session_factory() as session:
        machine = await seed_machine(
            session,
            owner_id=owner.id,
            state="ready",
            desired_state="running",
            stop_reason=None,
            revision=1,
        )
        controller = await link_controller(session, machine)
        placed = await place_managed_agent(
            session, owner_id=owner.id, controller_id=controller.id, name=name
        )
        controller.status = {
            "agents": [
                {
                    "agent_id": placed.agent_id,
                    "process": "running",
                    "session": "active",
                    "busy": True,
                    "detail": MARKER,
                    "reason": MARKER,
                }
            ],
            "machine": {"detail": MARKER},
        }
        await session.commit()
        return placed.agent_id


def _agent_ids(answer: dict[str, Any]) -> set[str]:
    return {agent["agent_id"] for agent in answer["agents"]}


async def test_two_people_in_one_workspace_see_only_their_own_agents(
    harness: Harness,
) -> None:
    ada = await add_member(harness.session_factory, "ada")
    bob = await add_member(harness.session_factory, "bob")
    carol = await add_member(harness.session_factory, "carol")  # no box at all
    adas = await _box_with_agent(harness, ada, "ada-reviewer")
    bobs = await _box_with_agent(harness, bob, "bob-reviewer")

    async with harness.client() as client:
        as_ada = await client.get(ROUTE, cookies=cookies_for(ada))
        as_bob = await client.get(ROUTE, cookies=cookies_for(bob))
        as_carol = await client.get(ROUTE, cookies=cookies_for(carol))
        anonymous = await client.get(ROUTE)

    for response in (as_ada, as_bob, as_carol):
        assert response.status_code == 200, response.text
        assert set(response.json()) == ANSWER_KEYS
    assert as_ada.json()["available"] is True
    assert _agent_ids(as_ada.json()) == {adas}
    assert _agent_ids(as_bob.json()) == {bobs}
    # Someone with no box hears "no shared cloud here", never anyone else's.
    assert as_carol.json() == {"available": False, "agents": []}
    assert anonymous.status_code == 401
    assert adas not in anonymous.text and bobs not in anonymous.text


async def test_only_fixed_fields_leave_never_the_boxs_text(harness: Harness) -> None:
    ada = await add_member(harness.session_factory, "ada")
    await _box_with_agent(harness, ada, "ada-reviewer")

    async with harness.client() as client:
        response = await client.get(ROUTE, cookies=cookies_for(ada))

    assert response.status_code == 200, response.text
    assert MARKER not in response.text
    (agent,) = response.json()["agents"]
    assert set(agent) <= AGENT_KEYS


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_paused_person_and_a_turned_off_person_each_see_their_own_reason(
    harness: Harness,
) -> None:
    """The pause and turn-off marks, read through their own checks: Ada paused by Switch, Bob turned off in this
    workspace, Carol neither. Each sees only their own agent, with their own reason, on the
    shared-cloud list and on the management list."""
    ada = await add_member(harness.session_factory, "ada")
    bob = await add_member(harness.session_factory, "bob")
    carol = await add_member(harness.session_factory, "carol")
    adas = await _box_with_agent(harness, ada, "ada-reviewer")
    bobs = await _box_with_agent(harness, bob, "bob-reviewer")
    carols = await _box_with_agent(harness, carol, "carol-reviewer")
    paused_at = datetime(2026, 10, 29, 9, 30, tzinfo=UTC)
    async with harness.session_factory() as session:
        # Written straight to the rows: this test is about reading them, not the pause routes.
        await session.execute(
            update(User).where(User.id == ada.id).values(hosted_paused_at=paused_at)
        )
        await session.execute(
            update(TenantMember)
            .where(
                TenantMember.tenant_id == TENANT_ZERO_ID,
                TenantMember.user_id == bob.id,
            )
            .values(hosted_enabled=False)
        )
        await session.commit()

    async with harness.client() as client:
        shared = {
            who.name: (await client.get(ROUTE, cookies=cookies_for(who))).json()
            for who in (ada, bob, carol)
        }
        managed = {
            who.name: (
                await client.get("/gateway/management/agents", cookies=cookies_for(who))
            ).json()
            for who in (ada, bob, carol)
        }

    (ada_card,) = shared["ada"]["agents"]
    (bob_card,) = shared["bob"]["agents"]
    (carol_card,) = shared["carol"]["agents"]
    assert (ada_card["agent_id"], ada_card["stop_reason"]) == (adas, "paused_by_switch")
    assert ada_card["paused"] is True and ada_card["state"] == "unavailable"
    assert (bob_card["agent_id"], bob_card["stop_reason"]) == (
        bobs,
        "turned_off_by_admin",
    )
    assert bob_card["turned_off"] is True
    assert carol_card["agent_id"] == carols
    assert carol_card.get("stop_reason") not in (
        "paused_by_switch",
        "turned_off_by_admin",
    )

    reasons = {
        who: [
            (a["agent_id"], (a["stop_reason"] or {}).get("code")) for a in managed[who]
        ]
        for who in managed
    }
    assert reasons["ada"] == [(adas, "paused_by_switch")]
    assert reasons["bob"] == [(bobs, "turned_off_by_admin")]
    assert [agent_id for agent_id, _ in reasons["carol"]] == [carols]
    assert reasons["carol"][0][1] not in ("paused_by_switch", "turned_off_by_admin")
    ada_reason = managed["ada"][0]["stop_reason"]
    assert ada_reason["since"] == paused_at.isoformat()
    assert managed["bob"][0]["stop_reason"]["since"] is None
