"""The room templates that come with Switch: one document each in
official_templates/rooms/, each creating a room and its agents, served only
with agent management and never revised."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from switch_core import official_templates as official
from switch_core.agent_templates import plan_template
from switch_core.management.schemas import MAX_INSTRUCTIONS_BYTES
from switch_core.official_templates import official_templates
from switch_core.rooms_yaml import RoomSpec
from switch_core.template_lint import lint_template

_ROOMS = (
    Path(__file__).resolve().parents[2] / "switch_core" / "official_templates" / "rooms"
)
_DOCUMENTS = sorted(p for p in _ROOMS.glob("*.yaml") if p.name != "catalogue.yaml")
_BUILTINS = {
    "$creator": "zoe",
    "$creator_email": "zoe@example.com",
    "$date": "2026-11-11",
    "$timestamp": "0",
    "$agents_dir": "/home/zoe/agents",
}
_MACHINES = [
    {
        "id": "m-laptop",
        "name": "laptop",
        "state": "online",
        "providers": [{"provider": "claude", "installed": True, "auth": "ok"}],
    }
]


def _rooms(agent_management: bool, switch_buddy: bool) -> list:
    return [
        t
        for t in official_templates(agent_management, switch_buddy)
        if t.kind == "room"
    ]


def _inputs(params: dict) -> dict:
    """A value for every param a run must be given."""
    inputs: dict = {"bridge": "Slack", "machine": "laptop"}
    for name, spec in params.items():
        if spec["type"] == "provider":
            inputs[name] = "claude"
        elif spec["type"] == "enum":
            inputs[name] = spec["enum"][0]
        elif spec["type"] == "string":
            inputs[name] = f"{name} one"
    return inputs


def test_the_34_room_templates_are_served_only_with_agent_management():
    for switch_buddy in (True, False):
        rooms = _rooms(True, switch_buddy)
        assert len(rooms) == 34 == len({t.id for t in rooms})
        assert all(t.removable for t in rooms)
        assert [t.id for t in rooms] == [f"official:{p.stem}" for p in _DOCUMENTS]
        assert _rooms(False, switch_buddy) == []
    agents = [t for t in official_templates(True, True) if t.kind == "agent"]
    assert agents and not any(t.removable for t in agents)


def test_every_room_template_plans_its_room_and_agents():
    for template in _rooms(True, False):
        assert template.name and template.description, template.id
        assert template.version == 1
        result = lint_template(template.content)
        assert result.errors == [] and result.warnings == [], template.id
        data = yaml.safe_load(template.content)
        kinds = [r["type"] for r in data["resources"].values()]
        assert kinds.count("room") == 1 and 1 <= kinds.count("agent") <= 3
        plan = plan_template(
            template.content,
            {},
            _inputs(data["params"]),
            builtins=_BUILTINS,
            machines=_MACHINES,
        )
        assert len(plan.new_agents) == kinds.count("agent"), template.id
        assert {a.machine for a in plan.new_agents} == {"laptop"}
        assert {a.provider for a in plan.new_agents} == {"claude"}
        assert all(
            len(a.instructions.encode()) <= MAX_INSTRUCTIONS_BYTES
            for a in plan.new_agents
        )
        room = RoomSpec.model_validate(yaml.safe_load(plan.document)["room"])
        assert sorted(room.agents) == sorted(a.name for a in plan.new_agents)
        assert room.users == ["{$creator}"] and room.bridge == "{bridge}"
        assert room.instructions


def test_room_template_runs_without_bridge():
    """Templates with optional bridge param should plan successfully when bridge is omitted."""
    incident_template = next(
        t for t in _rooms(True, False) if t.id == "official:incident-war-room"
    )

    inputs = {
        "provider": "claude",
        "machine": "laptop",
        "incident": "API latency spike",
        "severity": "SEV1 - Critical",
    }

    plan = plan_template(
        incident_template.content,
        {},
        inputs,
        builtins=_BUILTINS,
        machines=_MACHINES,
    )

    assert len(plan.new_agents) == 3
    assert {a.machine for a in plan.new_agents} == {"laptop"}
    assert {a.provider for a in plan.new_agents} == {"claude"}

    room = RoomSpec.model_validate(yaml.safe_load(plan.document)["room"])
    assert sorted(room.agents) == sorted(a.name for a in plan.new_agents)
    assert room.instructions


def test_a_room_template_the_catalogue_does_not_name_fails_loud(tmp_path, monkeypatch):
    (tmp_path / "a.yaml").write_text("version: 2\n")
    (tmp_path / "catalogue.yaml").write_text("a: {name: A}\n")
    monkeypatch.setattr(official, "_ROOMS", tmp_path)
    monkeypatch.setattr(official, "_CATALOGUE", tmp_path / "catalogue.yaml")
    with pytest.raises(RuntimeError, match="no name or no description"):
        official._room_templates.__wrapped__()
    (tmp_path / "b.yaml").write_text("version: 2\n")
    with pytest.raises(RuntimeError, match=r"one side only: \['b'\]"):
        official._room_templates.__wrapped__()
