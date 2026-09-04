from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, ApiKey, Client, RoleLease, Room, User
from switch_core.db.stores.room_role_store import RoomRoleStore


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
        matrix_user_id=f"@{name}:test",
        display_name=name,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def _make_room(session: AsyncSession, name: str) -> Room:
    room = Room(
        matrix_room_id=f"!{name}:test",
        name=name,
        description=f"{name} desc",
    )
    session.add(room)
    await session.flush()
    return room


async def _age_lease(session: AsyncSession, agent_id: str, age: timedelta) -> None:
    await session.execute(
        update(RoleLease)
        .where(RoleLease.agent_id == agent_id)
        .values(last_seen_at=datetime.now(UTC) - age)
    )


class TestRoleDefinitions:
    async def test_define_list_edit_delete(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            await store.define_role(session, room.id, "manager", "lead", True)
            await store.define_role(session, room.id, "worker", "do work", False)
            await session.commit()

            roles = await store.list_roles(session, room.id)
            assert [r.name for r in roles] == ["manager", "worker"]
            assert roles[0].exclusive is True
            assert roles[1].exclusive is False

            await store.edit_role(session, room.id, "worker", "new instr", True)
            await session.commit()
            worker = await store.get_role(session, room.id, "worker")
            assert worker is not None
            assert worker.instructions == "new instr"
            assert worker.exclusive is True

            await store.delete_role(session, room.id, "manager")
            await session.commit()
            assert await store.get_role(session, room.id, "manager") is None

    async def test_define_duplicate_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()
            with pytest.raises(ValueError, match="already exists"):
                await store.define_role(session, room.id, "manager", "x", False)

    async def test_name_with_whitespace_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            for bad in ["manager role", "lead\t", " ", ""]:
                with pytest.raises(ValueError, match="whitespace"):
                    await store.define_role(session, room.id, bad, "x", False)

    async def test_edit_missing_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            with pytest.raises(ValueError, match="not found"):
                await store.edit_role(session, room.id, "ghost", "x", None)


class TestLeases:
    async def test_acquire_and_release(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "a1")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, agent.id, "tx1")
            await session.commit()

            holders = await store.live_holders_for_room(session, room.id)
            assert holders == {role.id: [agent.id]}
            assert await store.agent_room_role(session, room.id, agent.id) == "manager"

            await store.release_lease(session, agent.id)
            await session.commit()
            assert await store.live_holders_for_room(session, room.id) == {}

    async def test_exclusive_collision_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            a1 = await _make_agent(session, "a1")
            a2 = await _make_agent(session, "a2")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, a1.id, "tx1")
            await session.commit()

            with pytest.raises(ValueError, match="exclusive"):
                await store.acquire_lease(session, role, a2.id, "tx2")

    async def test_one_lease_per_agent_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "a1")
            manager = await store.define_role(session, room.id, "manager", "m", True)
            worker = await store.define_role(session, room.id, "worker", "w", False)
            await session.commit()

            await store.acquire_lease(session, manager, agent.id, "tx1")
            await session.commit()
            with pytest.raises(ValueError, match="already hold"):
                await store.acquire_lease(session, worker, agent.id, "tx1")

    async def test_stale_lease_is_free(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            a1 = await _make_agent(session, "a1")
            a2 = await _make_agent(session, "a2")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, a1.id, "tx1")
            await session.commit()
            # Age a1's lease past the TTL → logically free.
            await _age_lease(
                session, a1.id, RoomRoleStore.LEASE_TTL + timedelta(seconds=5)
            )
            await session.commit()

            assert await store.live_holders_for_room(session, room.id) == {}
            # a2 can now take the exclusive role despite a1's stale row.
            await store.acquire_lease(session, role, a2.id, "tx2")
            await session.commit()
            holders = await store.live_holders_for_room(session, room.id)
            assert holders == {role.id: [a2.id]}

    async def test_touch_keeps_lease_live(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "a1")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, agent.id, "tx1")
            await session.commit()
            # Age it most of the way, then touch → live again.
            await _age_lease(
                session, agent.id, RoomRoleStore.LEASE_TTL - timedelta(seconds=1)
            )
            await session.commit()
            assert await store.touch_lease(session, agent.id) is True
            await session.commit()
            assert await store.get_agent_live_lease(session, agent.id) is not None

    async def test_touch_no_lease(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            await _make_room(session, "r1")
            agent = await _make_agent(session, "a1")
            await session.commit()
            assert await store.touch_lease(session, agent.id) is False

    async def test_get_agent_lease_ignores_liveness(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "a1")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, agent.id, "tx-77")
            await session.commit()
            # Age the lease past the TTL: get_agent_live_lease should miss it,
            # but get_agent_lease still returns it (to read transport_session_id).
            await _age_lease(
                session, agent.id, RoomRoleStore.LEASE_TTL + timedelta(seconds=5)
            )
            await session.commit()

            assert await store.get_agent_live_lease(session, agent.id) is None
            lease = await store.get_agent_lease(session, agent.id)
            assert lease is not None
            assert lease.transport_session_id == "tx-77"

    async def test_reassume_same_role_idempotent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "a1")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            first = await store.acquire_lease(session, role, agent.id, "tx1")
            await session.commit()
            again = await store.acquire_lease(session, role, agent.id, "tx2")
            await session.commit()
            assert first.id == again.id
            holders = await store.live_holders_for_room(session, room.id)
            assert holders == {role.id: [agent.id]}


class TestSharedRoles:
    async def test_shared_role_admits_multiple_holders(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A non-exclusive role can be held by several agents at once: a second
        agent assuming it must NOT evict the first (the eviction bug)."""
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            a1 = await _make_agent(session, "a1")
            a2 = await _make_agent(session, "a2")
            role = await store.define_role(session, room.id, "reviewer", "rev", False)
            await session.commit()

            await store.acquire_lease(session, role, a1.id, "tx1")
            await session.commit()
            await store.acquire_lease(session, role, a2.id, "tx2")
            await session.commit()

            holders = await store.live_holders_for_room(session, room.id)
            assert set(holders[role.id]) == {a1.id, a2.id}
            # Both still resolve to the role by name.
            assert await store.agent_room_role(session, room.id, a1.id) == "reviewer"
            assert await store.agent_room_role(session, room.id, a2.id) == "reviewer"
            assert await store.has_live_holder(session, role.id) is True

    async def test_release_one_holder_leaves_the_other(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            a1 = await _make_agent(session, "a1")
            a2 = await _make_agent(session, "a2")
            role = await store.define_role(session, room.id, "reviewer", "rev", False)
            await session.commit()

            await store.acquire_lease(session, role, a1.id, "tx1")
            await store.acquire_lease(session, role, a2.id, "tx2")
            await session.commit()

            await store.release_lease(session, a1.id)
            await session.commit()

            holders = await store.live_holders_for_room(session, room.id)
            assert holders == {role.id: [a2.id]}

    async def test_has_live_holder_false_when_free(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            role = await store.define_role(session, room.id, "reviewer", "rev", False)
            await session.commit()
            assert await store.has_live_holder(session, role.id) is False

    async def test_live_leases_for_room_exposes_transport_session(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """live_leases_for_room returns the full lease rows (with the assuming
        session's transport id) for live holders, and excludes stale leases."""
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            a1 = await _make_agent(session, "a1")
            a2 = await _make_agent(session, "a2")
            role = await store.define_role(session, room.id, "reviewer", "rev", False)
            await session.commit()

            await store.acquire_lease(session, role, a1.id, "tx1")
            await store.acquire_lease(session, role, a2.id, "tx2")
            await session.commit()

            leases = await store.live_leases_for_room(session, room.id)
            assert set(leases.keys()) == {role.id}
            by_agent = {lease.agent_id: lease for lease in leases[role.id]}
            assert by_agent[a1.id].transport_session_id == "tx1"
            assert by_agent[a2.id].transport_session_id == "tx2"

            # Age a1's lease past the TTL: it drops out, a2 remains.
            await _age_lease(
                session, a1.id, RoomRoleStore.LEASE_TTL + timedelta(seconds=5)
            )
            await session.commit()
            leases = await store.live_leases_for_room(session, room.id)
            assert [lease.agent_id for lease in leases[role.id]] == [a2.id]


class TestLeaseLivenessIsAUnion:
    """A lease survives on a fresh heartbeat OR a live connection (CHOO-1857).

    A client on the push transport sends one connection heartbeat and no
    `/leases/renew`, so freshness alone would drop its role within the TTL —
    silently, and within six seconds of it migrating. `alive_agent_ids` is the
    connection arm; an empty set means "freshness only", which is exactly what
    an un-migrated client still relies on.
    """

    async def test_a_stale_lease_survives_while_its_agent_is_connected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "a1")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, agent.id, "tx1")
            await session.commit()
            await _age_lease(
                session, agent.id, RoomRoleStore.LEASE_TTL + timedelta(seconds=5)
            )
            await session.commit()

            # Freshness alone: gone.
            assert await store.live_holders_for_room(session, room.id) == {}
            # With the connection arm: still held.
            assert await store.live_holders_for_room(session, room.id, {agent.id}) == {
                role.id: [agent.id]
            }

    async def test_a_connected_holder_still_blocks_an_exclusive_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The seat is not free just because the old heartbeat stopped.

        Without this, a second session could take a role its holder still has —
        the exact double-holder the exclusivity rule exists to prevent.
        """
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            a1 = await _make_agent(session, "a1")
            a2 = await _make_agent(session, "a2")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, a1.id, "tx1")
            await session.commit()
            await _age_lease(
                session, a1.id, RoomRoleStore.LEASE_TTL + timedelta(seconds=5)
            )
            await session.commit()

            with pytest.raises(ValueError, match="exclusive"):
                await store.acquire_lease(session, role, a2.id, "tx2", {a1.id})

    async def test_an_unconnected_agent_does_not_keep_a_stale_lease(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The connection arm names specific agents; it is not a blanket amnesty."""
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            a1 = await _make_agent(session, "a1")
            a2 = await _make_agent(session, "a2")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, a1.id, "tx1")
            await session.commit()
            await _age_lease(
                session, a1.id, RoomRoleStore.LEASE_TTL + timedelta(seconds=5)
            )
            await session.commit()

            # Some *other* agent is connected: a1's lease is still stale.
            assert await store.live_holders_for_room(session, room.id, {a2.id}) == {}

    async def test_agent_room_role_reads_through_the_connection_arm(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomRoleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            agent = await _make_agent(session, "a1")
            role = await store.define_role(session, room.id, "manager", "lead", True)
            await session.commit()

            await store.acquire_lease(session, role, agent.id, "tx1")
            await session.commit()
            await _age_lease(
                session, agent.id, RoomRoleStore.LEASE_TTL + timedelta(seconds=5)
            )
            await session.commit()

            assert await store.agent_room_role(session, room.id, agent.id) is None
            assert (
                await store.agent_room_role(session, room.id, agent.id, {agent.id})
                == role.name
            )
