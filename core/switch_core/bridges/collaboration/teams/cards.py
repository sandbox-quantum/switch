from __future__ import annotations

import re
from typing import Any

from switch_core.bridges.collaboration.adapter import AgentRendering

ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive"

# A line markdown would set as a list item: a bullet or a number, indented by
# less than the four spaces that would make it a code block instead.
_LIST_ITEM = re.compile(r"^ {0,3}(?:[-*+]|\d+[.)]) ")


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
    return [
        {
            "type": "TextBlock",
            "text": "\n".join(lines),
            "wrap": True,
            "spacing": spacing,
        }
        for spacing, lines in runs
    ]


def agent_message_card(
    agent: AgentRendering,
    body: str,
    mentions: list[dict[str, Any]],
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
    notified."""
    card: dict[str, Any] = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
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
        ],
    }
    if mentions:
        card["msteams"] = {"entities": mentions}
    return card


def card_attachment(card: dict[str, Any]) -> dict[str, Any]:
    """Wrap an Adaptive Card as a Bot Framework activity attachment."""
    return {"contentType": ADAPTIVE_CARD_CONTENT_TYPE, "content": card}
