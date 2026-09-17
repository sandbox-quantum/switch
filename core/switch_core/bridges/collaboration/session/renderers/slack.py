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
import re
from dataclasses import dataclass
from html import unescape
from typing import Any
from urllib.parse import urlsplit

from switch_core.bridges.collaboration.slack.mrkdwn import escape_mrkdwn, plain_text
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
    ANSWER_ACTION,
    CLOSED,
    INTERRUPT_ACTION,
    INTERRUPT_LABEL,
    INTERRUPT_QUEUED_NOTE,
    NO_OPTIONS,
    SURFACES,
    RequestReference,
    example_value,
    turn_state,
    unanswerable,
)
from .neutral import SAID_MARKER, in_activity_log

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
# in the thread under the prompt that started it.
#
# Slack caps a plan at 50 tasks and rejects the block over it, taking the whole
# post with it, so a long turn keeps its newest end and the header says what it
# dropped. The per-task budgets are ours: nothing here is near a documented
# limit, and a card is read at a glance.
_MAX_PLAN_TASKS = 50
# What a section spends on the turn, the remaining row being the session card.
# Fixed rather than widened when there is no session url to put in that card:
# the url can arrive after the stream has opened, and a boundary that moved with
# it would re-cut every page already drawn.
_MAX_SECTION_ITEMS = _MAX_PLAN_TASKS - 1
_MAX_PLAN_TITLE = 150
_MAX_PLAN_TASK_TITLE = 200
_MAX_PLAN_TASK_DETAILS = 200
# Prose gets more room than a tool result because it is read rather than
# scanned, and because a card's detail is the one part of this block Slack will
# expand on request.
#
# Where the ceiling is, observed against a real workspace because Slack
# documents none of it. A streamed turn draws up to two fifty-card pages into
# one message, and a hundred cards of ASCII detail were pushed at it two ways:
# sent as one append it took 2,180 characters a card, 257,715 bytes, and refused
# 2,181; delivered a chunk at a time, the way a turn that is still running
# arrives, it took 2,179 and refused 2,180. So the binding figure is the second,
# 257,615 bytes — and the two arms landing 100 bytes apart say the ceiling is on
# what the message now holds rather than on how much was sent to build it.
#
# That is a boundary someone watched, not a published contract: it sits near
# 256 KiB, and nothing says it is exactly that or that it will hold. The unit is
# bytes on the wire rather than characters, because the payload is serialised
# with `ensure_ascii=True` — a non-ASCII character leaves as a six-byte
# `\uXXXX` escape, so the same message would tolerate only about 200 characters
# a card in Japanese.
#
# Why this number is not sized against that worst case: it does not occur. Over
# 445 real turns the largest message reached a tenth of the ceiling, and
# removing this cap altogether left that figure unchanged, because no turn has
# both many cards and long remarks. 3,000 truncated none of the 1,625 remarks
# measured, where 750 truncated a tenth of them. A turn unlike any of those is
# still possible, and the thing that would catch it is a check on the assembled
# message rather than a smaller number here.
_MAX_SAID_DETAILS = 3000
# That check's budgets: what a whole drawn message may weigh. This is the bound
# the per-card numbers cannot enforce between them, because how many cards carry
# a detail is not known until a turn is drawn. A hundred cards at 3,000 is
# 300,000 characters, and nearly two million bytes of it in Japanese — no
# per-card budget both leaves prose room to breathe and holds that, so the worst
# case is caught on the assembled message instead.
#
# Two numbers because the two paths refuse differently, and both are boundaries
# someone watched rather than published contracts. A stream grown a chunk at a
# time took a hundred cards at 257,615 bytes and refused a hundred bytes more
# with `msg_too_long`; an ordinary post took fifty cards of 4,743 characters
# each and refused the message above that with `msg_blocks_too_long`. Each
# budget sits under its measurement, which buys room for the request envelope
# weighed nowhere here — channel, timestamp, chunk wrappers — and for Slack
# tightening a limit it never published in the first place.
_MAX_STREAM_BYTES = 250_000
_MAX_POST_BYTES = 220_000
# How far a detail is pulled back when the assembled message is too big, in
# order. The last step is small rather than absent: a card that quietly lost its
# expansion looks exactly like a remark that never had more to say.
_DETAIL_RETREAT = (1500, 750, 300, 120)
# A local display budget, not a claimed Slack rich_text protocol limit.
# Preserve the decision/answer before spending the remainder on context.
_MAX_RESOLVED_DETAILS = 2800
# `chat.postMessage` takes 40,000 characters of `text`, and twenty messages each
# inside their own budget is more than that, so the fallback is bounded as a
# whole as well as a message at a time.
_MAX_TEXT = 39000

_MAX_TASK_ID = 64

# What a cut detail ends with. Words the reader will not get to see are worth a
# few characters saying so, in language no agent would have written itself.
_TRUNCATED = " […truncated]"

# The three blocks a stream draws its steps in, top to bottom. Slack fixes a
# block at the position it was first written and has no call that removes one,
# so where each one sits is decided by the order they are created in and cannot
# be changed afterwards. That is the whole reason there are three: the top block
# has to exist before either of the others to be able to carry the line saying
# what is no longer shown, so it starts as the first page of steps and becomes
# that line when there is something to disclose.
_STEP_BLOCKS = ("switch-steps-top", "switch-steps-middle", "switch-steps-bottom")

# The first card of every section, carrying the Console link. The same id in
# both sections is deliberate and Slack takes it: a reader opens one section or
# the other, and the link has to be in whichever one they chose.
_SESSION_CARD = "switch-session"

# The stop control's own block. Fixed, because a stream addresses a block by id
# and this one is rewritten every time the turn it stops changes; and created in
# the same append as the first section so that Slack fixes it below the steps
# rather than wherever the turn happened to acquire something to stop.
INTERRUPT_BLOCK_ID = "switch-interrupt"

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

# What a card draws in its own glyph slot. Not an emoji field: Slack takes a
# closed set of 54 names here and refuses anything outside it — `bolt`, `wrench`
# and `terminal` are all rejected as invalid enum values — so these two are
# chosen from what exists rather than from what a speech bubble or a shell
# prompt would ideally be.
_SAID_ICON = "comment"
_TOOL_ICON = "code"

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


@dataclass(frozen=True)
class SlackMessage:
    """A `chat.postMessage` body: blocks, and the text a notification shows."""

    text: str
    blocks: list[dict[str, Any]]


def render_request(
    request: SnapshotRequest,
    reference: RequestReference,
    *,
    responder_external_id: str | None = None,
    responder_name: str | None = None,
    unavailable_reason: str | None = None,
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
    if request.state == "open" and isinstance(request.content, QuestionsContent):
        pressable = _pressable(request, request.content)
        if pressable is not None and not pressable.allow_custom_answer:
            message.blocks[:] = [
                block for block in message.blocks if block["type"] != "context"
            ]
        elif pressable is not None:
            for block in message.blocks:
                if block["type"] == "context":
                    block["elements"][0]["text"] = (
                        "Choose a button, or reply in this thread with "
                        f'`{escape_mrkdwn(reference.handle)} "your answer"` '
                        "to give a different answer."
                    )
    if request.state == "resolved":
        content = request.content
        answer = (
            _answered_questions(request, content)
            if isinstance(content, QuestionsContent)
            else _answered(request, _approval(request))
        )
        if (
            responder_external_id
            and re.fullmatch(r"[UW][A-Z0-9]+", responder_external_id)
            and request.decided_by
        ):
            answer = answer.replace(
                _actor(request.decided_by), f"<@{responder_external_id}>"
            )
        answer = answer.replace(" — chosen by ", " · ").replace(
            " — answered by ", " · "
        )
        icon = "✅"
        if (
            isinstance(content, ApprovalContent)
            and request.result
            and isinstance(request.result.result, ApprovalResult)
        ):
            chosen = next(
                (
                    option
                    for option in content.options
                    if option.option_id == request.result.result.option_id
                ),
                None,
            )
            if chosen and chosen.decision == "decline":
                icon = "❌"
        summary = f"{icon} {_fit(reference.handle, 32)} · {answer}"

        title = summary
        if responder_external_id:
            title = title.replace(
                f"<@{responder_external_id}>", responder_name or responder_external_id
            )
        title = _truncate(plain_text(unescape(title)), _MAX_PLAN_TITLE)
        task_title = (
            plain_text(content.detail or "Permission details")
            if isinstance(content, ApprovalContent)
            else plain_text(content.title)
        )
        details = []
        if isinstance(content, ApprovalContent):
            if content.detail and len(task_title) > _MAX_PLAN_TASK_TITLE:
                details.append(
                    {
                        "type": "text",
                        "text": "\n" + _truncate(content.detail, _MAX_DETAIL),
                    }
                )
        else:
            description = (
                content.title + "\n" + "\n".join(q.prompt for q in content.questions)
            )
            details.append({"type": "text", "text": _truncate(description, _MAX_TITLE)})
        details.append(
            {
                "type": "text",
                "text": "\n" + plain_text(unescape(answer)).split(" · <@")[0],
            }
        )
        if responder_external_id and re.fullmatch(
            r"[UW][A-Z0-9]+", responder_external_id
        ):
            details.extend(
                [
                    {"type": "text", "text": " · "},
                    {"type": "user", "user_id": responder_external_id},
                ]
            )
        # Every rich-text leaf contributes to the same display budget. Allocate
        # the answer first so a long command/description cannot erase it.
        detail_blocks: list[dict[str, Any]] = []
        if isinstance(content, ApprovalContent):
            detail_blocks.append(
                {
                    "type": "rich_text_preformatted",
                    "elements": [
                        {"type": "text", "text": _truncate(content.title, _MAX_TITLE)}
                    ],
                }
            )
        command_size = sum(
            len(element.get("text", ""))
            for block in detail_blocks
            for element in block["elements"]
        )
        text_size = sum(len(element.get("text", "")) for element in details)
        overflow = max(0, command_size + text_size - _MAX_RESOLVED_DETAILS)
        if overflow and details:
            # The leading context is optional; keep the answer and actor at the end.
            context = details[0]
            context["text"] = _truncate(
                context.get("text", ""), max(0, len(context.get("text", "")) - overflow)
            )
        detail_blocks.append({"type": "rich_text_section", "elements": details})
        message = SlackMessage(
            text=summary,
            blocks=[
                {
                    "type": "plan",
                    "title": title,
                    "tasks": [
                        {
                            "task_id": _task_id(request.request_id),
                            "title": _truncate(task_title, _MAX_PLAN_TASK_TITLE),
                            "status": "complete",
                            "details": {
                                "type": "rich_text",
                                "elements": detail_blocks,
                            },
                        }
                    ],
                }
            ],
        )
    if unavailable_reason and request.state in {"open", "submitting"}:
        message.blocks[:] = [
            block
            for block in message.blocks
            if block["type"] not in {"actions", "input", "context"}
        ]
        notice = escape_mrkdwn(unavailable_reason)
        message.blocks.append(
            {"type": "context", "elements": [{"type": "mrkdwn", "text": notice}]}
        )
        message = SlackMessage(text=unavailable_reason, blocks=message.blocks)
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
    prompt = f"*{_HEADINGS[request.state]}*"
    if content.detail:
        prompt += f"\n> {_fit(content.detail, _MAX_DETAIL)}"
    command = content.title.replace("```", "``\u200b`")
    prompt += f"\n```\n{_fit(command, _MAX_TITLE)}\n```"

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
    if request.state != "open" or not content.options:
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
            # Neither reader of the contract gives `options` a minimum
            # length, and the schema is still the wrong place to add one — see
            # `unanswerable`, which refuses the same defect a question apart.
            return NO_OPTIONS
        # Code spans, because the reader is meant to copy these and quote marks
        # around them are not part of the answer: `"R42 1"` parses as a handle
        # of `"R42`, which resolves to nothing and changes nothing on the card.
        # Slack draws a span from the backticks and the grammar strips them.
        #
        # The handle and the example are both shown because `R42 1` on its own
        # reads as one fixed string to type, and the number in it is the whole
        # decision.
        handle = escape_mrkdwn(reference.handle)
        return (
            f"Reply with `{handle}` and your choice, "
            f"e.g. `{handle} 1`, or press a button."
        )
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
    summary = CLOSED.get(
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
        f"{_fit(decided_by.actor_id, _MAX_ACTOR)} from {SURFACES[decided_by.surface]}"
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
        stuck = unanswerable(content.questions)
        if stuck is not None:
            return stuck
        example = f"`{_example(reference.handle, content.questions)}`"
        start = f"Reply with `{escape_mrkdwn(reference.handle)}`"
        if buttons:
            return f"{start} and your answer, e.g. {example}, or press a button."
        if len(content.questions) > 1:
            return (
                f"{start} and your answers, e.g. {example} "
                "— every question needs an answer."
            )
        return f"{start} and your answer, e.g. {example}."
    if request.state == "submitting":
        if request.decided_by is None:
            return "An answer is on its way."
        return f"Answering: {_actor(request.decided_by)}."
    if request.state == "resolved":
        return _answered_questions(request, content)
    settled = request.result
    if settled is None:
        return "Closed without being answered."
    summary = CLOSED.get(
        settled.outcome, f"Closed, though the host called it {settled.outcome}."
    )
    if request.decided_by is not None:
        summary += f" Decided by {_actor(request.decided_by)}."
    return summary


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
        return f"{escape_mrkdwn(handle)} {values[0]}"
    return f"{escape_mrkdwn(handle)} " + "; ".join(
        f"q{position}={value}" for position, value in enumerate(values, start=1)
    )


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


def with_session_context(
    message: SlackMessage,
    *,
    session_url: str | None = None,
    notify_external_id: str | None = None,
    inline_link: bool = False,
) -> SlackMessage:
    """Add compact status navigation and mentions on attention posts only."""
    text = message.text
    if session_url and urlsplit(session_url).scheme in {"https", "http", "switchdash"}:
        if inline_link:
            text = f"{text} · <{session_url}|Console app>"
            return SlackMessage(
                text=text,
                blocks=[
                    {
                        "type": "context",
                        "elements": [{"type": "mrkdwn", "text": text}],
                    }
                ],
            )
    if notify_external_id and re.fullmatch(r"[UW][A-Z0-9]+", notify_external_id):
        mention = f"<@{notify_external_id}>"
        message.blocks.append(
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": f"Needs attention: {mention}"}],
            }
        )
        text = f"{mention} {text}"
    return SlackMessage(text=text, blocks=message.blocks)


def render_attention(summary: str) -> SlackMessage:
    """One visible sentence for a turn or host error."""
    title = _truncate(plain_text(summary), _MAX_PLAN_TASK_TITLE)
    return SlackMessage(
        text=escape_mrkdwn(title),
        blocks=[
            {
                "type": "task_card",
                "task_id": "switch-attention",
                "title": title,
                "status": "error",
            }
        ],
    )


def render_activity(
    items: list[Item],
    turn: TurnUpsert,
    *,
    elapsed_seconds: float | None = None,
    status_only: bool = False,
) -> SlackMessage:
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
    if status_only:
        state = turn_state(
            items, turn, tool_detail=True, elapsed_seconds=elapsed_seconds
        )
        if turn.status not in TURN_ENDED:
            return SlackMessage(
                text=state,
                blocks=[
                    {
                        "type": "task_card",
                        "task_id": _task_id(turn.turn_id),
                        "title": _truncate(state, _MAX_PLAN_TASK_TITLE),
                        "status": "in_progress",
                    }
                ],
            )
        return SlackMessage(text=state, blocks=[_context(state)])
    said = [item for item in items if item.kind == "assistant-message"]
    did = [item for item in items if item.kind == "tool-activity"]

    blocks: list[dict[str, Any]] = []
    hidden = max(len(said) - _MAX_MESSAGES, 0)
    if hidden:
        blocks.append(_context(f"_…{hidden} earlier in this turn, not shown._"))
    blocks += [
        {"type": "section", "text": {"type": "mrkdwn", "text": _message_text(item)}}
        for item in said[len(said) - _MAX_MESSAGES :]
    ]
    if did:
        blocks.append(_plan(items, did, turn, elapsed_seconds=elapsed_seconds))
    else:
        state = turn_state(
            items, turn, tool_detail=True, elapsed_seconds=elapsed_seconds
        )
        blocks.append(_context(f"_{state}_"))
    return SlackMessage(
        text=render_activity_text(items, turn, elapsed_seconds=elapsed_seconds),
        blocks=blocks,
    )


def render_turn_with_request(
    items: list[Item],
    turn: TurnUpsert,
    request: SnapshotRequest,
    reference: RequestReference,
    *,
    elapsed_seconds: float | None = None,
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
    activity = render_activity(items, turn, elapsed_seconds=elapsed_seconds)
    card = render_request(request, reference)
    blocks = activity.blocks + card.blocks
    text = "\n\n".join(_within([activity.text, card.text], _MAX_TEXT))
    return SlackMessage(text=text, blocks=blocks)


def render_activity_text(
    items: list[Item], turn: TurnUpsert, *, elapsed_seconds: float | None = None
) -> str:
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

    lines: list[str] = []
    hidden = max(len(said) - _MAX_MESSAGES, 0)
    if hidden:
        lines.append(f"…{hidden} earlier in this turn, not shown.")
    lines += [_message_text(item) for item in said[len(said) - _MAX_MESSAGES :]]
    lines += _activity_lines(did)
    lines.append(
        turn_state(items, turn, tool_detail=True, elapsed_seconds=elapsed_seconds)
    )
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


def render_activity_plan(
    items: list[Item],
    turn: TurnUpsert,
    *,
    elapsed_seconds: float | None = None,
    session_url: str | None = None,
    interrupt_turn_id: str | None = None,
) -> SlackMessage:
    """A turn's activity as one plan block: the header, and the steps behind it.

    What a stream draws, drawn as an ordinary message instead, for a thread a
    stream could not be opened in. The two have to agree — a reader should not
    be able to tell which transport carried their turn — so both take their
    header from `_activity_title` and settle their cards the same way.

    What the agent said goes in here too, interleaved with the calls in the
    order the session produced it. The plan is the only part of this message a
    reader opens rather than is shown, so it is the only place prose can go
    without putting it in the channel: nothing else here is collapsed. Prose
    reaches a Slack channel no other way — an agent's console narration is not
    posted to the room unless the agent posts it — so without this the turn's
    reasoning is simply not available to a reader who wants it.

    One section and no more, which is the one place this path cannot follow the
    streamed one: `chat.postMessage` refuses a message holding two plan blocks
    outright, where a stream accepts any number of them. So a long turn shows
    its newest section and says in the header what it dropped, rather than the
    previous section a streamed turn keeps.

    A turn that has neither called nor said anything still draws the section,
    because the session card in it is a card — this one message stands in for
    both of the two it replaced, and the second of those was a status line that
    appeared before the turn had done anything.
    """
    shown = [item for item in items if in_activity_log(item)]
    kept = shown[len(shown) - _MAX_SECTION_ITEMS :]
    title = _activity_title(
        items, turn, elapsed_seconds=elapsed_seconds, omitted=len(shown) - len(kept)
    )
    blocks: list[dict[str, Any]] = [
        {
            "type": "plan",
            "title": _truncate(title, _MAX_PLAN_TITLE),
            "tasks": [
                _session_card(session_url, live=turn.status not in TURN_ENDED),
                *(_settled(_plan_task(item), item, turn) for item in kept),
            ],
        }
    ]
    _fit_details(blocks, _MAX_POST_BYTES)
    # After the fit, and never part of it: the control is a fixed few hundred
    # bytes that must survive whatever trimming the steps need, and a message
    # that dropped its stop button to make room for one more step line would
    # have traded the only thing on it a reader can act on.
    control = _interrupt_block(interrupt_turn_id, turn)
    if control is not None:
        blocks.append(control)
    return SlackMessage(text=title, blocks=blocks)


@dataclass
class StreamedActivity:
    """A turn's activity as the blocks a stream is built from.

    The whole turn every time, not a delta: which of these Slack has already
    been told is the streaming adapter's bookkeeping, because only it knows
    what its own appends landed. Keeping that out of here leaves this a pure
    function of the turn, testable without a stream.

    `title` is not one of the blocks and is never sent. It is the one line the
    message amounts to, which is what a failed publication has to report to a
    caller that cannot know how Slack was going to draw it.
    """

    title: str
    blocks: list[dict[str, Any]]


def render_activity_stream(
    items: list[Item],
    turn: TurnUpsert,
    *,
    elapsed_seconds: float | None = None,
    session_url: str | None = None,
    interrupt_turn_id: str | None = None,
) -> StreamedActivity:
    """The same turn as `render_activity_plan`, shaped for `chat.appendStream`.

    Sections and nothing else. A stream can carry its own plan, addressed with
    chunks, and that is what used to hold the status line — but a plan that
    grows cannot take a card back, so it could never hold the steps, and it
    cost the message a line of its own above them. The whole turn is drawn
    instead in ordinary `plan` blocks carried inside the stream, addressed by
    `block_id` and replaced whole, which can hold a different fifty than they
    held a minute ago.

    So the message collapses to the heading of its newest section: where the
    turn got to and how long it has been there, on the section a reader would
    open to watch it carry on. A settled section above it is headed by the range
    it holds, which is what makes it legible as history rather than as a second
    thing to read.

    Measured before it was built: a stream with no plan chunks at all still
    draws its blocks, and the title of a plan with no cards in it draws nothing
    — so there is no invisible header left behind by dropping it.
    """
    shown = [item for item in items if in_activity_log(item)]
    blocks = _step_blocks(
        [_settled(_plan_task(item), item, turn) for item in shown],
        _running(shown, turn),
        turn_state(items, turn, tool_detail=True, elapsed_seconds=elapsed_seconds),
        session_url,
        turn.status not in TURN_ENDED,
    )
    _fit_details(blocks, _MAX_STREAM_BYTES)
    # Read off the last section before the control is appended: the title is the
    # heading of the newest plan block, and the control has no title at all.
    title = blocks[-1]["title"]
    control = _interrupt_block(interrupt_turn_id, turn)
    if control is not None:
        blocks.append(control)
    return StreamedActivity(title=title, blocks=blocks)


def spent_interrupt_block() -> dict[str, Any]:
    """What a stream puts where its stop control was, once there is none.

    A stream cannot take a block back. Measured: a block left out of an append
    stays exactly as it was drawn — the reader keeps a live-looking button over
    a turn that has ended — and the only way to be rid of one is to send
    something else under the same `block_id`. So the control is not omitted at
    the end of a turn, it is overwritten, and this is what with.

    A divider because it is the emptiest block Slack has: it carries no text to
    read and nothing to press, and a thin rule under a finished turn reads as
    the end of it rather than as a leftover. An ordinary post has no such
    problem and simply stops drawing the control, so this is the streamed path's
    alone.
    """
    return {"type": "divider", "block_id": INTERRUPT_BLOCK_ID}


def _session_card(session_url: str | None, *, live: bool) -> dict[str, Any]:
    """The first card of a section, and where the Console link lives.

    Asked for as the first row of the block rather than a line beside it: a
    link on its own line is a line every reader pays for and few use, and the
    same expansion that opens the turn's activity is the one a reader reaches
    for when they want the session itself.

    It is repeated in every section on purpose. A reader opens one section, and
    a link that is only in the other one is a link they have to go looking for.

    `live` rather than the turn's status, because only the section holding the
    live end of the turn should spin: Slack draws a block's glyph from the cards
    in it, and a settled section showing a spinner would point at a place where
    nothing is happening. On the live section it is this card that guarantees
    the spinner, which the steps cannot — between two calls every step card is
    settled, and the heading would show a check beside "Working…".

    The whole url goes in or the card carries no link at all. A session url is
    built from a configured origin and three ids rather than written by an
    agent, so its length is the deployment's, not something to defend against —
    and half a url is not a link, it is a line of text that looks like one and
    goes nowhere.

    With the link there, the title is hidden and the link is the whole card: a
    row reading "Switch session" above a row reading "Open in Console app" says
    the same thing twice, and the second row says it better. Without the link
    the title is all there is, so it stays — the card is still what holds the
    section's glyph, and a section is still drawn for a turn that has not done
    anything yet.
    """
    card: dict[str, Any] = {
        "task_id": _SESSION_CARD,
        "title": "Switch session",
        "status": "in_progress" if live else "complete",
    }
    if not session_url or urlsplit(session_url).scheme not in {
        "https",
        "http",
        "switchdash",
    }:
        return card
    return {
        **card,
        "hide_title": True,
        "details": {
            "type": "rich_text",
            "elements": [
                {
                    "type": "rich_text_section",
                    "elements": [
                        {
                            "type": "link",
                            "url": session_url,
                            "text": "Open in Console app",
                        }
                    ],
                }
            ],
        },
    }


def _interrupt_block(
    interrupt_turn_id: str | None, turn: TurnUpsert
) -> dict[str, Any] | None:
    """The stop control, or None where there is nothing for it to stop.

    Three things have to hold before it is drawn, and each removes it on its
    own. There has to be a running turn to name — a session between turns has
    nothing to interrupt, and a button that can only be refused is worse than no
    button. The message's own turn has to be unfinished — a reader scrolling
    past yesterday's turn is not offered a control over today's work, whatever
    is running now. And the caller has to have found the session interruptible
    at all; a session whose provider cannot be interrupted never gets one.

    `value` carries the turn rather than the `action_id` because Slack hands
    both back unchanged and only one of them is bounded generously enough to
    stop mattering: 2000 characters against 255. The id stays constant so the
    press can be routed on it without parsing.

    A queued turn's control has to say what it does, because there the button is
    not about the message it sits on, and a bare "Stop current work" under a
    message reading "Queued" invites a reader to take it as a cancel. An
    `actions` block holds interactive elements and nothing else, so the sentence
    needs a block that can carry text: the button becomes the accessory of a
    section instead. A running turn needs no such sentence and keeps the plain
    `actions` block, so the control is a button and not a paragraph.

    Measured against Slack before it was written: both shapes are accepted in a
    stream and in an ordinary post, and a stream accepts one replacing the other
    under the same `block_id`, which is what a turn leaving the queue does.
    """
    if interrupt_turn_id is None or turn.status in TURN_ENDED:
        return None
    button = {
        "type": "button",
        "action_id": INTERRUPT_ACTION,
        "text": {"type": "plain_text", "text": INTERRUPT_LABEL},
        "style": "danger",
        "value": _truncate(interrupt_turn_id, _MAX_VALUE),
    }
    if turn.status == "queued":
        return {
            "type": "section",
            "block_id": INTERRUPT_BLOCK_ID,
            "text": {"type": "plain_text", "text": INTERRUPT_QUEUED_NOTE},
            "accessory": button,
        }
    return {
        "type": "actions",
        "block_id": INTERRUPT_BLOCK_ID,
        "elements": [button],
    }


def _step_blocks(
    steps: list[dict[str, Any]],
    running: tuple[int, str] | None,
    header: str,
    session_url: str | None,
    live: bool,
) -> list[dict[str, Any]]:
    """The turn as the three blocks that hold it: what is gone, then two sections.

    Sections are cut on fixed boundaries — the first forty-nine, the next
    forty-nine — so a step never moves between them once it has landed in one,
    which keeps a settled section from being rewritten under a reader who has it
    open. Forty-nine rather than fifty because Slack caps a plan block at fifty
    cards and the session card takes the first of them.

    Only the newest two sections are drawn, and everything before them is gone
    from the message. That is said on one line of its own above them, naming the
    whole range rather than only the most recent thing dropped, so the reader is
    never left to add up several disclosures to find out what is missing. Below
    two sections there is nothing to disclose and no line: a turn that has not
    overflowed twice collapses to a single heading.

    The line has to be the first of the three blocks written, because Slack
    fixes a block where it was created and one made later would render *below*
    the sections it is describing. So the top block starts life as the first
    section and is replaced by the line when there is finally something to
    disclose — a substitution in place, which keeps its position. There is no
    call that removes a block, and this needs none.
    """
    top, middle, bottom = _STEP_BLOCKS
    last = max(len(steps) - 1, 0) // _MAX_SECTION_ITEMS
    if last < 2:
        pages = (top, middle)
        return [
            _step_page(
                steps, page, pages[page], running, header, session_url, live, last
            )
            for page in range(last + 1)
        ]
    gone = (last - 1) * _MAX_SECTION_ITEMS
    return [
        {
            "type": "context",
            "block_id": top,
            "elements": [
                {"type": "mrkdwn", "text": f"_Activity 1–{gone} no longer shown_"}
            ],
        },
        _step_page(steps, last - 1, middle, running, header, session_url, live, last),
        _step_page(steps, last, bottom, running, header, session_url, live, last),
    ]


def _step_page(
    steps: list[dict[str, Any]],
    page: int,
    block_id: str,
    running: tuple[int, str] | None,
    header: str,
    session_url: str | None,
    live: bool,
    newest: int,
) -> dict[str, Any]:
    """One section as the plan block that draws it.

    A section holds the turn as it happened, so a card in it is a call or a
    thing the agent said. It is headed "Activity" rather than "Steps" because
    half of what can be in there is not a step.

    The newest section carries the header instead: the turn's state and its
    clock. That is where a reader looking for the live end of the turn should be
    sent, and putting it on the section rather than on a line above them is what
    says which of two sections is still moving.

    The live step is named on the section actually holding it, which is usually
    but not always that one — a call left open while the agent talks past it
    stays where it landed. Naming it on the newest section regardless would
    point a reader at a section they can see it is not in.
    """
    start = page * _MAX_SECTION_ITEMS
    shown = steps[start : start + _MAX_SECTION_ITEMS]
    title = header if page == newest else f"Activity {start + 1}–{start + len(shown)}"
    if running and start <= running[0] < start + len(shown):
        title += f" · {running[1]}"
    return {
        "type": "plan",
        "block_id": block_id,
        "title": _truncate(title, _MAX_PLAN_TITLE),
        "tasks": [_session_card(session_url, live=live and page == newest), *shown],
    }


def _settled(task: dict[str, Any], item: Item, turn: TurnUpsert) -> dict[str, Any]:
    """A card's status as the log shows it, rather than as the item stands.

    A historical call that finished unsuccessfully keeps its warning in the
    title but not in its status, because one failed step does not make the
    whole plan a failed plan. A call still open when the turn stopped will
    never close, so the title says so rather than leaving a step spinning for
    good.

    None of that is about what the agent said. A host opens a prose item and
    fills it token by token, so it is routinely still in progress when the turn
    stops — marking that "Unfinished" would put the word on the one line of the
    turn where nothing was left undone.
    """
    if item.kind == "assistant-message":
        return task
    if item.status != "in-progress" or turn.status in TURN_ENDED:
        task["status"] = "complete"
    if item.status == "in-progress" and turn.status in TURN_ENDED:
        task["title"] = _truncate("Unfinished: " + task["title"], _MAX_PLAN_TASK_TITLE)
    return task


def _activity_title(
    items: list[Item],
    turn: TurnUpsert,
    *,
    elapsed_seconds: float | None = None,
    omitted: int = 0,
) -> str:
    """The one line a reader gets with the plan collapsed.

    This message replaced a pair — a status line that ticked, and a tool log
    that did not — so its header has to carry both jobs: where the turn got to
    and how long it has been there, then the step it is on. A running turn
    names that step, because "Working… 40s" alone does not say whether
    anything is happening. An ended one does not: `turn_state` already counts
    what it did, and the last step it ran is no longer news.

    What is not being shown is said here for the same reason — the header is
    the only part of a collapsed block, so a cut nobody is told about is a cut
    nobody can see.
    """
    title = turn_state(items, turn, tool_detail=True, elapsed_seconds=elapsed_seconds)
    running = _running(items, turn)
    if running:
        title += f" · {running[1]}"
    if omitted:
        line = "line" if omitted == 1 else "lines"
        title += f" · {omitted} earlier {line} not shown"
    return title


def _running(drawn: list[Item], turn: TurnUpsert) -> tuple[int, str] | None:
    """Where the live step is and what to call it, or nothing for an ended turn.

    The index is into the list as drawn, remarks and all, because it is what
    puts the label on the page the step is actually in and a page holds
    whatever was interleaved with it. Counting calls alone would name the right
    step and point at the wrong page.

    Only a call can be the live step. A sentence being written is not work in
    progress, and a heading naming a half-finished one would report a turn busy
    talking when it is busy working.

    A turn with nothing open still names the step it finished most recently:
    between two calls there is nothing running, and a heading that went blank
    for that moment would flicker on every step.
    """
    if turn.status in TURN_ENDED:
        return None
    calls = [index for index, item in enumerate(drawn) if item.kind == "tool-activity"]
    if not calls:
        return None
    current = next(
        (index for index in reversed(calls) if drawn[index].status == "in-progress"),
        None,
    )
    index = calls[-1] if current is None else current
    label = "Last" if current is None else "Running"
    title = plain_text(drawn[index].title) if drawn[index].title else "Tool"
    return index, f"{label}: {title}"


def _plan(
    items: list[Item],
    did: list[Item],
    turn: TurnUpsert,
    *,
    elapsed_seconds: float | None = None,
) -> dict[str, Any]:
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
    title = turn_state(items, turn, tool_detail=True, elapsed_seconds=elapsed_seconds)
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

    Not escaped, for the same reason. This used to escape on the grounds that
    Slack asks for `&`, `<` and `>` escaped and that a tool call titled
    `Ran <!here>` would otherwise notify the channel. Measured, both are false
    here: a title sent escaped is stored and shown escaped, so every `&&` in a
    shell command reached the reader as `&amp;&amp;`, and `<!here>` is stored
    as the text it is rather than as a broadcast. A field that parses nothing
    needs nothing escaped for it.

    Slack has three states against the contract's four, and `declined` is not
    an error — the call did what it was told, and what it was told was no. The
    status says only that the step is over; which of the two it was is carried
    by the same glyph the text fallback uses. `failed` is marked too, because
    a collapsed plan shows its cards without a status anywhere a reader can see
    at a glance.

    What the agent said is a card as well, because a card is the only thing
    this block holds. It is marked `SAID_MARKER` for the same reason it is
    everywhere else, and it is settled rather than running: a sentence has no
    outcome to report and nothing about it is still being worked on once the
    turn has moved past it.

    Slack draws a settled card with a check, which beside a sentence is the one
    thing the marker exists to deny. There is no fourth status to reach for —
    Slack has three and the other two are a spinner and an error, both of which
    say something worse — so a remark carries a `comment` glyph and a call
    carries `code`, which is what the glyph column does on every other platform.
    The marker stays in the title behind it as the same distinction in text.

    A remark is drawn as its detail rather than as its title: the title is
    hidden, and the prose sits at the top of the card where a reader meets it
    whole instead of meeting a one-line preview of it. The title is still
    written, because hiding it is the card's choice and a client that does not
    honour that should find a sentence there rather than nothing.

    The prose keeps the markdown the agent wrote. Slack renders none of it in
    this slot, so asterisks and backticks arrive literally — which is readable,
    and is less lossy than stripping the marks out and leaving a reader unable
    to tell a code span from a word.
    """
    if item.kind == "assistant-message":
        preview = f"{SAID_MARKER} {' '.join(plain_text(item.text).split())}"
        return {
            "task_id": _task_id(item.item_id),
            "title": _truncate(preview, _MAX_PLAN_TASK_TITLE),
            "hide_title": True,
            "icon": {"type": "icon", "name": _SAID_ICON},
            "status": "complete",
            "details": _rich_text(_truncate_prose(item.text, _MAX_SAID_DETAILS)),
        }
    title = plain_text(item.title) if item.title else ""
    if item.status in ("failed", "declined"):
        title = f"{_ACTIVITY[item.status]} {title}".strip()
    task: dict[str, Any] = {
        "task_id": _task_id(item.item_id),
        "title": _truncate(title, _MAX_PLAN_TASK_TITLE) or "(untitled)",
        "icon": {"type": "icon", "name": _TOOL_ICON},
        "status": _TASK_STATUS[item.status],
    }
    details = plain_text(item.text) if item.text else ""
    if details:
        task["details"] = _rich_text(_truncate_prose(details, _MAX_PLAN_TASK_DETAILS))
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


def _context(text: str) -> dict[str, Any]:
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}


def _truncate(text: str, limit: int) -> str:
    if limit <= 0:
        return ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _truncate_prose(text: str, limit: int) -> str:
    """`text` inside `limit`, saying plainly when some of it did not fit.

    `_truncate` marks a cut with an ellipsis, which is right for a title: the
    full text sits in the detail directly below it, so nothing is lost and a
    trailing `…` reads as the preview it is. A detail has nothing below it. A
    cut there loses words, and an ellipsis on the end of a sentence is
    indistinguishable from the author's own punctuation — the reader is left
    with prose that looks complete and is not.
    """
    keep = limit - len(_TRUNCATED)
    if keep <= 0:
        return _truncate(text, limit)
    return text if len(text) <= limit else text[:keep] + _TRUNCATED


def _weigh(payload: object) -> int:
    """What `payload` costs Slack, in the bytes its own serialisation produces.

    Characters are the wrong unit and the difference is not small. The request
    body goes out with `ensure_ascii=True`, so a character outside ASCII leaves
    as a six-byte `\\uXXXX` escape: a Japanese remark costs six times what its
    length suggests, and an emoji twelve.
    """
    return len(json.dumps(payload).encode())


def _fit_details(blocks: list[dict[str, Any]], limit: int) -> None:
    """Pull card details back until `blocks` weighs less than `limit`.

    Nothing is dropped. A detail is shortened, and a shortened detail says so in
    the place the missing words would have been, so a reader who opens one is
    told rather than left with prose that looks whole. Removing the expansion
    outright is the one outcome that would say nothing at all.

    Titles are left alone. They are bounded already, they are what a reader sees
    without opening anything, and between them they cannot reach the budget —
    which is why running out of retreat here is an exception rather than a
    smaller cut: it would mean cards arriving from somewhere this was not
    written to bound.

    So is the session card, whose detail is a link rather than prose. Cutting
    its label would leave a link reading "Open in Cons…", and cutting two of
    them buys back nothing worth having.
    """
    if _weigh(blocks) <= limit:
        return
    details = [
        element
        for block in blocks
        if block.get("type") == "plan"
        for task in block["tasks"]
        if "details" in task
        for element in [task["details"]["elements"][0]["elements"][0]]
        if element["type"] == "text"
    ]
    for budget in _DETAIL_RETREAT:
        for element in details:
            element["text"] = _truncate_prose(element["text"], budget)
        if _weigh(blocks) <= limit:
            return
    raise ValueError(
        f"A turn drew {len(details)} card details into {_weigh(blocks)} bytes, over "
        f"the {limit} Slack will take even with every one cut to "
        f"{_DETAIL_RETREAT[-1]} characters."
    )


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
