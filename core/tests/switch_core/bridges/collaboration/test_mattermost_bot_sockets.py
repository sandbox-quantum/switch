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

from websockets.asyncio.client import ClientConnection, connect
from websockets.asyncio.server import ServerConnection, serve

from switch_core.bridges.collaboration.adapter import AgentIdentity
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    _BotSocketConnection,
    _close_loop,
)
from tests.switch_core.bridges.collaboration.test_bridge_agent_display_names import (
    _agent,
    _bridge,
    _mattermost_identity_adapter,
    _run,
)

_SWITCHDEV = AgentIdentity(
    agent_id="agent-1",
    name="switchdev",
    description="a Switch agent",
    display_name=None,
)


class _Bot:
    """A bot driver whose socket stays open until it is disconnected."""

    def __init__(self) -> None:
        self.websocket: object | None = None
        self.connects = 0
        self.disconnected = threading.Event()

    def login(self) -> None:
        return None

    def init_websocket(self, handler: Any) -> asyncio.AbstractEventLoop:
        """As `mattermostdriver.Driver.init_websocket`: synchronous, running
        the thread's current event loop until the socket closes."""
        self.websocket = object()
        loop = asyncio.get_event_loop()
        loop.run_until_complete(self._connect(handler))
        return loop

    async def _connect(self, handler: Any) -> None:
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
        await adapter.create_agent_identity(_SWITCHDEV)
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
    bot, alive = _closed_by(lambda adapter: adapter.remove_agent_identity(_SWITCHDEV))

    assert bot.disconnected.is_set()
    assert not alive
    assert bot.connects == 1


class _BotWithKeepalive(_Bot):
    """A bot driver whose socket, like the `websockets` connection under
    `mattermostdriver`, runs a keepalive task beside it that outlives the
    socket's own coroutine unless something cancels it."""

    def __init__(self) -> None:
        super().__init__()
        self.keepalive: asyncio.Task[None] | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    async def _connect(self, handler: Any) -> None:
        self.loop = asyncio.get_running_loop()
        self.keepalive = asyncio.create_task(asyncio.sleep(3600))
        await super()._connect(handler)


def test_a_closed_socket_leaves_no_task_pending_on_its_loop() -> None:
    """A loop dropped with a task still pending on it is reported by asyncio
    as `Task was destroyed but it is pending!` whenever the loop is collected,
    an error logged in the middle of whatever the server is doing then."""
    bridge = _bridge(_agent("switchdev", "Switch Dev"))
    adapter, _ = _mattermost_identity_adapter(bridge, [], "full_name")
    bot = _BotWithKeepalive()
    adapter._create_driver = lambda **_kwargs: bot  # type: ignore[assignment,method-assign,return-value]

    async def go() -> None:
        adapter._main_loop = asyncio.get_running_loop()
        before = set(threading.enumerate())
        await adapter.create_agent_identity(_SWITCHDEV)
        thread = _socket_thread("switchdev", before)
        await _until(lambda: bot.connects == 1)
        await adapter.remove_agent_identity(_SWITCHDEV)
        await asyncio.to_thread(thread.join, 5)
        assert not thread.is_alive()

    _run(go())

    assert bot.keepalive is not None and bot.keepalive.cancelled()
    assert bot.loop is not None and bot.loop.is_closed()


def test_closing_a_socket_loop_closes_the_connection_left_open_on_it() -> None:
    """mattermostdriver keeps its connection in a local variable and leaves it
    open when the socket stops, so the loop's closing has to close it, or its
    file descriptor lasts until the garbage collector finds it."""
    server_saw_close = threading.Event()
    listening = threading.Event()
    port: list[int] = []
    stop_server = threading.Event()

    def serve_forever() -> None:
        async def handler(connection: ServerConnection) -> None:
            await connection.wait_closed()
            server_saw_close.set()

        async def main() -> None:
            async with serve(handler, "127.0.0.1", 0) as server:
                port.append(next(iter(server.sockets)).getsockname()[1])
                listening.set()
                await asyncio.to_thread(stop_server.wait, 10)

        asyncio.run(main())

    server_thread = threading.Thread(target=serve_forever, daemon=True)
    server_thread.start()
    assert listening.wait(5)

    opened: list[ClientConnection] = []

    def socket_thread() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def open_and_return() -> None:
            opened.append(
                await connect(
                    f"ws://127.0.0.1:{port[0]}",
                    create_connection=_BotSocketConnection,
                    close_timeout=2,
                )
            )

        loop.run_until_complete(open_and_return())
        _close_loop(loop)

    thread = threading.Thread(target=socket_thread)
    thread.start()
    thread.join(10)
    stop_server.set()

    assert opened and opened[0].transport.is_closing()
    assert server_saw_close.wait(5)
