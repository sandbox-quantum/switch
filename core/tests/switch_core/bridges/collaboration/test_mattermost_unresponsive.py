"""A Mattermost that accepts connections and never answers.

The driver is blocking and, by default, waits for ever. Called on the event
loop, one such request froze all of Switch: every agent connection lapsed,
every bridge stopped and /health stopped answering, for as long as Mattermost
stayed silent. Requests now give up after a timeout, and run off the loop.
"""

from __future__ import annotations

import asyncio
import socket
import threading
import time
from collections.abc import Iterator

import pytest

from switch_core.bridges.collaboration.mattermost import adapter as adapter_module
from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


@pytest.fixture
def silent_server() -> Iterator[int]:
    """A TCP server that accepts every connection and never sends a byte."""
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen()
    held: list[socket.socket] = []
    stop = threading.Event()

    def accept() -> None:
        server.settimeout(0.1)
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except TimeoutError:
                continue
            held.append(conn)

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    yield server.getsockname()[1]
    stop.set()
    thread.join()
    for conn in held:
        conn.close()
    server.close()


@pytest.fixture
def adapter(silent_server: int, monkeypatch: pytest.MonkeyPatch) -> MattermostAdapter:
    monkeypatch.setattr(adapter_module, "_MM_REQUEST_TIMEOUT_SECONDS", 0.5)
    mm = MattermostAdapter(
        config=MattermostConnectionConfig(
            url=f"http://127.0.0.1:{silent_server}",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    mm._admin_driver = mm._create_driver(token="placeholder")
    return mm


async def test_a_request_mattermost_never_answers_gives_up(
    adapter: MattermostAdapter,
) -> None:
    started = time.monotonic()

    with pytest.raises(Exception):  # noqa: B017, the driver's own timeout error
        await adapter._mm_api("get", "/config")

    assert time.monotonic() - started < 5


async def test_the_event_loop_keeps_running_while_mattermost_is_silent(
    adapter: MattermostAdapter,
) -> None:
    request = asyncio.ensure_future(adapter._mm_api("get", "/config"))
    gaps: list[float] = []
    last = time.monotonic()
    while not request.done():
        await asyncio.sleep(0.02)
        now = time.monotonic()
        gaps.append(now - last)
        last = now

    with pytest.raises(Exception):  # noqa: B017
        request.result()
    assert len(gaps) > 5
    assert max(gaps) < 0.25
