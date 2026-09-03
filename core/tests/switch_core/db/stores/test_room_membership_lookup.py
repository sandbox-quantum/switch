"""`RoomStore.get_with_membership` answers "does this room exist, and is this
agent in it" in one statement, so authorization costs one checkout."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.room_store import RoomStore


async def _make_agent(session: AsyncSession, name: str) -> Agent:
    user = User(name=name, email=f"{name}@test", role="user", password_hash="x")
    session.add(user)
    await session.flush()
    api_key = ApiKey(
        user_id=user.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(
        matrix_user_id=f"@{name}:test", display_name=name, type="agent", password="x"
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="session_addressable",
        connector_type="claude_code",
        integration_profile={},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


class TestGetWithMembership:
    async def test_member_gets_the_room_and_a_true_flag(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            room = await store.create(
                session, Room(matrix_room_id="!a:test", name="alpha", description="d")
            )
            agent = await _make_agent(session, "member")
            await store.add_agents(session, room.id, [agent.id])
            await session.commit()

            found = await store.get_with_membership(session, room.id, agent.id)

        assert found is not None
        loaded, is_member = found
        assert loaded.id == room.id
        assert loaded.name == "alpha"
        assert is_member is True

    async def test_non_member_still_gets_the_room_but_a_false_flag(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The caller has to tell "no such room" from "not yours" — they are a
        # 404 and a 403, and collapsing them loses the distinction.
        store = RoomStore()
        async with session_factory() as session:
            room = await store.create(
                session, Room(matrix_room_id="!b:test", name="beta", description="d")
            )
            outsider = await _make_agent(session, "outsider")
            await session.commit()

            found = await store.get_with_membership(session, room.id, outsider.id)

        assert found is not None
        loaded, is_member = found
        assert loaded.id == room.id
        assert is_member is False

    async def test_unknown_room_is_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            agent = await _make_agent(session, "lost")
            await session.commit()

            assert (
                await store.get_with_membership(session, "no-such-room", agent.id)
                is None
            )

    async def test_another_members_row_does_not_admit_this_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The join is filtered on the agent, not merely on the room: a room
        # with members must not read as "everyone is a member".
        store = RoomStore()
        async with session_factory() as session:
            room = await store.create(
                session, Room(matrix_room_id="!c:test", name="gamma", description="d")
            )
            insider = await _make_agent(session, "insider")
            outsider = await _make_agent(session, "stranger")
            await store.add_agents(session, room.id, [insider.id])
            await session.commit()

            found = await store.get_with_membership(session, room.id, outsider.id)

        assert found is not None
        assert found[1] is False
