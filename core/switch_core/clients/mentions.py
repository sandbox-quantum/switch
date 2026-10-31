from __future__ import annotations

import functools
import re

# Characters that may appear inside an agent / role / alias name (e.g.
# "cc-bug-fixing-2", "claude-code.my-project.alice"). An `@name` is
# only a real mention when the character right after the name is NOT one of
# these (or the string ends) — otherwise a name that is a prefix of a longer one
# (`@cc-bug-fixing` inside `@cc-bug-fixing-2`) would be falsely matched.
NAME_CHAR = r"[A-Za-z0-9._-]"

# Markdown / Slack-mrkdwn emphasis markers that can wrap or abut an @mention —
# a bolded mention arrives as "@*name*", which would otherwise hide the name
# from the token regex (the `*` is not a name char) and break matching. We
# strip these before mention matching. `_` is deliberately NOT stripped — it is
# a valid character in agent and role names.
_EMPHASIS = re.compile(r"[*~]")

_MENTION_TOKEN = re.compile(rf"@({NAME_CHAR}+)")


def strip_emphasis(text: str) -> str:
    """Remove Markdown/mrkdwn emphasis markers so `@*name*` matches `@name`."""
    return _EMPHASIS.sub("", text)


@functools.lru_cache(maxsize=16384)
def mention_regex(name: str) -> re.Pattern[str]:
    """Compile a case-insensitive regex matching `@name` only at a full-token
    boundary, so a prefix name is never matched inside a longer name. Kept
    per name: `re`'s own cache holds 512 patterns, fewer than the names a
    large deployment tags."""
    return re.compile(re.escape(f"@{name}") + rf"(?!{NAME_CHAR})", re.IGNORECASE)


def mention_tokens(text: str) -> list[str]:
    """Every `@token` name in `text`, in order of appearance (with duplicates).

    Tokens span the same characters a name may contain, so each token matches
    what `mention_regex` would treat as one whole mention.
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
