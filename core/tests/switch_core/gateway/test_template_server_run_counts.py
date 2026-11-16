"""A run of a template the server makes itself is counted there, for the
person who ran it, so the report Switch Console sends straight after it is
not counted a second time."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.template_store import TemplateStore
from switch_core.tenant_context import tenant_scope
from tests.switch_core.gateway.role_matrix.harness import (
    TENANT,
    Persona,
    build_gateway,
    client,
    seed_people,
)
from tests.switch_core.gateway.role_matrix.world import World

TEMPLATE = """\
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


async def _run_count(
    session_factory: async_sessionmaker[AsyncSession], template_id: str
) -> int:
    with tenant_scope(TENANT):
        async with session_factory() as session:
            return await TemplateStore().run_count(session, template_id)


async def test_a_run_through_the_server_is_counted_once_with_its_report(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    member = people.headers(Persona.MEMBER)
    async with client(gateway) as http:
        world = World(session_factory, people, "run-counts", http, gateway)
        agent = await world.agent_name()
        uploaded = await http.post(
            "/gateway/templates",
            json={"name": "helper room", "kind": "room", "content": TEMPLATE},
            headers=member,
        )
        assert uploaded.status_code == 201, uploaded.text
        template_id = uploaded.json()["id"]

        def run(room: str) -> dict[str, object]:
            return {
                "template": TEMPLATE.replace("{room}", room),
                "filled": {"helper": agent},
                "template_name": "helper room",
                "template_id": template_id,
            }

        ran = await http.post(
            "/gateway/rooms/from-template-document", json=run("first"), headers=member
        )
        assert ran.status_code == 201, ran.text
        assert await _run_count(session_factory, template_id) == 1

        reported = await http.post(
            f"/gateway/templates/{template_id}/runs", headers=member
        )
        assert reported.status_code == 201, reported.text
        assert reported.json() == {
            "template_id": template_id,
            "run_count": 1,
            "counted": False,
        }

        # A second real run is a run, report or no report.
        again = await http.post(
            "/gateway/rooms/from-template-document", json=run("second"), headers=member
        )
        assert again.status_code == 201, again.text
        assert await _run_count(session_factory, template_id) == 2

        # Someone else's report is theirs to make.
        other = await http.post(
            f"/gateway/templates/{template_id}/runs",
            headers=people.headers(Persona.OWNER),
        )
        assert other.json()["counted"] is True
        assert await _run_count(session_factory, template_id) == 3


async def test_a_refused_run_is_not_counted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    gateway = build_gateway(session_factory)
    people = await seed_people(session_factory)
    member = people.headers(Persona.MEMBER)
    async with client(gateway) as http:
        uploaded = await http.post(
            "/gateway/templates",
            json={"name": "helper room", "kind": "room", "content": TEMPLATE},
            headers=member,
        )
        template_id = uploaded.json()["id"]

        refused = await http.post(
            "/gateway/rooms/from-template-document",
            json={
                "template": TEMPLATE.replace("{room}", "nowhere"),
                "filled": {"helper": "no-such-agent"},
                "template_name": "helper room",
                "template_id": template_id,
            },
            headers=member,
        )

        assert refused.status_code in (400, 409), refused.text
        assert await _run_count(session_factory, template_id) == 0
