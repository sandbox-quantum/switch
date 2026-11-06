"""What the server tells the Gateway the caller may do.

The Gateway offers a room's, an agent's and a package's controls from flags the
server works out with `switch_core.authz`, so the rules live in one place. These
pin the flags against those rules: owner, workspace admin, and a member who
only has what the resource's visibility gives everyone.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_detail import agent_facing_summary
from switch_core.db.models import Package, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import list_agents
from switch_core.gateway.packages import list_room_packages
from switch_core.gateway.rooms import get_room
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user
from tests.switch_core.gateway.test_room_detail_access import (
    _ROOM_STORE,
    _USER_STORE,
    _add_room,
    _protocol,
    _svc,
)


class TestRoomPermissions:
    @pytest.mark.parametrize(
        ("caller", "write_visibility", "can_write", "can_manage"),
        [
            ("owner", "private", True, True),
            ("admin", "private", True, True),
            ("member", "public", True, False),
            ("member", "private", False, False),
        ],
    )
    async def test_the_room_detail_says_what_the_caller_may_do(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caller: str,
        write_visibility: str,
        can_write: bool,
        can_manage: bool,
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            room = await _add_room(
                session,
                name="r1",
                owner_id=owner.id,
                read_visibility="public",
                write_visibility=write_visibility,
            )
            user = owner if caller == "owner" else member

            detail = await get_room(
                room.id,
                session,
                _ROOM_STORE,
                None,  # type: ignore[arg-type]  # bridge_store: the room has no bridge
                None,  # type: ignore[arg-type]  # external_user_store
                _protocol(),
                user,
                caller == "admin",
            )

            assert (detail.can_write, detail.can_manage) == (can_write, can_manage)


class TestAgentPermissions:
    async def test_each_listed_agent_says_whether_the_caller_may_manage_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            await add_agent(session, name="mine", owner_id=owner.id)
            await add_agent(session, name="theirs", owner_id=member.id)

            async def manageable(user: User, admin: bool) -> dict[str, bool]:
                summaries = await list_agents(
                    session, AgentStore(), UserStore(), user, admin
                )
                return {s.name: s.can_manage for s in summaries}

            assert await manageable(owner, False) == {"mine": True, "theirs": False}
            assert await manageable(owner, True) == {"mine": True, "theirs": True}

    async def test_an_agent_reading_a_summary_is_not_told_the_flag(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The flag is about the Gateway's caller, not the agent reading it."""
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            await add_agent(session, name="mine", owner_id=owner.id)
            [summary] = await list_agents(
                session, AgentStore(), UserStore(), owner, False
            )

            assert "can_manage" not in agent_facing_summary(summary)


class TestRoomPackagePermissions:
    async def test_each_package_in_a_room_says_whether_the_caller_may_open_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            room = await _add_room(
                session, name="r1", owner_id=owner.id, read_visibility="public"
            )
            shared = Package(
                owner_id=owner.id,
                name="shared",
                description="",
                instructions="",
                read_visibility="public",
                write_visibility="private",
            )
            private = Package(
                owner_id=owner.id,
                name="private",
                description="",
                instructions="",
                read_visibility="private",
                write_visibility="private",
            )
            session.add_all([shared, private])
            await session.flush()
            svc = _svc(session_factory)
            for package in (shared, private):
                await svc.attach_package_to_room(
                    session,
                    room.id,
                    package.id,
                    user_id=owner.id,
                    is_admin=False,
                )

            async def readable(user: User) -> dict[str, bool]:
                packages = await list_room_packages(
                    room.id,
                    session,
                    svc,
                    _ROOM_STORE,
                    _USER_STORE,
                    user,
                    False,
                )
                return {p.name: p.can_read for p in packages}

            assert await readable(member) == {"shared": True, "private": False}
            assert await readable(owner) == {"shared": True, "private": True}
