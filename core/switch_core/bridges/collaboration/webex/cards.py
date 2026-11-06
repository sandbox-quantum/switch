"""Request cards drawn as Webex Adaptive Cards, and the presses they send back.

A card is the request's own text, as every other platform draws it, with one
`Action.Submit` per option underneath. What a press carries is the request's
token and the option's position, the same pair a typed answer names, so a
press and a typed answer mean the same thing and resolve the same way. Neither
value is trusted: the token is resolved against Switch's record and the
position against the form that record holds.
"""

from __future__ import annotations

import json
from typing import Any

from switch_core.bridges.collaboration.session.renderers import (
    Control,
    position_action,
)

CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive"

# Webex refuses a message whose text and attachments together pass this many
# bytes.
MAX_MESSAGE_BYTES = 22740

# Webex draws at most this many actions on one card.
MAX_ACTIONS = 20

# The longest button title drawn before it is cut; the body carries the option
# in full.
MAX_BUTTON_LABEL = 60

_KIND = "switch"
_ANSWER = "answer"


def _button_label(control: Control) -> str:
    label = f"{control.position}. {control.label}"
    if len(label) <= MAX_BUTTON_LABEL:
        return label
    return label[: MAX_BUTTON_LABEL - 1].rstrip() + "…"


def request_card(text: str, token: str, controls: list[Control]) -> dict[str, Any]:
    return _card(
        text,
        [
            {
                "type": "Action.Submit",
                "title": _button_label(control),
                "data": {
                    "kind": _KIND,
                    "do": _ANSWER,
                    "token": token,
                    "position": control.position,
                },
            }
            for control in controls[:MAX_ACTIONS]
        ],
    )


def _card(text: str, actions: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "contentType": CARD_CONTENT_TYPE,
        "content": {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "type": "AdaptiveCard",
            "version": "1.3",
            "body": [{"type": "TextBlock", "text": text, "wrap": True}],
            "actions": actions,
        },
    }


def message_size(markdown: str, attachments: list[dict[str, Any]]) -> int:
    serialised = json.dumps(attachments, separators=(",", ":"), ensure_ascii=False)
    return len(markdown.encode("utf-8")) + len(serialised.encode("utf-8"))


def read_press(inputs: object) -> tuple[str, str] | None:
    """The Switch action a press carries and what it names, or None if not ours."""
    if not isinstance(inputs, dict) or inputs.get("kind") != _KIND:
        return None
    if inputs.get("do") != _ANSWER:
        return None
    token = inputs.get("token")
    position = inputs.get("position")
    if isinstance(position, str) and position.isascii() and position.isdecimal():
        position = int(position)
    if not isinstance(token, str) or not token:
        return None
    if not isinstance(position, int) or isinstance(position, bool) or position < 1:
        return None
    return position_action(position), token
