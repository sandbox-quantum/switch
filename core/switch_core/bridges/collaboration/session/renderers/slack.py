"""A request, as Slack shows it.

An approval is a decision someone has to make, so it goes in the channel root
where a person will see it, with a button per option. It also carries the text
form of the same question: a card can fail to render, a person can be on a
client that will not press buttons, and the contract requires every bridge to
accept an explicit text answer as well as a control.

The card renders whatever state the request is currently in, so the same
function serves the first post and every edit after it. Buttons appear only
while the request is open: once an answer is in flight or the request has
settled, offering one invites a press that cannot land.

A title, a detail and an option label are all written by whatever asked for the
approval, so every one of them is escaped before it reaches somewhere Slack
parses mrkdwn — which is both the section text and the message's own `text`.
Button labels are `plain_text`, which Slack does not parse, and escaping one
would put the entity in front of the reader instead of the character.

They are also unbounded, and Slack's block limits are not: a title long enough
to push a section past 3000 characters is rejected, and it takes the whole post
with it rather than just the value that caused it. Every agent-supplied value
therefore has a budget here, and the budgets are set so that no combination of
them can reach a limit.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from switch_core.bridges.collaboration.slack.mrkdwn import escape_mrkdwn

from ..contract import (
    ApprovalContent,
    ApprovalOption,
    ApprovalResult,
    DecidedBy,
    Question,
    QuestionOption,
    QuestionsContent,
    QuestionsResult,
    SnapshotRequest,
    Surface,
)
from . import ANSWER_ACTION, RequestReference

# Slack's own limits. Exceeding one is rejected at the API, so it is caught here
# where the offending value can still be named.
_MAX_ACTION_ID = 255
_MAX_BUTTON_TEXT = 75
_MAX_VALUE = 2000
_MAX_ELEMENTS = 25

# Budgets for the values this renderer does not control. A title and a detail
# share one section with a heading and a few characters of framing, so they are
# set to leave the section comfortably short of Slack's 3000 characters however
# both are spent: 1500 + 1200 + a heading under 30 leaves room to spare.
_MAX_TITLE = 1500
_MAX_DETAIL = 1200
# A label appears once per option in the text form and once in the footer of a
# settled card. Twenty-five of them at this length still leave that text far
# short of what Slack accepts for a message body. It also bounds the pieces of
# a settled form's footer — a question's title, and what was written in answer
# to it — which play the same part in that sentence as a label does.
_MAX_LABEL = 150
# Who answered. A Switch identity rather than anything an agent writes, but the
# footer's arithmetic should not depend on that staying true.
_MAX_ACTOR = 200

# A question's own budgets. Each question is its own section, so these bound
# one section between them rather than the message: a title, a prompt and the
# option lines that fit in what is left of `_MAX_SECTION`.
_MAX_QUESTION_TITLE = 150
_MAX_PROMPT = 800
_MAX_DESCRIPTION = 200
# The settled footer names every question and what was said to it, and both are
# agent-supplied. A context block takes 3000 characters, and this is measured on
# the escaped text, so what is left covers the actor and the framing.
_MAX_ANSWERED = 1800
_MAX_SECTION = 2800
# Blocks per message are capped at 50 and a form needs one each plus framing.
# A card asking more questions than this is not a card, so it is refused rather
# than posted with questions missing: every question has to be answered, and
# one that was never shown cannot be.
_MAX_QUESTIONS = 20

_DANGEROUS = {"decline", "cancel"}

_HEADINGS = {
    "open": "Permission needed",
    "submitting": "Permission needed",
    "resolved": "Permission answered",
    "closed": "Permission request closed",
}

_QUESTION_HEADINGS = {
    "open": "Questions",
    "submitting": "Questions",
    "resolved": "Questions answered",
    "closed": "Questions closed",
}

# Where the person who answered was, in the words a reader of that platform
# would use for it.
_SURFACES: dict[Surface, str] = {
    "console": "the console",
    "switch-web": "Switch",
    "slack": "Slack",
    "mattermost": "Mattermost",
    "discord": "Discord",
    "teams": "Teams",
    "telegram": "Telegram",
}

# Every outcome but `answered`. Each says the request was not answered, because
# a closed request that reads as answered is the one mistake this must not make.
_CLOSED = {
    "cancelled": "Cancelled before it was answered.",
    "expired": "Expired before it was answered.",
    "interrupted": "Interrupted before it was answered.",
    "provider-error": "The provider failed before it was answered.",
}


@dataclass(frozen=True)
class SlackMessage:
    """A `chat.postMessage` body: blocks, and the text a notification shows."""

    text: str
    blocks: list[dict[str, Any]]


def render_request(
    request: SnapshotRequest, reference: RequestReference
) -> SlackMessage:
    """Whichever card `request` calls for, by the kind of thing it asks."""
    if isinstance(request.content, QuestionsContent):
        return render_questions(request, reference)
    return render_approval(request, reference)


def render_approval(
    request: SnapshotRequest, reference: RequestReference
) -> SlackMessage:
    """Render an approval as the card that stands for it right now.

    Open, it offers a button per option and is also answerable in words. Once
    an answer is in flight or the request has settled, the buttons go and the
    card says what became of it instead.
    """
    content = _approval(request)
    prompt = f"*{_HEADINGS[request.state]}*\n{_fit(content.title, _MAX_TITLE)}"
    if content.detail:
        prompt += f"\n`{_fit(content.detail, _MAX_DETAIL)}`"

    blocks: list[dict[str, Any]] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": prompt}}
    ]
    if request.state == "open":
        # Only a card that is still offering buttons can exceed the limit, so a
        # settled one with too many options still redraws rather than sticking.
        if len(content.options) > _MAX_ELEMENTS:
            raise ValueError(
                f"Request {request.request_id} has {len(content.options)} options; "
                f"Slack renders at most {_MAX_ELEMENTS} buttons."
            )
        blocks.append(
            {
                "type": "actions",
                "block_id": f"{ANSWER_ACTION}:{request.request_id}",
                "elements": [_button(option, reference) for option in content.options],
            }
        )
    blocks.append(
        {
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": _footer(request, content, reference)}
            ],
        }
    )
    return SlackMessage(text=render_approval_text(request, reference), blocks=blocks)


def render_approval_text(request: SnapshotRequest, reference: RequestReference) -> str:
    """The same approval with no card at all.

    This is the notification fallback, and the form a person is answering when
    they type rather than press. Numbering matches the button order, so "1"
    means the same on both. It follows the request's state for the same reason
    the card does: a notification that still asks a settled question is a
    notification asking for an answer that cannot land.

    Slack reads a message's `text` as mrkdwn, so this is not a plain string it
    can be careless with: every value is escaped, and only the quote markers
    and the numbering are markup this wrote.
    """
    content = _approval(request)
    lines = [
        f"> Request {escape_mrkdwn(reference.handle)}: "
        f"{_fit(content.title, _MAX_TITLE)}"
    ]
    if content.detail:
        lines.append(f"> {_fit(content.detail, _MAX_DETAIL)}")
    if request.state == "open":
        lines += [
            f"{index}. {_fit(option.label, _MAX_LABEL)}"
            for index, option in enumerate(content.options, start=1)
        ]
    lines.append(_footer(request, content, reference))
    return "\n".join(lines)


def _approval(request: SnapshotRequest) -> ApprovalContent:
    content = request.content
    if not isinstance(content, ApprovalContent):
        raise ValueError(
            f"Request {request.request_id} is not an approval: {content.kind}."
        )
    return content


def _footer(
    request: SnapshotRequest, content: ApprovalContent, reference: RequestReference
) -> str:
    """The one line under the card that says where the request has got to.

    Shared by the card and the text fallback so the two cannot disagree about
    whether something was answered. It returns text that is ready for mrkdwn:
    the framing is this file's own, and every value that came from anywhere
    else is escaped here, where it is also measured.
    """
    if request.state == "open":
        # A code span, because the reader is meant to copy this and quote marks
        # around it are not part of the answer: `"R42 1"` parses as a handle of
        # `"R42`, which resolves to nothing and changes nothing on the card.
        # Slack draws a span from the backticks and the grammar strips them.
        return f"Reply with `{escape_mrkdwn(reference.handle)} 1`, or press a button."
    if request.state == "submitting":
        if request.decided_by is None:
            return "An answer is on its way."
        return f"Answering: {_actor(request.decided_by)}."
    if request.state == "resolved":
        return _answered(request, content)
    settled = request.result
    if settled is None:
        return "Closed without being answered."
    # A closed request reporting `answered` contradicts itself. Say both rather
    # than pick one, and never the word that would read as a decision.
    return _CLOSED.get(
        settled.outcome, f"Closed, though the host called it {settled.outcome}."
    )


def _answered(request: SnapshotRequest, content: ApprovalContent) -> str:
    settled = request.result
    result = settled.result if settled else None
    by = f" by {_actor(request.decided_by)}" if request.decided_by else ""
    if not isinstance(result, ApprovalResult):
        return f"Answered{by}, but the host did not say which option was chosen."
    chosen = next(
        (option for option in content.options if option.option_id == result.option_id),
        None,
    )
    # An option the content never offered still gets named rather than hidden:
    # the id is what the host said, and saying nothing would read as a plain
    # answer to a question that was not the one asked.
    label = _fit(chosen.label if chosen else result.option_id, _MAX_LABEL)
    scope = (
        " (applies for the rest of this session)"
        if chosen and chosen.decision == "acceptForSession"
        else ""
    )
    return f"{label}{scope} — chosen{by}." if by else f"{label}{scope}."


def _actor(decided_by: DecidedBy) -> str:
    return (
        f"{_fit(decided_by.actor_id, _MAX_ACTOR)} from {_SURFACES[decided_by.surface]}"
    )


def _button(option: ApprovalOption, reference: RequestReference) -> dict[str, Any]:
    action_id = f"{ANSWER_ACTION}:{option.option_id}"
    if len(action_id) > _MAX_ACTION_ID:
        raise ValueError(f"Option id is too long for Slack: {option.option_id!r}.")
    if len(reference.token) > _MAX_VALUE:
        raise ValueError("Request reference is too long for a Slack button value.")
    button: dict[str, Any] = {
        "type": "button",
        "action_id": action_id,
        "value": reference.token,
        "text": {
            "type": "plain_text",
            "text": _truncate(option.label, _MAX_BUTTON_TEXT),
            "emoji": True,
        },
    }
    if option.decision in _DANGEROUS:
        button["style"] = "danger"
    elif option.decision == "accept":
        button["style"] = "primary"
    return button


# ── Questions ────────────────────────────────────────────────────────────────


def render_questions(
    request: SnapshotRequest, reference: RequestReference
) -> SlackMessage:
    """Render a questions request as the card that stands for it right now.

    A question is not a permission, and the difference shows in what the card
    offers. Buttons appear only where a single press can finish the answer —
    one question, one choice — because a form that needs several answers cannot
    be assembled by pressing, and half-pressed controls with no draft behind
    them would submit whichever part was pressed last.

    Everything else is answered in words. The card numbers its questions and
    their options, and the footer says what to type against this particular
    form, so the instruction on the card is the grammar the parser accepts.
    """
    content = _questions(request)
    if len(content.questions) > _MAX_QUESTIONS:
        raise ValueError(
            f"Request {request.request_id} asks {len(content.questions)} questions; "
            f"Slack shows at most {_MAX_QUESTIONS} and every one has to be answered."
        )

    heading = _QUESTION_HEADINGS[request.state]
    blocks: list[dict[str, Any]] = [
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": f"*{heading}*\n{_fit(content.title, _MAX_TITLE)}",
            },
        }
    ]
    open_now = request.state == "open"
    if open_now:
        blocks += [
            {"type": "section", "text": {"type": "mrkdwn", "text": section}}
            for section in (
                _question_section(position, question)
                for position, question in enumerate(content.questions, start=1)
            )
        ]
    pressable = _pressable(request, content)
    if pressable is not None:
        blocks.append(
            {
                "type": "actions",
                "block_id": f"{ANSWER_ACTION}:{request.request_id}",
                "elements": [
                    _option_button(option, reference) for option in pressable.options
                ],
            }
        )
    blocks.append(
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": _questions_footer(
                        request, content, reference, buttons=pressable is not None
                    ),
                }
            ],
        }
    )
    return SlackMessage(text=render_questions_text(request, reference), blocks=blocks)


def render_questions_text(request: SnapshotRequest, reference: RequestReference) -> str:
    """The same form with no card at all, and the whole of it.

    The notification and accessibility string, and what is left when blocks do
    not render. Numbering matches the card exactly, because the numbers are what
    an answer is made of, and unlike the card it never drops an option — it is
    not bound by a block limit.

    Whether a channel reader can see this at all when the message also carries
    blocks is not settled, so nothing here relies on it being visible: the card
    says out loud when it has cut a list rather than leaving the reader to find
    the rest in this.
    """
    content = _questions(request)
    lines = [
        f"> Request {escape_mrkdwn(reference.handle)}: "
        f"{_fit(content.title, _MAX_TITLE)}"
    ]
    if request.state == "open":
        for position, question in enumerate(content.questions, start=1):
            lines.append(
                f"*{position}. {_fit(question.title, _MAX_QUESTION_TITLE)}*"
                if question.title
                else f"*{position}.*"
            )
            if question.prompt:
                lines.append(_fit(question.prompt, _MAX_PROMPT))
            lines += [
                _option_line(index, option)
                for index, option in enumerate(question.options, start=1)
            ]
    lines.append(
        _questions_footer(
            request,
            content,
            reference,
            buttons=_pressable(request, content) is not None,
        )
    )
    return "\n".join(lines)


def _questions(request: SnapshotRequest) -> QuestionsContent:
    content = request.content
    if not isinstance(content, QuestionsContent):
        raise ValueError(
            f"Request {request.request_id} is not a set of questions: {content.kind}."
        )
    return content


def _pressable(request: SnapshotRequest, content: QuestionsContent) -> Question | None:
    """The one question a press could answer on its own, if there is one.

    Only while the request is open, and only when the whole form is a single
    choice out of a list Slack will draw. Anything else is answered in words.
    """
    if request.state != "open" or len(content.questions) != 1:
        return None
    question = content.questions[0]
    if question.multi_select or not question.options:
        return None
    if len(question.options) > _MAX_ELEMENTS:
        return None
    return question


def _question_section(position: int, question: Question) -> str:
    """One question, numbered, with as many of its options as will fit.

    Slack rejects a section over 3000 characters and takes the whole post with
    it, so a long list is cut. The cut is said out loud, with the count and
    where the numbering resumes, and the numbering itself is untouched: an
    option that is not shown is still answerable by its number by anyone who
    knows it.

    That last part is the weak point, and it is open (CHOO-2621): the full list
    is in the message text, but whether a channel reader sees the text of a
    message that carries blocks is unverified. If they cannot, a cut option is
    one nobody can find, and this should refuse the way a form of more than
    `_MAX_QUESTIONS` does rather than cut.
    """
    heading = f"*{position}. {_fit(question.title, _MAX_QUESTION_TITLE)}*"
    if question.prompt:
        heading += f"\n{_fit(question.prompt, _MAX_PROMPT)}"

    lines: list[str] = []
    spent = len(heading)
    for index, option in enumerate(question.options, start=1):
        line = _option_line(index, option)
        if spent + len(line) + 1 > _MAX_SECTION:
            left = len(question.options) - index + 1
            lines.append(f"_…and {left} more, numbered {index} up. Answer by number._")
            break
        lines.append(line)
        spent += len(line) + 1
    return "\n".join([heading, *lines])


def _option_line(index: int, option: QuestionOption) -> str:
    line = f"{index}. {_fit(option.label, _MAX_LABEL)}"
    if option.description:
        line += f" — {_fit(option.description, _MAX_DESCRIPTION)}"
    return line


def _option_button(
    option: QuestionOption, reference: RequestReference
) -> dict[str, Any]:
    action_id = f"{ANSWER_ACTION}:{option.option_id}"
    if len(action_id) > _MAX_ACTION_ID:
        raise ValueError(f"Option id is too long for Slack: {option.option_id!r}.")
    if len(reference.token) > _MAX_VALUE:
        raise ValueError("Request reference is too long for a Slack button value.")
    return {
        "type": "button",
        "action_id": action_id,
        "value": reference.token,
        "text": {
            "type": "plain_text",
            "text": _truncate(option.label, _MAX_BUTTON_TEXT),
            "emoji": True,
        },
    }


def _questions_footer(
    request: SnapshotRequest,
    content: QuestionsContent,
    reference: RequestReference,
    *,
    buttons: bool,
) -> str:
    """The one line under the form that says how to answer it, or how it went.

    Ready for mrkdwn, like the approval's: escaping happens here, beside the
    budget that measures it.
    """
    if request.state == "open":
        stuck = _unanswerable(content.questions)
        if stuck:
            where = (
                ""
                if len(content.questions) == 1
                else " on " + ", ".join(f"q{position}" for position in stuck)
            )
            return (
                f"This card cannot be answered: nothing to choose{where}, "
                "and no written answer allowed."
            )
        example = f"`{_example(reference.handle, content.questions)}`"
        if buttons:
            return f"Reply with {example}, or press a button."
        if len(content.questions) > 1:
            return f"Reply with {example} — every question needs an answer."
        return f"Reply with {example}."
    if request.state == "submitting":
        if request.decided_by is None:
            return "An answer is on its way."
        return f"Answering: {_actor(request.decided_by)}."
    if request.state == "resolved":
        return _answered_questions(request, content)
    settled = request.result
    if settled is None:
        return "Closed without being answered."
    return _CLOSED.get(
        settled.outcome, f"Closed, though the host called it {settled.outcome}."
    )


def _unanswerable(questions: list[Question]) -> list[int]:
    """The questions offering nothing to choose and taking no written answer.

    A question like that cannot be answered on any surface — there is no number
    to type and words are refused — and because every question has to be
    answered for the answer to be sent at all, one of them makes the whole form
    unanswerable. It is the host's mistake rather than the reader's, so the card
    says so instead of printing an instruction the resolver would then refuse.
    """
    return [
        position
        for position, question in enumerate(questions, start=1)
        if not question.options and not question.allow_custom_answer
    ]


def _example(handle: str, questions: list[Question]) -> str:
    """What answering this form actually looks like, typed out.

    Built from the form rather than fixed, because the shapes need different
    things said: one question takes a number on its own, several need saying
    which is which, and a question with nothing to number is answered in words.
    Only ever called for a form every question of which can be answered, so
    there is always something for each part to say.
    """
    values = [_example_value(question) for question in questions]
    if len(values) == 1:
        return f"{escape_mrkdwn(handle)} {values[0]}"
    return f"{escape_mrkdwn(handle)} " + "; ".join(
        f"q{position}={value}" for position, value in enumerate(values, start=1)
    )


def _example_value(question: Question) -> str:
    if not question.options:
        return '"your answer"'
    if question.multi_select and len(question.options) > 1:
        return "1,2"
    return "1"


def _answered_questions(request: SnapshotRequest, content: QuestionsContent) -> str:
    settled = request.result
    result = settled.result if settled else None
    by = f" by {_actor(request.decided_by)}" if request.decided_by else ""
    if not isinstance(result, QuestionsResult):
        return f"Answered{by}, but the host did not say what was chosen."
    labels = {
        option.option_id: option.label
        for question in content.questions
        for option in question.options
    }
    titles = {question.question_id: question.title for question in content.questions}

    # Budgeted on the escaped text and one whole answer at a time. Measuring
    # before escaping would let a label full of `&` — a command line, a bit of
    # code — take a footer that looked well inside the limit past the 3000 a
    # context block accepts, and Slack rejects the whole update rather than the
    # block: the card would stop tracking the request it stands for. Cutting
    # the joined string afterwards is no good either, because the cut can land
    # inside an entity and show the reader a literal `&am`.
    said: list[str] = []
    spent = 0
    for position, answer in enumerate(result.answers, start=1):
        # An id the content never offered is still named rather than hidden,
        # for the same reason an approval names one: it is what the host said,
        # and dropping it would read as an answer to a question nobody asked.
        chosen = [
            _fit(labels.get(x, x), _MAX_LABEL) for x in answer.selected_option_ids
        ]
        if answer.custom_text:
            chosen.append(f"“{_fit(answer.custom_text, _MAX_LABEL)}”")
        title = _fit(titles.get(answer.question_id, answer.question_id), _MAX_LABEL)
        part = f"{title}: {', '.join(chosen) if chosen else 'nothing'}"
        if spent + len(part) + 2 > _MAX_ANSWERED:
            said.append(f"…and {len(result.answers) - position + 1} more")
            break
        said.append(part)
        spent += len(part) + 2
    answered = "; ".join(said)
    return f"{answered} — answered{by}." if by else f"{answered}."


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _fit(text: str, limit: int) -> str:
    """Escape `text` for mrkdwn and keep the result inside `limit`.

    The cut is made on the source, never on the escaped form: slicing after
    escaping can leave half an entity behind, and Slack shows the reader a
    literal `&am`. Escaping only ever lengthens a string, so the longest prefix
    that still fits can be found on the source and escaped whole.
    """
    escaped = escape_mrkdwn(text)
    if len(escaped) <= limit:
        return escaped
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if len(escape_mrkdwn(text[:middle])) + 1 <= limit:
            low = middle
        else:
            high = middle - 1
    return escape_mrkdwn(text[:low]) + "…"
