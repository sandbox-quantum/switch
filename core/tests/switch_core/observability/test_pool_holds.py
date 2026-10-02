"""Who holds a pooled connection, for how long, and how long others wait.

The pool peak says the pool filled. These say which code was holding it and
what that cost everyone queued behind it, which is what a pool timeout during
a reconnect storm needs before anyone can fix it.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import QueuePool
from sqlalchemy.util import greenlet_spawn

from switch_core.observability import pool as pool_module
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from switch_core.observability.pool import (
    UNKNOWN_CALLER,
    WaitTimedQueuePool,
    _Hold,
    _LongHoldLog,
    describe_borrower,
    install_hold_timer,
)

# Code compiled under a switch_core path, so the borrower lookup takes it for
# ours: the test module itself is deliberately not counted as a caller.
_FAKE_FILE = "/srv/switch/core/switch_core/rooms/fake_borrower.py"


@pytest.fixture
def registry() -> Iterator[MetricsRegistry]:
    registry = MetricsRegistry()
    install(registry)
    yield registry
    uninstall()


def _histograms(registry: MetricsRegistry, name: str) -> dict[tuple, tuple[int, float]]:
    payload = next((p for p in registry.collect() if p.name == name), None)
    if payload is None:
        return {}
    return {
        tuple(sorted(point.attributes.items())): (point.count, point.total)
        for point in payload.histograms
    }


def _ours(source: str) -> dict[str, object]:
    namespace: dict[str, object] = {
        "describe_borrower": describe_borrower,
        "greenlet_spawn": greenlet_spawn,
    }
    exec(compile(source, _FAKE_FILE, "exec"), namespace)
    return namespace


class TestTheBorrower:
    def test_names_the_innermost_switch_core_function(self) -> None:
        borrow = _ours("def borrow():\n    return describe_borrower()\n")["borrow"]

        caller, stack = borrow()  # type: ignore[operator]

        assert caller == "switch_core.rooms.fake_borrower:borrow"
        assert stack[0].startswith("switch_core.rooms.fake_borrower:borrow:")

    async def test_finds_the_coroutine_behind_sqlalchemys_greenlet(self) -> None:
        """An async checkout runs in a greenlet whose own stack starts at the
        greenlet. The coroutine that awaited it is only reachable through the
        parent, and it is the one worth naming."""
        fetch = _ours(
            "async def fetch_members():\n"
            "    return await greenlet_spawn(describe_borrower)\n"
        )["fetch_members"]

        caller, _ = await fetch()  # type: ignore[operator]

        assert caller == "switch_core.rooms.fake_borrower:fetch_members"

    def test_code_outside_switch_core_is_unknown(self) -> None:
        assert describe_borrower() == (UNKNOWN_CALLER, ())


class TestHoldTime:
    def test_every_checkout_is_timed_by_its_caller(self, registry) -> None:
        engine = create_engine("sqlite://", poolclass=QueuePool)
        install_hold_timer(SimpleNamespace(sync_engine=engine))  # type: ignore[arg-type]

        with engine.connect() as conn:
            conn.execute(text("select 1"))

        holds = _histograms(registry, "switch.db.pool.hold.duration")
        assert list(holds) == [(("caller", UNKNOWN_CALLER),)]
        count, total = holds[(("caller", UNKNOWN_CALLER),)]
        assert count == 1
        assert total >= 0.0

    def test_a_long_hold_is_logged_with_its_stack(
        self, registry, caplog, monkeypatch
    ) -> None:
        monkeypatch.setattr(pool_module, "LONG_HOLD_SECONDS", 0.0)
        engine = create_engine("sqlite://", poolclass=QueuePool)
        install_hold_timer(SimpleNamespace(sync_engine=engine))  # type: ignore[arg-type]

        with caplog.at_level(logging.WARNING, logger=pool_module.__name__):
            with engine.connect():
                pass

        assert "A database connection was held for" in caplog.text


class TestTheLongHoldLog:
    def test_one_warning_per_caller_per_window(self, caplog, monkeypatch) -> None:
        clock = iter([100.0, 110.0, 200.0])
        monkeypatch.setattr(pool_module.time, "monotonic", lambda: next(clock))
        log = _LongHoldLog()
        hold = _Hold(started=0.0, caller="switch_core.rooms:slow", stack=())

        with caplog.at_level(logging.WARNING, logger=pool_module.__name__):
            log.report(hold, 2.0)
            log.report(hold, 3.0)  # inside the window: counted, not logged
            log.report(hold, 4.0)  # after it: logged, with the one it held back

        warnings = [r.getMessage() for r in caplog.records]
        assert len(warnings) == 2
        assert "(0 more long holds" in warnings[0]
        assert "(1 more long holds" in warnings[1]


class TestWaitTime:
    async def test_every_request_for_a_connection_is_timed(self, registry) -> None:
        engine = create_async_engine(
            "postgresql+asyncpg://u:p@localhost/db", poolclass=WaitTimedQueuePool
        )
        pool = engine.pool

        def get_and_return() -> None:
            # The pool's own handover, without a server to connect to: a
            # placeholder entry the queue hands straight back.
            pool._pool.put(object())  # type: ignore[attr-defined]
            pool._do_get()  # type: ignore[attr-defined]

        await greenlet_spawn(get_and_return)

        waits = _histograms(registry, "switch.db.pool.wait.duration")
        assert waits[()][0] == 1
        await engine.dispose()

    def test_the_class_survives_a_rebuild(self) -> None:
        engine = create_async_engine(
            "postgresql+asyncpg://u:p@localhost/db", poolclass=WaitTimedQueuePool
        )

        assert isinstance(engine.pool.recreate(), WaitTimedQueuePool)
