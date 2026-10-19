"""A Mattermost bridge that stops closes its bots' sockets for good.

Each agent bot's socket runs in a thread of its own that reconnects whenever
the connection drops. A stopped bridge used to leave those threads running for
the life of the process, so a bridge handed to another process kept sockets
here that Mattermost went on handing every post to.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from typing import Any

from switch_core.bridges.collaboration.mattermost.adapter import MattermostAdapter
from tests.switch_core.bridges.collaboration.test_bridge_agent_display_names import (
    _agent,
    _bridge,
    _mattermost_identity_adapter,
    _run,
)


class _Bot:
    """A bot driver whose socket stays open until it is disconnected."""

    def __init__(self) -> None:
        self.websocket: object | None = None
        self.connects = 0
        self.disconnected = threading.Event()

    def login(self) -> None:
        return None

    async def init_websocket(self, handler: Any) -> None:
        self.websocket = object()
        self.connects += 1
        while not self.disconnected.is_set():
            await asyncio.sleep(0.01)

    def disconnect(self) -> None:
        self.disconnected.set()


def _adapter() -> tuple[MattermostAdapter, _Bot]:
    bridge = _bridge(_agent("switchdev", "Switch Dev"))
    adapter, _ = _mattermost_identity_adapter(bridge, [], "full_name")
    bot = _Bot()
    adapter._create_driver = lambda **_kwargs: bot  # type: ignore[assignment,method-assign,return-value]
    return adapter, bot


def _socket_thread(agent_name: str, before: set[threading.Thread]) -> threading.Thread:
    """The socket thread opened for `agent_name` since `before`: other tests'
    fakes leave threads of the same name parked for good."""
    return next(
        thread
        for thread in threading.enumerate()
        if thread.name == f"mm-ws-{agent_name}" and thread not in before
    )


async def _until(check: Callable[[], bool]) -> None:
    async with asyncio.timeout(5):
        while not check():
            await asyncio.sleep(0.01)


def _closed_by(close: Callable[[MattermostAdapter], Any]) -> tuple[_Bot, bool]:
    """Open the agent's socket, close it the way `close` does, and say
    whether its thread has finished."""
    adapter, bot = _adapter()

    async def go() -> bool:
        adapter._main_loop = asyncio.get_running_loop()
        before = set(threading.enumerate())
        await adapter.create_agent_identity("switchdev", "a Switch agent")
        thread = _socket_thread("switchdev", before)
        await _until(lambda: bot.connects == 1)

        await close(adapter)
        await asyncio.to_thread(thread.join, 5)
        return thread.is_alive()

    alive = _run(go())
    return bot, alive


def test_stopping_the_adapter_closes_each_socket_for_good() -> None:
    bot, alive = _closed_by(lambda adapter: adapter.stop())

    assert bot.disconnected.is_set()
    assert not alive
    assert bot.connects == 1


def test_removing_an_agent_closes_its_socket_for_good() -> None:
    bot, alive = _closed_by(lambda adapter: adapter.remove_agent_identity("switchdev"))

    assert bot.disconnected.is_set()
    assert not alive
    assert bot.connects == 1
