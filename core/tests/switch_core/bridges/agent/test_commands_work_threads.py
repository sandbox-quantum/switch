"""`!work-threads`: whether a room's turns asked at the channel root work in a
thread of the agent's own, against real Postgres."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import commands
from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_work_threads
from switch_core.db.models import Room
from switch_core.db.stores.room_store import WORK_THREADS_ON_KEY, RoomStore
from switch_core.room_policy import RoomDecision
from switch_core.transport import RoomRef


@pytest.fixture
def allowed(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Who may change a room is the room policy's; this records what was asked."""
    asked: list[str] = []

    async def decide(*args: object, **_kwargs: object) -> RoomDecision:
        asked.append(str(args[4]))
        return RoomDecision(True, None)

    monkeypatch.setattr(commands, "_room_decision", decide)
    return asked


async def _room(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="d",
            metadata_={"created_by_kind": "user"},
        )
        session.add(room)
        await session.commit()
        return room.id


def _host(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> tuple[SimpleNamespace, list[str]]:
    posted: list[str] = []

    async def _resolve_room_meta(_transport_room_id: str) -> SimpleNamespace:
        return SimpleNamespace(room_id=room_id, name="room")

    async def _reply_command(_room_id: str, body: str, **_kw: object) -> None:
        posted.append(body)

    host = SimpleNamespace(
        session_factory=session_factory,
        _resolve_room_meta=_resolve_room_meta,
        reply_command=_reply_command,
        send_message=_reply_command,
        _room_store=RoomStore(),
    )
    return host, posted


async def _run(host: SimpleNamespace, args: str) -> None:
    event = SimpleNamespace(command="work-threads", args=args, thread_id=None)
    await _cmd_work_threads(host, RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]


def test_is_a_room_command_the_switch_app_runs() -> None:
    command = COMMANDS_BY_NAME["work-threads"]
    assert command.admin_owned
    assert [a.name for a in command.args_spec] == ["state"]


async def test_off_by_default_and_reading_it_asks_nobody(
    session_factory: async_sessionmaker[AsyncSession], allowed: list[str]
) -> None:
    room_id = await _room(session_factory)
    host, posted = _host(session_factory, room_id)
    await _run(host, "")
    assert "Work threads are **off**" in posted[-1]
    assert allowed == []


async def test_on_then_off_is_a_room_setting_change(
    session_factory: async_sessionmaker[AsyncSession], allowed: list[str]
) -> None:
    room_id = await _room(session_factory)
    host, posted = _host(session_factory, room_id)
    store = RoomStore()

    await _run(host, "on")
    assert "Work threads are **on**" in posted[-1]
    assert allowed == ["configure"]
    async with session_factory() as session:
        room = await store.get(session, room_id)
        assert room is not None
        assert room.metadata_ == {"created_by_kind": "user", WORK_THREADS_ON_KEY: True}

    await _run(host, " OFF ")
    assert "Work threads are **off**" in posted[-1]
    async with session_factory() as session:
        assert not await store.work_threads_mode(session, room_id)
        room = await store.get(session, room_id)
        assert room is not None
        assert room.metadata_ == {"created_by_kind": "user"}


async def test_a_refused_change_changes_nothing(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def refuse(*_args: object, **_kwargs: object) -> RoomDecision:
        return RoomDecision(False, "Only the room's owner or an admin can do that.")

    monkeypatch.setattr(commands, "_room_decision", refuse)
    room_id = await _room(session_factory)
    host, posted = _host(session_factory, room_id)
    await _run(host, "on")
    assert "Only the room's owner" in posted[-1]
    async with session_factory() as session:
        assert not await RoomStore().work_threads_mode(session, room_id)


async def test_anything_else_shows_usage(
    session_factory: async_sessionmaker[AsyncSession], allowed: list[str]
) -> None:
    room_id = await _room(session_factory)
    host, posted = _host(session_factory, room_id)
    await _run(host, "maybe")
    assert posted[-1].startswith("Usage: `!work-threads on`, `!work-threads inline`")
    assert allowed == []


async def test_inline_is_a_setting_of_its_own(
    session_factory: async_sessionmaker[AsyncSession], allowed: list[str]
) -> None:
    room_id = await _room(session_factory)
    host, posted = _host(session_factory, room_id)
    store = RoomStore()

    await _run(host, "inline")
    assert "Work threads are **inline**" in posted[-1]
    async with session_factory() as session:
        assert await store.work_threads_mode(session, room_id) == "inline"
        room = await store.get(session, room_id)
        assert room is not None
        assert room.metadata_[WORK_THREADS_ON_KEY] == "inline"

    await _run(host, "on")
    async with session_factory() as session:
        assert await store.work_threads_mode(session, room_id) == "thread"
