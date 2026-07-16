from __future__ import annotations

from typing import Any
from urllib.parse import quote

ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive"


def agent_icon_url(agent_name: str) -> str:
    """A stable generated avatar for an agent, matching the Slack adapter's
    scheme so the same agent looks the same across bridged platforms."""
    name = quote(agent_name.replace("_", "+"))
    return f"https://ui-avatars.com/api/?name={name}&background=random&size=128"


def agent_message_card(agent_name: str, body: str) -> dict[str, Any]:
    """An Adaptive Card that labels a message with the sending agent's identity.

    Teams has a single bot identity and no per-message username override (unlike
    Slack), so each Switch agent is presented as a card whose header carries the
    agent's avatar + name, with the message body beneath. ``body`` should already
    be run through ``translate_outbound`` (Adaptive Card TextBlocks render a
    markdown subset: bold, italic, links, lists)."""
    return {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
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
                                "url": agent_icon_url(agent_name),
                                "size": "Small",
                                "style": "Person",
                                "altText": agent_name,
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
                                "text": agent_name,
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


def card_attachment(card: dict[str, Any]) -> dict[str, Any]:
    """Wrap an Adaptive Card as a Bot Framework activity attachment."""
    return {"contentType": ADAPTIVE_CARD_CONTENT_TYPE, "content": card}
