"""Per-platform renderings of a projected session.

A renderer reads contract types and produces one platform's artefact. It makes
no access decisions and no routing ones: by the time something reaches a
renderer, whether a room sees it and which room that is have both been settled.

What is here rather than in a platform module is shared because it carries no
platform's markup — an action id, a turn's own wording — so every renderer
reads it the same way rather than each keeping its own copy to drift.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from switch_core.sessions.contract import (
    TURN_ENDED,
    ApprovalContent,
    Item,
    Question,
    SnapshotRequest,
    Surface,
    TurnUpsert,
)

# Where the turn itself has got to. One message per turn is edited in place, so
# without this a turn that finished and a turn that stalled read identically:
# the same tool log, the last line still marked in progress, and nothing to say
# which of the two a reader is looking at. Plain sentences, not markup, so
# every renderer reads the same wording rather than each keeping its own copy.
TURN_STATE = {
    "queued": "Queued. Waiting for the agent to start…",
    "running": "Working…",
    "completed": "Turn complete.",
    "interrupted": "Turn interrupted.",
    "error": "Turn ended with an error.",
}


def turn_state(
    items: list[Item],
    turn: TurnUpsert,
    *,
    tool_detail: bool,
    elapsed_seconds: float | None = None,
) -> str:
    """Where a turn got to, and what it left behind if it stopped.

    A turn that ends while a tool call is still open leaves that call marked
    in progress for good. What ended the call is whatever the host last said
    and is not rewritten here — the host is the only thing that knows how the
    call actually ended — so the count is what tells the reader those lines
    are not still moving.

    Calls only. What the agent said arrives as items too, and the last of them
    is routinely still marked in progress when the turn stops, so counting
    those would have a turn that finished cleanly report unfinished work.

    `elapsed_seconds` comes from outside: neither a turn nor an item carries
    a timestamp, so a caller that tracked one against the session's own event
    log supplies it. A running turn shows the live duration. A completed turn shows it in
    place of the plain "Turn complete." — that phrase said only that the turn
    was over, and this says what happened while it ran. An interrupted or
    errored turn keeps its own phrase, since that is still worth knowing on
    its own, with the same account appended: the run still took the time it
    took either way.

    `tool_detail` says whether this platform reports tool activity at all.
    Where it does not, how many calls a turn made is the detail it is not
    reporting — the duration stays, because that is the turn's own. What a
    turn left unfinished is not covered by it: that is an outcome, and it is
    reported wherever the turn is.
    """
    state = TURN_STATE[turn.status]
    if turn.status not in TURN_ENDED:
        if elapsed_seconds is not None:
            return f"{state} {_format_duration(elapsed_seconds)}"
        return state
    if elapsed_seconds is not None:
        worked = _worked_for(elapsed_seconds, items, tool_detail=tool_detail)
        state = worked if turn.status == "completed" else f"{state} {worked}"
    unfinished = sum(
        1
        for item in items
        if item.kind == "tool-activity" and item.status == "in-progress"
    )
    if not unfinished:
        return state
    step = "step" if unfinished == 1 else "steps"
    return f"{state} {unfinished} {step} left unfinished."


def _worked_for(elapsed_seconds: float, items: list[Item], *, tool_detail: bool) -> str:
    """How long a turn ran, and how much of that was tool calls."""
    calls = sum(1 for item in items if item.kind == "tool-activity")
    worked = f"Worked for {_format_duration(elapsed_seconds)}."
    if not calls or not tool_detail:
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


# The same control on a platform whose payload is too small to carry an option
# id. Telegram allows 64 bytes for everything a press hands back, and an option
# id is an unbounded, possibly non-ASCII string the host chose, so the press
# names where the control was on the card and the server resolves that against
# the form the card rendered. Shorter than the id it replaces on purpose: what
# is left of the budget is the request token, and both have to fit.
POSITION_ACTION = "switch:request-option"


def position_action(position: int) -> str:
    """The action id for the control drawn `position`th on the card."""
    return f"{POSITION_ACTION}:{position}"


def parse_answer_position(action_id: str) -> int | None:
    """Where on the card the operated control was, or None if not one of ours.

    A count, in ASCII digits, from one. Anything else is refused here rather
    than carried inwards as a number: `int` accepts digits from any script and
    a payload that was not ours is not owed a resolution against a form.
    """
    prefix = f"{POSITION_ACTION}:"
    if not action_id.startswith(prefix):
        return None
    digits = action_id[len(prefix) :]
    if not digits.isascii() or not digits.isdecimal():
        return None
    position = int(digits)
    return position if position > 0 else None


@dataclass(frozen=True)
class Control:
    """One press a card offers: what it says, and where on the card it is.

    `position` is the number printed beside the option in the body, which is
    also what a typed answer names — so the two ways of answering a card mean
    the same thing by the same number, and a control that carries a position
    resolves to the option the reader was looking at.

    The option's own id is deliberately not here. A platform whose control can
    carry one reads it off the request directly; a platform whose control
    cannot is the reason this exists, and handing it an id it has no room for
    invites the payload this shape was made to avoid.
    """

    position: int
    label: str


def offered_controls(request: SnapshotRequest) -> list[Control]:
    """The controls a card for `request` may draw, in the order it draws them.

    Empty is the ordinary answer rather than a failure: a settled request has
    nothing left to press, and neither has a form whose answer one press cannot
    be. The rule is the one `resolve_pressed_option` applies when the press
    comes back — one question, one choice out of a list — stated here so that a
    card does not draw a control whose press is going to be refused.

    A platform may still decline to draw what this offers, because a limit on
    how many controls fit is the platform's own. What it must not do is offer
    more.
    """
    if request.state != "open":
        return []
    content = request.content
    if isinstance(content, ApprovalContent):
        return [
            Control(position=position, label=option.label)
            for position, option in enumerate(content.options, start=1)
        ]
    if len(content.questions) != 1:
        return []
    question = content.questions[0]
    if question.multi_select:
        return []
    return [
        Control(position=position, label=option.label)
        for position, option in enumerate(question.options, start=1)
    ]


@dataclass(frozen=True)
class Drawn:
    """A rendering of a request, and whether it can be answered where it shows.

    The two travel together because only the renderer knows both, and it knows
    them at the same moment: whether the body had to be cut is settled while it
    is being composed, and a form cut short of the difference between two
    options cannot be answered from what is on the screen — which is why the
    footer under a cut form stops asking to be answered there.

    `offered_controls` says which presses a request *could* have. This says
    whether this particular drawing of it earned them. A platform that draws
    buttons needs both: without this, a live control ends up under the very
    sentence explaining that the form cannot be answered here, and a press on
    it decides something the reader was never shown.
    """

    text: str
    answerable: bool


class Markup:
    """The marks the neutral renderer makes, in one platform's spelling.

    Emphasis, a literal a reader is meant to copy, the command a card is asking
    about, and a link. Everything else the renderer writes is plain text. They
    live behind this rather than being written into the renderer because a
    platform that does not parse Markdown is otherwise forced to choose between
    a renderer of its own — the whole of the budget and faithfulness logic,
    copied and left to drift — and shipping `**Working…**` to a reader as those
    characters.

    Not an escaper, with one exception it cannot delegate: `literal` says how
    text must be spelled to survive this markup's own code span, because only
    the spelling knows whether its content is read as syntax. Everything else
    is neutralised by the adapter's own escape before it reaches here, and what
    these produce is measured against the message budget like anything else, so
    a spelling that costs more characters costs them out of the same allowance.
    """

    def bold(self, text: str) -> str:
        return f"**{text}**"

    def literal(self, escape: Callable[[str], str]) -> Callable[[str], str]:
        """The escape that gets text intact through `code` and `command`.

        A code span is not prose and the prose escape is wrong inside it:
        Markdown reads nothing between the backticks as syntax, so a `_`
        defused to `\\_` for the body arrives with the backslash showing, in
        the one place on the card that is meant to be read literally. The
        identity here is the whole point — a platform whose span does read its
        content, as an HTML one reads `&` and `<`, overrides this with the
        escape that makes it safe.
        """
        return lambda text: text

    def code(self, text: str) -> str:
        """A literal, fenced by a run of backticks the content cannot close.

        A single backtick is the common case and the only one before this: a
        command containing one ended the span early and spilled the rest of
        itself into the body as prose. CommonMark closes a span on a run of
        exactly the length that opened it, so a fence one longer than the
        longest run inside is always safe. The padding spaces are stripped by
        the same rule, and are there so content that starts or ends with a
        backtick does not fuse with its own fence.
        """
        longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
        fence = "`" * (longest + 1)
        pad = " " if text.startswith("`") or text.endswith("`") else ""
        return f"{fence}{pad}{text}{pad}{fence}"

    def command(self, text: str) -> str:
        """The command a card is asking about, set apart from the prose.

        Most platforms spell this the same as `code`, but the two are asking
        for different things and a platform may answer them differently. A
        handle is a literal to copy and has to survive being marked some other
        way; a command is read, not typed, so a platform with no code span is
        better off leaving it alone than emphasising it into a third bold on a
        card that already has two.
        """
        return self.code(text)

    def link(self, label: str, url: str) -> str:
        # A `)` inside the destination closes the link early and spills the
        # rest of the URL into the body as text. Percent-encoding is the one
        # transform that keeps the link working and cannot be read as syntax.
        return f"[{label}]({url.replace(')', '%29')})"


MARKDOWN = Markup()


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
