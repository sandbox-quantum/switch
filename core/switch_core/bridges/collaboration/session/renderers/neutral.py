"""A turn and a request, for a platform that draws them in plain body text.

Slack has cards: Block Kit for the turn and for the request, with the text
forms beside them as the notification string (`slack.py`). Nothing here is a
smaller version of those. This is what a platform gets when the message body
*is* the artefact — Mattermost today — so the shapes are chosen for a reader
looking at a paragraph rather than at a card, and for a writer who has one
message to say everything in.

Three renderings live here:

- `turn_summary` — the oldest and the least: the last thing the agent said and
  whether the turn is still going. What a platform falls back to with no
  activity presentation of its own.
- `turn_status` — the compact one a platform edits in place while a turn runs:
  where the turn got to, how long it has been going, what it is doing now, how
  the tool calls went, and one link to the Console. One message, edited, never
  a second one.
- `request_summary` — the text form of a request, in every state it can be in,
  with the typed-answer grammar the card is asking for spelled out against
  this particular form.

`escape`, `limit` and `markup` are the platform's: every value that came from a
host is host text and needs neutralising the way that platform's body text
does, the result has to fit inside one message rather than assume there is room
to spare, and emphasis, a copyable literal and a link are spelled the way the
platform spells them. A numbered list is plain text either way. What is still
assumed of a platform arriving here is only that it renders those three marks
somehow; one that renders none of them is better served by a renderer of its
own than by a `Markup` that returns its argument.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from switch_core.sessions.contract import (
    TURN_ENDED,
    ApprovalContent,
    ApprovalOption,
    ApprovalResult,
    DecidedBy,
    Item,
    Question,
    QuestionOption,
    QuestionsContent,
    QuestionsResult,
    SnapshotRequest,
    TurnUpsert,
)

from . import (
    CLOSED,
    NO_OPTIONS,
    SURFACES,
    Drawn,
    Markup,
    RequestReference,
    example_value,
    turn_state,
    unanswerable,
)

# Only these reach a reader as a link. A scheme outside the set is printed as
# the plain text it is rather than wrapped in link syntax: `javascript:` in an
# anchor is the one thing a rendered URL must never become, and a platform
# that refuses an unknown scheme would render the syntax instead of the link.
_LINK_SCHEMES = ("https://", "http://", "switchdash://")

_CONSOLE = "Open in Switch Console"

# What a card says when it could not show all of itself. The reader is told the
# count rather than left to notice; where the rest of it is comes from the
# footer, which a cut body always replaces with `_TOO_BIG`.
_CUT = "…{left} more not shown."

# What an open request says in place of "Reply with `R42 1`" when it could not
# be shown faithfully — an option cut short of what distinguishes it, a
# question left out. Answering by number means answering the numbers on the
# screen, so a form that is not all on the screen stops asking to be answered
# there and names the place it can be.
_TOO_BIG = (
    "Too long to show in full here, so it cannot be answered from this "
    f"message. {_CONSOLE} to read and answer it."
)

# How a tool call went, in one character: read at a glance and down the left
# edge of a line rather than as a sentence. The same glyphs `slack.py` uses,
# so the two platforms do not spell the same outcome differently.
_OUTCOME = {
    "in-progress": "▸",
    "completed": "✓",
    "failed": "✗",
    "declined": "⊘",
}

_OUTCOME_WORDS = {
    "in-progress": "running",
    "completed": "done",
    "failed": "failed",
    "declined": "declined",
}

# What the heading says where the outcome cannot. A resolved card names the
# option that was chosen instead, so "Permission answered" is left for the one
# case that earns it: answered, but the host never said with what.
_HEADINGS = {
    "open": "Permission needed",
    "submitting": "Permission needed",
    "resolved": "Permission answered",
    "closed": "Closed",
}

# How far an "accept for this session" option reaches. One copy, because the
# open form and the answered one are describing the same thing and a reader
# comparing them should not have to work out that they agree.
_FOR_SESSION = " (applies for the rest of this session)"

_QUESTION_HEADINGS = {
    "open": "Questions",
    "submitting": "Questions",
    "resolved": "Questions answered",
    "closed": "Questions closed",
}


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
    state = turn_state(items, turn, tool_detail=True)
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


def turn_status(
    items: list[Item],
    turn: TurnUpsert,
    *,
    escape: Callable[[str], str],
    limit: int,
    markup: Markup,
    elapsed_seconds: float | None = None,
    session_url: str | None = None,
    mention: str | None = None,
    error_summary: str | None = None,
    tool_detail: bool,
) -> str:
    """A turn's progress, compact enough to live in one message that is edited.

    Deliberately not the transcript. The agent's reply reaches the channel on
    its own, as a message, the way it always has; this is the thing beside it
    that says the turn is still running and roughly what it is doing. Repeating
    the reply here would put every paragraph in the channel twice — which is
    what `turn_summary` does, and why a platform publishing SDK sessions wants
    this instead.

    Three lines at most, and usually one:

    - where the turn got to and how long it has taken, with one Console link;
    - what it is doing right now, while it is still doing something;
    - how the tool calls went, once there is more than one outcome to report.

    `tool_detail` says whether this platform reports tool activity at all, and
    a platform can decline it. Where the status shares the conversation with
    everything else that is said there, the tool of the moment and a count of
    healthy calls are both noise: the state, its duration and its link are the
    record, and what the turn did is in Console.

    What survives declining it is what a reader has to act on — a call that
    failed or was declined is an outcome, not chatter about progress, and it
    is reported wherever the turn is.

    `error_summary` is the attention slot rather than the status: a distinct
    problem somebody has to act on, said in one sentence with the mention that
    makes it reach them. When it is set, that is the whole message — the state
    line under it would only be reporting a turn that is, by definition, not
    getting anywhere.

    `mention` is already in the platform's own syntax and is not escaped: it is
    the adapter's, resolved from an id Switch holds, never host text.
    """
    if error_summary:
        return _mentioned(
            mention, _truncate(f"⚠️ {error_summary}", _room(limit, mention))
        )

    budget = _room(limit, mention)
    state = turn_state(
        items, turn, tool_detail=tool_detail, elapsed_seconds=elapsed_seconds
    )
    head = markup.bold(state)
    link = _link(_CONSOLE, session_url, markup)
    if link and len(head) + 3 + len(link) <= budget:
        head = f"{head} · {link}"

    lines = [head]
    spent = len(head)
    did = [item for item in items if item.kind == "tool-activity"]
    for line in _doing(
        did, turn, escape=escape, budget=budget, tool_detail=tool_detail
    ):
        if spent + len(line) + 1 > budget:
            break
        lines.append(line)
        spent += len(line) + 1
    return _mentioned(mention, "\n".join(lines))


def _doing(
    did: list[Item],
    turn: TurnUpsert,
    *,
    escape: Callable[[str], str],
    budget: int,
    tool_detail: bool,
) -> list[str]:
    """The optional lines under the state: what is running, and how it is going.

    Both are dropped when the state line already says it. A turn that has ended
    gets its total from `turn_state` ("Worked for 2m 5s. 7 tool calls."), so the
    only count worth adding is one the total hides — a call that failed or was
    declined reads as a completed turn otherwise.

    Nothing here says a finished turn is running. A call the host never closed
    keeps the status the host gave it, because the host is the only thing that
    knows how it ended, but counting it as present-tense activity under a
    headline saying the turn is over describes a turn nobody has. What the turn
    left behind is `turn_state`'s to report, in the tense that belongs to it.
    """
    if not did:
        return []
    lines: list[str] = []
    ended = turn.status in TURN_ENDED
    if tool_detail and not ended:
        current = next(
            (item for item in reversed(did) if item.status == "in-progress"), None
        )
        item = current or did[-1]
        label = "Now" if current else "Last"
        title = item.title or "Tool call"
        lines.append(f"{label}: {_fit(title, max(1, budget // 4), escape=escape)}")

    counts = {
        status: sum(1 for item in did if item.status == status) for status in _OUTCOME
    }
    unwell = counts["failed"] + counts["declined"]
    if not unwell and (ended or not tool_detail):
        return lines
    if ended or not tool_detail:
        counts["in-progress"] = 0
    if not tool_detail:
        counts["completed"] = 0
    tally = " · ".join(
        f"{_OUTCOME[status]} {count} {_OUTCOME_WORDS[status]}"
        for status, count in counts.items()
        if count
    )
    if tally:
        lines.append(tally)
    return lines


def request_summary(
    request: SnapshotRequest,
    reference: RequestReference,
    *,
    escape: Callable[[str], str],
    limit: int,
    markup: Markup,
    responder: str | None = None,
    unavailable_reason: str | None = None,
) -> str:
    """`render_request`, for a platform whose drawing is the whole of the card.

    A platform with no controls of its own has nothing to do with the rest of
    the result: the body already says how to answer, or says it cannot be
    answered here. Nothing else carries the options either, which is why the
    body here always prints them.
    """
    return render_request(
        request,
        reference,
        escape=escape,
        limit=limit,
        markup=markup,
        responder=responder,
        unavailable_reason=unavailable_reason,
        control_label_limit=None,
    ).text


def render_request(
    request: SnapshotRequest,
    reference: RequestReference,
    *,
    escape: Callable[[str], str],
    limit: int,
    markup: Markup,
    responder: str | None,
    unavailable_reason: str | None,
    control_label_limit: int | None,
) -> Drawn:
    """The text form of a request: the question, the options, and how to answer.

    The same function serves the first post and every edit after it, because
    the card is one message edited in place and the state it is in is the whole
    of what changes. An open request offers its numbered options and says what
    to type; a settled one drops them and says what became of it, because a
    form still asking a settled question is a form asking for an answer that
    cannot land.

    The footer always survives the budget. Everything above it can be cut —
    with the count and a route to the whole of it said out loud — but the line
    telling a reader how to answer is the one line the message exists for.

    `responder` names whoever is answering or answered, in the platform's own
    syntax, and is not escaped: the adapter resolved it from an id Switch
    holds. Without one the card falls back to the Switch identity, which is
    correct but not a name anybody in the channel recognises.

    `control_label_limit` is how much of an option's label a control beside
    this card will show, or None where the platform draws no controls. Where a
    control carries the whole of an option, the body stops repeating it: the
    same choices printed under the buttons offering them are the screen the
    instruction needed, on the platform where the screen is a phone. What a
    control cannot show — a label too long for a button, a scope the button
    has no room for — keeps its line, so no option is ever only half visible.

    `unavailable_reason` replaces the instruction rather than joining it. It
    exists for a card that cannot be answered where it is showing, and leaving
    "Reply with `R42 1`" underneath would invite exactly the answer that is
    about to be refused.

    A form that does not fit refuses the same way, and for the same reason.
    An instruction to answer by number under options a reader can only see
    part of invites the wrong number: the form drops the instruction, says it
    is too long, and names Console. Only an instruction is replaced this way
    — a card that already says why it cannot be answered says it better than
    this would.

    Whether it came to that is the other half of the result. It is decided
    here, from the same facts that decide the footer, so a platform drawing
    controls beside the body does not have to work it out a second way — and
    cannot come to a different answer than the words under its own buttons.
    """
    content = request.content
    if isinstance(content, ApprovalContent):
        head, body, footer, invites_answer = _approval_form(
            request,
            content,
            reference,
            escape=escape,
            limit=limit,
            markup=markup,
            responder=responder,
            control_label_limit=control_label_limit,
        )
    else:
        head, body, footer, invites_answer = _questions_form(
            request,
            content,
            reference,
            escape=escape,
            limit=limit,
            markup=markup,
            responder=responder,
        )
    if unavailable_reason and request.state in {"open", "submitting"}:
        body = []
        footer = _fit(unavailable_reason, max(1, limit // 3), escape=escape)
        invites_answer = False
    text, cut = _compose(
        head,
        body,
        footer,
        limit=limit,
        if_cut=_TOO_BIG if invites_answer else footer,
    )
    return Drawn(text=text, answerable=invites_answer and not cut)


def _approval_form(
    request: SnapshotRequest,
    content: ApprovalContent,
    reference: RequestReference,
    *,
    escape: Callable[[str], str],
    limit: int,
    markup: Markup,
    responder: str | None,
    control_label_limit: int | None,
) -> tuple[list[str], list[str], str, bool]:
    fit = _Faithful(escape)
    handle = escape(reference.handle)
    outcome = (
        _chosen(request, content, escape=escape, limit=limit)
        if request.state == "resolved"
        else None
    )
    heading = outcome.label if outcome else _HEADINGS[request.state]
    head = [f"{markup.bold(heading)} · request {markup.code(handle)}"]
    head.append(fit(content.title, _share(limit, 1500, 3)))
    if content.detail:
        detail = fit(content.detail, _share(limit, 1200, 4))
        head.append(markup.command(detail) if "\n" not in detail else detail)

    body: list[str] = []
    if request.state == "open":
        budget = _label_budget(limit)
        numbered = [
            (option, f"{index}. {fit(option.label, budget)}{_scope(option)}")
            for index, option in enumerate(content.options, start=1)
        ]
        body = [
            line
            for option, line in numbered
            if not _carried(option, control_label_limit)
        ]
    # The one state whose footer is an instruction. `_approval_footer` says
    # why the others are not: nothing to choose, or already answered.
    invites_answer = request.state == "open" and bool(content.options)
    if invites_answer and not fit.whole:
        return (head, body, _TOO_BIG, False)
    return (
        head,
        body,
        _approval_footer(
            request,
            content,
            handle,
            outcome,
            escape=escape,
            limit=limit,
            markup=markup,
            responder=responder,
        ),
        invites_answer,
    )


def _approval_footer(
    request: SnapshotRequest,
    content: ApprovalContent,
    handle: str,
    outcome: _Chosen | None,
    *,
    escape: Callable[[str], str],
    limit: int,
    markup: Markup,
    responder: str | None,
) -> str:
    if request.state == "open":
        if not content.options:
            return NO_OPTIONS
        # A code span, because the reader is meant to copy this and quote marks
        # around it are not part of the answer: `"R42 1"` parses as a handle of
        # `"R42`, which resolves to nothing and changes nothing on the card.
        # The grammar strips the backticks the span is drawn from.
        return f"Reply with {markup.code(f'{handle} 1')}."
    if request.state == "submitting":
        return _in_flight(request, responder=responder, limit=limit, escape=escape)
    if request.state == "resolved":
        return _approval_answer(
            request, outcome, escape=escape, limit=limit, responder=responder
        )
    return _closed(request, escape=escape, limit=limit, responder=responder)


@dataclass(frozen=True)
class _Chosen:
    """The option a resolved approval settled on, and how far it reaches."""

    label: str
    scope: str


def _chosen(
    request: SnapshotRequest,
    content: ApprovalContent,
    *,
    escape: Callable[[str], str],
    limit: int,
) -> _Chosen | None:
    """What was decided, or None where the host never said.

    The heading and the footer both need this and have to agree: a heading
    naming an outcome over a footer saying none was reported would be the card
    contradicting itself, so it is settled once and passed to both.
    """
    settled = request.result
    result = settled.result if settled else None
    if not isinstance(result, ApprovalResult):
        return None
    chosen = next(
        (option for option in content.options if option.option_id == result.option_id),
        None,
    )
    # An option the content never offered is still named rather than hidden:
    # the id is what the host said, and saying nothing would read as a plain
    # answer to a question that was not the one asked.
    #
    # Folded onto one line first. This label heads the card, and a heading is a
    # line that begins bold and ends in the handle — a newline in the middle of
    # it leaves two lines that are each only half of that, and Discord finds a
    # card again after a restart by looking for exactly that shape.
    named = " ".join((chosen.label if chosen else result.option_id).split())
    return _Chosen(
        label=_fit(named, _share(limit, 150, 8), escape=escape),
        scope=_scope(chosen) if chosen else "",
    )


def _approval_answer(
    request: SnapshotRequest,
    outcome: _Chosen | None,
    *,
    escape: Callable[[str], str],
    limit: int,
    responder: str | None,
) -> str:
    """Who answered, the outcome itself having already been said in the heading."""
    by = _by(request.decided_by, responder=responder, limit=limit, escape=escape)
    if outcome is None:
        return f"Answered{by}, but the host did not say which option was chosen."
    return f"Chosen{by}{outcome.scope}." if by else f"Answered{outcome.scope}."


def _questions_form(
    request: SnapshotRequest,
    content: QuestionsContent,
    reference: RequestReference,
    *,
    escape: Callable[[str], str],
    limit: int,
    markup: Markup,
    responder: str | None,
) -> tuple[list[str], list[str], str, bool]:
    fit = _Faithful(escape)
    handle = escape(reference.handle)
    head = [
        f"{markup.bold(_QUESTION_HEADINGS[request.state])} · request "
        f"{markup.code(handle)}",
        fit(content.title, _share(limit, 1500, 3)),
    ]

    body: list[str] = []
    if request.state == "open":
        budget = _label_budget(limit)
        for position, question in enumerate(content.questions, start=1):
            title = fit(question.title, budget) if question.title else ""
            body.append(
                markup.bold(f"{position}. {title}" if title else f"{position}.")
            )
            if question.prompt:
                body.append(fit(question.prompt, _share(limit, 800, 4)))
            for index, option in enumerate(question.options, start=1):
                body.append(_option_line(index, option, fit=fit, limit=limit))
    invites_answer = request.state == "open" and unanswerable(content.questions) is None
    if invites_answer and not fit.whole:
        return (head, body, _TOO_BIG, False)
    return (
        head,
        body,
        _questions_footer(
            request,
            content,
            handle,
            escape=escape,
            limit=limit,
            markup=markup,
            responder=responder,
        ),
        invites_answer,
    )


def _option_line(
    index: int,
    option: QuestionOption,
    *,
    fit: _Faithful,
    limit: int,
) -> str:
    """One numbered choice, label and the description that distinguishes it.

    The description gets the same budget as the label, because it is doing the
    same job: two options can share a label and differ only in the description
    under it, and clipping that is clipping the difference the reader is being
    asked to choose on.
    """
    line = f"{index}. {fit(option.label, _label_budget(limit))}"
    if option.description:
        line += f" — {fit(option.description, _label_budget(limit))}"
    return line


def _questions_footer(
    request: SnapshotRequest,
    content: QuestionsContent,
    handle: str,
    *,
    escape: Callable[[str], str],
    limit: int,
    markup: Markup,
    responder: str | None,
) -> str:
    if request.state == "open":
        stuck = unanswerable(content.questions)
        if stuck is not None:
            return stuck
        example = markup.code(_example(handle, content.questions))
        if len(content.questions) > 1:
            return f"Reply with {example} — every question needs an answer."
        return f"Reply with {example}."
    if request.state == "submitting":
        return _in_flight(request, responder=responder, limit=limit, escape=escape)
    if request.state == "resolved":
        return _questions_answer(
            request, content, escape=escape, limit=limit, responder=responder
        )
    return _closed(request, escape=escape, limit=limit, responder=responder)


def _example(handle: str, questions: list[Question]) -> str:
    """What answering this form actually looks like, typed out.

    Built from the form rather than fixed, because the shapes need different
    things said: one question takes a number on its own, several need saying
    which is which, and a question with nothing to number is answered in words.
    Only ever called for a form that has questions and every one of which can
    be answered, so there is always something for each part to say.
    """
    values = [example_value(question) for question in questions]
    if len(values) == 1:
        return f"{handle} {values[0]}"
    return f"{handle} " + "; ".join(
        f"q{position}={value}" for position, value in enumerate(values, start=1)
    )


def _questions_answer(
    request: SnapshotRequest,
    content: QuestionsContent,
    *,
    escape: Callable[[str], str],
    limit: int,
    responder: str | None,
) -> str:
    settled = request.result
    result = settled.result if settled else None
    by = _by(request.decided_by, responder=responder, limit=limit, escape=escape)
    # An empty `answers` is as legal as a missing result and says as little:
    # neither reader gives the list a minimum length, and a card settled from
    # the console or by a host that answers nothing lands here.
    if not isinstance(result, QuestionsResult) or not result.answers:
        return f"Answered{by}, but the host did not say what was chosen."
    labels = {
        option.option_id: option.label
        for question in content.questions
        for option in question.options
    }
    titles = {question.question_id: question.title for question in content.questions}

    # Budgeted on the escaped text and one whole answer at a time. Cutting the
    # joined string afterwards can land the cut inside whatever the escape
    # produced and show the reader half of it.
    label_budget = _share(limit, 150, 8)
    room = _share(limit, 1800, 3)
    said: list[str] = []
    spent = 0
    for position, answer in enumerate(result.answers, start=1):
        chosen = [
            _fit(labels.get(x, x), label_budget, escape=escape)
            for x in answer.selected_option_ids
        ]
        if answer.custom_text:
            chosen.append(f"“{_fit(answer.custom_text, label_budget, escape=escape)}”")
        title = _fit(
            titles.get(answer.question_id, answer.question_id),
            label_budget,
            escape=escape,
        )
        part = f"{title}: {', '.join(chosen) if chosen else 'nothing'}"
        if spent + len(part) + 2 > room:
            said.append(f"…and {len(result.answers) - position + 1} more")
            break
        said.append(part)
        spent += len(part) + 2
    answered = "; ".join(said)
    return f"{answered} — answered{by}." if by else f"{answered}."


def _in_flight(
    request: SnapshotRequest,
    *,
    responder: str | None,
    limit: int,
    escape: Callable[[str], str],
) -> str:
    if request.decided_by is None:
        return "An answer is on its way."
    actor = _actor(request.decided_by, responder=responder, limit=limit, escape=escape)
    return f"Answering: {actor}."


def _closed(
    request: SnapshotRequest,
    *,
    escape: Callable[[str], str],
    limit: int,
    responder: str | None,
) -> str:
    settled = request.result
    if settled is None:
        return "Closed without being answered."
    # A closed request reporting `answered` contradicts itself. Say both rather
    # than pick one, and never the word that would read as a decision.
    summary = CLOSED.get(
        settled.outcome, f"Closed, though the host called it {settled.outcome}."
    )
    if request.decided_by is not None:
        actor = _actor(
            request.decided_by, responder=responder, limit=limit, escape=escape
        )
        summary += f" Decided by {actor}."
    return summary


def _by(
    decided_by: DecidedBy | None,
    *,
    responder: str | None,
    limit: int,
    escape: Callable[[str], str],
) -> str:
    if decided_by is None:
        return ""
    actor = _actor(decided_by, responder=responder, limit=limit, escape=escape)
    return f" by {actor}"


def _actor(
    decided_by: DecidedBy,
    *,
    responder: str | None,
    limit: int,
    escape: Callable[[str], str],
) -> str:
    """Who answered, named the way the channel knows them where that is known.

    `responder` is the platform handle the adapter resolved for this decision;
    it only exists when the answer was given on this very platform, so where
    there is none the Switch identity is the only true thing to say.
    """
    where = SURFACES[decided_by.surface]
    if responder:
        return f"{responder} from {where}"
    return f"{_fit(decided_by.actor_id, _share(limit, 200, 8), escape=escape)} from {where}"


def _compose(
    head: list[str], body: list[str], footer: str, *, limit: int, if_cut: str
) -> tuple[str, bool]:
    """Head, as much of the body as fits, then the footer — and whether it cut.

    The body is what gets dropped because it is the part a reader can recover
    elsewhere: an option they cannot see is still an option, and the notice
    says how many are missing. The footer is not recoverable that way — it is
    the instruction for answering *here* — so it is measured first and the
    rest is spent around it.

    A body that had to be cut changes what the footer can honestly say, which
    is what `if_cut` is: answering by number means answering the numbers on
    the screen, and some of them are not. Both footers are measured, so the
    one that ends up being used is the one there was room for and the choice
    between them cannot change how much body fits.
    """
    footer = _truncate(footer, limit)
    if_cut = _truncate(if_cut, limit)
    spent = max(len(footer), len(if_cut))
    lines: list[str] = []
    for line in head:
        if spent + len(line) + 1 > limit:
            break
        lines.append(line)
        spent += len(line) + 1

    shown: list[str] = []
    for line in body:
        if spent + len(line) + 1 > limit:
            break
        shown.append(line)
        spent += len(line) + 1
    # A head line that did not fit is dropped silently — there is no count to
    # report for a title — but it is still the form failing to show itself,
    # and `if_cut` is as much the answer for that as for a dropped option.
    cut = len(shown) < len(body) or len(lines) < len(head)
    if len(shown) < len(body):
        notice = _CUT.format(left=len(body) - len(shown))
        while shown and spent + len(notice) + 1 > limit:
            spent -= len(shown.pop()) + 1
            notice = _CUT.format(left=len(body) - len(shown))
        if spent + len(notice) + 1 <= limit:
            shown.append(notice)
    return "\n".join([*lines, *shown, if_cut if cut else footer]), cut


def _mentioned(mention: str | None, body: str) -> str:
    return f"{mention} {body}" if mention else body


def _room(limit: int, mention: str | None) -> int:
    return max(1, limit - (len(mention) + 1 if mention else 0))


def _link(label: str, url: str | None, markup: Markup) -> str:
    """`url` as a link, or nothing at all if it is not a scheme worth linking."""
    if not url or not url.startswith(_LINK_SCHEMES):
        return ""
    return markup.link(label, url)


def _label_budget(limit: int) -> int:
    """How much room a thing a reader picks between gets.

    Generous where the short ceilings elsewhere are not, because this is the
    text the choice is made on: a permission label is routinely a whole
    command line, and two options that differ only past a short ceiling render
    as the same choice under two numbers. What the message can hold still
    bounds it — and a label that does not fit even this stops the card
    inviting an answer at all, rather than being quietly shortened into one.
    """
    return _share(limit, 1500, 3)


class _Faithful:
    """`_fit`, remembering whether it ever had to cut.

    Every piece of a form a reader decides on goes through one of these, so
    "did this show itself whole" is answered by the fitting itself rather than
    by a second set of checks kept in step with it by hand. That pairing is
    the point: a budget added later without a matching check is how a form
    comes to clip the sentence naming a second operation and still ask for a
    number.

    Whole means every one of them fitted. A title cut short is as good a
    reason not to invite an answer as an option cut short — the reader is
    choosing on what is in front of them, and a question they can only see
    part of is not one a number answers.
    """

    def __init__(self, escape: Callable[[str], str]) -> None:
        self._escape = escape
        self.whole = True

    def __call__(self, text: str, limit: int) -> str:
        self.whole = self.whole and len(self._escape(text)) <= limit
        return _fit(text, limit, escape=self._escape)


def _scope(option: ApprovalOption) -> str:
    """How far an approval reaches, where the label may not have said.

    The same wording the answered card uses, on the form itself: two options
    can be labelled the same and mean "this once" and "from now on", and a
    reader choosing between them by number needs the difference said.
    """
    return _FOR_SESSION if option.decision == "acceptForSession" else ""


def _carried(option: ApprovalOption, control_label_limit: int | None) -> bool:
    """Whether a control beside the card already shows the whole of this option.

    An option a reader can press, spelled out again underneath, is the same
    choice twice — and on a phone the second copy is what pushes the rest of
    the card off the screen. It is only the same choice if the control shows
    all of it, which is two things: a label short enough that the button did
    not have to cut it, and nothing said beside the label that a button has no
    room for. A scope is exactly that, so an option reaching past this turn
    keeps its line while the ones a button says in full lose theirs.

    Every line is fitted before this is asked, kept or not. A label too long
    for the card is a form that cannot honestly ask for a number, and that is
    as true of a label on a button as of one in the body.

    None where the platform draws no controls, which is most of them: nothing
    but the body is carrying the choices there.
    """
    if control_label_limit is None or _scope(option):
        return False
    return len(option.label.strip()) <= control_label_limit


def _share(limit: int, most: int, denominator: int) -> int:
    """One value's budget: `most` characters, or a share of a tighter limit.

    The fixed ceilings are `slack.py`'s, so a value is cut to the same length
    on either platform wherever the platform's own limit leaves room for it.
    The share is what keeps a small `limit` from being spent entirely on the
    first value that reaches it — and `_compose` still bounds the whole
    message afterwards, so this is about fairness between values rather than
    about the message fitting.
    """
    return max(1, min(most, limit // denominator))


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
