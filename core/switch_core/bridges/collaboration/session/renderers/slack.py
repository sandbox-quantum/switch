"""A request, as Slack shows it.

An approval is a decision someone has to make, so it goes in the channel root
where a person will see it, with a button per option. It also carries the text
form of the same question: a card can fail to render, a person can be on a
client that will not press buttons, and the contract requires every bridge to
accept an explicit text answer as well as a control.

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

from ..contract import ApprovalContent, ApprovalOption, SnapshotRequest
from . import ANSWER_ACTION, RequestReference

# Slack's own limits. Exceeding one is rejected at the API, so it is caught here
# where the offending value can still be named.
_MAX_ACTION_ID = 255
_MAX_BUTTON_TEXT = 75
_MAX_VALUE = 2000
_MAX_ELEMENTS = 25

_DANGEROUS = {"decline", "cancel"}


@dataclass(frozen=True)
class SlackMessage:
    """A `chat.postMessage` body: blocks, and the text a notification shows."""

    text: str
    blocks: list[dict[str, Any]]


def render_approval(
    request: SnapshotRequest, reference: RequestReference
) -> SlackMessage:
    """Render an open approval as a card that is also answerable in words."""
    content = request.content
    if not isinstance(content, ApprovalContent):
        raise ValueError(
            f"Request {request.request_id} is not an approval: {content.kind}."
        )
    if len(content.options) > _MAX_ELEMENTS:
        raise ValueError(
            f"Request {request.request_id} has {len(content.options)} options; "
            f"Slack renders at most {_MAX_ELEMENTS} buttons."
        )

    prompt = f"*Permission needed*\n{escape_mrkdwn(content.title)}"
    if content.detail:
        prompt += f"\n`{escape_mrkdwn(content.detail)}`"

    blocks: list[dict[str, Any]] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": prompt}},
        {
            "type": "actions",
            "block_id": f"{ANSWER_ACTION}:{request.request_id}",
            "elements": [_button(option, reference) for option in content.options],
        },
        {
            "type": "context",
            "elements": [
                {"type": "mrkdwn", "text": escape_mrkdwn(_reply_hint(reference))}
            ],
        },
    ]
    return SlackMessage(text=render_approval_text(request, reference), blocks=blocks)


def render_approval_text(request: SnapshotRequest, reference: RequestReference) -> str:
    """The same approval with no card at all.

    This is the notification fallback, and the form a person is answering when
    they type rather than press. Numbering matches the button order, so "1"
    means the same on both.

    Slack reads a message's `text` as mrkdwn, so this is not a plain string it
    can be careless with: every value is escaped, and only the quote markers
    and the numbering are markup this wrote.
    """
    content = request.content
    if not isinstance(content, ApprovalContent):
        raise ValueError(
            f"Request {request.request_id} is not an approval: {content.kind}."
        )
    lines = [
        f"> Request {escape_mrkdwn(reference.handle)}: {escape_mrkdwn(content.title)}"
    ]
    if content.detail:
        lines.append(f"> {escape_mrkdwn(content.detail)}")
    lines += [
        f"{index}. {escape_mrkdwn(option.label)}"
        for index, option in enumerate(content.options, start=1)
    ]
    lines.append(escape_mrkdwn(_reply_hint(reference)))
    return "\n".join(lines)


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


def _reply_hint(reference: RequestReference) -> str:
    return f'Reply with "{reference.handle} 1", or press a button.'


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
