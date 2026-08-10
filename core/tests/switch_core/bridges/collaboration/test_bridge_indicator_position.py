from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.collaboration.bridge_core import BridgeCore


class _FakeAdapter:
    def __init__(self, live: list[str]) -> None:
        self._live = live
        self.moved: list[tuple[str, str]] = []
        self.targets: list[str | None] = []

    def agents_with_live_runtime_state(self, channel_id: str) -> list[str]:
        return list(self._live)

    async def reposition_runtime_state(
        self, channel_id: str, agent_name: str, thread_root_id: str | None
    ) -> None:
        self.moved.append((channel_id, agent_name))
        self.targets.append(thread_root_id)


def _bridge(live: list[str]) -> Any:
    """A BridgeCore stand-in wired to the real positioning methods."""
    adapter = _FakeAdapter(live)
    ns = SimpleNamespace(
        _adapter=adapter,
        _indicator_move_timers={},
        _indicator_move_targets={},
        _reported_anchors={},
        adapter_spy=adapter,
    )
    for name in (
        "_move_indicator_for_sender",
        "_schedule_indicator_move",
        "_run_indicator_move",
        "_follow_reported_anchor",
    ):
        setattr(ns, name, getattr(BridgeCore, name).__get__(ns))
    return ns


def _drain(bridge: Any, coro: Any) -> list[tuple[str, str]]:
    """Run `coro`, then let every queued move fire, and report what moved."""

    async def _go() -> None:
        await coro
        for timer in list(bridge._indicator_move_timers.values()):
            timer.cancel()
        for key in list(bridge._indicator_move_timers):
            await bridge._run_indicator_move(key)

    asyncio.run(_go())
    return bridge.adapter_spy.moved


def _anchor(
    bridge: Any, anchor_event_id: str | None, *, thread: str | None = None
) -> Any:
    return bridge._follow_reported_anchor(
        "chan-1", "agent-a", "working", anchor_event_id, thread
    )


# ── Inbound: driven by what the agent reports it has received ───────────────


def test_a_new_reported_anchor_moves_the_indicator() -> None:
    bridge = _bridge(["agent-a"])

    async def go() -> None:
        await _anchor(bridge, "$m1")
        await _anchor(bridge, "$m2")

    assert _drain(bridge, go()) == [("chan-1", "agent-a")]


def test_the_first_anchor_of_a_turn_moves_nothing() -> None:
    # The indicator was only just posted against that message.
    bridge = _bridge(["agent-a"])

    assert _drain(bridge, _anchor(bridge, "$m1")) == []


def test_repeating_the_same_anchor_moves_nothing() -> None:
    # The 5s activity refresh replays the current anchor; it must not churn.
    bridge = _bridge(["agent-a"])

    async def go() -> None:
        await _anchor(bridge, "$m1")
        for _ in range(5):
            await _anchor(bridge, "$m1")

    assert _drain(bridge, go()) == []


def test_a_message_the_agent_has_not_been_given_moves_nothing() -> None:
    # The whole point of the redesign: arriving in the room is not evidence the
    # agent saw it, so only what the agent reports may move the indicator.
    bridge = _bridge(["agent-a"])

    async def go() -> None:
        await _anchor(bridge, "$m1")
        # A message lands in the room, but the agent is busy and is never
        # handed it — so no new anchor is ever reported.
        await _anchor(bridge, "$m1")

    assert _drain(bridge, go()) == []


def test_a_report_without_an_anchor_moves_nothing() -> None:
    # Connectors that don't report anchors simply never reposition.
    bridge = _bridge(["agent-a"])

    async def go() -> None:
        await _anchor(bridge, "$m1")
        await _anchor(bridge, None)

    assert _drain(bridge, go()) == []


def test_the_move_lands_in_the_thread_of_the_reported_message() -> None:
    bridge = _bridge(["agent-a"])

    async def go() -> None:
        await _anchor(bridge, "$m1", thread=None)
        await _anchor(bridge, "$m2", thread="root-7")

    _drain(bridge, go())

    assert bridge.adapter_spy.targets == ["root-7"]


def test_the_anchor_resets_when_the_turn_ends() -> None:
    # A later turn's first anchor must not be mistaken for a move within the
    # previous one.
    bridge = _bridge(["agent-a"])

    async def go() -> None:
        await _anchor(bridge, "$m1")
        await bridge._follow_reported_anchor("chan-1", "agent-a", "idle", None, None)
        await _anchor(bridge, "$m2")

    assert _drain(bridge, go()) == []


# ── Outbound: the agent's own messages ──────────────────────────────────────


def test_indicator_follows_a_message_the_agent_posts() -> None:
    # No ambiguity here — the agent demonstrably acted, so core may move it.
    bridge = _bridge(["agent-a"])

    moved = _drain(bridge, bridge._move_indicator_for_sender("chan-1", "agent-a", None))

    assert moved == [("chan-1", "agent-a")]


def test_another_agents_message_does_not_move_this_indicator() -> None:
    bridge = _bridge(["agent-a"])

    moved = _drain(bridge, bridge._move_indicator_for_sender("chan-1", "agent-b", None))

    assert moved == []


def test_nothing_moves_when_no_indicator_is_live() -> None:
    bridge = _bridge([])

    moved = _drain(bridge, bridge._move_indicator_for_sender("chan-1", "agent-a", None))

    assert moved == []


def test_a_burst_of_agent_posts_costs_a_single_move() -> None:
    bridge = _bridge(["agent-a"])
    scheduled: list[Any] = []

    async def burst() -> None:
        for _ in range(20):
            await bridge._move_indicator_for_sender("chan-1", "agent-a", None)
            scheduled.append(bridge._indicator_move_timers[("chan-1", "agent-a")])

    moved = _drain(bridge, burst())

    assert all(timer is scheduled[0] for timer in scheduled)
    assert moved == [("chan-1", "agent-a")]


def test_a_platform_failure_during_a_move_does_not_escape() -> None:
    # The indicator is cosmetic; a failed move must not propagate into the
    # bridge callback that happened to trigger it.
    bridge = _bridge(["agent-a"])

    async def boom(
        _channel_id: str, _agent_name: str, _thread_root_id: str | None
    ) -> None:
        raise RuntimeError("platform down")

    bridge._adapter.reposition_runtime_state = boom

    asyncio.run(bridge._run_indicator_move(("chan-1", "agent-a")))
