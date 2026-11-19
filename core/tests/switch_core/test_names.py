"""The characters no name may hold (`names`), and the ways in besides the
gateway's request bodies that refuse them."""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from switch_core.agent_display_name import InvalidDisplayName, validate_display_name
from switch_core.bridges.agent.operations.definitions import (
    create_room,
    create_room_group,
    update_room,
)
from switch_core.names import (
    HIDDEN_CHARACTERS,
    Name,
    OneLineName,
    refuse_hidden_characters,
)
from switch_core.rooms_yaml import GroupMeta, RoomSpec

RLO = "\u202e"


def test_the_hidden_characters_are_the_bidi_controls_and_the_invisible_ones() -> None:
    assert sorted(f"{ord(c):04X}" for c in HIDDEN_CHARACTERS) == [
        "200B",
        "200E",
        "200F",
        "202A",
        "202B",
        "202C",
        "202D",
        "202E",
        "2060",
        "2066",
        "2067",
        "2068",
        "2069",
        "FEFF",
    ]


@pytest.mark.parametrize("char", sorted(HIDDEN_CHARACTERS))
def test_each_is_refused_and_named(char: str) -> None:
    with pytest.raises(ValueError, match=f"U\\+{ord(char):04X}"):
        refuse_hidden_characters(f"ops{char}team")


@pytest.mark.parametrize(
    "name",
    [
        "Équipe",
        "東京チーム",
        "فريق العمليات",
        "צוות",
        "команда",
        "Ops 🚀",
        # Joiners: a family emoji, and Persian that needs the non-joiner.
        "Team 👨‍👩‍👧",
        "می‌خواهم",
        # Next to the refused ranges, and shown: a hair space, a hyphen and
        # a narrow no-break space.
        "a\u200ab",
        "a\u2010b",
        "a\u202fb",
    ],
)
def test_text_in_any_script_is_kept(name: str) -> None:
    assert refuse_hidden_characters(name) == name
    assert TypeAdapter(Name).validate_python(name) == name


def test_a_one_line_name_is_trimmed_to_rename_rules() -> None:
    adapter = TypeAdapter(OneLineName)
    assert adapter.validate_python("  Acme  ") == "Acme"
    for refused in ("x" * 256, "a\nb", "a\tb", "   ", f"Acme{RLO}"):
        with pytest.raises(ValidationError):
            adapter.validate_python(refused)


def test_an_agent_display_name_refuses_them() -> None:
    with pytest.raises(InvalidDisplayName, match="U\\+202E"):
        validate_display_name(f"Helper {RLO}rof")


def test_a_template_room_or_group_name_refuses_them() -> None:
    with pytest.raises(ValidationError, match="U\\+202E"):
        RoomSpec(name=f"room{RLO}", description="d")
    with pytest.raises(ValidationError, match="U\\+202E"):
        GroupMeta(name=f"group{RLO}")


async def test_an_agents_room_tools_refuse_them() -> None:
    """Before anything else is asked: no caller is bound here."""
    with pytest.raises(ValueError, match="U\\+202E"):
        await create_room(name=f"room{RLO}", description="d", agent_names=[])
    with pytest.raises(ValueError, match="U\\+202E"):
        await update_room(room_id="r1", name=f"room{RLO}")
    with pytest.raises(ValueError, match="U\\+202E"):
        await create_room_group(name=f"group{RLO}")
