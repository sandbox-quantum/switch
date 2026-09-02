"""Validation for an agent's human display name.

An agent's `name` is a machine identifier — lowercase, no spaces — because it
is addressed, mentioned and matched on. A display name is the other half: the
label a person reads ("Switch Dev" beside "switchdev"), so uppercase, spaces
and punctuation are exactly what it exists to allow.

It is rendered into message headers on the collaboration bridges, which is what
the rules below constrain: a newline or a control character in a header is a
way to forge a line the platform never sent, and length has to fit the
narrowest consumer rather than the widest.
"""

from typing import NoReturn

# Discord caps a webhook username at 80 characters; the other platforms sit at
# or above that. 64 is a safe intersection with room to spare, and short enough
# that a display name stays a label rather than a sentence.
MAX_DISPLAY_NAME_LENGTH = 64


class InvalidDisplayName(ValueError):
    """Raised when a display name is empty, over-long, or unsafe to render."""


def _reject(reason: str) -> NoReturn:
    raise InvalidDisplayName(f"Invalid agent display name: {reason}")


def _is_control_or_line_break(character: str) -> bool:
    """True for C0, DEL, C1, and the Unicode line terminators.

    U+2028, U+2029 and U+0085 are not C0 controls but end a line for the
    consumers a display name reaches — Python's own `splitlines`, and JSON and
    JavaScript on the bridge side — so they are line breaks for this purpose.
    """
    code_point = ord(character)
    return (
        code_point < 0x20 or 0x7F <= code_point <= 0x9F or character in "\u2028\u2029"
    )


def validate_display_name(value: str) -> str:
    """Return `value` stripped, or raise `InvalidDisplayName`.

    Accepts any printable text — uppercase, spaces and punctuation are the
    point. Rejects a blank value, one longer than `MAX_DISPLAY_NAME_LENGTH`,
    and any control character or line break.
    """
    if not isinstance(value, str):
        _reject("must be a string")

    candidate = value.strip()
    if not candidate:
        _reject("must not be empty")

    if len(candidate) > MAX_DISPLAY_NAME_LENGTH:
        _reject(f"must be at most {MAX_DISPLAY_NAME_LENGTH} characters")

    if any(_is_control_or_line_break(character) for character in candidate):
        _reject("must not contain line breaks or control characters")

    return candidate


def normalise_display_name(value: str | None) -> str | None:
    """Validate an optional display name, treating blank as "no display name".

    Callers accept `None` to mean "leave unset" and an empty string to mean
    "clear it"; both collapse to `None` so a cleared display name is stored as
    NULL rather than as an empty string the display layer would have to
    special-case.
    """
    if value is None:
        return None

    if not value.strip():
        return None

    return validate_display_name(value)
