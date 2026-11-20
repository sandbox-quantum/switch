from __future__ import annotations

import functools
import re

# Characters that may appear inside an agent / role / alias name (e.g.
# "cc-bug-fixing-2", "claude-code.my-project.alice").
NAME_CHAR = r"[A-Za-z0-9._-]"

# Where a mention may start: an `@` that does not continue a word, so an
# address such as `root@staging` or `ops@example.com` names nobody.
_MENTION_START = r"(?<![A-Za-z0-9])"

# Where a mention ends: no more name characters that reach a letter or digit.
# A name that is a prefix of a longer one (`@cc-bug-fixing` inside
# `@cc-bug-fixing-2`) is therefore not matched, while the `.`, `-` or `_` that
# closes a sentence or an emphasis (`@reviewer.`, `@reviewer...`, `_@reviewer_`)
# is punctuation rather than part of the name — the same rule
# `room_wide_mention.py` applies to `@channel.`.
_MENTION_END = rf"(?!{NAME_CHAR}*[A-Za-z0-9])"

# Markdown / Slack-mrkdwn emphasis markers that can wrap or abut an @mention —
# a bolded mention arrives as "@*name*", which would otherwise hide the name
# from the token regex (the `*` is not a name char) and break matching. We
# strip these before mention matching. `_` is deliberately NOT stripped — it is
# a valid character in agent and role names.
_EMPHASIS = re.compile(r"[*~]")

# A token ends on a letter or digit, so trailing punctuation is left out of it
# by the same rule `_MENTION_END` uses.
_MENTION_TOKEN = re.compile(rf"{_MENTION_START}@({NAME_CHAR}*[A-Za-z0-9])")


def strip_emphasis(text: str) -> str:
    """Remove Markdown/mrkdwn emphasis markers so `@*name*` matches `@name`."""
    return _EMPHASIS.sub("", text)


def mention_pattern(name: str) -> str:
    """The regex source matching `@name` as a whole mention (see
    `mention_regex`), for a caller that extends it."""
    return _MENTION_START + re.escape(f"@{name}") + _MENTION_END


@functools.lru_cache(maxsize=16384)
def mention_regex(name: str) -> re.Pattern[str]:
    """Compile a case-insensitive regex matching `@name` as a whole mention:
    not inside a word before it, and not as the prefix of a longer name after
    it. Kept per name: `re`'s own cache holds 512 patterns, fewer than the
    names a large deployment tags."""
    return re.compile(mention_pattern(name), re.IGNORECASE)


def mention_tokens(text: str) -> list[str]:
    """Every `@token` name in `text`, in order of appearance (with duplicates).

    Each token is what `mention_regex` treats as one whole mention, without the
    punctuation that may follow it.
    """
    return _MENTION_TOKEN.findall(strip_emphasis(text))


def unique_mention_tokens(text: str) -> list[str]:
    """`mention_tokens` de-duplicated case-insensitively, preserving order."""
    seen: set[str] = set()
    out: list[str] = []
    for token in mention_tokens(text):
        key = token.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(token)
    return out
