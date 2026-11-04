"""What a post checks first, kept on its own: the hold and the TTL come from
`HeldRows` (`test_controller_auth_cache.py` pins them); these pin what the
signals drop, and what is never kept.

Against Postgres, with the triggers and a real signal bus, in
`tests/switch_core/management/test_room_access_cache.py`.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from switch_core.bridges.agent import held_rows
from switch_core.bridges.agent.protocol.types import RoomDescriptor
from switch_core.bridges.agent.room_access_cache import RoomAccessCache
from switch_core.db.room_access_notify_ddl import (
    BUDGETS_CHANGED_SIGNAL,
    ROOM_AGENT_CHANGED_SIGNAL,
    ROOM_CHANGED_SIGNAL,
)


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr(held_rows, "time", SimpleNamespace(monotonic=fake))
    return fake


def _room(room_id: str = "r1") -> RoomDescriptor:
    return RoomDescriptor(
        id=room_id,
        name=room_id,
        description="",
        transport_room_id=f"!{room_id}",
        matrix_room_id=f"!{room_id}",
    )


class _Bus:
    """What `follow` needs of the signal bus."""

    def __init__(self) -> None:
        self.handlers: dict[str, object] = {}
        self.connected = SimpleNamespace(is_set=lambda: False)
        self.listens = 0

    def handle(self, kind: str, handler: object) -> None:
        self.handlers[kind] = handler


def test_a_membership_is_kept_for_its_tenant_until_the_ttl(clock: _Clock) -> None:
    cache = RoomAccessCache(ttl_seconds=5, max_entries=8)
    cache.put_member("t1", "a1", _room(), cache.ticket())

    assert cache.member("t1", "a1", "r1") == _room()
    assert cache.member("t2", "a1", "r1") is None
    assert cache.member("t1", "a2", "r1") is None
    clock.now += 5
    assert cache.member("t1", "a1", "r1") is None


def test_the_signals_drop_what_they_name(clock: _Clock) -> None:
    cache = RoomAccessCache(ttl_seconds=5, max_entries=8)
    bus = _Bus()
    cache.follow(bus)  # type: ignore[arg-type]
    for agent_id, room_id in (("a1", "r1"), ("a2", "r1"), ("a1", "r2")):
        cache.put_member("t1", agent_id, _room(room_id), cache.ticket())
    for agent_id in ("a1", "a2"):
        cache.put_unbudgeted("t1", agent_id, cache.ticket())
    cache.put_unbudgeted("t2", "a3", cache.ticket())

    bus.handlers[ROOM_AGENT_CHANGED_SIGNAL](  # type: ignore[operator]
        {"tenant_id": "t1", "room_id": "r2", "agent_id": "a1"}
    )
    assert cache.member("t1", "a1", "r2") is None
    assert cache.member("t1", "a1", "r1") is not None

    bus.handlers[ROOM_CHANGED_SIGNAL]({"tenant_id": "t1", "room_id": "r1"})  # type: ignore[operator]
    assert cache.member("t1", "a1", "r1") is None
    assert cache.member("t1", "a2", "r1") is None

    bus.handlers[BUDGETS_CHANGED_SIGNAL]({"tenant_id": "t1"})  # type: ignore[operator]
    assert not cache.unbudgeted("t1", "a1")
    assert not cache.unbudgeted("t1", "a2")
    assert cache.unbudgeted("t2", "a3")


def test_a_read_that_straddled_a_signal_is_not_kept(clock: _Clock) -> None:
    cache = RoomAccessCache(ttl_seconds=5, max_entries=8)
    ticket = cache.ticket()
    cache.invalidate_member("a1", "r1")

    cache.put_member("t1", "a1", _room(), ticket)
    cache.put_unbudgeted("t1", "a1", ticket)

    assert cache.member("t1", "a1", "r1") is None
    assert not cache.unbudgeted("t1", "a1")


def test_it_keeps_no_more_than_its_bound(clock: _Clock) -> None:
    cache = RoomAccessCache(ttl_seconds=5, max_entries=2)
    for room_id in ("r1", "r2", "r3"):
        cache.put_member("t1", "a1", _room(room_id), cache.ticket())

    assert cache.member("t1", "a1", "r1") is None
    assert cache.member("t1", "a1", "r3") is not None


def test_a_ttl_of_zero_keeps_nothing(clock: _Clock) -> None:
    cache = RoomAccessCache(ttl_seconds=0, max_entries=8)
    cache.put_member("t1", "a1", _room(), cache.ticket())
    cache.put_unbudgeted("t1", "a1", cache.ticket())

    assert cache.member("t1", "a1", "r1") is None
    assert not cache.unbudgeted("t1", "a1")
