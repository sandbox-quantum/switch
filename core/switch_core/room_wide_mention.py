"""The room-wide mention: an agent notifying every person in a room at once.

An agent asks for one with the reserved target `everyone` on
`send_targeted_message`. It reaches the people, never the agents. Addressing
matches only an agent's name, its room alias or a role it holds (see
`delivery/addressing.py`), and `everyone` is reserved so that none of those can
be it. Where a name predates the reservation, the send refuses rather than
wake whoever holds it.

What makes a bridge ping the channel is the marker below, never the message
text. The body opens with a readable `@everyone` for the transcript, but only a
message the server marked is rendered as the platform's channel-wide mention.
Every other outbound body has these words defused, so an agent typing
`@channel` into an ordinary message cannot page anyone.

`channel`, `here` and `all` are reserved alongside `everyone` because they are
the platforms' own words for it: Mattermost passes a person's `@channel`
through as text, so an agent named `channel` would be addressed every time
somebody paged the room.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from switch_core.clients.mentions import NAME_CHAR

ROOM_WIDE_TARGET = "everyone"

RESERVED_MENTION_NAMES = frozenset({ROOM_WIDE_TARGET, "channel", "here", "all"})

# Stamped on the content of a message the server sent as a room-wide mention.
# Only `ProtocolService.send_targeted_message` writes it; a bridge reads it to
# decide whether to render the platform's channel-wide mention.
ROOM_WIDE_MENTION_MARKER = "com.switch.room_wide_mention"

_ZERO_WIDTH_SPACE = "\u200b"

# A reserved word after `@`, allowing the trailing `.`, `-` or `_` a platform
# strips before matching (Mattermost pages the channel for `@channel.`), but
# not a longer handle that merely starts with one (`@allison`, `@all-hands`).
_MASS_MENTION_AT = re.compile(
    rf"@(?=(?:{'|'.join(sorted(RESERVED_MENTION_NAMES))})[._-]*(?!{NAME_CHAR}))",
    re.IGNORECASE,
)

# Left exactly as written. No platform resolves a mention inside code or a
# URL, and those are where a defused `@` would do harm: `npm install
# @here/sdk` copied out of a message, or a link to `…/package/@here/sdk`,
# would carry the zero-width space with it. A URL must start its host with a
# letter or digit, so `http://@channel` is not one.
_UNTOUCHED = re.compile(
    r"```.*?```|~~~.*?~~~|`[^`\n]*`|https?://[A-Za-z0-9]\S*",
    re.DOTALL | re.IGNORECASE,
)

_LEADING_TARGET = re.compile(rf"\A@{ROOM_WIDE_TARGET}(?!{NAME_CHAR})[ \t]*")


def is_reserved_mention_name(name: str) -> bool:
    return name.casefold() in RESERVED_MENTION_NAMES


def reject_reserved_mention_name(name: str, *, kind: str) -> None:
    """Raise ValueError when `name` is one of the room-wide mention words.

    `kind` names what was being created ("Agent name", "Role name") so the
    message says which field to change.
    """
    if is_reserved_mention_name(name):
        raise ValueError(
            f"{kind} {name!r} is reserved for room-wide mentions, so it cannot "
            "name an agent, alias or role."
        )


def room_wide_mention_content() -> dict[str, object]:
    """The `extra_content` that marks a message as a room-wide mention."""
    return {ROOM_WIDE_MENTION_MARKER: {}}


def is_room_wide_mention(content: Mapping[str, object]) -> bool:
    return ROOM_WIDE_MENTION_MARKER in content


def strip_room_wide_target(body: str) -> str:
    """Remove the leading `@everyone` the server wrote, so a bridge can put its
    own platform's mention in its place."""
    return _LEADING_TARGET.sub("", body, count=1)


def defuse_mass_mention_words(text: str) -> str:
    """Break every `@everyone`, `@channel`, `@here` and `@all` outside code
    and URLs.

    A zero-width space after the `@` leaves the word legible and the mention
    dead, the same defusal `defuse_label_markup` applies to display names.
    """
    parts: list[str] = []
    last = 0
    for span in _UNTOUCHED.finditer(text):
        parts.append(
            _MASS_MENTION_AT.sub("@" + _ZERO_WIDTH_SPACE, text[last : span.start()])
        )
        parts.append(span.group(0))
        last = span.end()
    parts.append(_MASS_MENTION_AT.sub("@" + _ZERO_WIDTH_SPACE, text[last:]))
    return "".join(parts)
