"""What a template creates, as the catalogue counts it: the agents and rooms
its document describes, in either version of the language."""

from __future__ import annotations

import pytest

from switch_core.agent_templates import TemplateCounts, template_counts


def test_a_version_2_document_counts_its_resources_by_type():
    text = """\
version: 2
params:
  start_in: { type: enum, enum: [nowhere, new_room], default: nowhere }
resources:
  expert: { type: agent, display_name: Switch expert }
  expert_room:
    type: room
    if: "{start_in} == new_room"
    name: "Ask {expert.name}"
    agents: [expert]
"""
    # The room may not be created, depending on the inputs, and still counts.
    assert template_counts(text) == TemplateCounts(agents=1, rooms=1)


def test_a_version_2_group_counts_each_of_its_rooms_and_not_itself():
    text = """\
version: 2
resources:
  lead: { type: agent, display_name: Lead }
  helper: { type: agent, display_name: Helper, if: "{extra}" }
  lobby: { type: room, name: Lobby, group: team }
  work: { type: room, name: Work, group: team }
  team: { type: group, name: Team }
"""
    assert template_counts(text) == TemplateCounts(agents=2, rooms=2)


@pytest.mark.parametrize(
    ("text", "counts"),
    [
        ("room:\n  name: r\n  agents: [someone-already-here]\n", (0, 1)),
        ("agent:\n  name: solo\n", (1, 0)),
        (
            "agents:\n  - name: a\n  - name: b\n  - not an agent\nroom:\n  name: r\n",
            (2, 1),
        ),
        (
            "agent:\n  name: a\ngroup:\n  name: g\nrooms:\n  - name: one\n  - name: two\n",
            (1, 2),
        ),
        ("params:\n  x: { type: string }\n", (0, 0)),
    ],
    ids=["room", "agent", "team", "group", "nothing"],
)
def test_a_version_1_document_counts_its_blocks(text: str, counts: tuple[int, int]):
    assert template_counts(text) == TemplateCounts(*counts)


@pytest.mark.parametrize(
    "text",
    [
        "room: [unclosed\n",
        "- a list\n",
        "version: 2\nresources:\n  x: { name: no type }\n",
    ],
    ids=["not-yaml", "not-a-mapping", "resource-without-a-type"],
)
def test_a_document_that_does_not_parse_raises(text: str):
    with pytest.raises(ValueError):
        template_counts(text)
