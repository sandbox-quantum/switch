"""Who may change a room from its chat: the room policy (`room_policy`), asked
for the command's sender, against real Postgres.

The sender posted in the room, so is in it. Changing how the room behaves is
its owner's and admins'; an alias is also the aliased agent's owner's. A chat
account nobody has linked can't be recognised as anyone, so it is refused and
told to link.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import commands
from switch_core.bridges.agent.commands import (
    _cmd_add_room_admin,
    _cmd_follow_ups,
    _cmd_list_room_admins,
    _cmd_remove_room_admin,
    _cmd_set_alias,
)
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    Room,
    TenantMember,
    User,
    room_agents,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import SenderPrincipal
from switch_core.transport import RoomRef


async def _user(
    session_factory: async_sessionmaker[AsyncSession], name: str, role: str
) -> str:
    async with session_factory() as session:
        user = User(
            name=name,
            email=f"{name}-{uuid.uuid4().hex[:6]}@example.invalid",
            role="user",
        )
        session.add(user)
        await session.flush()
        session.add(TenantMember(tenant_id=TENANT_ZERO_ID, user_id=user.id, role=role))
        await session.commit()
        return user.id


async def _agent_of(
    session_factory: async_sessionmaker[AsyncSession], room_id: str, owner_id: str
) -> str:
    async with session_factory() as session:
        name = f"agent-{uuid.uuid4().hex[:6]}"
        client = Client(
            transport_user_id=f"@{name}:test", display_name=name, type="agent"
        )
        key = ApiKey(
            user_id=owner_id,
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
            owner_id=owner_id,
        )
        session.add(agent)
        await session.flush()
        await session.execute(
            room_agents.insert().values(room_id=room_id, agent_id=agent.id)
        )
        await session.commit()
        return name


class _World:
    def __init__(
        self, session_factory: async_sessionmaker[AsyncSession], room_id: str
    ) -> None:
        self.session_factory = session_factory
        self.room_id = room_id
        self.sender: list[str] = []
        self.posted: list[str] = []

    def host(self) -> SimpleNamespace:
        async def _resolve_sender(
            _session: AsyncSession, _transport_user_id: str
        ) -> SenderPrincipal:
            return SenderPrincipal("user", "ext-sender", list(self.sender), None)

        async def _resolve_room_meta(_transport_room_id: str) -> SimpleNamespace:
            return SimpleNamespace(room_id=self.room_id, name="room")

        async def _reply_command(_room_id: str, body: str, **_kw: object) -> None:
            self.posted.append(body)

        return SimpleNamespace(
            session_factory=self.session_factory,
            _resolve_room_meta=_resolve_room_meta,
            reply_command=_reply_command,
            _room_store=RoomStore(),
            _agent_store=AgentStore(),
            _room_role_store=RoomRoleStore(),
            _fake_resolve_sender=_resolve_sender,
            _follow_the_conversation_enabled=True,
            tenant_id=TENANT_ZERO_ID,
        )

    async def follow_ups(self, *, as_: list[str], choice: str) -> bool:
        self.sender = as_
        event = SimpleNamespace(
            command="follow-ups", args=choice, thread_id=None, user_id="@s:test"
        )
        await _cmd_follow_ups(self.host(), RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]
        async with self.session_factory() as session:
            return await RoomStore().follow_ups_enabled(session, self.room_id)

    async def set_alias(self, *, as_: list[str], agent: str, alias: str) -> str | None:
        self.sender = as_
        event = SimpleNamespace(
            command="set-alias",
            args=f"@{agent} @{alias}",
            thread_id=None,
            user_id="@s:test",
        )
        await _cmd_set_alias(self.host(), RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]
        async with self.session_factory() as session:
            return await RoomStore().get_agent_id_by_alias(session, self.room_id, alias)

    async def room_admin_command(
        self, command: str, *, as_: list[str], args: str
    ) -> str:
        self.sender = as_
        event = SimpleNamespace(
            command=command, args=args, thread_id=None, user_id="@s:test"
        )
        handler = {
            "add-room-admin": _cmd_add_room_admin,
            "remove-room-admin": _cmd_remove_room_admin,
            "list-room-admins": _cmd_list_room_admins,
        }[command]
        await handler(self.host(), RoomRef(room_id="!t:test"), event, False)  # type: ignore[arg-type]
        return self.posted[-1]

    async def admins(self) -> list[str]:
        async with self.session_factory() as session:
            return [
                a.user_id for a in await RoomStore().list_admins(session, self.room_id)
            ]

    async def join(self, user_id: str, name: str) -> None:
        """Put `user_id` in the room through a Switch Console member client."""
        async with self.session_factory() as session:
            client = Client(
                transport_user_id=f"@{name}-{uuid.uuid4().hex[:6]}:test",
                display_name=name,
                type=MEMBER_CLIENT_TYPE,
                user_id=user_id,
            )
            session.add(client)
            await session.flush()
            session.add(ClientRoom(client_id=client.id, room_id=self.room_id))
            await session.commit()


@pytest.fixture(autouse=True)
def _resolve_through_the_host(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        commands,
        "_command_resolver",
        lambda host: SimpleNamespace(resolve_sender=host._fake_resolve_sender),
    )


async def _world(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[_World, str]:
    owner = await _user(session_factory, "room-owner", "member")
    async with session_factory() as session:
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="d",
            owner_id=owner,
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.commit()
        return _World(session_factory, room.id), owner


class TestRoomSettings:
    async def test_the_owner_changes_them(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, owner = await _world(session_factory)

        assert await world.follow_ups(as_=[owner], choice="off") is False

    async def test_a_workspace_admin_changes_them(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, _ = await _world(session_factory)
        admin = await _user(session_factory, "admin", "admin")

        assert await world.follow_ups(as_=[admin], choice="off") is False

    async def test_someone_else_in_the_room_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, _ = await _world(session_factory)
        member = await _user(session_factory, "member", "member")

        assert await world.follow_ups(as_=[member], choice="off") is True
        assert world.posted[-1] == (
            "Only the room's owner, a room admin or a workspace admin can change "
            "this room's settings. Nothing was changed."
        )

    async def test_an_unlinked_chat_account_is_told_to_link(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, _ = await _world(session_factory)

        assert await world.follow_ups(as_=[], choice="off") is True
        assert "link this chat account to your Switch account" in world.posted[-1]

    async def test_anyone_may_see_them(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, _ = await _world(session_factory)

        await world.follow_ups(as_=[], choice="")
        assert "Follow-ups are **on**" in world.posted[-1]


class TestAliases:
    async def test_the_agents_owner_aliases_it_in_a_room_they_do_not_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, _ = await _world(session_factory)
        member = await _user(session_factory, "member", "member")
        theirs = await _agent_of(session_factory, world.room_id, member)

        assert await world.set_alias(as_=[member], agent=theirs, alias="mine")

    async def test_someone_elses_agent_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, owner = await _world(session_factory)
        member = await _user(session_factory, "member", "member")
        owners = await _agent_of(session_factory, world.room_id, owner)

        assert await world.set_alias(as_=[member], agent=owners, alias="x") is None
        assert "or the agent's own owner for their agent" in world.posted[-1]

    async def test_the_rooms_owner_aliases_anyones_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, owner = await _world(session_factory)
        member = await _user(session_factory, "member", "member")
        theirs = await _agent_of(session_factory, world.room_id, member)

        assert await world.set_alias(as_=[owner], agent=theirs, alias="theirs")


class TestRoomAdmins:
    async def _with_member(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> tuple[_World, str, str, str]:
        world, owner = await _world(session_factory)
        name = f"max-{uuid.uuid4().hex[:6]}"
        member = await _user(session_factory, name, "member")
        await world.join(member, name)
        return world, owner, member, name

    async def test_the_owner_makes_someone_in_the_room_one_who_then_changes_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, owner, member, name = await self._with_member(session_factory)

        reply = await world.room_admin_command(
            "add-room-admin", as_=[owner], args=f"@{name}"
        )

        assert reply.startswith(f"**{name}** is now a room admin")
        assert await world.admins() == [member]
        assert await world.follow_ups(as_=[member], choice="off") is False

    async def test_someone_else_in_the_room_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, _, member, name = await self._with_member(session_factory)

        reply = await world.room_admin_command(
            "add-room-admin", as_=[member], args=f"@{name}"
        )

        assert reply == (
            "Only the room's owner or a workspace admin can choose this room's "
            "room admins. Nothing was changed."
        )
        assert await world.admins() == []

    async def test_a_room_admin_cannot_choose_others_but_can_step_down(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, owner, member, name = await self._with_member(session_factory)
        other_name = f"bea-{uuid.uuid4().hex[:6]}"
        other = await _user(session_factory, other_name, "member")
        await world.join(other, other_name)
        await world.room_admin_command("add-room-admin", as_=[owner], args=f"@{name}")

        refused = await world.room_admin_command(
            "add-room-admin", as_=[member], args=f"@{other_name}"
        )
        assert "Nothing was changed" in refused
        stepped = await world.room_admin_command(
            "remove-room-admin", as_=[member], args=f"@{name}"
        )
        assert stepped == f"**{name}** is no longer a room admin."
        assert await world.admins() == []

    async def test_someone_not_in_the_room_cannot_be_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, owner = await _world(session_factory)
        name = f"out-{uuid.uuid4().hex[:6]}"
        await _user(session_factory, name, "member")

        reply = await world.room_admin_command(
            "add-room-admin", as_=[owner], args=f"@{name}"
        )

        assert reply == f"Nobody in this room goes by `{name}`. Nothing was changed."

    async def test_list_names_the_owner_and_room_admins(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, owner, _, name = await self._with_member(session_factory)
        await world.room_admin_command("add-room-admin", as_=[owner], args=f"@{name}")

        listing = await world.room_admin_command("list-room-admins", as_=[], args="")

        assert listing.splitlines() == [
            "**Owner:** room-owner",
            "**Room admins:**",
            f"- {name}",
        ]

    async def test_a_name_two_people_share_is_refused_as_ambiguous(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        world, owner = await _world(session_factory)
        name = f"sam-{uuid.uuid4().hex[:6]}"
        for _ in range(2):
            twin = await _user(session_factory, name, "member")
            await world.join(twin, name)

        reply = await world.room_admin_command(
            "add-room-admin", as_=[owner], args=f"@{name}"
        )

        assert reply.startswith(f"More than one person in this room goes by `{name}`")
        assert await world.admins() == []
