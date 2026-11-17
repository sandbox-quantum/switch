# ruff: noqa: F811 - `managed` is the fixture imported below
"""Retrying a template run finishes it, never doubles it.

A run's caller names the run (`run_key`); Switch Console sends the same key
again on Retry, and an agent running a template gets one derived from its
request. An attempt then counts the agents an earlier attempt of the run made
as done, finishes the room it made instead of making another beside it, and
posts that room's kickoff only if it never was.

Over the same fake protocol and fake management port as the other template
run tests: real PostgreSQL, the real template engine and run guards.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select, text

from switch_core.bridges.agent.operations.definitions import run_template
from switch_core.db.models import Agent, User, require_tenant_id, room_agents
from switch_core.gateway import rooms as gateway_rooms
from switch_core.gateway.rooms import _run_as_person, template_run_so_far
from switch_core.template_runs import (
    AgentsNotCreated,
    RunUndone,
    attempt_in_flight,
    one_attempt_at_a_time,
)
from tests.switch_core.bridges.agent.operations.test_template_managed_agents import (  # noqa: F401
    TEAM,
    _as,
    _plan,
    _rooms,
    _stored,
    managed,
)


@pytest.fixture(autouse=True)
def _quick_listen(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gateway_rooms, "LISTEN_TIMEOUT_SECONDS", 0.2)


def _kickoffs(env: dict[str, Any]) -> list[dict[str, Any]]:
    return [m for m in env["admin"].sent if "kickoff" in m["body"].lower()]


async def _agents_in(env: dict[str, Any], room_id: str) -> set[str]:
    async with env["session_factory"]() as session:
        rows = await session.execute(
            select(Agent.name)
            .join(room_agents, room_agents.c.agent_id == Agent.id)
            .where(room_agents.c.room_id == room_id)
        )
        return set(rows.scalars())


async def _person_run(env: dict[str, Any], run_key: str | None) -> Any:
    """A person running TEAM from Switch Console, as the from-template route
    does it."""
    plan = _plan(TEAM, inputs={"team": "red"})
    async with env["session_factory"]() as session:
        user = await session.get(User, env["user_id"])
        assert user is not None
    protocol = env["protocol"]
    return await _run_as_person(
        protocol.room_yaml_service(),
        protocol,
        user,
        False,
        plans=plan.new_agents,
        document=plan.document,
        inputs=plan.inputs or None,
        template_name="Team",
        room_addressing=plan.room_addressing,
        run_key=run_key,
    )


@pytest.mark.asyncio
async def test_retrying_a_run_that_finished_unseen_counts_what_it_made(managed):
    """Console stopped waiting, but the server finished: Retry answers with
    what exists, makes nothing again and posts no second kickoff."""
    first = await _person_run(managed, run_key="run-1")
    again = await _person_run(managed, run_key="run-1")

    assert isinstance(again, dict), again
    assert again["room"]["room_id"] == first["room"]["room_id"]
    assert [a["agent_id"] for a in again["created_agents"]] == [
        a["agent_id"] for a in first["created_agents"]
    ]
    assert len(managed["management"].created) == 2
    assert len(await _rooms(managed)) == 1
    assert len(_kickoffs(managed)) == 1


@pytest.mark.asyncio
async def test_without_a_run_key_a_second_run_is_a_new_one(managed):
    await _person_run(managed, run_key=None)

    refused = await _person_run(managed, run_key=None)

    assert refused.status_code == 409
    assert b"name_taken" in refused.body


@pytest.mark.asyncio
async def test_a_room_step_that_failed_once_is_finished_on_retry(managed):
    """The room was recorded, then the step failed and the run was undone.
    The retry makes the agents again and puts them in that room, with one
    kickoff, instead of making a second room beside it."""
    room_service = managed["protocol"].room_service
    real_create = room_service.create_room
    calls: list[str] = []

    async def fails_once_after_recording(config: Any) -> Any:
        calls.append(config.name)
        result = await real_create(config)
        if len(calls) == 1:
            raise ValueError("the messaging app did not answer")
        return result

    room_service.create_room = fails_once_after_recording
    template_id = await _stored(managed, TEAM)

    with pytest.raises(RunUndone):
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
        )
    result = await _as(
        managed["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"team": "red"},
    )

    (room,) = await _rooms(managed)
    assert result["room_id"] == room.id
    assert calls == ["red-room"]
    assert await _agents_in(managed, room.id) == {"red-lead", "red-helper"}
    assert len(_kickoffs(managed)) == 1


@pytest.mark.asyncio
async def test_an_agent_running_the_same_template_again_gets_one_kickoff(managed):
    template_id = await _stored(managed, TEAM)
    first = await _as(
        managed["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"team": "red"},
    )

    again = await _as(
        managed["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"team": "red"},
    )

    assert again["room_id"] == first["room_id"]
    assert len(managed["management"].created) == 2
    assert len(await _rooms(managed)) == 1
    assert len(_kickoffs(managed)) == 1


@pytest.mark.asyncio
async def test_a_second_attempt_while_one_is_going_is_refused(managed):
    tenant_id = require_tenant_id()
    async with one_attempt_at_a_time(
        managed["session_factory"], tenant_id, managed["user_id"], "run-2"
    ):
        assert await attempt_in_flight(
            managed["session_factory"], tenant_id, managed["user_id"], "run-2"
        )
        refused = await _person_run(managed, run_key="run-2")
    assert refused.status_code == 409
    assert b'"busy"' in refused.body
    assert not await attempt_in_flight(
        managed["session_factory"], tenant_id, managed["user_id"], "run-2"
    )
    assert managed["management"].created == []


@pytest.mark.asyncio
async def test_what_a_run_made_so_far_is_read_back_by_its_key(managed):
    await _person_run(managed, run_key="run-3")

    async with managed["session_factory"]() as session:
        user = await session.get(User, managed["user_id"])
        assert user is not None
        so_far = await template_run_so_far(
            "run-3",
            session,
            managed["protocol"],
            managed["protocol"].room_store,
            managed["protocol"].agent_store,
            user,
        )
        other = await template_run_so_far(
            "another-run",
            session,
            managed["protocol"],
            managed["protocol"].room_store,
            managed["protocol"].agent_store,
            user,
        )

    assert so_far.in_flight is False
    assert sorted(a.name for a in so_far.agents) == ["red-helper", "red-lead"]
    assert [(r.room_name, r.kickoff_posted) for r in so_far.rooms] == [
        ("red-room", True)
    ]
    assert other.agents == [] and other.rooms == []


ESCALATION = """\
version: 1
room:
  name: Ops Escalation
  description: One customer escalation
  agents: ["claude-code.bob"]
kickoff: "@claude-code.bob take the escalation."
"""


async def _age_everything(env: dict[str, Any], by: str) -> None:
    """As if the earlier run last made something `by` ago."""
    async with env["session_factory"]() as session:
        await session.execute(
            text(f"UPDATE rooms SET created_at = created_at - interval '{by}'")
        )
        await session.execute(
            text(f"UPDATE agents SET created_at = created_at - interval '{by}'")
        )
        await session.commit()


@pytest.mark.asyncio
async def test_the_same_request_within_the_window_is_a_retry(managed):
    template_id = await _stored(managed, ESCALATION, kind="room")
    first = await _as(managed["agent_id"], run_template, template_id=template_id)
    await _age_everything(managed, "50 minutes")

    again = await _as(managed["agent_id"], run_template, template_id=template_id)

    assert again["room_id"] == first["room_id"]
    assert len(await _rooms(managed)) == 1
    assert len(_kickoffs(managed)) == 1


@pytest.mark.asyncio
async def test_the_same_request_after_the_window_is_a_new_run(managed):
    """Some templates are meant to be run again on purpose (an escalation
    room per escalation): past the window the same request makes a fresh
    room and posts its own kickoff."""
    template_id = await _stored(managed, ESCALATION, kind="room")
    first = await _as(managed["agent_id"], run_template, template_id=template_id)
    await _age_everything(managed, "61 minutes")

    again = await _as(managed["agent_id"], run_template, template_id=template_id)

    assert again["room_id"] != first["room_id"]
    assert len(await _rooms(managed)) == 2
    assert len(_kickoffs(managed)) == 2


@pytest.mark.asyncio
async def test_after_the_window_an_earlier_run_s_agents_are_not_reused(managed):
    """A fresh run creates its own agents; ones a run past the window made
    are any other agent of that name, refused as taken as before."""
    template_id = await _stored(managed, TEAM)
    await _as(
        managed["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"team": "red"},
    )
    await _age_everything(managed, "2 hours")

    with pytest.raises(AgentsNotCreated) as refused:
        await _as(
            managed["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
        )

    assert {p.code for p in refused.value.problems} == {"name_taken"}
