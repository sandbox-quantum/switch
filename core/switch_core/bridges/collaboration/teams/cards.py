from __future__ import annotations

import re
from typing import Any

from switch_core.bridges.collaboration.adapter import AgentRendering
from switch_core.bridges.collaboration.session.renderers import Control

ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive"

# What a press on a Switch control calls itself. Teams hands the verb back
# untouched, so it is the first thing a press is checked against: an action
# from some other app's card is not one this bridge has any business reading.
ANSWER_VERB = "switch/answerRequest"

# Where the press carries what it is answering. Nested under one key because
# Teams merges a card's input values into the same object, and a flat name is a
# collision waiting for the first card here to grow an input.
_ANSWER_DATA = "switchAnswer"

# The schema version that introduced Action.Execute, which is the only card
# action that reaches a bot with a reply the presser alone sees. A card with
# nothing to press stays at 1.4: a client too old for the newer schema falls
# back to `fallbackText` for the whole card, which is a cost worth paying only
# where there is something to gain.
_ACTION_VERSION = "1.5"
_BASE_VERSION = "1.4"

# How much of an option's label a button shows. Not a documented Teams limit —
# it is where a row of buttons stops being readable. Safe to impose because the
# body above lists every option in full, so the button only has to say which.
_MAX_ACTION_TITLE = 60

# A line markdown would set as a list item: a bullet or a number, indented by
# less than the four spaces that would make it a code block instead.
_LIST_ITEM = re.compile(r"^ {0,3}(?:[-*+]|\d+[.)]) ")

# A TextBlock costs roughly this much JSON around whatever line it carries,
# measured the way Teams measures an activity — its keys are ASCII, so UTF-16
# counts each of them twice.
_BLOCK_OVERHEAD = 140

# What all that structure may add up to. The connector refuses an activity over
# 64 KiB on the same metric, and a body split a line to a block spends the
# budget on punctuation: a thousand characters written as five hundred short
# lines cost seventy kilobytes of braces to say. Past this the body is set as
# one block again, so a long message is judged on its own length rather than on
# the shape it was drawn in.
_BLOCK_BUDGET = 8 * 1024


def body_blocks(body: str) -> list[dict[str, Any]]:
    """A message body as consecutive TextBlocks, a line to a block.

    One TextBlock renders markdown, where a lone newline is whitespace: a
    heading and the line under it arrive as one run-on sentence. Doubling the
    newline gives the break back but pays a full paragraph gap for it, so a
    six-line card is read as six paragraphs. Separate blocks give the break
    back and let `spacing` say what kind of break it is — `None` for a line
    that simply follows the one above, `Small` where the body itself left a
    blank line.

    Consecutive list items stay in one block, so they render as one list with
    its numbering intact rather than as several lists of one item each.
    Markdown already keeps those on their own lines.

    A body with more lines than `_BLOCK_BUDGET` pays for is set as a single
    block with its breaks doubled instead. Every line survives, in order; what
    changes is that each gets a paragraph's gap rather than a line's. That is
    worth it against the alternative, which is the whole message refused for
    being made of too many short lines.
    """
    runs: list[tuple[str, list[str]]] = []
    # The first block sits against the card header, which is a gap of its own.
    gap = True
    for line in body.split("\n"):
        if not line.strip():
            gap = True
            continue
        if (
            not gap
            and runs
            and _LIST_ITEM.match(line)
            and _LIST_ITEM.match(runs[-1][1][-1])
        ):
            runs[-1][1].append(line)
            continue
        runs.append(("Small" if gap else "None", [line]))
        gap = False
    if len(runs) * _BLOCK_OVERHEAD > _BLOCK_BUDGET:
        return [
            {
                "type": "TextBlock",
                "text": "\n\n".join("\n".join(lines) for _, lines in runs),
                "wrap": True,
                "spacing": "None",
            }
        ]
    return [
        {
            "type": "TextBlock",
            "text": "\n".join(lines),
            "wrap": True,
            "spacing": spacing,
        }
        for spacing, lines in runs
    ]


def answer_actions(token: str, controls: list[Control]) -> list[dict[str, Any]]:
    """A card's options as `Action.Execute` buttons, in the order they are drawn.

    What travels in the press is the card's opaque token and the number beside
    the option in the body — never the option's own id, its label, or anything
    about who may press it. The number is what a typed answer names too, so the
    two ways of answering mean the same thing by the same word, and both are
    resolved against the record rather than trusted.

    Wrapped in an `ActionSet` because Teams clients that predate the universal
    action model only honour an action's fallback inside one. `drop` is that
    fallback: the body lists every option and says how to type an answer, so a
    client with no button still has a card it can act on.
    """
    return [
        {
            "type": "ActionSet",
            "spacing": "Medium",
            "actions": [
                {
                    "type": "Action.Execute",
                    "title": _action_title(control),
                    "verb": ANSWER_VERB,
                    "data": {
                        _ANSWER_DATA: {
                            "token": token,
                            "position": control.position,
                        }
                    },
                    "fallback": "drop",
                }
                for control in controls
            ],
        }
    ]


def _action_title(control: Control) -> str:
    """What the button says: the option's number, and as much of it as fits.

    Numbered because the body numbers it, and a reader looking at "2." in the
    text and "Decline" on a button should not have to work out that they are
    the same choice.
    """
    label = control.label.strip() or f"Option {control.position}"
    room = _MAX_ACTION_TITLE - len(f"{control.position}. ")
    if len(label) > room:
        label = label[: room - 1].rstrip() + "…"
    return f"{control.position}. {label}"


def read_answer_action(value: dict[str, Any]) -> tuple[str, int] | None:
    """The card and the option a press names, or None if it is not ours.

    Read as strictly as it is written. Teams hands back whatever was put in the
    button, plus whatever the client chose to add, so neither half is trusted
    past its shape: the token is resolved against the stored card and the
    position against the form that card was posted with.
    """
    action = value.get("action")
    if not isinstance(action, dict) or action.get("verb") != ANSWER_VERB:
        return None
    data = action.get("data")
    carried = data.get(_ANSWER_DATA) if isinstance(data, dict) else None
    if not isinstance(carried, dict):
        return None
    token = carried.get("token")
    position = carried.get("position")
    if not isinstance(token, str) or not token:
        return None
    if isinstance(position, bool) or not isinstance(position, int) or position < 1:
        return None
    return token, position


def agent_message_card(
    agent: AgentRendering,
    body: str,
    mentions: list[dict[str, Any]],
    actions: list[dict[str, Any]],
) -> dict[str, Any]:
    """An Adaptive Card that labels a message with the sending agent's identity.

    Teams has a single bot identity and no per-message username override (unlike
    Slack), so each Switch agent is presented as a card whose header carries the
    agent's avatar + name, with the message body beneath. ``body`` should already
    be run through ``translate_outbound`` (Adaptive Card TextBlocks render a
    markdown subset: bold, italic, links, lists).

    ``agent`` is resolved by the caller — one lookup gives the label, its escaped
    form and the icon — because resolving it is async and this builder is not.
    Which form goes where is the point of taking the whole rendering: the header
    is an ordinary TextBlock and so renders the markdown subset, while
    ``altText`` is read out verbatim by a screen reader.

    The body becomes one TextBlock per line rather than one for the whole of it
    — see ``body_blocks`` for why. ``fallbackText`` keeps the body as it came
    in, because nothing renders it as a card.

    ``mentions`` are Bot Framework mention entities matching ``<at>`` markup in
    ``body``. A card carries them under ``msteams`` rather than on the activity,
    and without them the markup renders as inert text and the person is never
    notified.

    ``actions`` are card elements appended under the body — an empty list for
    everything but an open request card. They set the schema version, because
    the action model they use is the reason to ask for the newer one."""
    card: dict[str, Any] = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": _ACTION_VERSION if actions else _BASE_VERSION,
        # Plain-text representation for surfaces that can't render the card
        # inline (mobile, notification toasts, copy-link/search previews); its
        # absence is what makes Teams show the "cards.unsupported" placeholder.
        "fallbackText": f"{agent.body_label}: {body}",
        "body": [
            {
                "type": "ColumnSet",
                "columns": [
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
                    },
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
                                "spacing": "None",
                            }
                        ],
                    },
                ],
            },
            *body_blocks(body),
            *actions,
        ],
    }
    if mentions:
        card["msteams"] = {"entities": mentions}
    return card


def card_attachment(card: dict[str, Any]) -> dict[str, Any]:
    """Wrap an Adaptive Card as a Bot Framework activity attachment."""
    return {"contentType": ADAPTIVE_CARD_CONTENT_TYPE, "content": card}
