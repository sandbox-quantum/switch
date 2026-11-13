"""Authenticated sender metadata and delivery preferences for steering."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from switch_core.delivery.addressing import SenderPrincipal
from switch_core.delivery.recipient import AgentRecipient
from switch_core.gateway.agents import update_mid_turn_delivery
from switch_core.gateway.schemas import UpdateAgentMidTurnDeliveryRequest
from switch_core.transport.types import InboundMessage


@pytest.mark.parametrize(
    ("principal", "expected"),
    [
        (SenderPrincipal("user", "client", ["owner"], None), True),
        (SenderPrincipal("user", "client", ["other"], None), False),
        (SenderPrincipal("agent", "agent", [], "owner"), False),
        (None, False),
    ],
)
async def test_ownership_is_resolved_from_a_human_claim(principal, expected):
    recipient = SimpleNamespace(
        agent=SimpleNamespace(owner_id="owner"),
        _addressing=SimpleNamespace(resolve_sender=AsyncMock(return_value=principal)),
    )
    event = InboundMessage(
        room_id="room", event_id="message", sender="sender", timestamp=1, body="hi"
    )
    assert await AgentRecipient._sender_owns_agent(recipient, None, event) is expected


def test_delivery_preference_defaults_to_steer_and_can_queue():
    recipient = SimpleNamespace(agent=SimpleNamespace(metadata_=None))
    assert AgentRecipient._mid_turn_delivery(recipient) == "steer"
    recipient.agent.metadata_ = {"mid_turn_delivery": "queue"}
    assert AgentRecipient._mid_turn_delivery(recipient) == "queue"


async def test_setting_requires_agent_owner_or_admin():
    agent = SimpleNamespace(owner_id="owner")
    store = SimpleNamespace(get=AsyncMock(return_value=agent), update=AsyncMock())
    with pytest.raises(HTTPException) as refused:
        await update_mid_turn_delivery(
            "a",
            UpdateAgentMidTurnDeliveryRequest(mid_turn_delivery="queue"),
            None,
            store,
            SimpleNamespace(id="other"),
            False,
        )
    assert refused.value.status_code == 403
    store.update.assert_not_awaited()


async def test_owner_can_set_queue_and_preserve_other_metadata(monkeypatch):
    agent = SimpleNamespace(owner_id="owner", metadata_={"other": "value"})
    store = SimpleNamespace(get=AsyncMock(return_value=agent), update=AsyncMock())
    session = SimpleNamespace(commit=AsyncMock(), refresh=AsyncMock())
    summary = object()
    monkeypatch.setattr(
        "switch_core.gateway.agents.build_agent_summary",
        AsyncMock(return_value=summary),
    )
    result = await update_mid_turn_delivery(
        "a",
        UpdateAgentMidTurnDeliveryRequest(mid_turn_delivery="queue"),
        session,
        store,
        SimpleNamespace(id="owner", name="Owner"),
        False,
    )
    assert result is summary
    store.update.assert_awaited_once_with(
        session, "a", metadata_={"other": "value", "mid_turn_delivery": "queue"}
    )
    session.commit.assert_awaited_once()


def test_steered_item_triggers_activity_card_redraw():
    from switch_core.session_activity.bridge_turns import status_state

    turn = SimpleNamespace(status="running")
    item = SimpleNamespace(
        kind="user-message",
        title="Steered into the running turn",
        item_id="steer",
        revision=1,
    )
    view = SimpleNamespace(turn=turn, items=[])
    kwargs = dict(
        elapsed_seconds=None,
        interrupt_turn_id=None,
        clock_redraws=False,
        closed_by_platform=False,
    )
    before = status_state(view, **kwargs)
    view.items = [item]
    assert status_state(view, **kwargs) != before
