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
    """One or two lines: what was last said, and where the turn got to.

    The state line is the one thing that always survives whole — it is a
    handful of words from a fixed vocabulary, never host text — so what gets
    cut when the budget is tight is what was said, not whether the turn is
    still going.
    """
    state = turn_state(items, turn)
    said = [item for item in items if item.kind != "tool-activity"]
    if not said:
        return _fit(state, limit)

    last = escape(said[-1].text) if said[-1].text else "(nothing said)"
    remaining = limit - len(state) - 1  # 1 for the newline between them
    if remaining <= 0:
        return _fit(state, limit)
    return f"{_fit(last, remaining)}\n{state}"


def _fit(text: str, limit: int) -> str:
    """The start of `text` that fits `limit`, saying so if it had to cut."""
    if len(text) <= limit:
        return text
    if limit <= 1:
        return text[:limit]
    return text[: limit - 1].rstrip() + "…"
