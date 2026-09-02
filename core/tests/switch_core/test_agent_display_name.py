"""Display name validation.

The acceptance cases matter as much as the rejections here: the point of a
display name is to allow what an agent identifier cannot — capitals, spaces,
punctuation — so a rule that quietly narrowed it would defeat the field.
"""

import pytest

from switch_core.agent_display_name import (
    MAX_DISPLAY_NAME_LENGTH,
    InvalidDisplayName,
    normalise_display_name,
    validate_display_name,
)


@pytest.mark.parametrize(
    "value",
    [
        "Switch Dev",
        "SWITCH",
        "Ana's Reviewer",
        "Switch Dev (staging)",
        "Réviseur",
        "研究員",
        "Switch — Dev",
        "S" * MAX_DISPLAY_NAME_LENGTH,
    ],
)
def test_accepts_human_readable_names(value: str) -> None:
    assert validate_display_name(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "  Switch Dev  ",
        "Switch Dev\n",
        "\tSwitch Dev",
    ],
)
def test_strips_surrounding_whitespace(value: str) -> None:
    assert validate_display_name(value) == "Switch Dev"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        "S" * (MAX_DISPLAY_NAME_LENGTH + 1),
        # A display name is rendered into a message header, so a line break is
        # a way to forge a line the platform never sent.
        "Switch\nDev",
        "Switch\rDev",
        "Switch\x00Dev",
        "Switch\x1bDev",
        "Switch\x7fDev",
        "Switch\x9bDev",
        "Switch\x85Dev",
        "Switch\u2028Dev",
        "Switch\u2029Dev",
    ],
)
def test_rejects_blank_overlong_and_control_characters(value: str) -> None:
    with pytest.raises(InvalidDisplayName):
        validate_display_name(value)


@pytest.mark.parametrize("value", [None, "", "   ", "\n"])
def test_normalise_collapses_absent_and_blank_to_none(value: str | None) -> None:
    assert normalise_display_name(value) is None


def test_normalise_validates_anything_else() -> None:
    assert normalise_display_name("  Switch Dev  ") == "Switch Dev"
    with pytest.raises(InvalidDisplayName):
        normalise_display_name("Switch\nDev")
