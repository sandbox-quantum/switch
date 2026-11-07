"""The schedule tools an agent calls in its connected room: what an agent may
do to a room's schedules is what its owner may, and a mistake comes back as
an error the agent can relay. Real Postgres, the real `AgentCore` methods and
the real service; only the caller's identity and room are bound by hand."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import definitions
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Agent, Room, User, room_agents
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.room_schedules import RoomScheduleService, parse_schedule_time
from tests.switch_core.test_room_schedules import _make_agent


class Env(SimpleNamespace):
    protocol: AgentCore
    owner_agent: Agent
    other_agent: Agent
    admin_agent: Agent
    room_id: str
    caller: str


def _bind(monkeypatch: pytest.MonkeyPatch, env: Env, agent: Agent) -> None:
    async def room() -> str:
        return env.room_id

    monkeypatch.setattr(definitions, "get_agent_id", lambda: agent.id)
    monkeypatch.setattr(definitions, "get_protocol", lambda: env.protocol)
    monkeypatch.setattr(definitions, "require_connected_room", room)


@pytest.fixture
async def env(session_factory: async_sessionmaker[AsyncSession]) -> Env:
    async with session_factory() as session:
        owner = User(name="Dana", email="dana@example.com", role="user")
        other = User(name="Eli", email="eli@example.com", role="user")
        admin = User(name="Root", email="root@example.com", role="admin")
        session.add_all([owner, other, admin])
        await session.flush()
        owner_agent = await _make_agent(session, "owner-agent", owner.id)
        other_agent = await _make_agent(session, "other-agent", other.id)
        admin_agent = await _make_agent(session, "admin-agent", admin.id)
        room = Room(
            transport_room_id="!room:test",
            name="triage",
            description="triage room",
            owner_id=owner.id,
        )
        session.add(room)
        await session.flush()
        for agent in (owner_agent, other_agent, admin_agent):
            await session.execute(
                room_agents.insert().values(room_id=room.id, agent_id=agent.id)
            )
        await session.commit()
        room_id = room.id

    protocol = object.__new__(AgentCore)
    protocol.session_factory = session_factory
    protocol.agent_store = AgentStore()
    protocol.room_store = RoomStore()
    protocol.user_store = UserStore()
    protocol.room_schedules = RoomScheduleService(
        schedule_store=RoomScheduleStore(),
        room_store=RoomStore(),
        agent_store=AgentStore(),
        user_store=UserStore(),
        client_lifecycle=SimpleNamespace(),  # type: ignore[arg-type]
        session_factory=session_factory,
        clock=lambda: datetime.now(UTC),
    )
    return Env(
        protocol=protocol,
        owner_agent=owner_agent,
        other_agent=other_agent,
        admin_agent=admin_agent,
        room_id=room_id,
    )


async def _create(env: Env, **overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {
        "agent_ids": [env.owner_agent.id],
        "message": "summarise new issues",
        "schedule_type": "cron",
        "cron_expression": "0 9 * * 1-5",
        "timezone": "Europe/Berlin",
    }
    fields.update(overrides)
    return await definitions.create_schedule(**fields)


class TestOperations:
    async def test_create_list_update_pause_and_delete(
        self, env: Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _bind(monkeypatch, env, env.owner_agent)

        created = await _create(env)
        assert created["enabled"] is True
        assert created["next_run_at"] is not None
        assert created["created_by_user_id"] == env.owner_agent.owner_id

        assert [s["id"] for s in await definitions.list_schedules()] == [created["id"]]

        edited = await definitions.update_schedule(
            created["id"], message="weekly digest", cron_expression="0 8 * * 1"
        )
        assert edited["message"] == "weekly digest"
        assert edited["cron_expression"] == "0 8 * * 1"

        paused = await definitions.update_schedule(created["id"], enabled=False)
        assert paused["enabled"] is False
        assert paused["next_run_at"] is None

        assert await definitions.delete_schedule(created["id"]) == {"ok": True}
        assert await definitions.list_schedules() == []

    async def test_a_one_off_takes_an_iso_time(
        self, env: Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _bind(monkeypatch, env, env.owner_agent)
        when = (datetime.now(UTC) + timedelta(days=2)).replace(microsecond=0)

        created = await _create(
            env,
            schedule_type="once",
            cron_expression=None,
            run_at=when.isoformat(),
            timezone="UTC",
        )

        assert created["next_run_at"] == when.isoformat()

    async def test_a_mistake_comes_back_as_an_error_to_relay(
        self, env: Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _bind(monkeypatch, env, env.owner_agent)

        with pytest.raises(ValueError, match="five fields"):
            await _create(env, cron_expression="daily")
        with pytest.raises(ValueError, match="ISO 8601"):
            await _create(env, schedule_type="once", run_at="tomorrow")
        with pytest.raises(ValueError, match="Schedule not found"):
            await definitions.update_schedule("missing", enabled=False)
        with pytest.raises(ValueError, match="Schedule not found"):
            await definitions.delete_schedule("missing")


class TestWhoMayManage:
    async def test_an_agent_whose_owner_does_not_own_the_room_may_only_list(
        self, env: Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _bind(monkeypatch, env, env.owner_agent)
        created = await _create(env)
        _bind(monkeypatch, env, env.other_agent)

        assert [s["id"] for s in await definitions.list_schedules()] == [created["id"]]
        with pytest.raises(PermissionError):
            await _create(env)
        with pytest.raises(PermissionError):
            await definitions.update_schedule(created["id"], enabled=False)
        with pytest.raises(PermissionError):
            await definitions.delete_schedule(created["id"])

    async def test_an_agent_of_a_workspace_admin_may_manage_any_room(
        self, env: Env, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _bind(monkeypatch, env, env.admin_agent)

        created = await _create(env)

        assert created["created_by_user_id"] == env.admin_agent.owner_id

    async def test_an_agent_outside_the_room_cannot_even_list(
        self,
        env: Env,
        monkeypatch: pytest.MonkeyPatch,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        async with session_factory() as session:
            owner = User(name="Fay", email="fay@example.com", role="user")
            session.add(owner)
            await session.flush()
            outsider = await _make_agent(session, "outsider", owner.id)
            await session.commit()
        _bind(monkeypatch, env, outsider)

        with pytest.raises(PermissionError):
            await definitions.list_schedules()

    async def test_the_agents_addressed_must_be_in_the_room(
        self,
        env: Env,
        monkeypatch: pytest.MonkeyPatch,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        async with session_factory() as session:
            outsider = await _make_agent(session, "outsider", env.owner_agent.owner_id)
            await session.commit()
        _bind(monkeypatch, env, env.owner_agent)

        with pytest.raises(ValueError, match="must be in the room"):
            await _create(env, agent_ids=[outsider.id])


class TestParseScheduleTime:
    def test_none_stays_none(self) -> None:
        assert parse_schedule_time(None) is None

    def test_an_offset_is_kept_and_a_bare_time_is_naive(self) -> None:
        assert parse_schedule_time(
            "2026-12-01T09:00:00+01:00"
        ) == datetime.fromisoformat("2026-12-01T09:00:00+01:00")
        assert parse_schedule_time("2026-12-01T09:00").tzinfo is None
