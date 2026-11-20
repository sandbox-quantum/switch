"""A room made from a template or a YAML document asks the invite rule
`POST /rooms` asks: a member may not put in somebody else's agent that takes
no requests from them, and is told so in the same words."""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.db.models import Agent, Room
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.role_matrix.harness import (
    TENANT,
    Persona,
    build_gateway,
    client,
    seed_people,
)
from tests.switch_core.gateway.role_matrix.world import World

AGENT_TEMPLATE = """\
version: 1
agent:
  name: helper
  description: Helps
  instructions: Help.
  allow_existing: true
room:
  name: "{room}"
  description: "d"
  agents: ["{agent}"]
"""


def _room_yaml(room: str, agent: str) -> str:
    return f'room:\n  name: "{room}"\n  description: "d"\n  agents: ["{agent}"]\n'


def _bodies(agent: str) -> dict[str, tuple[str, dict[str, object]]]:
    """Each way in, asking for a room that holds `agent`."""
    return {
        "create": (
            "/gateway/rooms",
            {"name": "by-create", "description": "", "agent_ids": ["{id}"]},
        ),
        "from-yaml": (
            "/gateway/rooms/from-yaml",
            {"yaml": _room_yaml("by-yaml", agent), "template_name": "t"},
        ),
        "from-template": (
            "/gateway/rooms/from-template",
            {
                "agents": [],
                "yaml": _room_yaml("by-template", agent),
                "template_name": "t",
            },
        ),
        "from-template-document": (
            "/gateway/rooms/from-template-document",
            {
                "template": AGENT_TEMPLATE.replace("{room}", "by-document"),
                "filled": {"helper": agent},
                "template_name": "t",
            },
        ),
    }


@pytest.mark.parametrize("restricted", [True, False])
async def test_every_way_of_making_a_room_asks_the_invite_rule(
    session_factory: async_sessionmaker[AsyncSession], restricted: bool
) -> None:
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    async with client(gateway) as http:
        world = World(session_factory, people, "invite-rule", http, gateway)
        agent_id = await world.agent()
        name = await world.agent_name()
        with tenant_scope(TENANT):
            async with session_factory() as session:
                agent = await session.get(Agent, agent_id)
                assert agent is not None
                agent.addressing_policy = (
                    owner_only_policy([]).model_dump() if restricted else None
                )
                await session.commit()
        answers = {}
        for way, (path, body) in _bodies(name).items():
            if way == "create":
                body = {**body, "agent_ids": [agent_id]}
            response = await http.post(
                path, json=body, headers=people.headers(Persona.MEMBER)
            )
            answers[way] = (response.status_code, response.json().get("detail"))
    with tenant_scope(TENANT):
        async with session_factory() as session:
            made = set((await session.execute(select(Room.name))).scalars().all())

    if restricted:
        refusal = answers["create"]
        assert refusal[0] == 403
        assert "doesn't take requests from you" in refusal[1]
        assert answers == dict.fromkeys(answers, refusal)
        assert made == set()
    else:
        assert {way: status for way, (status, _) in answers.items()} == dict.fromkeys(
            answers, 201
        ), answers
        assert made == {"by-create", "by-yaml", "by-template", "by-document"}
