from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from switch_core import signals
from switch_core.bridges.agent.protocol import agent_event_listener
from switch_core.messages import notify
from switch_core.session_activity import listener as session_activity


@pytest.mark.parametrize(
    "kind",
    ("messages", "agent_events", "session_activity", "signals"),
)
async def test_listener_keeps_retrying_after_an_extended_outage(
    monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    def unavailable() -> None:
        raise OSError("database unavailable")

    connect = Mock(side_effect=unavailable)
    if kind == "messages":
        module, listener = notify, notify.MessageListener(connect)
    elif kind == "agent_events":
        module = agent_event_listener
        listener = agent_event_listener.AgentEventListener(connect, Mock())
    elif kind == "session_activity":
        module = session_activity
        listener = session_activity.AgentSessionActivityListener(connect)
    else:
        module, listener = signals, signals.SignalBus(Mock(), connect, "process")

    delays: list[float] = []
    failures = 1100

    async def sleep(delay: float) -> None:
        delays.append(delay)
        if len(delays) == failures:
            listener._running = False

    monkeypatch.setattr(
        module,
        "asyncio",
        SimpleNamespace(sleep=sleep, CancelledError=asyncio.CancelledError),
    )
    monkeypatch.setattr(module.logger, "error", Mock())
    listener._running = True
    await listener._listen_forever()

    assert connect.call_count == failures
    assert delays[:5] == [1.0, 2.0, 4.0, 8.0, 15.0]
    assert delays[5:] == [15.0] * (failures - 5)
