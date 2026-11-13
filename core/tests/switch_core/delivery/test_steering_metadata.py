"""What an agent is told about a sender for steering a running turn, and the
per-agent setting that says whether it may.

A host steers a message into the running turn only for the person who started
that turn or the agent's owner (`console/docs/sdk-sessions.md`), so Switch
tells it who the sender is (`sender_person`), whether they own the agent
(`sender_owns_agent`), and the agent's setting (`mid_turn_delivery`).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.message_events import message_event
from switch_core.delivery.addressing import SenderPrincipal
from switch_core.delivery.recipient import AgentRecipient, steering_identity
from switch_core.gateway.agents import update_mid_turn_delivery
from switch_core.gateway.schemas import UpdateAgentMidTurnDeliveryRequest
from switch_core.transport.types import InboundMessage
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
    register,
)


@pytest.mark.parametrize(
    ("principal", "person", "owns"),
    [
        # A person whose chat account one Switch user claimed is that user,
        # from every platform and from Switch Console.
        (SenderPrincipal("user", "ext-ada", ["ada"], None), "ada", False),
        (SenderPrincipal("user", "ext-mo", ["mo"], None), "mo", True),
        # A person nobody claimed is their chat account: they can still steer
        # a turn they started, but are never taken for the owner.
        (SenderPrincipal("user", "ext-anon", [], None), "ext-anon", False),
        # An account several people claimed speaks for none of them.
        (
            SenderPrincipal("user", "ext-shared", ["mo", "ada"], None),
            "ext-shared",
            False,
        ),
        # Agents, the platform, and what the platform carries for someone
        # (the owner's schedule, a kickoff) never steer.
        (SenderPrincipal("agent", "agent-1", [], "mo"), None, False),
        (
            SenderPrincipal("platform", "admin", [], None, on_behalf_of="mo"),
            None,
            False,
        ),
        (None, None, False),
    ],
)
def test_who_a_sender_is_for_steering(
    principal: SenderPrincipal | None, person: str | None, owns: bool
) -> None:
    assert steering_identity(principal, "mo") == (person, owns)


def test_an_agent_with_no_owner_is_owned_by_nobody() -> None:
    principal = SenderPrincipal("user", "ext-mo", ["mo"], None)
    assert steering_identity(principal, None) == ("mo", False)


def test_the_setting_is_read_from_the_agent() -> None:
    recipient = SimpleNamespace(agent=SimpleNamespace(mid_turn_delivery="steer"))
    assert AgentRecipient._mid_turn_delivery(recipient) == "steer"  # type: ignore[arg-type]
    recipient.agent.mid_turn_delivery = "queue"
    assert AgentRecipient._mid_turn_delivery(recipient) == "queue"  # type: ignore[arg-type]


def test_the_facts_ride_on_the_message() -> None:
    event = message_event(
        room_id="room-1",
        bridge_id=None,
        channel_type="direct",
        event=InboundMessage(
            room_id="room-1",
            event_id="$1",
            sender="@mo:test",
            timestamp=1,
            body="no, use the other file",
            sender_name="mo",
        ),
        addressed=True,
        sender_name="mo",
        body="no, use the other file",
        thread_id=None,
        sender_person="mo",
        sender_owns_agent=True,
        mid_turn_delivery="queue",
    )
    payload = event.payload
    assert payload.sender_person == "mo"  # type: ignore[union-attr]
    assert payload.sender_owns_agent is True  # type: ignore[union-attr]
    assert payload.mid_turn_delivery == "queue"  # type: ignore[union-attr]
    assert event.channel_type == "direct"


async def test_a_new_agent_steers_and_re_registering_keeps_the_owners_choice(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    svc = make_service(session_factory)
    owner_id = await make_owner(session_factory)
    agent_id = await register(svc, "steady", owner_id)
    async with session_factory() as session:
        agent = await svc.agent_store.get(session, agent_id)
        assert agent is not None and agent.mid_turn_delivery == "steer"
        await svc.agent_store.update(session, agent_id, mid_turn_delivery="queue")
        await session.commit()

    # What Switch Console does every time it relaunches the agent.
    again = await register(
        svc, "steady", owner_id, overwrite=True, metadata={"known_agent_type": "x"}
    )

    assert again == agent_id
    async with session_factory() as session:
        agent = await svc.agent_store.get(session, agent_id)
        assert agent is not None and agent.mid_turn_delivery == "queue"


async def test_only_the_owner_or_an_admin_may_change_the_setting() -> None:
    agent = SimpleNamespace(owner_id="owner")
    store = SimpleNamespace(get=AsyncMock(return_value=agent), update=AsyncMock())
    with pytest.raises(HTTPException) as refused:
        await update_mid_turn_delivery(
            "a",
            UpdateAgentMidTurnDeliveryRequest(mid_turn_delivery="queue"),
            None,  # type: ignore[arg-type]
            store,  # type: ignore[arg-type]
            SimpleNamespace(id="other"),  # type: ignore[arg-type]
            False,
        )
    assert refused.value.status_code == 403
    assert "owner or an admin" in str(refused.value.detail)
    store.update.assert_not_awaited()


async def test_the_owner_sets_the_column(monkeypatch: pytest.MonkeyPatch) -> None:
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
        session,  # type: ignore[arg-type]
        store,  # type: ignore[arg-type]
        SimpleNamespace(id="owner", name="Owner"),  # type: ignore[arg-type]
        False,
    )
    assert result is summary
    store.update.assert_awaited_once_with(session, "a", mid_turn_delivery="queue")
    session.commit.assert_awaited_once()


def test_steered_item_triggers_activity_card_redraw() -> None:
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
    before = status_state(view, **kwargs)  # type: ignore[arg-type]
    view.items = [item]
    assert status_state(view, **kwargs) != before  # type: ignore[arg-type]
