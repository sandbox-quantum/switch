"""`!follow-ups` and `!assign-agent`: a room's settings for following the
conversation, against real Postgres."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_only_policy
from switch_core.bridges.agent.commands import (
    COMMANDS_BY_NAME,
    _cmd_assign_agent,
    _cmd_follow_ups,
    _cmd_unassign_agent,
)
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import FOLLOW_UPS_OFF_KEY, RoomStore
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
        _agent_store=AgentStore(),
        _room_role_store=RoomRoleStore(),
        _external_user_store=ExternalUserStore(),
        client_store=ClientStore(),
        _connections=SimpleNamespace(live_connection_ids=lambda: set()),
        _follow_the_conversation_enabled=True,
    )
    return host, posted


async def _run(host: SimpleNamespace, args: str) -> None:
    event = SimpleNamespace(command="follow-ups", args=args, thread_id=None)
    await _cmd_follow_ups(host, RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]


async def _assign(host: SimpleNamespace, args: str, sender: str) -> None:
    event = SimpleNamespace(
        command="assign-agent", args=args, thread_id=None, user_id=sender
    )
    await _cmd_assign_agent(host, RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]


async def _unassign(host: SimpleNamespace, sender: str) -> None:
    event = SimpleNamespace(
        command="unassign-agent", args="", thread_id=None, user_id=sender
    )
    await _cmd_unassign_agent(host, RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]


def test_is_a_room_command_the_switch_app_runs() -> None:
    command = COMMANDS_BY_NAME["follow-ups"]
    assert command.admin_owned
    assert [a.name for a in command.args_spec] == ["state"]


class TestFollowUpsCommand:
    async def test_on_by_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id)

        await _run(host, "")

        assert "Follow-ups are **on**" in posted[-1]

    async def test_off_then_on(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id)
        store = RoomStore()

        await _run(host, "off")
        assert "Follow-ups are **off**" in posted[-1]
        async with session_factory() as session:
            assert not await store.follow_ups_enabled(session, room_id)
            room = await store.get(session, room_id)
            assert room is not None
            # The rest of the room's metadata is left alone.
            assert room.metadata_ == {
                "created_by_kind": "user",
                FOLLOW_UPS_OFF_KEY: True,
            }

        await _run(host, " ON ")
        assert "Follow-ups are **on**" in posted[-1]
        async with session_factory() as session:
            assert await store.follow_ups_enabled(session, room_id)
            room = await store.get(session, room_id)
            assert room is not None
            assert room.metadata_ == {"created_by_kind": "user"}

    async def test_anything_else_shows_usage_and_changes_nothing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        host, posted = _host(session_factory, room_id)

        await _run(host, "maybe")

        assert posted[-1].startswith("Usage: `!follow-ups on`")
        async with session_factory() as session:
            assert await RoomStore().follow_ups_enabled(session, room_id)


class TestStore:
    async def test_a_missing_room_has_no_follow_ups(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            assert not await RoomStore().follow_ups_enabled(session, "no-such-room")

    async def test_setting_a_missing_room_is_an_error(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            with pytest.raises(ValueError, match="does not exist"):
                await RoomStore().set_follow_ups_enabled(session, "no-such-room", False)


async def _agents(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> dict[str, str]:
    """Two agents in the room: `manager` (anyone may instruct it) and
    `private` (owner only). Returns name → id."""
    tag = uuid.uuid4().hex[:8]
    ids: dict[str, str] = {}
    async with session_factory() as session:
        owner = User(name="o", email=f"o-{tag}@test", role="user", password_hash="x")
        session.add(owner)
        await session.flush()
        for name in ("manager", "private"):
            key = ApiKey(
                user_id=owner.id,
                key_hash=f"h-{name}-{tag}",
                encrypted_key="e",
                label=name,
                type="agent",
            )
            client = Client(
                transport_user_id=f"@{name}-{tag}:test", display_name=name, type="agent"
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=f"{name}-{tag}",
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={"connection_model": "session_addressable"},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=owner.id,
                addressing_policy=(
                    owner_only_policy([]).model_dump(mode="json")
                    if name == "private"
                    else None
                ),
            )
            session.add(agent)
            await session.flush()
            ids[agent.name] = agent.id
        await RoomStore().add_agents(session, room_id, list(ids.values()))
        await session.commit()
    return ids


class TestAssignAgent:
    async def test_assign_then_show_then_unassign(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        ids = await _agents(session_factory, room_id)
        manager = next(n for n in ids if n.startswith("manager"))
        host, posted = _host(session_factory, room_id)

        await _assign(host, "", "@someone:test")
        assert posted[-1].startswith("No agent is assigned")

        await _assign(host, f"@{manager}", "@someone:test")
        assert posted[-1].startswith("From now on, every message here goes to")
        assert f"@{manager}" not in posted[-1]  # names it without mentioning it
        async with session_factory() as session:
            assert await RoomStore().main_agent_id(session, room_id) == ids[manager]

        await _assign(host, "", "@someone:test")
        assert posted[-1].startswith("Every message here goes to")

        await _unassign(host, "@someone:test")
        assert "is no longer assigned" in posted[-1]
        async with session_factory() as session:
            assert await RoomStore().main_agent_id(session, room_id) is None

        await _unassign(host, "@someone:test")
        assert posted[-1] == "No agent is assigned in this room."

    async def test_by_alias(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        ids = await _agents(session_factory, room_id)
        manager = next(n for n in ids if n.startswith("manager"))
        async with session_factory() as session:
            await RoomStore().set_alias(session, room_id, ids[manager], "boss")
            await session.commit()
        host, _posted = _host(session_factory, room_id)

        await _assign(host, "@boss", "@someone:test")

        async with session_factory() as session:
            assert await RoomStore().main_agent_id(session, room_id) == ids[manager]

    async def test_an_agent_not_in_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        await _agents(session_factory, room_id)
        host, posted = _host(session_factory, room_id)

        await _assign(host, "@nobody-here", "@someone:test")

        assert posted[-1].startswith("No agent named `nobody-here`")
        async with session_factory() as session:
            assert await RoomStore().main_agent_id(session, room_id) is None

    async def test_only_an_agent_that_takes_your_instructions(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        ids = await _agents(session_factory, room_id)
        private = next(n for n in ids if n.startswith("private"))
        host, posted = _host(session_factory, room_id)

        await _assign(host, f"@{private}", "@someone-unknown:test")

        assert posted[-1].startswith("You can't assign")
        async with session_factory() as session:
            assert await RoomStore().main_agent_id(session, room_id) is None

    async def test_replacing_says_so(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        room_id = await _room(session_factory)
        ids = await _agents(session_factory, room_id)
        manager = next(n for n in ids if n.startswith("manager"))
        async with session_factory() as session:
            await RoomStore().set_main_agent(session, room_id, ids[manager])
            await session.commit()
        other = await _agents(session_factory, room_id)
        other_manager = next(n for n in other if n.startswith("manager"))
        host, posted = _host(session_factory, room_id)

        await _assign(host, f"@{other_manager}", "@someone:test")

        assert "(replacing" in posted[-1]

    def test_are_room_commands_the_switch_app_runs(self) -> None:
        assert COMMANDS_BY_NAME["assign-agent"].admin_owned
        assert COMMANDS_BY_NAME["unassign-agent"].admin_owned
