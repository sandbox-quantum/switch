"""Signals between switch-core processes.

Against real PostgreSQL, two buses on one database standing in for two
processes: the point is that a `NOTIFY` sent by one reaches the other's
`LISTEN`, which no stand-in can show.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core import signals as signals_module
from switch_core.signals import SIGNAL_CHANNEL, SignalBus

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

DELIVERY_TIMEOUT = 10.0


class Received:
    def __init__(self) -> None:
        self.signals: list[dict[str, Any]] = []
        self._anything = asyncio.Event()

    def __call__(self, signal: dict[str, Any]) -> None:
        self.signals.append(signal)
        self._anything.set()

    async def wait(self) -> None:
        await asyncio.wait_for(self._anything.wait(), DELIVERY_TIMEOUT)
        self._anything.clear()


@pytest.fixture
def make_bus(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> Callable[[], SignalBus]:
    def _make() -> SignalBus:
        return SignalBus(
            session_factory,
            lambda: create_async_engine(postgres_url, poolclass=NullPool),
            process_id=str(uuid.uuid4()),
        )

    return _make


@pytest.fixture
async def two_buses(
    make_bus: Callable[[], SignalBus],
) -> AsyncIterator[tuple[SignalBus, SignalBus]]:
    first, second = make_bus(), make_bus()
    yield first, second
    await first.stop()
    await second.stop()


async def _start(*buses: SignalBus) -> None:
    for bus in buses:
        await bus.start()
    for bus in buses:
        await asyncio.wait_for(bus.connected.wait(), DELIVERY_TIMEOUT)


class TestBetweenProcesses:
    async def test_a_signal_reaches_the_other_process(
        self, two_buses: tuple[SignalBus, SignalBus]
    ) -> None:
        sender, receiver = two_buses
        received = Received()
        receiver.handle("thing.changed", received)
        await _start(sender, receiver)

        sender.publish("thing.changed", thing_id="t1", revision=3)
        await received.wait()

        assert received.signals == [
            {
                "kind": "thing.changed",
                "from": sender.process_id,
                "thing_id": "t1",
                "revision": 3,
            }
        ]

    async def test_the_sender_skips_its_own(
        self, two_buses: tuple[SignalBus, SignalBus]
    ) -> None:
        sender, receiver = two_buses
        own, other = Received(), Received()
        sender.handle("thing.changed", own)
        receiver.handle("thing.changed", other)
        await _start(sender, receiver)

        sender.publish("thing.changed", thing_id="t1")
        await other.wait()

        assert own.signals == []

    async def test_signals_raised_together_all_arrive(
        self, two_buses: tuple[SignalBus, SignalBus]
    ) -> None:
        sender, receiver = two_buses
        received = Received()
        receiver.handle("thing.changed", received)
        await _start(sender, receiver)

        for n in range(20):
            sender.publish("thing.changed", n=n)
        async with asyncio.timeout(DELIVERY_TIMEOUT):
            while len(received.signals) < 20:
                await received.wait()

        assert [signal["n"] for signal in received.signals] == list(range(20))

    async def test_a_kind_nobody_handles_is_ignored(
        self, two_buses: tuple[SignalBus, SignalBus]
    ) -> None:
        sender, receiver = two_buses
        received = Received()
        receiver.handle("known", received)
        await _start(sender, receiver)

        sender.publish("unknown", x=1)
        sender.publish("known", x=2)
        await received.wait()

        assert [signal["x"] for signal in received.signals] == [2]


class TestResync:
    async def test_connecting_runs_every_resync(
        self, make_bus: Callable[[], SignalBus]
    ) -> None:
        bus = make_bus()
        ran = asyncio.Event()

        async def resync() -> None:
            ran.set()

        bus.on_resync(resync)
        try:
            await bus.start()
            await asyncio.wait_for(ran.wait(), DELIVERY_TIMEOUT)
        finally:
            await bus.stop()


class TestPublishing:
    def test_an_oversized_signal_is_refused(
        self, make_bus: Callable[[], SignalBus]
    ) -> None:
        with pytest.raises(ValueError, match="too large"):
            make_bus().publish("thing.changed", blob="x" * 8000)

    def test_a_kind_has_one_handler(self, make_bus: Callable[[], SignalBus]) -> None:
        bus = make_bus()
        bus.handle("thing.changed", lambda _signal: None)
        with pytest.raises(ValueError, match="already registered"):
            bus.handle("thing.changed", lambda _signal: None)


class _FailingOnce:
    """A session factory whose first session fails on the statement, as a
    database that refuses for a moment does."""

    def __init__(self, real: async_sessionmaker[AsyncSession]) -> None:
        self._real = real
        self.failures = 1

    def __call__(self) -> Any:
        if self.failures:
            self.failures -= 1
            return _RefusingSession()
        return self._real()


class _RefusingSession:
    async def __aenter__(self) -> _RefusingSession:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    async def execute(self, *_args: object, **_kwargs: object) -> None:
        raise ConnectionError("the database refused")


class TestNothingIsLost:
    async def test_a_batch_that_fails_to_send_is_sent_again(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        make_bus: Callable[[], SignalBus],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(signals_module, "RETRY_SECONDS", 0.05)
        sender = SignalBus(
            _FailingOnce(session_factory),  # type: ignore[arg-type]
            lambda: create_async_engine(postgres_url, poolclass=NullPool),
            process_id=str(uuid.uuid4()),
        )
        receiver = make_bus()
        received = Received()
        receiver.handle("thing.changed", received)
        try:
            await _start(sender, receiver)
            sender.publish("thing.changed", n=1)
            sender.publish("thing.changed", n=2)
            async with asyncio.timeout(DELIVERY_TIMEOUT):
                while len(received.signals) < 2:
                    await received.wait()
        finally:
            await sender.stop()
            await receiver.stop()

        assert [signal["n"] for signal in received.signals] == [1, 2]
        assert sender.unsent == 0

    async def test_every_recheck_runs_periodically(
        self, make_bus: Callable[[], SignalBus], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(signals_module, "RECHECK_SECONDS", 0.02)
        bus = make_bus()
        runs: list[str] = []

        async def failing() -> None:
            runs.append("failing")
            raise RuntimeError("one family's re-check failed")

        async def working() -> None:
            runs.append("working")

        bus.on_recheck(failing)
        bus.on_recheck(working)
        try:
            await bus.start()
            async with asyncio.timeout(DELIVERY_TIMEOUT):
                while runs.count("working") < 2:
                    await asyncio.sleep(0.01)
        finally:
            await bus.stop()

        # A failing re-check does not stop the others, now or next time.
        assert runs.count("failing") >= 2

    async def test_work_that_fails_is_kept_and_tried_again(
        self, make_bus: Callable[[], SignalBus], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(signals_module, "RETRY_SECONDS", 0.02)
        bus = make_bus()
        attempts: list[str] = []
        done = asyncio.Event()

        async def reread(key: str) -> None:
            attempts.append(key)
            if len(attempts) == 1:
                raise ConnectionError("the database refused")
            done.set()

        work = bus.pending_work("things", reread)
        try:
            await bus.start()
            work.add("t1")
            work.add("t1")
            await asyncio.wait_for(done.wait(), DELIVERY_TIMEOUT)
        finally:
            await bus.stop()

        # Added twice before its turn, so one piece of work, retried once.
        assert attempts == ["t1", "t1"]
        assert work.pending == 0

    async def test_a_signal_with_no_sender_reaches_every_process(
        self,
        two_buses: tuple[SignalBus, SignalBus],
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        """What a database trigger sends: no process skips it as its own."""
        first, second = two_buses
        heard_first, heard_second = Received(), Received()
        first.handle("thing.changed", heard_first)
        second.handle("thing.changed", heard_second)
        await _start(first, second)

        async with session_factory() as session:
            await session.execute(
                text("SELECT pg_notify(:channel, :payload)"),
                {
                    "channel": SIGNAL_CHANNEL,
                    "payload": '{"kind": "thing.changed", "thing_id": "t1"}',
                },
            )
            await session.commit()
        await heard_first.wait()
        await heard_second.wait()

        assert heard_first.signals == heard_second.signals
