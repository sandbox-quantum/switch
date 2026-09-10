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

from ..contract import Item, SnapshotRequest, TurnUpsert
from . import RequestReference, turn_state


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
        return _truncate(state, limit)

    remaining = limit - len(state) - 1  # 1 for the newline between them
    if remaining <= 0:
        return _truncate(state, limit)

    text = said[-1].text
    body = (
        _fit(text, remaining, escape=escape)
        if text
        else _truncate("(nothing said)", remaining)
    )
    return f"{body}\n{state}"


def request_summary(
    request: SnapshotRequest,
    reference: RequestReference,
    *,
    escape: Callable[[str], str],
    limit: int,
) -> str:
    """The text form of a request, for a platform with no card renderer of its own.

    Not implemented. There is no off-Slack request renderer yet to write this
    against, and building it now — title, detail, per-option or per-question
    lines, a footer, each bounded to fit inside `limit` after `escape` — would
    be the speculative renderer this plan already decided not to build (see
    "Session activity in Slack — open questions", §6). Implement this
    alongside the first one, using the cut-then-escape, raise-rather-than-cut
    rules `turn_summary` and `_fit` already follow. Until then, `post_rich`'s
    base raises through this rather than guessing at a shape.
    """
    raise NotImplementedError(
        "No neutral request card form yet — implement alongside the first "
        "off-Slack request renderer, using the escape+budget pattern "
        "turn_summary already uses."
    )


def _truncate(text: str, limit: int) -> str:
    """The start of `text` that fits `limit`, saying so if it had to cut.

    For text that needs no escaping — the state line is ours, never host
    text, so there is nothing here an escape could expand past `limit`.
    """
    if len(text) <= limit:
        return text
    if limit <= 1:
        return text[:limit]
    return text[: limit - 1].rstrip() + "…"


def _fit(text: str, limit: int, *, escape: Callable[[str], str]) -> str:
    """Escape `text` and keep the result inside `limit`.

    The cut is made on the source, never on the escaped form: slicing after
    escaping can leave half of whatever the escape produced behind — an
    entity, a zero-width space with nothing either side of it to protect.
    Escaping is assumed only to lengthen a string, the same assumption
    `slack.py`'s own `_fit` makes, so the longest prefix that still fits after
    escaping can be found on the source and escaped whole.
    """
    escaped = escape(text)
    if len(escaped) <= limit:
        return escaped
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if len(escape(text[:middle])) + 1 <= limit:
            low = middle
        else:
            high = middle - 1
    return escape(text[:low]) + "…"
