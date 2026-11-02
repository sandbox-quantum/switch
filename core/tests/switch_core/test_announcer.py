"""The process's announcements, sent after their commits in batches.

Against real PostgreSQL, with a `LISTEN` standing in for the other processes:
what matters is what they hear, in what order, and how many transactions it
took to send it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core import announcer as announcer_module
from switch_core.announcer import Announcer
from tests.session_counting import CountingSessionFactory
from tests.switch_core.test_signals import _FailingOnce, _RefusingSession

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

CHANNELS = ("switch_message", "switch_agent_event")
_SENTINEL = "heard-everything"


@contextlib.asynccontextmanager
async def heard(
    postgres_url: str, channels: tuple[str, ...] = CHANNELS
) -> AsyncIterator[list[tuple[str, str]]]:
    """What was announced on `channels` while the block ran, in the order it
    arrived. A sentinel goes out on each channel after the block, and
    announcements arrive in commit order, so once every sentinel is heard,
    everything committed before them has been heard too."""
    engine = create_async_engine(postgres_url, poolclass=NullPool)
    announcements: list[tuple[str, str]] = []
    waiting = set(channels)
    done = asyncio.Event()

    def on_notify(_conn: Any, _pid: int, channel: str, payload: str) -> None:
        if payload == _SENTINEL:
            waiting.discard(channel)
            if not waiting:
                done.set()
        else:
            announcements.append((channel, payload))

    try:
        async with engine.connect() as connection:
            raw = await connection.get_raw_connection()
            driver = raw.driver_connection
            assert driver is not None
            for channel in channels:
                await driver.add_listener(channel, on_notify)
            yield announcements
            for channel in channels:
                await driver.execute(f"NOTIFY {channel}, '{_SENTINEL}'")
            await asyncio.wait_for(done.wait(), 10)
    finally:
        await engine.dispose()


class TestSending:
    async def test_announcements_arrive_on_their_channels_in_order(
        self, postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        announcer = Announcer(session_factory)
        sent = [
            (channel, json.dumps({"n": n})) for n in range(3) for channel in CHANNELS
        ]

        async with heard(postgres_url) as announcements:
            await announcer.start()
            for channel, payload in sent:
                announcer.announce(channel, payload)
            await announcer.stop()

        assert announcements == sent

    async def test_what_is_handed_over_together_goes_in_one_transaction(
        self, postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The lock a notifying commit takes is taken once per transaction,
        so a hundred announcements cost the database one."""
        counting = CountingSessionFactory(session_factory)
        announcer = Announcer(counting)  # type: ignore[arg-type]
        for n in range(100):
            announcer.announce("switch_message", json.dumps({"n": n}))

        async with heard(postgres_url) as announcements:
            await announcer.start()
            await announcer.stop()

        assert len(announcements) == 100
        assert counting.opened == 1

    def test_an_oversized_announcement_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        with pytest.raises(ValueError, match="too large"):
            Announcer(session_factory).announce("switch_message", "x" * 8000)


class TestNothingIsLost:
    async def test_a_batch_that_fails_is_sent_again_ahead_of_what_came_after(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(announcer_module, "RETRY_SECONDS", 0.05)
        announcer = Announcer(_FailingOnce(session_factory))  # type: ignore[arg-type]

        async with heard(postgres_url) as announcements:
            await announcer.start()
            announcer.announce("switch_message", "first")
            await asyncio.sleep(0.01)
            announcer.announce("switch_message", "second")
            await announcer.stop()

        assert [payload for _, payload in announcements] == ["first", "second"]
        assert announcer.unsent == 0

    def test_announcements_waiting_are_bounded_while_the_sender_keeps_up(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Not only while the database refuses: announcements handed over
        faster than they go out drop the oldest, and the newest stay."""
        monkeypatch.setattr(announcer_module, "MAX_UNSENT", 10)
        announcer = Announcer(session_factory)

        for n in range(25):
            announcer.announce("switch_message", str(n))

        assert announcer.unsent <= 10
        assert announcer._outbox[-1] == ("switch_message", "24")
        assert ("switch_message", "0") not in announcer._outbox

    async def test_stopping_waits_a_while_then_gives_up_on_a_refusing_database(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(announcer_module, "RETRY_SECONDS", 0.02)
        monkeypatch.setattr(announcer_module, "FLUSH_SECONDS", 0.1)
        announcer = Announcer(lambda: _RefusingSession())  # type: ignore[arg-type,return-value]

        await announcer.start()
        announcer.announce("switch_message", "never sent")
        await announcer.stop()

        assert announcer.unsent == 1
