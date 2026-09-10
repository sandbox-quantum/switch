"""A turn, for a platform with no card of its own for one yet.

Slack has a card: the activity block plus `render_activity_text`, a
twenty-message notification string bounded at Slack's own 39,000 characters,
built to stand in for blocks that usually render (`slack.py`). This is not a
smaller version of that. It is what a turn falls back to on a platform with no
card behind it at all, so it carries only what a reader actually came for: the
last thing the agent said, and whether the turn is still going.
`render_activity_text` stays exactly where it is — nothing here replaces it,
and nothing on Slack reads this instead.

`escape` and `limit` are the platform's: the last thing said is host text and
needs neutralising the way that platform's body text does, and the result has
to fit inside one message rather than assume there is room to spare.
"""

from __future__ import annotations

from collections.abc import Callable

from ..contract import Item, TurnUpsert
from . import turn_state


def turn_summary(
    items: list[Item],
    turn: TurnUpsert,
    *,
    escape: Callable[[str], str],
    limit: int,
) -> str:
    """One or two lines: what the agent last said, and where the turn got to.

    Only the agent's own words. A person's message is skipped rather than
    taken as `items[-1]`: there is no card here to attribute it against the
    way Slack's does, and a prompt or a mid-turn interjection shown bare on
    its own line reads as the agent having said it.

    The state line is the one thing that always survives whole — it is a
    handful of words from a fixed vocabulary, never host text — so what gets
    cut when the budget is tight is what was said, not whether the turn is
    still going.
    """
    state = turn_state(items, turn)
    said = [item for item in items if item.kind == "assistant-message"]
    if not said:
        return _fit(state, limit)

    remaining = limit - len(state) - 1  # 1 for the newline between them
    if remaining <= 0:
        return _fit(state, limit)

    # Cut the raw text and escape what survives, not the other way round: an
    # escape that expands a character (`escape_mrkdwn`'s `&`, `<`, `>`) would
    # otherwise have the cut land inside the entity it produced.
    text = said[-1].text
    body = escape(_fit(text, remaining)) if text else "(nothing said)"
    return f"{body}\n{state}"


def _fit(text: str, limit: int) -> str:
    """The start of `text` that fits `limit`, saying so if it had to cut."""
    if len(text) <= limit:
        return text
    if limit <= 1:
        return text[:limit]
    return text[: limit - 1].rstrip() + "…"
