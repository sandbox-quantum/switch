"""The template tools an agent has: finding, reading, running and saving
templates, and the refusals when it asks for what it may not do.

Over the same fake protocol as the create_room_from_yaml tests: real
PostgreSQL, the real template engine and run guards, no Matrix.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
import pytest_asyncio
import yaml
from sqlalchemy import select

from switch_core.agent_refusals import AgentRefused
from switch_core.agent_templates import agent_slots, room_document, template_kind
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    reset_call_context,
    set_call_context,
)
from switch_core.bridges.agent.operations.definitions import (
    delete_template,
    get_template,
    list_templates,
    run_template,
    save_template,
    update_template,
)
from switch_core.db.models import AgentRefusal, Room, Template, User
from switch_core.db.stores.agent_store import AgentStore

ROOM_TEMPLATE = """\
version: 1
params:
  topic: { type: string, description: What the room is about }
room:
  name: "{topic} room"
  description: "A room about {topic}"
  agents: ["claude-code.alice"]
"""

TEAM_TEMPLATE = """\
version: 1
params:
  team: { type: string }
  provider: { type: provider, default: claude }
agents:
  - name: "{team}-triager"
    description: Routes reports
    provider: "{provider}"
    instructions: Route reports.
  - name: "{team}-repro"
    description: Reproduces bugs
    instructions: Reproduce bugs.
room:
  name: "{team}-triage"
  description: The triage room
  agents: ["{team}-triager", "{team}-repro"]
kickoff: "@{team}-triager say hello to @{team}-repro."
"""

AGENT_TEMPLATE = """\
version: 1
agent:
  name: jq-expert
  description: Answers jq questions
  instructions: Answer jq questions.
room:
  name: "Ask {agent}"
  description: "Ask {agent} about jq"
  agents: ["{agent}"]
kickoff: "@{agent} introduce yourself."
"""


@pytest_asyncio.fixture
async def tools(env):
    env["protocol"].config = SimpleNamespace(template_max_bytes=64 * 1024)
    env["protocol"].telemetry = None
    async with env["session_factory"]() as session:
        stranger = User(name="mallory", email="m@example.com", role="member")
        session.add(stranger)
        await session.commit()
        env["stranger_id"] = stranger.id
    return env


async def _as(agent_id: str, fn: Any, **kwargs: Any) -> Any:
    token = set_call_context(
        CallContext(agent_id=agent_id, session_key=None, session=None)
    )
    try:
        return await fn(**kwargs)
    finally:
        reset_call_context(token)


async def _stored(
    env: dict[str, Any], owner_id: str, name: str, content: str, **kw: Any
) -> str:
    async with env["session_factory"]() as session:
        template = Template(
            owner_id=owner_id,
            name=name,
            description=f"{name} description",
            kind=kw.pop("kind", "room"),
            content=content,
            **kw,
        )
        session.add(template)
        await session.commit()
        return template.id


async def _bob_id(env: dict[str, Any]) -> str:
    async with env["session_factory"]() as session:
        bob = await AgentStore().get_by_name(session, "claude-code.bob")
        assert bob is not None
        return bob.id


async def _refusals(env: dict[str, Any]) -> list[tuple[str, str]]:
    async with env["session_factory"]() as session:
        rows = (await session.execute(select(AgentRefusal))).scalars().all()
    return [(r.operation, r.reason) for r in rows]


# ── Reading a document ────────────────────────────────────────────────────


def test_kinds_and_slots_are_read_from_the_document():
    assert template_kind(ROOM_TEMPLATE) == "room"
    assert template_kind(AGENT_TEMPLATE) == "agent"
    assert template_kind(TEAM_TEMPLATE) == "group"
    assert [s.name for s in agent_slots(TEAM_TEMPLATE)] == [
        "{team}-triager",
        "{team}-repro",
    ]


def test_a_team_template_becomes_a_room_with_the_chosen_agents():
    document, inputs = room_document(
        TEAM_TEMPLATE,
        {"red-triager": "claude-code.alice", "{team}-repro": "claude-code.bob"},
        {"team": "red", "provider": "codex"},
    )
    doc = yaml.safe_load(document)
    assert "agents" not in doc
    assert doc["room"]["agents"] == ["claude-code.alice", "claude-code.bob"]
    assert doc["kickoff"] == "@claude-code.alice say hello to @claude-code.bob."
    # Console-only params do not reach the server.
    assert set(doc["params"]) == {"team"}
    assert inputs == {"team": "red"}


def test_an_unfilled_slot_is_refused_with_the_console_message():
    with pytest.raises(
        AgentRefused, match="creating agents happens in Switch Console"
    ) as e:
        room_document(
            TEAM_TEMPLATE, {"red-triager": "claude-code.alice"}, {"team": "red"}
        )
    assert e.value.reason == "agent_creation_console_only"
    assert "red-repro" in str(e.value)


# ── The tools ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_shows_shared_and_the_owners_private_templates(tools):
    await _stored(
        tools,
        tools["user_id"],
        "mine-private",
        ROOM_TEMPLATE,
        read_visibility="private",
    )
    await _stored(tools, tools["stranger_id"], "theirs-shared", ROOM_TEMPLATE)
    await _stored(
        tools,
        tools["stranger_id"],
        "theirs-private",
        ROOM_TEMPLATE,
        read_visibility="private",
    )

    rows = await _as(tools["agent_id"], list_templates)

    assert {r["name"] for r in rows} == {"mine-private", "theirs-shared"}
    assert all(r["can_edit"] is False for r in rows)
    assert {r["saved_by"] for r in rows} == {"alice", "mallory"}


@pytest.mark.asyncio
async def test_get_describes_inputs_and_agent_slots(tools):
    template_id = await _stored(
        tools, tools["user_id"], "team", TEAM_TEMPLATE, kind="group"
    )

    detail = await _as(tools["agent_id"], get_template, template_id=template_id)

    assert [p["name"] for p in detail["params"]] == ["team", "provider"]
    assert [s["name"] for s in detail["agent_slots"]] == [
        "{team}-triager",
        "{team}-repro",
    ]
    assert detail["content"] == TEAM_TEMPLATE


@pytest.mark.asyncio
async def test_a_private_template_of_someone_else_does_not_exist_for_the_agent(tools):
    template_id = await _stored(
        tools, tools["stranger_id"], "secret", ROOM_TEMPLATE, read_visibility="private"
    )

    with pytest.raises(AgentRefused, match="No template"):
        await _as(tools["agent_id"], get_template, template_id=template_id)
    assert await _refusals(tools) == [("get_template", "not_found")]


@pytest.mark.asyncio
async def test_run_creates_the_room_under_the_templates_name(tools):
    template_id = await _stored(
        tools, tools["stranger_id"], "Topic room", ROOM_TEMPLATE
    )

    result = await _as(
        tools["agent_id"], run_template, template_id=template_id, inputs={"topic": "jq"}
    )

    async with tools["session_factory"]() as session:
        room = await session.get(Room, result["room_id"])
    assert room is not None
    assert (room.name, room.template_name) == ("jq room", "Topic room")
    assert room.created_by_agent_id == tools["agent_id"]


@pytest.mark.asyncio
async def test_run_a_team_template_with_existing_agents(tools):
    template_id = await _stored(
        tools, tools["user_id"], "team", TEAM_TEMPLATE, kind="group"
    )

    result = await _as(
        tools["agent_id"],
        run_template,
        template_id=template_id,
        inputs={"team": "red"},
        agents={"red-triager": "claude-code.alice", "red-repro": "claude-code.bob"},
    )

    assert result["room_name"] == "red-triage"
    assert (
        tools["admin"]
        .sent[-1]["body"]
        .startswith("@claude-code.alice say hello to @claude-code.bob.")
    )


@pytest.mark.asyncio
async def test_run_an_agent_template_with_an_existing_agent(tools):
    template_id = await _stored(
        tools, tools["user_id"], "jq", AGENT_TEMPLATE, kind="agent"
    )

    result = await _as(
        tools["agent_id"],
        run_template,
        template_id=template_id,
        agents={"jq-expert": "claude-code.bob"},
    )

    assert result["room_name"] == "Ask claude-code.bob"


@pytest.mark.asyncio
async def test_run_that_would_create_an_agent_is_refused_and_recorded(tools):
    template_id = await _stored(
        tools, tools["user_id"], "jq", AGENT_TEMPLATE, kind="agent"
    )

    with pytest.raises(AgentRefused, match="Switch Console"):
        await _as(tools["agent_id"], run_template, template_id=template_id)

    assert await _refusals(tools) == [("run_template", "agent_creation_console_only")]
    async with tools["session_factory"]() as session:
        refusal = (await session.execute(select(AgentRefusal))).scalar_one()
    assert refusal.subject == "jq"
    assert refusal.owner_id == tools["user_id"]
    assert refusal.agent_name == "claude-code.alice"


@pytest.mark.asyncio
async def test_missing_agents_are_named_all_at_once_and_nothing_is_created(tools):
    template_id = await _stored(
        tools, tools["user_id"], "team", TEAM_TEMPLATE, kind="group"
    )

    with pytest.raises(AgentRefused, match="ghost-one, ghost-two"):
        await _as(
            tools["agent_id"],
            run_template,
            template_id=template_id,
            inputs={"team": "red"},
            agents={"red-triager": "ghost-one", "red-repro": "ghost-two"},
        )
    async with tools["session_factory"]() as session:
        assert (await session.execute(select(Room))).scalars().all() == []


@pytest.mark.asyncio
async def test_save_is_owned_by_the_owner_and_marked_with_the_agent(tools):
    saved = await _as(
        tools["agent_id"],
        save_template,
        name="standup",
        description="Daily standup room",
        yaml=ROOM_TEMPLATE,
        visibility="shared",
    )

    async with tools["session_factory"]() as session:
        template = await session.get(Template, saved["id"])
    assert template is not None
    assert template.owner_id == tools["user_id"]
    assert template.created_by_agent_id == tools["agent_id"]
    assert (template.read_visibility, template.write_visibility) == (
        "public",
        "private",
    )
    assert saved["kind"] == "room"
    rows = await _as(tools["agent_id"], list_templates)
    assert [(r["name"], r["can_edit"], r["saved_by"]) for r in rows] == [
        ("standup", True, "agent claude-code.alice")
    ]


@pytest.mark.asyncio
async def test_save_refuses_a_template_anyone_could_change(tools):
    with pytest.raises(AgentRefused, match="not one an agent can set"):
        await _as(
            tools["agent_id"],
            save_template,
            name="open",
            description="",
            yaml=ROOM_TEMPLATE,
            visibility="open",
        )
    assert await _refusals(tools) == [("save_template", "visibility_not_allowed")]


@pytest.mark.asyncio
async def test_save_refuses_a_name_the_owner_already_uses(tools):
    await _stored(tools, tools["user_id"], "standup", ROOM_TEMPLATE)

    with pytest.raises(AgentRefused, match="already has a template named 'standup'"):
        await _as(
            tools["agent_id"],
            save_template,
            name="standup",
            description="",
            yaml=ROOM_TEMPLATE,
        )
    assert await _refusals(tools) == [("save_template", "name_taken")]


@pytest.mark.asyncio
async def test_an_agent_changes_and_deletes_what_it_saved(tools):
    saved = await _as(
        tools["agent_id"],
        save_template,
        name="standup",
        description="",
        yaml=ROOM_TEMPLATE,
    )

    updated = await _as(
        tools["agent_id"],
        update_template,
        template_id=saved["id"],
        yaml=ROOM_TEMPLATE.replace("A room about", "Talk about"),
        visibility="shared",
    )
    assert (updated["version"], updated["visibility"]) == (2, "shared")
    deleted = await _as(tools["agent_id"], delete_template, template_id=saved["id"])
    assert deleted["name"] == "standup"


@pytest.mark.asyncio
async def test_an_agent_cannot_change_its_owners_template(tools):
    template_id = await _stored(tools, tools["user_id"], "owners", ROOM_TEMPLATE)

    with pytest.raises(AgentRefused, match="saved by alice"):
        await _as(
            tools["agent_id"], update_template, template_id=template_id, description="x"
        )
    with pytest.raises(AgentRefused, match="saved by alice"):
        await _as(tools["agent_id"], delete_template, template_id=template_id)
    assert await _refusals(tools) == [
        ("update_template", "not_yours"),
        ("delete_template", "not_yours"),
    ]


@pytest.mark.asyncio
async def test_an_agent_cannot_change_another_agents_template_of_the_same_owner(tools):
    saved = await _as(
        await _bob_id(tools),
        save_template,
        name="bobs",
        description="",
        yaml=ROOM_TEMPLATE,
        visibility="shared",
    )

    with pytest.raises(AgentRefused, match="saved by agent claude-code.bob"):
        await _as(tools["agent_id"], delete_template, template_id=saved["id"])
