"""The room line for an agent whose owner is paused or turned off:
the agreed words, and at most once per room per hour for each code."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.clients.admin_messages import AUTO_REPLY_FLAG
from switch_core.delivery import recipient
from switch_core.delivery.recipient import (
    AgentRecipient,
    _hosted_block_message,
    _hosted_block_notice_due,
)
from switch_core.transport import InboundMessage


def test_the_agreed_words_for_each_code() -> None:
    paused = _hosted_block_message("paused_by_switch", "@ada")
    assert paused == (
        "Switch has paused hosted agents for my owner (@ada), so I can't answer. "
        "This message won't be answered later. Contact your workspace admin."
    )
    off = _hosted_block_message("turned_off_by_admin", None)
    assert off.startswith(
        "Hosted agents are turned off for my owner, so I can't answer."
    )
    assert "Ask your workspace admin to turn them back on." in off
    for line in (paused, off):
        assert "\n" not in line


def test_at_most_once_per_room_per_hour_for_each_code(monkeypatch) -> None:
    now = [1000.0]
    monkeypatch.setattr(recipient.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(recipient, "_hosted_block_notices", {})
    assert _hosted_block_notice_due("!room:a", "paused_by_switch") is True
    assert _hosted_block_notice_due("!room:a", "paused_by_switch") is False
    # Another room, or another code, is due its own line.
    assert _hosted_block_notice_due("!room:b", "paused_by_switch") is True
    assert _hosted_block_notice_due("!room:a", "turned_off_by_admin") is True
    now[0] += 3599
    assert _hosted_block_notice_due("!room:a", "paused_by_switch") is False
    now[0] += 2
    assert _hosted_block_notice_due("!room:a", "paused_by_switch") is True


# ── The gate: a blocked agent's message is dropped, with the line or nothing ──


def _blocked_client(code: str | None, *, allowed: bool = True):  # type: ignore[no-untyped-def]
    calls: list[str] = []

    async def _hosted_block(_session, _agent):  # type: ignore[no-untyped-def]
        return code

    async def _addressing_allowed(*_args, **_kwargs):  # type: ignore[no-untyped-def]
        calls.append("addressing")
        return SimpleNamespace(allowed=allowed, refusal="" if allowed else "no")

    async def _require_within(*_args, **_kwargs):  # type: ignore[no-untyped-def]
        calls.append("budget")

    async def owner_handle_in(_session, _agent, _bridge_id):  # type: ignore[no-untyped-def]
        return "@ada"

    async def _daily_cap_refusal(_session, _agent, _meta):  # type: ignore[no-untyped-def]
        return None  # the daily cap check: not capped here

    client = SimpleNamespace(
        agent=SimpleNamespace(id="agent-1", name="fixer"),
        tenant_id="tenant-1",
        _hosted_block=_hosted_block,
        _daily_cap_refusal=_daily_cap_refusal,
        _addressing_allowed=_addressing_allowed,
        _budget_guard=SimpleNamespace(require_within=_require_within),
        owner_handle_in=owner_handle_in,
        _triggered_by_auto_reply=AgentRecipient._triggered_by_auto_reply,
    )
    client.calls = calls  # type: ignore[attr-defined]
    return client


def _event(*, auto_reply: bool = False) -> InboundMessage:
    content: dict = {"body": "@fixer hello", "sender_name": "human"}
    if auto_reply:
        content[AUTO_REPLY_FLAG] = True
    return InboundMessage(
        room_id="!matrix:switch.local",
        event_id="$evt",
        sender="@u:switch.local",
        timestamp=1700000000000,
        content=content,
        body="@fixer hello",
        sender_name="human",
    )


async def _gate(client, event, room_id: str = "!room:a"):  # type: ignore[no-untyped-def]
    meta = SimpleNamespace(room_id=room_id, bridge_id=None)
    return await AgentRecipient._gate_addressed(client, None, client.agent, event, meta)


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_paused_agents_message_is_dropped_with_one_line(monkeypatch) -> None:
    monkeypatch.setattr(recipient, "_hosted_block_notices", {})
    client = _blocked_client("paused_by_switch")
    first = await _gate(client, _event())
    assert first.addressed is False  # not kept for the agent, now or later
    assert first.refusal == _hosted_block_message("paused_by_switch", "@ada")
    second = await _gate(client, _event())
    assert second.addressed is False and second.refusal is None  # once an hour
    # The pause is checked first: addressing and budgets never run.
    assert client.calls == []


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_turned_off_agent_never_answers_an_auto_reply(monkeypatch) -> None:
    monkeypatch.setattr(recipient, "_hosted_block_notices", {})
    client = _blocked_client("turned_off_by_admin")
    outcome = await _gate(client, _event(auto_reply=True))
    assert outcome.addressed is False and outcome.refusal is None
    # The auto-reply didn't spend the room's line.
    assert _hosted_block_notice_due("!room:a", "turned_off_by_admin") is True


async def test_an_agent_nothing_blocks_goes_on_to_the_usual_checks(monkeypatch) -> None:
    monkeypatch.setattr(recipient, "_hosted_block_notices", {})
    client = _blocked_client(None)
    outcome = await _gate(client, _event())
    assert outcome.addressed is True and outcome.refusal is None
    assert client.calls == ["addressing", "budget"]
