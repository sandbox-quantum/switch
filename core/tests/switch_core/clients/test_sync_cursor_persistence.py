"""Cursor writes must not stampede the connection pool.

Every Matrix client in the process persists its `next_batch` cursor, and both
the sync long-poll and the write throttle were 30s. All clients start when the
process does, so hundreds of them crossed the threshold in the same instant and
each opened its own transaction for a one-row update — enough to exhaust the
pool on an otherwise idle instance.

Two properties fix that and are asserted here: an idle sync does not earn a
write at all, and the clients that do write are spread out rather than aligned.

Whether a given batch counted as idle is the transport's judgement, not this
one's — it is the only thing that can see what the batch held, and it says so
as the `durable` flag these tests pass in. What that flag is derived from is
covered in `tests/switch_core/transport/test_sync_durability.py`.
"""

from __future__ import annotations

import time

import pytest

from switch_core.clients.client_base import (
    SYNC_STATE_INTERVAL,
    SYNC_STATE_JITTER,
    SYNC_STATE_MAX_STALENESS,
    ClientBase,
)
from tests.switch_core.transport.fake import FakeMessageRecorder

ROOM = "!room:switch.local"


class _Session:
    async def __aenter__(self) -> _Session:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def commit(self) -> None:
        return None


class _Store:
    """Records what the real `_persist_state` would have written."""

    def __init__(self) -> None:
        self.writes: list[str | None] = []

    async def update_state(
        self,
        session: object,
        client_id: str,
        *,
        next_batch_token: str | None,
    ) -> None:
        self.writes.append(next_batch_token)


class _Client(ClientBase):
    """A real client with the database swapped out.

    `_persist_state` itself is deliberately not overridden — the throttle it
    applies is half of what these tests are about.
    """

    def __init__(self) -> None:
        super().__init__(
            client_id="c1",
            matrix_user_id="@switch-agent-1:switch.local",
            display_name="agent-1",
            password="",
            server_url="http://matrix.invalid",
            session_factory=_Session,  # type: ignore[arg-type]
            client_store=_Store(),  # type: ignore[arg-type]
            config=ClientBase.config_class(),
            transport_factory=lambda client: object(),  # type: ignore[arg-type,return-value]
            session_state={},
            message_recorder=FakeMessageRecorder(),
            next_batch_token="s0",
        )
        # Pin the jittered interval so the throttle assertions are deterministic.
        self._sync_persist_interval = SYNC_STATE_INTERVAL

    @property
    def writes(self) -> list[str | None]:
        store: _Store = self.client_store  # type: ignore[assignment]
        return store.writes


@pytest.mark.asyncio
async def test_idle_sync_advances_the_cursor_without_writing() -> None:
    """The overnight case: nothing happened, so nothing is worth persisting.

    Resuming from the older cursor replays the same nothing, so the write buys
    us no safety — and it was the whole burst.
    """
    client = _Client()
    client._last_sync_persist = time.monotonic() - 10 * SYNC_STATE_INTERVAL

    for i in range(1, 6):
        await client._handle_sync(f"s{i}", False)

    assert client.writes == []
    # The cursor still moved, so the next sync does not refetch.
    assert client.next_batch_token == "s5"
    assert client._sync_state_dirty is True


@pytest.mark.asyncio
async def test_a_batch_the_transport_called_idle_does_not_earn_a_write() -> None:
    """Typing notices and read receipts advance the token and mean nothing."""
    client = _Client()
    client._last_sync_persist = time.monotonic() - 10 * SYNC_STATE_INTERVAL

    await client._handle_sync("s1", False)

    assert client.writes == []
    assert client.next_batch_token == "s1"


@pytest.mark.asyncio
async def test_durable_events_are_persisted() -> None:
    """Anything a restart would replay to a handler must move the cursor."""
    client = _Client()
    client._last_sync_persist = time.monotonic() - 10 * SYNC_STATE_INTERVAL

    await client._handle_sync("s1", True)

    assert client.writes == ["s1"]


@pytest.mark.asyncio
async def test_a_stale_cursor_is_flushed_even_while_idle() -> None:
    """Skipping idle writes must not let the token fall arbitrarily behind."""
    client = _Client()
    client._last_sync_persist = time.monotonic() - (SYNC_STATE_MAX_STALENESS - 1)

    await client._handle_sync("s1", False)
    assert client.writes == []

    client._last_sync_persist = time.monotonic() - (SYNC_STATE_MAX_STALENESS + 1)
    await client._handle_sync("s2", False)

    assert client.writes == ["s2"]
    assert client._sync_state_dirty is False


@pytest.mark.asyncio
async def test_busy_clients_are_still_throttled() -> None:
    """A room under load must not write a row per message."""
    client = _Client()
    client._last_sync_persist = time.monotonic() - 10 * SYNC_STATE_INTERVAL

    await client._handle_sync("s1", True)
    await client._handle_sync("s2", True)
    await client._handle_sync("s3", True)

    assert client.writes == ["s1"]
    assert client.next_batch_token == "s3"


@pytest.mark.asyncio
async def test_an_unchanged_cursor_is_ignored() -> None:
    client = _Client()
    client._last_sync_persist = time.monotonic() - 10 * SYNC_STATE_INTERVAL

    await client._handle_sync("s0", True)

    assert client.writes == []


def _real_clients(count: int) -> list[ClientBase]:
    """Construct through `ClientBase.__init__` — the jitter is set there."""
    return [
        ClientBase(
            client_id=f"c{i}",
            matrix_user_id=f"@switch-agent-{i}:switch.local",
            display_name=f"agent-{i}",
            password="",
            server_url="http://matrix.invalid",
            session_factory=None,  # type: ignore[arg-type]
            client_store=None,  # type: ignore[arg-type]
            config=ClientBase.config_class(),
            transport_factory=lambda client: object(),  # type: ignore[arg-type,return-value]
            session_state={},
            message_recorder=FakeMessageRecorder(),
        )
        for i in range(count)
    ]


def test_clients_do_not_share_a_write_deadline() -> None:
    """The stampede is the alignment, so the intervals must differ per client."""
    clients = _real_clients(200)

    intervals = {c._sync_persist_interval for c in clients}
    assert len(intervals) > 190, "intervals are effectively identical"
    assert all(
        SYNC_STATE_INTERVAL <= i <= SYNC_STATE_INTERVAL + SYNC_STATE_JITTER
        for i in intervals
    )


def test_the_first_write_after_boot_is_spread_across_the_window() -> None:
    """Clients all start together, so seeding the clock identically would put
    their first write in the same instant too."""
    now = time.monotonic()
    elapsed = sorted(now - c._last_sync_persist for c in _real_clients(200))

    assert elapsed[0] >= 0.0
    assert elapsed[-1] <= SYNC_STATE_INTERVAL
    # Spread over the window rather than bunched at one end of it.
    assert elapsed[-1] - elapsed[0] > SYNC_STATE_INTERVAL / 2
