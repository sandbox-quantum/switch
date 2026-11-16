"""What a name people type may hold, past what each kind of name allows.

No name may hold a character that changes how the text around it reads
without showing itself:

- a bidirectional control (U+202A-U+202E, U+2066-U+2069), which reorders what
  follows it, so "report <U+202E>slrep.exe" reads as "report exe.perls";
- a zero-width or invisible character (U+200B, U+200E, U+200F, U+2060,
  U+FEFF), which makes two names that look alike differ, or hides one inside
  another.

Text in any script is fine; only these are refused. The zero-width joiner and
non-joiner (U+200C, U+200D) are allowed: emoji sequences and Persian and Indic
writing need them. A workspace's or an
organization's name is also held to one line (`OneLineName`), as the switcher
and the breadcrumbs show it.
"""

from __future__ import annotations

import unicodedata
from typing import Annotated

from pydantic import AfterValidator, StringConstraints
from pydantic_core import PydanticCustomError

HIDDEN_CHARACTERS = frozenset(
    chr(code)
    for code in (
        *range(0x202A, 0x202F),
        *range(0x2066, 0x206A),
        0x200B,
        0x200E,
        0x200F,
        0x2060,
        0xFEFF,
    )
)

MAX_ONE_LINE_NAME_LENGTH = 255


def hidden_character_refusal(name: str) -> str | None:
    """Why `name` is refused, naming the first hidden character in it; None
    for a name with none."""
    for char in name:
        if char in HIDDEN_CHARACTERS:
            label = unicodedata.name(char, "")
            return (
                f"A name can't contain U+{ord(char):04X}"
                + (f" ({label})" if label else "")
                + ": it changes how the name reads without showing."
            )
    return None


def refuse_hidden_characters(name: str) -> str:
    """`name`, or a ValueError saying which hidden character it holds."""
    refusal = hidden_character_refusal(name)
    if refusal is not None:
        raise ValueError(refusal)
    return name


def no_hidden_characters(name: str) -> str:
    """`refuse_hidden_characters` as a pydantic validator, which a body
    refuses with a 422."""
    refusal = hidden_character_refusal(name)
    if refusal is not None:
        raise PydanticCustomError("hidden_character", refusal)
    return name


def _shown_on_one_line(name: str) -> str:
    """A name shown on one line, as a breadcrumb or a switcher shows it: with
    a character in it that can be seen, so it is never blank there, and no
    control character, such as a line break, to break the line."""
    if any(unicodedata.category(char) == "Cc" for char in name):
        raise PydanticCustomError(
            "control_character", "A name can't contain a line break or a tab."
        )
    if not any(char.isprintable() and not char.isspace() for char in name):
        raise PydanticCustomError(
            "nothing_visible", "A name needs at least one visible character."
        )
    return name


# A name in a request body: refused, as a 422, when it holds a hidden
# character.
Name = Annotated[str, AfterValidator(no_hidden_characters)]

# A workspace's or an organization's name, on create and rename alike.
OneLineName = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=MAX_ONE_LINE_NAME_LENGTH
    ),
    AfterValidator(_shown_on_one_line),
    AfterValidator(no_hidden_characters),
]
