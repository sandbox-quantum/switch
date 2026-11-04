"""What the agent event listener does with a notification: ring the agent's
doorbell with the new event's number, which the controller stream takes as
the agent's head instead of reading it."""

from __future__ import annotations

from switch_core.bridges.agent.protocol.agent_event_listener import (
    AgentEventListener,
)


class _Doorbells:
    def __init__(self) -> None:
        self.rung: list[tuple[str, int | None]] = []

    def ring(self, agent_id: str, seq: int | None = None) -> None:
        self.rung.append((agent_id, seq))


def _heard(payload: str) -> list[tuple[str, int | None]]:
    doorbells = _Doorbells()
    listener = AgentEventListener(lambda: None, doorbells)  # type: ignore[arg-type,return-value]
    listener._on_notify(None, 0, "switch_agent_event", payload)
    return doorbells.rung


def test_a_notification_rings_with_the_events_number() -> None:
    assert _heard('{"agent_id": "a1", "seq": 42}') == [("a1", 42)]


def test_a_notification_without_a_usable_number_rings_without_one() -> None:
    """The stream then reads the agent's head, as it did before notifications
    carried it."""
    assert _heard('{"agent_id": "a1"}') == [("a1", None)]
    assert _heard('{"agent_id": "a1", "seq": "42"}') == [("a1", None)]
    assert _heard('{"agent_id": "a1", "seq": true}') == [("a1", None)]


def test_an_unreadable_notification_rings_nothing() -> None:
    assert _heard("not json") == []
    assert _heard('["a1", 42]') == []
