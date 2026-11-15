"""The fake controller's socket calls. No server."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import controllers  # noqa: E402
from agents import Stats  # noqa: E402
from controllers import FakeController  # noqa: E402
from seed import RequestIds  # noqa: E402


class _Socket:
    """Takes every frame and never answers one."""

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, frame: str) -> None:
        self.sent.append(frame)


def test_a_call_the_server_never_answers_fails_after_the_timeout(monkeypatch):
    monkeypatch.setattr(controllers, "CALL_TIMEOUT_S", 0.05)
    c = FakeController(
        0, "c1", "load-c1", "cred", "http://core", None, RequestIds("t"), Stats()
    )
    c._ws, c.takes_calls = _Socket(), True

    async def call():
        return await c.call("a1", "send_message", {"content": "hi"}, "r1")

    with pytest.raises(ConnectionError, match="no answer in 0.05s"):
        asyncio.run(call())
    assert len(c._ws.sent) == 1 and c._answers == {}
