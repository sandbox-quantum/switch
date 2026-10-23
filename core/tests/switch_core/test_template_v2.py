"""Version 2 templates: resources with a key and a type, references by key,
and `if:` on resources, params and field values, compiled into the version 1
document the rest of the engine runs."""

from __future__ import annotations

import pytest
import yaml

from switch_core.agent_templates import agent_slots, plan_template, template_kind
from switch_core.rooms_yaml import ExistingPackageById, ExistingPackageByName, RoomSpec
from switch_core.template_lint import lint_template
from switch_core.template_v2 import TemplateError, compile_v2, holds

EXPERT = """\
version: 2
params:
  name: { type: string, default: Switch expert }
  start_in:
    type: enum
    enum: [nowhere, new_room, existing_room]
    default: nowhere
  existing_room:
    type: room
    if: "{start_in} == existing_room"
  bridge: { type: bridge, default: [Slack, $first], required: false }
  provider: { type: provider, default: [claude, codex], input: advanced }
  machine: { type: machine, default: [$first], input: advanced }
  directory:
    type: directory
    default: "{$agents_dir}/{expert.name}"
    input: advanced
resources:
  expert:
    type: agent
    display_name: "{name}"
    instructions: Answer questions about Switch.
    provider: "{provider}"
    machine: "{machine}"
    directory: "{directory}"
    repo: https://github.com/sandbox-quantum/switch
    join: ["{existing_room}"]
    addressing:
      - if: "{start_in} == new_room"
        value: { anyone_in: [expert_room] }
      - value: anyone
  expert_room:
    type: room
    if: "{start_in} == new_room"
    name: "Ask {expert.name}"
    description: Where you ask {expert.name} about Switch.
    bridge: "{bridge}"
    agents: [expert]
    users: ["{$creator}"]
    kickoff: "@{expert.name} hi."
"""

MACHINES = [
    {
        "id": "m-laptop",
        "name": "laptop",
        "state": "online",
        "providers": [{"provider": "claude", "installed": True, "auth": "ok"}],
    }
]


def _compiled(inputs: dict, text: str = EXPERT) -> dict:
    compiled = compile_v2(text, inputs, {"$creator": "ada"})
    return yaml.safe_load(compiled.document)


def test_conditions():
    assert holds("{a}", {"a": True}) and not holds("{a}", {"a": ""})
    assert holds("{a} == x", {"a": "x"}) and holds("{a} != x", {"a": "y"})
    assert not holds("{a} == x", {})
    with pytest.raises(TemplateError):
        holds("a == x", {"a": "x"})


def test_nowhere_creates_the_agent_alone_and_open_to_anyone():
    doc = _compiled({})
    (agent,) = doc["agents"]
    assert agent["name"] == "switch-expert"
    assert agent["addressing"] == "anyone"
    assert "room" not in doc and "kickoff" not in doc
    # The param asked only for an existing room is not part of this run.
    assert "existing_room" not in doc["params"]


def test_new_room_names_the_agent_by_key_and_opens_it_to_that_room():
    compiled = compile_v2(EXPERT, {"start_in": "new_room"}, {"$creator": "ada"})
    doc = yaml.safe_load(compiled.document)
    assert doc["room"]["name"] == "Ask switch-expert"
    assert doc["room"]["agents"] == ["switch-expert"]
    assert doc["kickoff"] == "@switch-expert hi."
    assert compiled.room_addressing == {"switch-expert": ["Ask switch-expert"]}
    assert doc["agents"][0]["addressing"] == "owner"


def test_existing_room_joins_the_one_picked():
    doc = _compiled({"start_in": "existing_room", "existing_room": "lobby"})
    assert doc["agents"][0]["join"] == ["{existing_room}"]
    assert doc["params"]["existing_room"]["type"] == "room"
    assert "room" not in doc


def test_a_reference_to_a_resource_that_is_off_is_refused():
    text = EXPERT.replace('join: ["{existing_room}"]', 'join: ["{expert_room.name}"]')
    with pytest.raises(
        TemplateError, match="expert_room, which this run does not create"
    ):
        _compiled({}, text)


def test_a_rooms_packages_pass_through_to_the_room_block():
    text = """\
version: 2
params:
  context: { type: string, default: Payments context }
resources:
  work:
    type: room
    name: Work
    description: d
    packages: [{id: pkg-1}, {name: "{context}"}]
"""
    compiled = compile_v2(text, {}, {"$creator": "ada"})
    doc = yaml.safe_load(compiled.document)
    assert doc["room"]["packages"] == [{"id": "pkg-1"}, {"name": "{context}"}]
    room = RoomSpec.model_validate(
        {**doc["room"], "packages": [{"id": "pkg-1"}, {"name": "Payments context"}]}
    )
    assert room.packages == [
        ExistingPackageById(id="pkg-1"),
        ExistingPackageByName(name="Payments context"),
    ]


def test_several_rooms_need_a_group_and_links_name_rooms_by_key():
    text = """\
version: 2
resources:
  team: { type: group, name: Team, links: [{from: lobby, to: work, label: next}] }
  lobby: { type: room, name: Lobby, description: d, group: team, kickoff: hi }
  work: { type: room, name: Work, description: d, group: team }
"""
    doc = _compiled({}, text)
    assert doc["group"] == {"name": "Team"}
    assert [r["name"] for r in doc["rooms"]] == ["Lobby", "Work"]
    assert doc["rooms"][0]["kickoff"] == "hi"
    assert doc["links"] == [{"from": "Lobby", "to": "Work", "label": "next"}]
    with pytest.raises(TemplateError, match="Several rooms go in a group"):
        _compiled(
            {},
            text.replace(
                "  team: { type: group, name: Team, links: [{from: lobby, to: work, label: next}] }\n",
                "",
            ),
        )


def test_kind_and_slots():
    assert template_kind(EXPERT) == "agent"
    (slot,) = agent_slots(EXPERT)
    assert (slot.key, slot.name, slot.machine) == ("expert", "{name}", "{machine}")


def test_plan_resolves_the_machine_and_keeps_the_room_addressing():
    plan = plan_template(
        EXPERT,
        {},
        {"start_in": "new_room"},
        builtins={"$creator": "ada"},
        machines=MACHINES,
    )
    (agent,) = plan.new_agents
    assert (agent.name, agent.machine, agent.provider) == (
        "switch-expert",
        "m-laptop",
        "claude",
    )
    assert agent.directory == "{$agents_dir}/switch-expert"
    assert plan.room_addressing == {"switch-expert": ["Ask switch-expert"]}
    assert yaml.safe_load(plan.document or "")["room"]["agents"] == ["switch-expert"]


def test_an_agent_without_addressing_is_planned_on_the_default():
    document = EXPERT.replace(
        """    addressing:
      - if: "{start_in} == new_room"
        value: { anyone_in: [expert_room] }
      - value: anyone
""",
        "",
    )
    plan = plan_template(
        document, {}, {}, builtins={"$creator": "ada"}, machines=MACHINES
    )
    (agent,) = plan.new_agents
    assert agent.addressing == "owner-agents"


def test_lint_reads_a_v2_document():
    assert lint_template(EXPERT).warnings == []
    broken = EXPERT.replace("type: room\n    if:", "type: rom\n    if:").replace(
        '"{start_in} == new_room"\n    name', '"start_in == new_room"\n    name'
    )
    codes = {f.code for f in lint_template(broken).errors}
    assert "invalid_resource_type" in codes
    unknown = lint_template(EXPERT.replace("{expert.name} hi", "{nobody.name} hi"))
    assert "unknown_reference" in {w.code for w in unknown.warnings}


def test_an_input_that_refers_to_a_resource_is_resolved():
    plan = plan_template(
        EXPERT,
        {},
        {"name": "Expert N1", "directory": "{$agents_dir}/{expert.name}"},
        builtins={"$creator": "ada"},
        machines=MACHINES,
    )
    (agent,) = plan.new_agents
    assert agent.directory == "{$agents_dir}/expert-n1"


def test_an_existing_room_to_join_comes_from_the_input():
    plan = plan_template(
        EXPERT,
        {},
        {"start_in": "existing_room", "existing_room": "gamma-room"},
        builtins={"$creator": "ada"},
        machines=MACHINES,
    )
    assert plan.new_agents[0].joins == ["gamma-room"]


def test_an_existing_room_left_out_is_refused():
    from switch_core.template_runs import AgentsNotCreated

    with pytest.raises(AgentsNotCreated) as e:
        plan_template(
            EXPERT,
            {},
            {"start_in": "existing_room"},
            builtins={"$creator": "ada"},
            machines=MACHINES,
        )
    assert {p.code for p in e.value.problems} == {"input_missing"}
