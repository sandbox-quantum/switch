"""Per-platform renderings of a projected session.

A renderer reads contract types and produces one platform's artefact. It makes
no access decisions and no routing ones: by the time something reaches a
renderer, whether a room sees it and which room that is have both been settled.

What is here rather than in a platform module is shared because it carries no
platform's markup — an action id, a turn's own wording — so every renderer
reads it the same way rather than each keeping its own copy to drift.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..contract import TURN_ENDED, Item, TurnUpsert

# Where the turn itself has got to. One message per turn is edited in place, so
# without this a turn that finished and a turn that stalled read identically:
# the same tool log, the last line still marked in progress, and nothing to say
# which of the two a reader is looking at. Plain sentences, not markup, so
# every renderer reads the same wording rather than each keeping its own copy.
TURN_STATE = {
    "queued": "Queued.",
    "running": "Working…",
    "completed": "Turn complete.",
    "interrupted": "Turn interrupted.",
    "error": "Turn ended with an error.",
}


def turn_state(items: list[Item], turn: TurnUpsert) -> str:
    """Where a turn got to, and what it left behind if it stopped.

    A turn that ends while a tool call is still open leaves that call marked
    in progress for good. What ended the call is whatever the host last said
    and is not rewritten here — the host is the only thing that knows how the
    call actually ended — so the count is what tells the reader those lines
    are not still moving.
    """
    state = TURN_STATE[turn.status]
    if turn.status not in TURN_ENDED:
        return state
    unfinished = sum(1 for item in items if item.status == "in-progress")
    if not unfinished:
        return state
    step = "step" if unfinished == 1 else "steps"
    return f"{state} {unfinished} {step} left unfinished."


# Every platform that puts controls on a message gives each one an id it hands
# straight back when it is operated. The prefix marks the ones this layer wrote,
# so a control belonging to something else in the same channel is left alone.
ANSWER_ACTION = "switch:request-answer"


def parse_answer_action(action_id: str) -> str | None:
    """The option a control stands for, or None if it is not one of ours.

    An option id is all the id carries. Which request, and against which
    revision, comes from the record the token resolves to — not from here, and
    not from anything else the platform sent back.
    """
    prefix = f"{ANSWER_ACTION}:"
    if not action_id.startswith(prefix):
        return None
    option_id = action_id[len(prefix) :]
    return option_id or None


@dataclass(frozen=True)
class RequestReference:
    """How a platform refers back to a request, without carrying the session.

    `token` goes in a button's callback payload and `handle` is the short thing
    a person types when they answer in words. Both are opaque and resolved
    against a record the server keeps: a payload that leaks names nothing, and
    it is never an agent credential. Callers mint them — this layer only
    renders and reads them back.
    """

    token: str
    handle: str
