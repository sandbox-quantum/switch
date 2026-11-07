"""Rendering Switch Markdown as Zulip's own Markdown, and splitting a long
reply under Zulip's `max_message_length` without breaking a code fence or a
multi-codepoint character.

Zulip's own body syntax is CommonMark-flavoured and already spells `**bold**`
and backtick code the way Switch Markdown does, so this is mostly a pass
through plus Zulip's own mention syntax (`@**name**`) handling. Pure
functions, no network.
"""

from __future__ import annotations

import re

#: Zulip's wildcard-mention words, each written as `@**word**` (two
#: asterisks on each side) rather than a bare `@word`, so the base adapter's
#: word-level mass-mention defusal does not see them.
_WILDCARDS = ("all", "everyone", "channel", "stream", "topic")
_WILDCARD_MENTION = re.compile(r"@\*\*(" + "|".join(_WILDCARDS) + r")\*\*")

#: An inbound real-name mention: `@**Full Name**`, optionally
#: disambiguated with `|<user_id>`, or silent with a leading `@_`.
_NAME_MENTION = re.compile(r"@_?\*\*([^*|]+)(?:\|\d+)?\*\*")
_GROUP_MENTION = re.compile(r"@\*([^*]+)\*")


def defuse_wildcard_mentions(text: str) -> str:
    """Break `@**all**` and friends with a zero-width space, the same shape
    of defence the base class's `defuse_mass_mention_words` gives bare
    `@everyone` — needed in addition to it because Zulip's wildcards are
    never bare words, they are always wrapped in `@**...**`."""
    return _WILDCARD_MENTION.sub(lambda m: f"@**​{m.group(1)}**", text)


def render_mentions_outbound(text: str) -> str:
    """An `@Name` Switch wrote (resolved by the caller to a real display
    name) is left as plain text here: this adapter does not resolve a
    Switch handle to a Zulip user id (`search_directory_users` is not
    implemented), so there is nothing to turn into a real `@**Name**`
    mention outbound. Kept as its own function so that becomes a one-line
    change if a directory lookup is added later."""
    return text


def translate_mentions_inbound(text: str) -> str:
    """Zulip's own mention markup, rendered back to the plain `@name` form
    the rest of Switch matches agent and user names against."""
    text = _NAME_MENTION.sub(lambda m: f"@{m.group(1)}", text)
    text = _GROUP_MENTION.sub(lambda m: f"@{m.group(1)}", text)
    return text


def _opens_unclosed_fence(chunk: str) -> bool:
    """Whether `chunk` ends with a ``` fence still open (an odd number of
    ``` markers), counting the opening marker this function itself
    prepended when the chunk continues one from the previous piece."""
    return chunk.count("```") % 2 == 1


def split_to_chunks(text: str, *, max_length: int) -> list[str]:
    """Split `text` into pieces of at most `max_length` Unicode code points
    (Zulip's own unit for `max_message_length`), on paragraph or word
    boundaries, never inside a multi-codepoint grapheme's surrogate pair
    (Python 3 strings are already indexed by code point, so slicing a `str`
    never does that).

    A split is free to fall inside a fenced code block — a long block is
    exactly when a reply needs splitting most — but never leaves one
    looking broken: a fence left open at the end of a chunk is closed
    there and reopened at the start of the next, so every chunk renders as
    valid Markdown on its own.
    """
    if len(text) <= max_length:
        return [text] if text else [""]

    chunks: list[str] = []
    start = 0
    in_open_fence = False
    # Reserve room for the fence markers a chunk may gain: up to 4 chars
    # ("```\n") prepended if it continues a fence, and up to 4 ("\n```")
    # appended if it ends one still open — reserving both unconditionally
    # is simpler than predicting which apply, and always safe.
    FENCE_MARKER_BUDGET = 8
    while start < len(text):
        budget = max_length - FENCE_MARKER_BUDGET
        end = min(start + budget, len(text))
        if end < len(text):
            # Prefer the last line break at or before `end`; a bare word
            # space is the fallback, so a line is only ever split mid-word
            # when it alone is longer than the remaining budget.
            newline_at = text.rfind("\n", start, end)
            if newline_at > start:
                end = newline_at + 1
            else:
                space_at = text.rfind(" ", start, end)
                if space_at > start:
                    end = space_at + 1
        piece = text[start:end]
        if in_open_fence:
            piece = "```\n" + piece
        if _opens_unclosed_fence(piece):
            piece = piece if piece.endswith("\n") else piece + "\n"
            piece += "```"
            in_open_fence = True
        else:
            in_open_fence = False
        chunks.append(piece)
        start = end
    return chunks
