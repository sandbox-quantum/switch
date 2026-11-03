"""switch-core stops once, in its own order, on SIGTERM.

uvicorn handles SIGTERM and SIGINT itself while it serves, and asyncio
delivers a signal to its handlers and to switch-core's alike. Left in place,
uvicorn stopped serving at once, before switch-core had handed its work over
and drained, and re-raised the signal once serving ended, which started a
second shutdown that the process then exited under ("Task was destroyed but
it is pending").
"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import textwrap
import time

import pytest
import uvicorn

from switch_core import main as main_module
from switch_core.main import _Server, _ShutdownOnSignal


async def _app(scope: dict, receive: object, send: object) -> None:
    if scope["type"] == "lifespan":
        return


def test_the_server_leaves_signal_handling_to_switch_core() -> None:
    def ours(signum: int, frame: object) -> None:
        raise AssertionError("not called")

    previous = signal.signal(signal.SIGTERM, ours)
    try:
        server = _Server(uvicorn.Config(_app))
        with server.capture_signals():
            assert signal.getsignal(signal.SIGTERM) is ours
        assert signal.getsignal(signal.SIGTERM) is ours
    finally:
        signal.signal(signal.SIGTERM, previous)


async def test_the_first_signal_starts_the_one_shutdown_and_finish_waits_for_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started: list[str] = []
    release = asyncio.Event()

    async def shutdown() -> None:
        started.append("shutdown")
        await release.wait()

    exits: list[int] = []
    monkeypatch.setattr(main_module.os, "_exit", exits.append)
    on_signal = _ShutdownOnSignal(shutdown)

    await on_signal.finish()
    on_signal()
    finishing = asyncio.create_task(on_signal.finish())
    await asyncio.sleep(0)
    assert started == ["shutdown"]
    assert not finishing.done()

    on_signal()
    assert exits == [1]
    assert started == ["shutdown"]

    release.set()
    await finishing


_PROCESS = textwrap.dedent(
    """
    import asyncio, os, signal, sys
    import uvicorn
    from switch_core.main import _Server, _ShutdownOnSignal

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                else:
                    await send({"type": "lifespan.shutdown.complete"})
                    return

    async def run():
        server = _Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))

        async def shutdown():
            print("shutdown started", flush=True)
            await asyncio.sleep(0.3)
            server.should_exit = True
            await asyncio.sleep(0.5)
            print("shutdown finished", flush=True)
            os._exit(0)

        on_signal = _ShutdownOnSignal(shutdown)
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, on_signal)
        serving = asyncio.create_task(server.serve())
        while not server.started:
            await asyncio.sleep(0.01)
        print("serving", flush=True)
        await serving
        print("serve returned", flush=True)
        await on_signal.finish()

    asyncio.run(run())
    """
)


@pytest.mark.skipif(sys.platform == "win32", reason="no SIGTERM handlers on Windows")
def test_sigterm_runs_the_shutdown_once_and_to_its_end() -> None:
    process = subprocess.Popen(
        [sys.executable, "-c", _PROCESS],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    deadline = time.monotonic() + 20
    while process.stdout.readline().strip() != "serving":
        assert time.monotonic() < deadline, "the server did not start"
        assert process.poll() is None, process.stderr.read() if process.stderr else ""
    os.kill(process.pid, signal.SIGTERM)
    out, err = process.communicate(timeout=20)

    assert process.returncode == 0, err
    lines = out.splitlines()
    assert lines.count("shutdown started") == 1
    assert lines[-1] == "shutdown finished"
    # Serving continued until the shutdown told uvicorn to stop.
    assert lines.index("serve returned") > lines.index("shutdown started")
    assert "destroyed but it is pending" not in err
