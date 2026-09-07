"""Agent identity provisioning must not hold up the bridge coming online.

Provisioning is one platform call per agent, and a rate-limited platform turns
that into minutes of mostly waiting. Awaiting it inside start() would delay the
bridge, every other bridge queued behind it, and any request that restarts one.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from switch_core.bridges.collaboration.bridge_core import BridgeCore


class _FakeAdapter:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False

    def set_channel_migration_handler(self, handler: Any) -> None:
        pass

    def set_agent_presentation_resolver(self, resolver: Any) -> None:
        pass

    async def start(self, **kwargs: Any) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


def _core(provision: Any) -> tuple[BridgeCore, _FakeAdapter]:
    """A BridgeCore with everything start() touches stubbed but the task logic."""
    core = object.__new__(BridgeCore)
    adapter = _FakeAdapter()
    core._bridge_type = "slack"  # type: ignore[attr-defined]
    core._adapter = adapter  # type: ignore[attr-defined]
    core._identity_task = None  # type: ignore[attr-defined]

    async def _noop() -> None:
        return None

    core._load_channel_map = _noop  # type: ignore[assignment]
    core._load_existing_puppets = _noop  # type: ignore[assignment]
    core._ensure_channel_captures = _noop  # type: ignore[assignment]
    core._handle_channel_migrated = None  # type: ignore[attr-defined]
    core._agent_presentation = None  # type: ignore[attr-defined]
    core._handle_inbound_message = None  # type: ignore[attr-defined]
    core._handle_inbound_command = None  # type: ignore[attr-defined]
    core._handle_agent_joined_channel = None  # type: ignore[attr-defined]
    core._handle_user_joined_channel = None  # type: ignore[attr-defined]
    core._handle_app_joined_channel = None  # type: ignore[attr-defined]
    core._create_agent_identities = provision  # type: ignore[assignment]
    return core, adapter


async def test_start_returns_without_waiting_for_provisioning() -> None:
    finished = False

    async def _slow_provision() -> None:
        nonlocal finished
        await asyncio.sleep(30)
        finished = True

    core, adapter = _core(_slow_provision)

    await asyncio.wait_for(core.start(), timeout=1)

    assert adapter.started
    assert not finished
    assert core._identity_task is not None
    await core.stop()


async def test_provisioning_still_runs_after_start_returns() -> None:
    done = asyncio.Event()

    async def _provision() -> None:
        done.set()

    core, _ = _core(_provision)

    await core.start()
    await asyncio.wait_for(done.wait(), timeout=1)

    await core.stop()


async def test_stop_cancels_provisioning_in_flight() -> None:
    """A bridge being torn down must not leave work running against the
    platform on its behalf."""
    started = asyncio.Event()

    async def _slow_provision() -> None:
        started.set()
        await asyncio.sleep(30)

    core, _ = _core(_slow_provision)

    await core.start()
    task = core._identity_task
    await asyncio.wait_for(started.wait(), timeout=1)
    await core.stop()

    assert task is not None
    await asyncio.sleep(0)
    assert task.cancelled() or task.done()
    assert core._identity_task is None


async def test_a_failure_is_logged_rather_than_swallowed(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """create_task discards whatever the coroutine raises, so anything escaping
    the per-agent handling would otherwise vanish without trace."""

    async def _explode() -> None:
        raise RuntimeError("provisioning blew up")

    core, _ = _core(_explode)

    with caplog.at_level("ERROR"):
        await core.start()
        task = core._identity_task
        assert task is not None
        await task

    assert any("stopped unexpectedly" in r.getMessage() for r in caplog.records)
    await core.stop()
