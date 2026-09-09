from __future__ import annotations

from typing import Any

from switch_core.bridges.collaboration.adapter import AgentRendering

ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive"


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
            {
                "type": "TextBlock",
                "text": body,
                "wrap": True,
            },
        ],
    }
    if mentions:
        card["msteams"] = {"entities": mentions}
    return card


def card_attachment(card: dict[str, Any]) -> dict[str, Any]:
    """Wrap an Adaptive Card as a Bot Framework activity attachment."""
    return {"contentType": ADAPTIVE_CARD_CONTENT_TYPE, "content": card}
