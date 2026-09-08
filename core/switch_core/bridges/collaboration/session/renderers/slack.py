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

_DANGEROUS = {"decline", "cancel"}

_HEADINGS = {
    "open": "Permission needed",
    "submitting": "Permission needed",
    "resolved": "Permission answered",
    "closed": "Permission request closed",
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


def render_approval(
    request: SnapshotRequest, reference: RequestReference
) -> SlackMessage:
    """Render an approval as the card that stands for it right now.

    Open, it offers a button per option and is also answerable in words. Once
    an answer is in flight or the request has settled, the buttons go and the
    card says what became of it instead.
    """
    content = _approval(request)
    prompt = f"*{_HEADINGS[request.state]}*\n{escape_mrkdwn(content.title)}"
    if content.detail:
        prompt += f"\n`{escape_mrkdwn(content.detail)}`"

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
                {
                    "type": "mrkdwn",
                    "text": escape_mrkdwn(_footer(request, content, reference)),
                }
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
        f"> Request {escape_mrkdwn(reference.handle)}: {escape_mrkdwn(content.title)}"
    ]
    if content.detail:
        lines.append(f"> {escape_mrkdwn(content.detail)}")
    if request.state == "open":
        lines += [
            f"{index}. {escape_mrkdwn(option.label)}"
            for index, option in enumerate(content.options, start=1)
        ]
    lines.append(escape_mrkdwn(_footer(request, content, reference)))
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
    whether something was answered.
    """
    if request.state == "open":
        return f'Reply with "{reference.handle} 1", or press a button.'
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
    label = chosen.label if chosen else result.option_id
    scope = (
        " (applies for the rest of this session)"
        if chosen and chosen.decision == "acceptForSession"
        else ""
    )
    return f"{label}{scope} — chosen{by}." if by else f"{label}{scope}."


def _actor(decided_by: DecidedBy) -> str:
    return f"{decided_by.actor_id} from {_SURFACES[decided_by.surface]}"


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


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
