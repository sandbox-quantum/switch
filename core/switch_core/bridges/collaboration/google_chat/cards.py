from __future__ import annotations

import uuid
from typing import Any

from switch_core.bridges.collaboration.adapter import RequestCard, TurnActivity
from switch_core.bridges.collaboration.session.renderers import (
    INTERRUPT_ACTION,
    position_action,
    turn_state,
)
from switch_core.bridges.collaboration.session.renderers.neutral import (
    turn_summary,
)
from switch_core.sessions.contract import (
    ApprovalContent,
    ApprovalResult,
    QuestionsContent,
)


def render_turn_activity_card(
    activity: TurnActivity,
    agent_name: str,
    *,
    avatar_url: str | None = None,
) -> dict[str, Any]:
    """Render a TurnActivity into a Google Chat Card v2 structure."""
    state_str = turn_state(
        activity.items,
        activity.turn,
        tool_detail=False,
        elapsed_seconds=activity.elapsed_seconds,
    )
    summary_text = turn_summary(
        activity.items,
        activity.turn,
        escape=lambda s: s,
        limit=500,
    )

    header: dict[str, Any] = {
        "title": f"Agent {agent_name}",
        "subtitle": state_str,
    }
    if avatar_url:
        header["imageUrl"] = avatar_url
        header["imageType"] = "CIRCLE"

    widgets: list[dict[str, Any]] = [
        {"textParagraph": {"text": summary_text or state_str}}
    ]

    # If turn is running, provide interrupt/stop button
    if activity.turn.status == "running":
        widgets.append(
            {
                "buttonList": {
                    "buttons": [
                        {
                            "text": "Stop",
                            "color": {
                                "red": 0.8,
                                "green": 0.2,
                                "blue": 0.2,
                                "alpha": 1.0,
                            },
                            "onClick": {
                                "action": {
                                    "function": "card_action",
                                    "parameters": [
                                        {
                                            "key": "token",
                                            "value": activity.turn.turn_id,
                                        },
                                        {"key": "action_id", "value": INTERRUPT_ACTION},
                                    ],
                                }
                            },
                        }
                    ]
                }
            }
        )

    card_body = {
        "header": header,
        "sections": [{"widgets": widgets}],
    }
    return {
        "cardId": f"turn-{activity.turn.turn_id}",
        "card": card_body,
    }


def render_request_card(
    card: RequestCard,
    agent_name: str,
    *,
    avatar_url: str | None = None,
) -> dict[str, Any]:
    """Render a RequestCard (Approval or Questions) into a Google Chat Card v2 structure."""
    req = card.request
    token = card.reference.token
    content = req.content

    header: dict[str, Any] = {
        "title": f"Agent {agent_name}",
        "subtitle": getattr(content, "title", "Request for Decision"),
    }
    if avatar_url:
        header["imageUrl"] = avatar_url
        header["imageType"] = "CIRCLE"

    widgets: list[dict[str, Any]] = []

    # Detail / prompt text
    if isinstance(content, ApprovalContent):
        detail = content.detail or content.title
        widgets.append({"textParagraph": {"text": detail}})

        # If open, show interactive buttons
        if req.state == "open" and not req.result:
            buttons: list[dict[str, Any]] = []
            for idx, opt in enumerate(content.options):
                is_deny = (
                    opt.decision in ("decline", "cancel")
                    or "deny" in opt.label.lower()
                    or "reject" in opt.label.lower()
                )
                color = (
                    {"red": 0.8, "green": 0.2, "blue": 0.2, "alpha": 1.0}
                    if is_deny
                    else {"red": 0.1, "green": 0.6, "blue": 0.2, "alpha": 1.0}
                )
                buttons.append(
                    {
                        "text": opt.label,
                        "color": color,
                        "onClick": {
                            "action": {
                                "function": "card_action",
                                "parameters": [
                                    {"key": "token", "value": token},
                                    {
                                        "key": "action_id",
                                        "value": position_action(idx + 1),
                                    },
                                    {"key": "option_id", "value": opt.option_id},
                                ],
                            }
                        },
                    }
                )
            if buttons:
                widgets.append({"buttonList": {"buttons": buttons}})
        else:
            # Settled outcome
            outcome_text = "Resolved"
            if req.result and isinstance(req.result.result, ApprovalResult):
                selected_id = req.result.result.option_id
                for opt in content.options:
                    if opt.option_id == selected_id:
                        outcome_text = f"Decided: {opt.label}"
                        break
            elif req.state in ("resolved", "closed"):
                outcome_text = "Decision recorded"
            if card.responder_external_id:
                outcome_text += f" by {card.responder_external_id}"
            widgets.append({"textParagraph": {"text": f"*{outcome_text}*"}})

    elif isinstance(content, QuestionsContent):
        for q in content.questions:
            widgets.append({"textParagraph": {"text": f"*{q.title}*\n{q.prompt}"}})
            if q.options and req.state == "open" and not req.result:
                q_buttons: list[dict[str, Any]] = []
                for idx, q_opt in enumerate(q.options):
                    q_buttons.append(
                        {
                            "text": q_opt.label,
                            "onClick": {
                                "action": {
                                    "function": "card_action",
                                    "parameters": [
                                        {"key": "token", "value": token},
                                        {
                                            "key": "action_id",
                                            "value": position_action(idx + 1),
                                        },
                                        {"key": "question_id", "value": q.question_id},
                                        {"key": "option_id", "value": q_opt.option_id},
                                    ],
                                }
                            },
                        }
                    )
                if q_buttons:
                    widgets.append({"buttonList": {"buttons": q_buttons}})
            elif q.allow_custom_answer or not q.options:
                widgets.append(
                    {
                        "textParagraph": {
                            "text": (
                                "_Free-text answer: Please reply in this thread with "
                                f"`{card.reference.handle} <your answer>`_"
                            )
                        }
                    }
                )

        if req.state != "open" or req.result:
            widgets.append({"textParagraph": {"text": "*Answers submitted.*"}})

    card_body = {
        "header": header,
        "sections": [{"widgets": widgets}],
    }
    return {
        "cardId": f"req-{req.request_id}",
        "card": card_body,
    }


def render_settled_approval_card(
    original_cards: list[dict[str, Any]] | None,
    decision_label: str,
    actor_name: str | None = None,
) -> list[dict[str, Any]]:
    """Update existing card to remove interactive buttons and show settled status."""
    who = f" by {actor_name}" if actor_name else ""
    status_msg = f"*{decision_label}*{who}"

    card_id = f"settled-{uuid.uuid4().hex[:8]}"
    if original_cards and original_cards[0].get("cardId"):
        card_id = original_cards[0]["cardId"]

    header = {"title": "Request Resolved", "subtitle": status_msg}
    if (
        original_cards
        and "card" in original_cards[0]
        and "header" in original_cards[0]["card"]
    ):
        orig_header = original_cards[0]["card"]["header"]
        header["title"] = orig_header.get("title", "Request Resolved")
        header["subtitle"] = status_msg
        if "imageUrl" in orig_header:
            header["imageUrl"] = orig_header["imageUrl"]
            header["imageType"] = "CIRCLE"

    return [
        {
            "cardId": card_id,
            "card": {
                "header": header,
                "sections": [
                    {
                        "widgets": [
                            {
                                "textParagraph": {
                                    "text": f"This request was marked as {status_msg}."
                                }
                            }
                        ]
                    }
                ],
            },
        }
    ]
