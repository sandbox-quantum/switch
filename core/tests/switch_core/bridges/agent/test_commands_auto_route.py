"""`!auto-route`: a room's switch for decision routing, against real
Postgres."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import COMMANDS_BY_NAME, _cmd_auto_route
from switch_core.bridges.collaboration.own_app_setup import slack_manifest
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    Room,
    User,
    room_agents,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.room_store import (
    AUTO_ROUTE_FALLBACK_KEY,
    AUTO_ROUTE_ON_KEY,
    RoomStore,
)
from switch_core.decision.settings import DecisionAvailability, ServerDefault
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
        _agent_store=AgentStore(),
        _decision_availability=DecisionAvailability(
            enabled=flag,
            server=ServerDefault(
                endpoint_url="http://decision.test/decide" if endpoint else None,
                api_key=None,
                bedrock_enabled=False,
            ),
            store=DecisionSettingsStore(),
            controllers=AgentControllerStore(),
        ),
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

    async def test_on_without_a_decision_service_says_who_can_fix_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id, endpoint=False)

        await _run(host, "on")

        assert posted[-1].startswith("Auto-route needs a decision service.")
        assert "Switch Console → Admin → Decision routing" in posted[-1]
        assert "Nothing was changed" in posted[-1]
        assert not await _on(session_factory, room_id)

    async def test_on_where_the_workspace_chose_none_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        async with session_factory() as session:
            await DecisionSettingsStore().save(
                session,
                TENANT_ZERO_ID,
                backend="none",
                endpoint=None,
                api_key_encrypted=None,
                threshold=None,
            )
            await session.commit()
        host, posted = _host(session_factory, room_id)

        await _run(host, "on")

        assert "turned auto-route off" in posted[-1]
        assert not await _on(session_factory, room_id)

    async def test_on_and_unavailable_since_says_it_cannot_act(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        host, _ = _host(session_factory, room_id)
        await _run(host, "on")
        unavailable, posted = _host(session_factory, room_id, endpoint=False)

        await _run(unavailable, "")
        assert "Automatic routing is **on**" in posted[-1]
        assert (
            "It can't act right now: Auto-route needs a decision service" in posted[-1]
        )

        await _run(unavailable, "off")
        assert "Automatic routing is **off**" in posted[-1]
        assert not await _on(session_factory, room_id)


async def _agents(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> dict[str, Agent]:
    """Two agents in the room, `triage` and `helper`."""
    agents: dict[str, Agent] = {}
    async with session_factory() as session:
        owner = User(name="owner", email="owner@example.invalid", role="user")
        session.add(owner)
        await session.flush()
        for name in ("triage", "helper"):
            client = Client(
                transport_user_id=f"@{name}-{uuid.uuid4().hex[:6]}:test",
                display_name=name,
                type="agent",
            )
            key = ApiKey(
                user_id=owner.id,
                key_hash=f"hash-{uuid.uuid4().hex}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            session.add_all([client, key])
            await session.flush()
            agent = Agent(
                name=name,
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={"connection_model": "session_addressable"},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=owner.id,
            )
            session.add(agent)
            await session.flush()
            await session.execute(
                room_agents.insert().values(room_id=room_id, agent_id=agent.id)
            )
            agents[name] = agent
        await session.commit()
    return agents


async def _fallback(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> str | None:
    async with session_factory() as session:
        return await RoomStore().auto_route_fallback(session, room_id)


class TestTheTriageAgent:
    async def test_naming_showing_and_clearing_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        agents = await _agents(session_factory, room_id)
        host, posted = _host(session_factory, room_id)

        await _run(host, "fallback")
        assert "This room has no triage agent" in posted[-1]

        await _run(host, "fallback @Triage")
        assert "is now this room's triage agent" in posted[-1]
        assert await _fallback(session_factory, room_id) == agents["triage"].id
        async with session_factory() as session:
            room = await RoomStore().get(session, room_id)
            assert room is not None
            assert room.metadata_[AUTO_ROUTE_FALLBACK_KEY] == agents["triage"].id

        await _run(host, "fallback")
        assert "go to **triage**" in posted[-1]
        await _run(host, "on")
        assert "the room's triage agent" in posted[-1]

        await _run(host, "fallback off")
        assert "no longer has a triage agent" in posted[-1]
        assert await _fallback(session_factory, room_id) is None

    async def test_an_agent_not_in_the_room_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        await _agents(session_factory, room_id)
        host, posted = _host(session_factory, room_id)

        await _run(host, "fallback @nobody")

        assert "No agent named `nobody` in this room" in posted[-1]
        assert await _fallback(session_factory, room_id) is None

    async def test_the_assigned_agent_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        agents = await _agents(session_factory, room_id)
        async with session_factory() as session:
            await RoomStore().set_main_agent(session, room_id, agents["helper"].id)
            await session.commit()
        host, posted = _host(session_factory, room_id)

        await _run(host, "fallback @helper")

        assert "assigned agent" in posted[-1]
        assert "Nothing was changed" in posted[-1]
        assert await _fallback(session_factory, room_id) is None

    @pytest.mark.parametrize("args", ["on off", "fallback @a @b", "maybe"])
    async def test_anything_else_gets_the_usage(
        self, session_factory: async_sessionmaker[AsyncSession], args: str
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id)

        await _run(host, args)

        assert posted[-1].startswith("Usage: `!auto-route on`")
        assert "`!auto-route fallback @agent`" in posted[-1]
