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

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from switch_core.bridges.collaboration.slack.mrkdwn import escape_mrkdwn, plain_text

from ..contract import (
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
    Surface,
    TurnUpsert,
)
from . import ANSWER_ACTION, RequestReference, turn_state

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

# A turn's own budgets. A message is a section of its own, and the section is
# what has to fit: quoting costs two characters a line on top of the text, so
# the quoted form is measured rather than the text it was built from. The tool
# log is one context block, which takes the same 3000 a section does.
_MAX_MESSAGE = 2400
_MAX_ACTIVITY_TITLE = 200
_MAX_ACTIVITY_DETAIL = 120
_MAX_ACTIVITY = 2800
# Blocks per message are capped at 50, and a long turn is cut rather than
# refused: unlike a form, a turn showing some of itself is still worth reading,
# and unlike a form there is nothing here anyone has to answer.
_MAX_MESSAGES = 20
_MAX_ACTIVITY_LINES = 12

# A `plan` block draws the tool log itself: one collapsed header with a card
# per step inside it, expanded by whoever wants the steps. That is the
# disclosure the context block was only ever standing in for, and unlike a
# stream it is an ordinary message block — so it goes wherever the turn goes,
# beside the prompt that started it rather than in a thread under it.
#
# Slack caps a plan at 50 tasks and rejects the block over it, taking the whole
# post with it, so a long turn keeps its newest end and the header says what it
# dropped. The per-task budgets are ours: nothing here is near a documented
# limit, and a card is read at a glance.
_MAX_PLAN_TASKS = 50
_MAX_PLAN_TITLE = 150
_MAX_PLAN_TASK_TITLE = 200
_MAX_PLAN_TASK_DETAILS = 200
# `chat.postMessage` takes 40,000 characters of `text`, and twenty messages each
# inside their own budget is more than that, so the fallback is bounded as a
# whole as well as a message at a time.
_MAX_TEXT = 39000

# A streamed turn's budgets. Slack caps a `task_update` chunk at 256
# characters and rejects the whole append that carries one over it, so the cap
# is measured on the serialised chunk rather than on any one value inside it —
# the id comes from the host too, and three values each inside their own budget
# can still be over the one Slack applies.
_MAX_TASK_CHUNK = 256
_MAX_TASK_ID = 64
_MAX_TASK_TITLE = 110
_MAX_TASK_DETAILS = 60
# `chat.startStream` documents 12,000 characters of markdown, and a message is
# appended whole rather than in pieces, so one has to fit inside that alone.
_MAX_STREAM_MESSAGE = 11000

# Slack's three task states against the contract's four. `declined` is not an
# error — the call did what it was told, and what it was told was no — but
# Slack has nowhere else to put it, so the status says only that the step is
# over and the glyph the fallback already uses carries which of the two it was.
_TASK_STATUS = {
    "in-progress": "in_progress",
    "completed": "complete",
    "failed": "error",
    "declined": "error",
}

_DANGEROUS = {"decline", "cancel"}

# How a tool call went, in one character, because it is read at a glance and
# down the left edge of a list rather than as a sentence.
_ACTIVITY = {
    "in-progress": "▸",
    "completed": "✓",
    "failed": "✗",
    "declined": "⊘",
}

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
    """Whichever card `request` calls for, by the kind of thing it asks.

    The first block always carries the token as its `block_id`, whatever kind
    or state the card is in: `find_request_card` recovers an uncertain
    delivery by scanning a channel's messages for it, and it has only the
    token to look for — the actions block's own `block_id` is keyed by
    request id and only present while the card still offers buttons.
    """
    message = (
        render_questions(request, reference)
        if isinstance(request.content, QuestionsContent)
        else render_approval(request, reference)
    )
    message.blocks[0]["block_id"] = f"switch-request:{reference.token}"
    return message


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
    if request.state == "open" and content.options:
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
        if not content.options:
            # The same shape as a form with no questions in it, and refused the
            # same way and for the same reasons: there is no number to type, no
            # word to say and nothing to press, so an instruction here would be
            # one the resolver goes on to refuse. Neither reader of the contract
            # gives `options` a minimum length, and the schema is still the
            # wrong place to add one — see `_unanswerable`.
            return "This card cannot be answered: it offers no options."
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
    summary = _CLOSED.get(
        settled.outcome, f"Closed, though the host called it {settled.outcome}."
    )
    if request.decided_by is not None:
        summary += f" Decided by {_actor(request.decided_by)}."
    return summary


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
        if stuck is not None:
            return stuck
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
    summary = _CLOSED.get(
        settled.outcome, f"Closed, though the host called it {settled.outcome}."
    )
    if request.decided_by is not None:
        summary += f" Decided by {_actor(request.decided_by)}."
    return summary


def _unanswerable(questions: list[Question]) -> str | None:
    """What the card says instead of an instruction, when there is no answering it.

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


def _example(handle: str, questions: list[Question]) -> str:
    """What answering this form actually looks like, typed out.

    Built from the form rather than fixed, because the shapes need different
    things said: one question takes a number on its own, several need saying
    which is which, and a question with nothing to number is answered in words.
    Only ever called for a form that has questions and every one of which can
    be answered, so there is always something for each part to say.
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
    # An empty `answers` is as legal as a missing result and says as little.
    # Neither reader gives the list a minimum length, and the settled event is
    # the host's rather than ours, so a card settled from the console or by a
    # host that answers nothing lands here. Without this the loop below produces
    # nothing and the whole footer comes out as " — answered by …." or, with no
    # actor, as a full stop: a card that looks answered and shows no answer.
    if not isinstance(result, QuestionsResult) or not result.answers:
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


# ── Activity ─────────────────────────────────────────────────────────────────


def render_activity(items: list[Item], turn: TurnUpsert) -> SlackMessage:
    """One turn, as the channel sees it: what was said, over what was done.

    The two are drawn differently because they are read differently. What the
    agent and the person said is the conversation, so it goes in the body at
    full size. What the agent *did* is a hundred lines of tool calls nobody
    reads unless something looks wrong, so it goes in a `plan` block under
    them: one header carrying where the turn got to, collapsed, with a card per
    step inside for whoever opens it. That is a placement decision, not an
    access one: both are visible to everyone in the channel, and nothing here
    decides who those people are.

    A turn with nothing done has no plan to draw, so its state goes in a
    context line instead — the header is part of the plan, and a plan with no
    tasks is a disclosure with nothing behind it.

    Tool activity is gathered into that one block rather than interleaved. A
    turn alternates between saying and doing, so keeping the order would put a
    paragraph, six tool lines, another paragraph — and the thing a reader came
    for is the paragraphs.

    Long turns are cut from the front, keeping what happened most recently,
    because that is the end a reader is looking at. Both cuts say how much they
    took: a turn that quietly showed half of itself would read as a turn that
    only did half.

    Somewhere in it is the turn's own state, because this message is edited in
    place as the turn runs and a reader has to be able to tell a turn that
    finished from one that stopped.

    Only the agent's own words are the conversation here. A person's message
    is skipped rather than shown quoted back: the turn always opens with one
    — the command that started it, echoed as its first item — and showing it
    back to the room it was typed in is only ever telling someone what they
    just said.
    """
    said = [item for item in items if item.kind == "assistant-message"]
    did = [item for item in items if item.kind == "tool-activity"]
    if not items:
        raise ValueError("This turn has no items, so there is nothing to show.")

    blocks: list[dict[str, Any]] = []
    hidden = max(len(said) - _MAX_MESSAGES, 0)
    if hidden:
        blocks.append(_context(f"_…{hidden} earlier in this turn, not shown._"))
    blocks += [
        {"type": "section", "text": {"type": "mrkdwn", "text": _message_text(item)}}
        for item in said[len(said) - _MAX_MESSAGES :]
    ]
    if did:
        blocks.append(_plan(items, did, turn))
    else:
        blocks.append(_context(f"_{turn_state(items, turn)}_"))
    return SlackMessage(text=render_activity_text(items, turn), blocks=blocks)


def render_turn_with_request(
    items: list[Item],
    turn: TurnUpsert,
    request: SnapshotRequest,
    reference: RequestReference,
) -> SlackMessage:
    """One message for a turn whose request is drawn with it, not apart from it.

    Everything `render_activity` already draws, with the request's own card
    content appended after it — same buttons, same footer, same settled
    wording, because a request drawn here is not a different card, only a
    different place to put the one `render_request` already knows how to
    draw. `render_request` already marks its own first block for
    `find_request_card`, which scans every block of a message rather than
    only the first, so that marker needs no help finding it from here.

    The combined `text` is bounded the same way `render_activity_text` bounds
    itself, and for the same reason: each half is already under Slack's
    40,000-character cap on its own, but nothing stopped the *sum* clearing
    it, and the request is the half someone has to press to unstick the
    session — dropping it to make room would be the one drop this cannot
    make silently.
    """
    activity = render_activity(items, turn)
    card = render_request(request, reference)
    blocks = activity.blocks + card.blocks
    text = "\n\n".join(_within([activity.text, card.text], _MAX_TEXT))
    return SlackMessage(text=text, blocks=blocks)


def render_activity_text(items: list[Item], turn: TurnUpsert) -> str:
    """The same turn with no card at all.

    The notification string, and what a reader is left with if blocks do not
    render, so it carries the doing as well as the saying rather than assuming
    the context block arrived.

    Each block has its own budget, but `text` is one string with a cap of its
    own and twenty of them clear it, so the whole is bounded too — the same end
    kept, and again saying what it dropped.

    Only the agent's own words, same as `render_activity`: a person's message
    is skipped rather than shown quoted back.
    """
    said = [item for item in items if item.kind == "assistant-message"]
    did = [item for item in items if item.kind == "tool-activity"]
    if not items:
        raise ValueError("This turn has no items, so there is nothing to show.")

    lines: list[str] = []
    hidden = max(len(said) - _MAX_MESSAGES, 0)
    if hidden:
        lines.append(f"…{hidden} earlier in this turn, not shown.")
    lines += [_message_text(item) for item in said[len(said) - _MAX_MESSAGES :]]
    lines += _activity_lines(did)
    lines.append(turn_state(items, turn))
    return "\n".join(_within(lines, _MAX_TEXT))


def _within(entries: list[str], limit: int) -> list[str]:
    """The last of these entries that fit, whole, with a note for the rest.

    Entries, not lines: one of them is a whole message and may be hundreds of
    lines, the next is a single tool call. Dropping eight messages and calling
    it eight lines would undercount what was taken by two orders of magnitude,
    which is the one thing this cut exists to avoid.
    """
    kept: list[str] = []
    spent = 0
    for entry in reversed(entries):
        if spent + len(entry) + 1 > limit:
            kept.append(f"…{len(entries) - len(kept)} earlier entries, not shown.")
            break
        kept.append(entry)
        spent += len(entry) + 1
    kept.reverse()
    return kept


def _message_text(item: Item) -> str:
    """One thing the agent said, fit to a section's budget."""
    return _fit(item.text, _MAX_MESSAGE) if item.text else "_(nothing said)_"


def _activity_lines(items: list[Item]) -> list[str]:
    """The tool log, newest end kept, each line marked with how it went."""
    lines: list[str] = []
    spent = 0
    for position, item in enumerate(reversed(items), start=1):
        title = _fit(item.title, _MAX_ACTIVITY_TITLE) if item.title else "_(untitled)_"
        line = f"{_ACTIVITY[item.status]} {title}"
        if item.text:
            line += f" — {_fit(item.text, _MAX_ACTIVITY_DETAIL)}"
        if position > _MAX_ACTIVITY_LINES or spent + len(line) + 1 > _MAX_ACTIVITY:
            lines.append(f"_…and {len(items) - position + 1} more before these._")
            break
        lines.append(line)
        spent += len(line) + 1
    lines.reverse()
    return lines


def _plan(items: list[Item], did: list[Item], turn: TurnUpsert) -> dict[str, Any]:
    """The tool log as a plan: a header to read, and the steps behind it.

    The header is the turn's state, because collapsed is how most readers will
    ever see this block and a header saying only "Activity" would leave a turn
    that stalled looking like one that finished. What the cut dropped is said
    there too, for the same reason.

    Cards are keyed on the item's own id, so a turn redrawn as it runs moves
    each step rather than growing a second copy of it — the same property the
    streamed timeline is built on, and the reason a plan can be edited in place
    at all.
    """
    kept = did[len(did) - _MAX_PLAN_TASKS :]
    dropped = len(did) - len(kept)
    title = turn_state(items, turn)
    if dropped:
        step = "step" if dropped == 1 else "steps"
        title = f"{title} …{dropped} earlier {step}, not shown."
    return {
        "type": "plan",
        "title": _truncate(title, _MAX_PLAN_TITLE),
        "tasks": [_plan_task(item) for item in kept],
    }


def _plan_task(item: Item) -> dict[str, Any]:
    """One tool call as a card inside the plan.

    Plain text, not mrkdwn: a card's title renders none, so markup passed into
    it arrives as literal underscores and backticks in front of the reader.
    Escaped all the same — Slack asks for `&`, `<` and `>` escaped in anything
    sent to the API, and a tool call titled `Ran <!here>` is a host string that
    would otherwise notify the channel.

    Slack has three states against the contract's four, and `declined` is not
    an error — the call did what it was told, and what it was told was no. The
    status says only that the step is over; which of the two it was is carried
    by the same glyph the text fallback uses. `failed` is marked too, because
    a collapsed plan shows its cards without a status anywhere a reader can see
    at a glance.
    """
    title = plain_text(item.title) if item.title else ""
    if item.status in ("failed", "declined"):
        title = f"{_ACTIVITY[item.status]} {title}".strip()
    task: dict[str, Any] = {
        "task_id": _task_id(item.item_id),
        "title": _fit(title, _MAX_PLAN_TASK_TITLE) or "(untitled)",
        "status": _TASK_STATUS[item.status],
    }
    details = plain_text(item.text) if item.text else ""
    if details:
        task["details"] = _rich_text(_fit(details, _MAX_PLAN_TASK_DETAILS))
    return task


def _rich_text(text: str) -> dict[str, Any]:
    """Plain words in the one block shape a task card's detail will take."""
    return {
        "type": "rich_text",
        "elements": [
            {
                "type": "rich_text_section",
                "elements": [{"type": "text", "text": text}],
            }
        ],
    }


# ── Activity, streamed ───────────────────────────────────────────────────────
#
# The same turn, where Slack will draw it itself. A streamed message renders a
# tool call as a task card in a timeline that is collapsed by default, which is
# the disclosure a context block was only ever standing in for: the prose is
# what a channel reads, and the steps are there for whoever wants them.
#
# What it costs is that a stream is append-only. A task card is the exception —
# an update carrying an id Slack has already seen moves that card — so the
# steps can be revised in place, and that is why they are keyed on the item's
# own id. Text is not: it cannot be unsaid, so a message is appended when it is
# finished rather than while it is still being written. The blocks above stay
# as the fallback for every thread Slack will not stream into, and they are all
# the other platforms have.


def stream_task_chunk(item: Item) -> dict[str, Any]:
    """One tool call as a card in Slack's timeline.

    Keyed on the item's own id, which is the whole of why the timeline
    accumulates: Slack merges an update into the card already carrying that id,
    so an item revised as it runs moves its own card instead of adding another.
    A constant here — which is what the runtime-state path uses, having only
    ever one step to show — collapses a turn's work into a single card
    overwriting itself.

    Plain text, and escaped, for the same two reasons the plan block's cards
    are: a card renders no markup, and a tool call titled `Ran <!here>` is a
    host-written string that would otherwise notify the channel.
    """
    title = plain_text(item.title) if item.title else ""
    if item.status == "declined":
        # `error` is the closest of Slack's three states, and it is not what
        # happened: a declined call was refused rather than broken. The glyph
        # says which, and matches what the fallback renderer shows.
        title = f"{_ACTIVITY['declined']} {title}".strip()
    chunk: dict[str, Any] = {
        "type": "task_update",
        "id": _task_id(item.item_id),
        "title": _fit(title, _MAX_TASK_TITLE) or "(untitled)",
        "status": _TASK_STATUS[item.status],
    }
    details = _fit(plain_text(item.text), _MAX_TASK_DETAILS) if item.text else ""
    if details:
        chunk["details"] = details
    return _within_chunk(chunk, title)


def stream_message_chunk(item: Item) -> dict[str, Any]:
    """One thing the agent said, as markdown in the stream.

    Markdown rather than mrkdwn, so the emphasis is `**` and nothing is escaped
    the way a section's text is: a `markdown_text` chunk is a message body and
    the characters Slack's own syntax is built from do not carry there.
    """
    body = (
        _truncate(item.text, _MAX_STREAM_MESSAGE) if item.text else "_(nothing said)_"
    )
    return {"type": "markdown_text", "text": f"{body}\n\n"}


def stream_state_chunk(items: list[Item], turn: TurnUpsert) -> dict[str, Any]:
    """Where the turn got to, appended once the turn has stopped.

    The last thing in the stream, and the reason the stream is not deleted when
    it closes. A step the host never finished stays unfinished — Slack's own
    card is marked done on the way out on the grounds that it is about to
    vanish, and this one is not going to — so the count is what tells a reader
    those lines have stopped moving.
    """
    return {"type": "markdown_text", "text": f"_{turn_state(items, turn)}_"}


def _task_id(item_id: str) -> str:
    """The card Slack should merge an update into.

    The item's own id wherever it fits. An id longer than the whole chunk is
    allowed to be is replaced by a digest of itself, which is still the same
    string every time the same item is revised — the one property this has to
    keep, because losing it is a second card rather than a moved one.
    """
    if len(item_id) <= _MAX_TASK_ID:
        return item_id
    return hashlib.sha256(item_id.encode()).hexdigest()[:_MAX_TASK_ID]


def _within_chunk(chunk: dict[str, Any], title: str) -> dict[str, Any]:
    """Bring a task chunk inside the size Slack accepts.

    Slack rejects the append rather than the chunk, so one oversized step takes
    every step sent with it — and the steps are what the timeline is for. The
    detail goes first, being the part a reader can do without, and then the
    title is cut down to whatever the id has left it.

    The cut is made on the unescaped title rather than the one in the chunk,
    because slicing an escaped string can leave half an entity behind and put a
    literal `&am` in front of the reader.
    """
    over = len(json.dumps(chunk, ensure_ascii=False)) - _MAX_TASK_CHUNK
    if over <= 0:
        return chunk
    if "details" in chunk:
        chunk = {key: value for key, value in chunk.items() if key != "details"}
        over = len(json.dumps(chunk, ensure_ascii=False)) - _MAX_TASK_CHUNK
        if over <= 0:
            return chunk
    room = max(len(str(chunk["title"])) - over, 1)
    chunk["title"] = _fit(title, room) or "(untitled)"
    return chunk


def _context(text: str) -> dict[str, Any]:
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}


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
