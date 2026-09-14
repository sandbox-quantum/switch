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

from switch_core.sessions.contract import (
    TURN_ENDED,
    Item,
    Question,
    Surface,
    TurnUpsert,
)

# Where the turn itself has got to. One message per turn is edited in place, so
# without this a turn that finished and a turn that stalled read identically:
# the same tool log, the last line still marked in progress, and nothing to say
# which of the two a reader is looking at. Plain sentences, not markup, so
# every renderer reads the same wording rather than each keeping its own copy.
TURN_STATE = {
    "queued": "Received. Waiting for the agent…",
    "running": "Working…",
    "completed": "Turn complete.",
    "interrupted": "Turn interrupted.",
    "error": "Turn ended with an error.",
}


def turn_state(
    items: list[Item], turn: TurnUpsert, *, elapsed_seconds: float | None = None
) -> str:
    """Where a turn got to, and what it left behind if it stopped.

    A turn that ends while a tool call is still open leaves that call marked
    in progress for good. What ended the call is whatever the host last said
    and is not rewritten here — the host is the only thing that knows how the
    call actually ended — so the count is what tells the reader those lines
    are not still moving.

    `elapsed_seconds` comes from outside: neither a turn nor an item carries
    a timestamp, so a caller that tracked one against the session's own event
    log supplies it. A running turn shows the live duration. A completed turn shows it in
    place of the plain "Turn complete." — that phrase said only that the turn
    was over, and this says what happened while it ran. An interrupted or
    errored turn keeps its own phrase, since that is still worth knowing on
    its own, with the same account appended: the run still took the time it
    took either way.
    """
    state = TURN_STATE[turn.status]
    if turn.status not in TURN_ENDED:
        if elapsed_seconds is not None:
            return f"{state} {_format_duration(elapsed_seconds)}"
        return state
    if elapsed_seconds is not None:
        worked = _worked_for(elapsed_seconds, items)
        state = worked if turn.status == "completed" else f"{state} {worked}"
    unfinished = sum(1 for item in items if item.status == "in-progress")
    if not unfinished:
        return state
    step = "step" if unfinished == 1 else "steps"
    return f"{state} {unfinished} {step} left unfinished."


def _worked_for(elapsed_seconds: float, items: list[Item]) -> str:
    """How long a turn ran, and how much of that was tool calls."""
    calls = sum(1 for item in items if item.kind == "tool-activity")
    worked = f"Worked for {_format_duration(elapsed_seconds)}."
    if not calls:
        return worked
    noun = "call" if calls == 1 else "calls"
    return f"{worked} {calls} tool {noun}."


def _format_duration(elapsed_seconds: float) -> str:
    """Minutes and seconds, dropping the minutes when there are none."""
    total = max(int(elapsed_seconds), 0)
    minutes, seconds = divmod(total, 60)
    return f"{minutes}m {seconds}s" if minutes else f"{seconds}s"


# How a request that was never answered ended, in the words a reader sees. One
# copy rather than one per renderer: two platforms describing the same outcome
# differently is a difference a reader would take for a difference in what
# actually happened.
CLOSED = {
    "cancelled": "Cancelled before it was answered.",
    "expired": "Expired before it was answered.",
    "interrupted": "Interrupted before it was answered.",
    "provider-error": "The provider failed before it was answered.",
}

# Where the person who answered was, in the words a reader of that platform
# would use for it.
SURFACES: dict[Surface, str] = {
    "console": "the console",
    "switch-web": "Switch",
    "slack": "Slack",
    "mattermost": "Mattermost",
    "discord": "Discord",
    "teams": "Teams",
    "telegram": "Telegram",
}

# An approval with nothing to choose from. The same defect as a form with no
# questions in it (see `unanswerable`) and refused the same way: there is no
# number to type, no word to say and nothing to press, so an instruction here
# would be one the resolver goes on to refuse.
NO_OPTIONS = "This card cannot be answered: it offers no options."


def unanswerable(questions: list[Question]) -> str | None:
    """What a card says instead of an instruction, when there is no answering it.

    Two shapes reach this, and they are the same defect a question apart. A
    question offering nothing to choose and taking no written answer cannot be
    answered on any surface — there is no number to type and words are refused —
    and because every question has to be answered for the answer to be sent at
    all, one of them stops the whole form. A form with no questions in it has
    nothing to say back either: there is no number, no word and no button, and
    the grammar has no shape for an answer to nothing.

    Both are the host's mistake rather than the reader's, so the card says so
    where a person can see the session is stuck on it, instead of printing an
    instruction the resolver would then refuse.

    The contract permits both — `questions` has no minimum length in either
    reader — and this is the wrong place to start forbidding them: rejecting
    the event would cost the whole snapshot rather than one card, and the
    Python reader would refuse a shape the TypeScript one accepts. So the
    refusal is on the card, where it is visible and costs nothing else.

    Plain words with no markup in them, so every platform's renderer reads the
    same refusal rather than keeping its own to drift.
    """
    if not questions:
        return "This card cannot be answered: it asks no questions."
    stuck = [
        position
        for position, question in enumerate(questions, start=1)
        if not question.options and not question.allow_custom_answer
    ]
    if not stuck:
        return None
    where = (
        ""
        if len(questions) == 1
        else " on " + ", ".join(f"q{position}" for position in stuck)
    )
    return (
        f"This card cannot be answered: nothing to choose{where}, "
        "and no written answer allowed."
    )


def example_value(question: Question) -> str:
    """The part of a typed answer that stands for one question.

    Built from the question rather than fixed, because the shapes need
    different things said: a list is answered by number, a list that takes
    more than one by several, and a question with nothing to number is
    answered in words.
    """
    if not question.options:
        return '"your answer"'
    if question.multi_select and len(question.options) > 1:
        return "1,2"
    return "1"


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
