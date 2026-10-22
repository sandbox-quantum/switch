"""`!auto-route`: a room's switch for decision routing, against real
Postgres."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_auto_route
from switch_core.bridges.collaboration.own_app_setup import slack_manifest
from switch_core.db.models import Room
from switch_core.db.stores.room_store import AUTO_ROUTE_ON_KEY, RoomStore
from switch_core.transport import RoomRef


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
    session_factory: async_sessionmaker[AsyncSession],
    room_id: str,
    *,
    flag: bool = True,
    endpoint: bool = True,
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
        _room_store=RoomStore(),
        _decision_routing_enabled=flag,
        _decision_endpoint_configured=endpoint,
    )
    return host, posted


async def _run(host: SimpleNamespace, args: str) -> None:
    event = SimpleNamespace(command="auto-route", args=args, thread_id=None)
    await _cmd_auto_route(host, RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]


async def _on(session_factory: async_sessionmaker[AsyncSession], room_id: str) -> bool:
    async with session_factory() as session:
        return await RoomStore().auto_route_on(session, room_id)


def test_is_a_room_command_the_switch_app_runs() -> None:
    command = COMMANDS_BY_NAME["auto-route"]
    assert command.admin_owned
    assert [a.name for a in command.args_spec] == ["state"]


def test_the_slack_manifest_lists_it() -> None:
    commands = {c["command"]: c for c in slack_manifest()["features"]["slash_commands"]}

    assert "/auto-route" in commands
    assert commands["/auto-route"]["usage_hint"] == "<state>"


class TestAutoRouteCommand:
    async def test_off_by_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id)

        await _run(host, "")

        assert "Automatic routing is **off**" in posted[-1]
        assert not await _on(session_factory, room_id)

    async def test_on_then_off(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id)

        await _run(host, "on")
        assert "Automatic routing is **on**" in posted[-1]
        assert await _on(session_factory, room_id)
        async with session_factory() as session:
            room = await RoomStore().get(session, room_id)
            assert room is not None
            assert room.metadata_ == {
                "created_by_kind": "user",
                AUTO_ROUTE_ON_KEY: True,
            }

        await _run(host, "")
        assert "Automatic routing is **on**" in posted[-1]

        await _run(host, "OFF")
        assert "Automatic routing is **off**" in posted[-1]
        assert not await _on(session_factory, room_id)

    async def test_anything_else_gets_the_usage(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id)

        await _run(host, "maybe")

        assert posted[-1].startswith("Usage: `!auto-route on`")
        assert not await _on(session_factory, room_id)

    @pytest.mark.parametrize("args", ["", "on", "off"])
    async def test_with_the_flag_off_it_says_so_and_changes_nothing(
        self, session_factory: async_sessionmaker[AsyncSession], args: str
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id, flag=False)

        await _run(host, args)

        assert (
            "Automatic routing isn't switched on for this Switch server" in (posted[-1])
        )
        assert not await _on(session_factory, room_id)

    @pytest.mark.parametrize("args", ["", "on"])
    async def test_without_a_decision_service_it_says_so_and_changes_nothing(
        self, session_factory: async_sessionmaker[AsyncSession], args: str
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id, endpoint=False)

        await _run(host, args)

        assert "has no decision service configured" in posted[-1]
        assert "nothing was changed" in posted[-1]
        assert not await _on(session_factory, room_id)
