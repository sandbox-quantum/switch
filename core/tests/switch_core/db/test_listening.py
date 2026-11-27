"""A held listening connection is known lost when it ends, and the reconnect
backoff starts again once a connection is made."""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import text

from switch_core import signals as signals_module
from switch_core.db.engine import create_engine_from_config, create_unpooled_engine
from switch_core.db.listening import (
    ListeningConnectionLost,
    ReconnectBackoff,
    hold_open,
)
from switch_core.messages.notify import MessageListener
from switch_core.signals import SignalBus
from tests.switch_core.db.test_dead_peer_detection import _config_for

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

NAME = "listening-test-0a1b2c3d"


def test_the_backoff_doubles_over_failures_in_a_row_up_to_its_cap() -> None:
    backoff = ReconnectBackoff(base=1.0, cap=5.0)

    assert [backoff.next_delay() for _ in range(5)] == [1.0, 2.0, 4.0, 5.0, 5.0]


def test_the_backoff_starts_again_after_a_connection_was_made() -> None:
    backoff = ReconnectBackoff(base=1.0, cap=15.0)
    for _ in range(4):
        backoff.next_delay()
        backoff.connected()

    assert backoff.next_delay() == 1.0


async def _end_backends(postgres_url: str, role: str) -> int:
    killer = create_engine_from_config(
        _config_for(postgres_url), "listening-test killer"
    )
    try:
        async with killer.connect() as connection:
            ended = await connection.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE application_name = :name"
                ),
                {"name": f"{NAME} {role}"},
            )
            return len(ended.all())
    finally:
        await killer.dispose()


async def _cleared_within(event: asyncio.Event, seconds: float) -> float | None:
    started = time.monotonic()
    while time.monotonic() - started < seconds:
        if not event.is_set():
            return time.monotonic() - started
        await asyncio.sleep(0.01)
    return None


async def test_the_signal_bus_knows_at_once_when_its_connection_is_ended(
    postgres_url: str,
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A backoff long enough that the bus is still between connections when
    # the check runs, and a heartbeat that would never notice in time.
    monkeypatch.setattr(signals_module, "RECONNECT_BACKOFF_BASE", 30.0)
    config = _config_for(postgres_url)
    bus = SignalBus(
        session_factory,
        lambda: create_unpooled_engine(config, f"{NAME} signals"),
        process_id=NAME,
    )
    await bus.start()
    try:
        await asyncio.wait_for(bus.connected.wait(), 10)
        listens = bus.listens

        assert await _end_backends(postgres_url, "signals") == 1

        assert await _cleared_within(bus.connected, 2.0) is not None
        assert bus.listens == listens
    finally:
        await bus.stop()


async def test_the_message_listener_knows_at_once_and_wakes_every_room_on_reconnect(
    postgres_url: str,
) -> None:
    config = _config_for(postgres_url)
    listener = MessageListener(
        lambda: create_unpooled_engine(config, f"{NAME} messages")
    )
    woken: list[str] = []

    async def wake(room_id: str) -> None:
        woken.append(room_id)

    listener.subscribe("!room:test", wake)
    await listener.start()
    try:
        await asyncio.wait_for(listener.connected.wait(), 10)
        woken.clear()

        assert await _end_backends(postgres_url, "messages") == 1
        assert await _cleared_within(listener.connected, 2.0) is not None

        # Back after the first backoff, not the heartbeat.
        await asyncio.wait_for(listener.connected.wait(), 5)
        for _ in range(100):
            if woken:
                break
            await asyncio.sleep(0.02)
        assert woken == ["!room:test"]
    finally:
        await listener.stop()


async def test_a_connection_that_ended_before_it_was_held_is_noticed_at_once(
    postgres_url: str,
) -> None:
    """As a cut during the signal bus's resync is: asyncpg has already called
    its termination listeners, so none is called for `hold_open`'s."""
    engine = create_unpooled_engine(_config_for(postgres_url), f"{NAME} held")
    try:
        async with engine.connect() as connection:
            driver = (await connection.get_raw_connection()).driver_connection
            assert await _end_backends(postgres_url, "held") == 1
            for _ in range(200):
                if driver.is_closed():
                    break
                await asyncio.sleep(0.01)
            started = time.monotonic()

            with pytest.raises(ListeningConnectionLost):
                await hold_open(
                    driver,
                    heartbeat_seconds=20.0,
                    heartbeat_timeout_seconds=60.0,
                    running=lambda: True,
                    after_beat=None,
                )

            assert time.monotonic() - started < 1.0
    finally:
        await engine.dispose()
