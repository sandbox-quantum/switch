"""Validating an agent's human display name, and writing it into a message.

An agent's `name` is a machine identifier — lowercase, no spaces — because it
is addressed, mentioned and matched on. A display name is the other half: the
label a person reads ("Switch Dev" beside "switchdev"), so uppercase, spaces
and punctuation are exactly what it exists to allow.

It is rendered into message headers on the collaboration bridges, which is what
the validation rules constrain: a newline or a control character in a header is
a way to forge a line the platform never sent, and length has to fit the
narrowest consumer rather than the widest.

Everything punctuation-shaped that survives validation is then the render
helpers' problem — see `defuse_label_markup`. They live here, free of any
bridge or database import, so the `!` command surface and the collaboration
adapters can share one rule rather than each growing their own.
"""

from typing import NoReturn

# Discord caps a webhook username at 80 characters; the other platforms sit at
# or above that. 64 is a safe intersection with room to spare, and short enough
# that a display name stays a label rather than a sentence.
MAX_DISPLAY_NAME_LENGTH = 64

_ZERO_WIDTH_SPACE = "\u200b"


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


def defuse_label_markup(label: str) -> str:
    """Neutralise the markup a label can use to claim something it is not.

    A display name is free text an agent's owner chooses, and it is inlined
    into message bodies that reach chat platforms. Two constructs are near
    universal there:

    - `@…` addresses somebody. Whether the reader's platform resolves
      `@channel`, `@here`, a person, or one of Switch's own agent handles on
      the way out, an un-defused label gets to notify people the message was
      never aimed at. A zero-width space after every `@` leaves the sigil
      legible and the resolution dead.
    - `[text](url)` renders an anchor whose destination the label chose and
      whose visible text hides it. The zero-width space goes after the `]`,
      breaking the `](` adjacency every Markdown dialect requires — after the
      `[` it lands inside the visible text and the link still matches.

    Defused rather than escaped, because the result has to survive as far as
    whatever renders it: a backslash escape would have to match the dialect at
    the far end, while a zero-width space is inert in every escaping pipeline
    it may pass through afterwards, so it cannot compound with one.
    """
    return label.replace("@", "@" + _ZERO_WIDTH_SPACE).replace(
        "]", "]" + _ZERO_WIDTH_SPACE
    )


def agent_label(display_name: str | None, name: str) -> str:
    """How to write an agent where the text is pure attribution.

    The display name when there is one, otherwise the identifier — defused
    with `defuse_label_markup`, because the caller is putting it into a body
    that nothing downstream escapes for it.

    For text a reader also has to type or copy back, use
    `agent_label_with_identifier`: this one can render a label that addresses
    nothing.
    """
    return defuse_label_markup(display_name or name)


def agent_label_with_identifier(display_name: str | None, name: str) -> str:
    """How to write an agent where the reader both reads and copies the name.

    ``Switch Dev (`switchdev`)`` — the defused display name, then the
    identifier that actually routes, so a reader can act on the line as well as
    read it. The identifier is in backticks because Discord and Slack resolve
    no mention inside a code span: it stays copyable without becoming a live
    ping of whoever happens to hold that handle on the platform.

    An agent with no display name renders as the bare identifier; there is
    nothing to disambiguate, and ``switchdev (`switchdev`)`` reads as noise.
    """
    if not display_name:
        return name

    return f"{defuse_label_markup(display_name)} (`{name}`)"
