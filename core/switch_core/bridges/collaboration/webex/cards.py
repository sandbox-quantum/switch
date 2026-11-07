"""Adaptive Cards, as Webex draws them, for the requests a person answers.

A request card is an ordinary Webex message carrying one card: the agent's
name over the request, and one button per option. The message's own Markdown
says the same thing in text, which is what a client that draws no cards — and
every notification — shows instead.

A press reaches the bridge as an *attachment action*: Webex records which card
was pressed, by whom, and whatever the button carried. What a button carries
here is the card's opaque token and the number printed beside the option, the
same number a typed answer names, so the two ways of answering mean the same
thing and both are resolved against Switch's record rather than trusted.
"""

from __future__ import annotations

import re
from typing import Any

from switch_core.bridges.collaboration.adapter import AgentRendering
from switch_core.bridges.collaboration.session.renderers import Control

CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive"

# The newest schema every Webex client draws. A card declaring more is shown
# as its fallback text on the clients that cannot.
CARD_VERSION = "1.3"

# What marks a press as one of this bridge's. Flat keys, because Webex merges a
# button's data into the same object as the card's inputs and returns it as
# given; a nested object would be one more shape to trust.
_KIND = "switch"
_ANSWER = "answer"

# Where a row of buttons stops being readable. The body above lists every
# option in full, so the button has only to say which one it is.
_MAX_TITLE = 60

# A line Markdown sets as a list item.
_LIST_ITEM = re.compile(r"^ {0,3}(?:[-*+]|\d+[.)]) ")


def body_blocks(body: str) -> list[dict[str, Any]]:
    """The body as TextBlocks, one per line, with list items kept together.

    A TextBlock's Markdown reads a lone newline as a space, so a body set as
    one block runs its lines together. A block per line keeps the breaks, and
    `spacing` keeps the difference between a line that follows the one above
    and one after a blank line. Consecutive list items share a block so they
    render as one list.
    """
    blocks: list[dict[str, Any]] = []
    gap = False
    for line in body.split("\n"):
        if not line.strip():
            gap = True
            continue
        if blocks and not gap and _LIST_ITEM.match(line):
            previous = blocks[-1]["text"].split("\n")[-1]
            if _LIST_ITEM.match(previous):
                blocks[-1]["text"] += f"\n{line}"
                continue
        blocks.append(
            {
                "type": "TextBlock",
                "text": line,
                "wrap": True,
                "spacing": "Small" if gap and blocks else "None",
            }
        )
        gap = False
    return blocks


def _title(control: Control) -> str:
    label = control.label.strip() or f"Option {control.position}"
    room = _MAX_TITLE - len(f"{control.position}. ")
    if len(label) > room:
        label = label[: room - 1].rstrip() + "…"
    return f"{control.position}. {label}"


def _header(agent: AgentRendering) -> dict[str, Any]:
    columns: list[dict[str, Any]] = []
    if agent.icon_url and agent.icon_url.startswith("https://"):
        columns.append(
            {
                "type": "Column",
                "width": "auto",
                "items": [
                    {
                        "type": "Image",
                        "url": agent.icon_url,
                        "size": "Small",
                        "style": "Person",
                        "altText": agent.field_label,
                    }
                ],
            }
        )
    columns.append(
        {
            "type": "Column",
            "width": "stretch",
            "verticalContentAlignment": "Center",
            "items": [
                {
                    "type": "TextBlock",
                    "text": agent.body_label,
                    "weight": "Bolder",
                    "wrap": True,
                }
            ],
        }
    )
    return {"type": "ColumnSet", "columns": columns}


def request_card(
    agent: AgentRendering, body: str, token: str, controls: list[Control]
) -> dict[str, Any]:
    """A request as a card: who is asking, what, and a button per option."""
    card: dict[str, Any] = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": CARD_VERSION,
        "body": [_header(agent), *body_blocks(body)],
    }
    if controls:
        card["actions"] = [
            {
                "type": "Action.Submit",
                "title": _title(control),
                "data": {_KIND: _ANSWER, "token": token, "position": control.position},
            }
            for control in controls
        ]
    return card


def card_attachment(card: dict[str, Any]) -> dict[str, Any]:
    return {"contentType": CARD_CONTENT_TYPE, "content": card}


def has_card(message: dict[str, Any]) -> bool:
    """Whether a message Webex returned carries a card."""
    return any(
        isinstance(attachment, dict)
        and attachment.get("contentType") == CARD_CONTENT_TYPE
        for attachment in message.get("attachments") or []
    )


def read_press(inputs: object) -> tuple[str, int] | None:
    """The card token and option number a press names, or None if not ours.

    Read as strictly as it is written. Webex hands back what the button
    carried merged with whatever the card's inputs held, so neither half is
    trusted past its shape: the token is resolved against the stored card and
    the number against the form that card was posted with.
    """
    if not isinstance(inputs, dict) or inputs.get(_KIND) != _ANSWER:
        return None
    token = inputs.get("token")
    position = inputs.get("position")
    if isinstance(position, str) and position.isdigit():
        position = int(position)
    if not isinstance(token, str) or not token:
        return None
    if isinstance(position, bool) or not isinstance(position, int) or position < 1:
        return None
    return token, position
