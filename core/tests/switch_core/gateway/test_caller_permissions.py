"""What the server tells the Gateway the caller may do.

The Gateway offers a room's, an agent's and a resource's controls from flags the
server works out with `switch_core.authz`, so the rules live in one place. These
pin the flags against those rules: owner, workspace admin, and a member who
only has what the resource's visibility gives everyone.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.bridges.agent.protocol.agent_detail import (
    agent_facing_summary,
    list_agent_summaries,
)
from switch_core.db.models import Document, Package, Reference, ReferenceType, User
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.agents import get_agent_detail, list_agents
from switch_core.gateway.documents import get_document
from switch_core.gateway.packages import get_package, list_room_packages
from switch_core.gateway.references import get_reference, list_owned_reference_types
from switch_core.gateway.rooms import get_room
from switch_core.gateway.schemas import (
    AgentDetail,
    AgentSummary,
    GatewayAgentDetail,
    GatewayAgentSummary,
)
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user
from tests.switch_core.gateway.test_room_detail_access import (
    _ROOM_STORE,
    _USER_STORE,
    _add_room,
    _protocol,
    _svc,
)


def _detail_protocol() -> SimpleNamespace:
    """What `get_agent_detail` reads off the protocol, with nothing connected."""
    return SimpleNamespace(
        agent_session_store=AgentSessionStore(),
        room_role_store=RoomRoleStore(),
        connections=AgentConnectionRegistry(),
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

    async def test_each_child_in_an_agents_detail_says_whether_the_caller_may_manage_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            parent = await add_agent(session, name="parent", owner_id=owner.id)
            child = await add_agent(session, name="parent-child", owner_id=owner.id)
            child.parent_agent_id = parent.id
            await session.flush()

            async def manageable(user: User, admin: bool) -> tuple[bool, list[bool]]:
                detail = await get_agent_detail(
                    parent.id,
                    session,
                    AgentStore(),
                    _ROOM_STORE,
                    UserStore(),
                    _detail_protocol(),  # type: ignore[arg-type]
                    user,
                    admin,
                )
                return detail.can_manage, [c.can_manage for c in detail.children]

            assert await manageable(owner, False) == (True, [True])
            assert await manageable(member, False) == (False, [False])
            assert await manageable(member, True) == (True, [True])

    async def test_an_agent_never_reads_what_the_gateways_caller_may_do(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The flags are about the Gateway's caller, not the agent reading, so
        they live only on the Gateway's own models."""
        summary_flags = (
            GatewayAgentSummary.model_fields.keys() - AgentSummary.model_fields.keys()
        )
        detail_flags = (
            GatewayAgentDetail.model_fields.keys() - AgentDetail.model_fields.keys()
        )
        assert "can_manage" in summary_flags
        assert summary_flags <= detail_flags
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            await add_agent(session, name="mine", owner_id=owner.id)
            [summary] = await list_agent_summaries(session, AgentStore(), UserStore())

            assert summary_flags.isdisjoint(agent_facing_summary(summary))


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


# Who reads a resource, whether its write visibility lets everyone change it,
# and the (can_edit, can_manage) the server must report: what visibility gives
# a member is editing, never deleting, transferring or changing who may see it.
_RESOURCE_CASES = [
    ("owner", "private", True, True),
    ("admin", "private", True, True),
    ("member", "public", True, False),
    ("member", "private", False, False),
]


def _visible(owner: User, write_visibility: str) -> dict[str, object]:
    return {
        "owner_id": owner.id,
        "read_visibility": "public",
        "write_visibility": write_visibility,
        "name": f"r-{uuid.uuid4().hex[:6]}",
        "description": "",
        "instructions": "",
    }


class TestResourcePermissions:
    @pytest.mark.parametrize(
        ("caller", "write_visibility", "can_edit", "can_manage"), _RESOURCE_CASES
    )
    async def test_a_reference_says_what_the_caller_may_do(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caller: str,
        write_visibility: str,
        can_edit: bool,
        can_manage: bool,
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            reference = Reference(
                **_visible(owner, write_visibility),
                type="url",
                value={"urls": ["https://example.test"]},
            )
            session.add(reference)
            await session.flush()

            detail = await get_reference(
                reference.id,
                session,
                _svc(session_factory),
                _USER_STORE,
                owner if caller == "owner" else member,
                caller == "admin",
            )

            assert (detail.can_edit, detail.can_manage) == (can_edit, can_manage)

    @pytest.mark.parametrize(
        ("caller", "write_visibility", "can_edit", "can_manage"), _RESOURCE_CASES
    )
    async def test_a_document_says_what_the_caller_may_do(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caller: str,
        write_visibility: str,
        can_edit: bool,
        can_manage: bool,
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            document = Document(**_visible(owner, write_visibility), content="")
            session.add(document)
            await session.flush()

            detail = await get_document(
                document.id,
                session,
                _svc(session_factory),
                _USER_STORE,
                AgentStore(),
                owner if caller == "owner" else member,
                caller == "admin",
            )

            assert (detail.can_edit, detail.can_manage, detail.can_transfer) == (
                can_edit,
                can_manage,
                can_manage,
            )

    @pytest.mark.parametrize(
        ("caller", "write_visibility", "can_edit", "can_manage"), _RESOURCE_CASES
    )
    async def test_a_package_says_what_the_caller_may_do(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caller: str,
        write_visibility: str,
        can_edit: bool,
        can_manage: bool,
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            package = Package(**_visible(owner, write_visibility))
            session.add(package)
            await session.flush()

            detail = await get_package(
                package.id,
                session,
                _svc(session_factory),
                _USER_STORE,
                owner if caller == "owner" else member,
                caller == "admin",
            )

            assert (detail.can_edit, detail.can_manage) == (can_edit, can_manage)

    @pytest.mark.parametrize("caller", ["owner", "admin"])
    async def test_a_managed_reference_type_says_it_may_be_changed(
        self, session_factory: async_sessionmaker[AsyncSession], caller: str
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            member = await add_user(session, name="member")
            session.add(
                ReferenceType(
                    type="notion",
                    owner_id=owner.id,
                    read_visibility="public",
                    write_visibility="private",
                    display_name="Notion",
                    instructions="",
                    value_hint="",
                )
            )
            await session.flush()

            [listed] = await list_owned_reference_types(
                session,
                _svc(session_factory),
                _USER_STORE,
                owner if caller == "owner" else member,
                caller == "admin",
            )

            assert (listed.can_edit, listed.can_manage) == (True, True)

    async def test_a_rooms_own_document_cannot_be_transferred(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            room = await _add_room(session, name="r1", owner_id=owner.id)
            document = Document(
                **_visible(owner, "private"), content="", room_id=room.id
            )
            session.add(document)
            await session.flush()

            detail = await get_document(
                document.id,
                session,
                _svc(session_factory),
                _USER_STORE,
                AgentStore(),
                owner,
                False,
            )

            assert (detail.can_manage, detail.can_transfer) == (True, False)


class TestRoomTransfer:
    @pytest.mark.parametrize(
        ("metadata", "can_transfer"),
        [(None, True), ({"chat_operation_id": "op-1"}, False)],
    )
    async def test_a_room_says_whether_it_can_be_transferred(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        metadata: dict[str, str] | None,
        can_transfer: bool,
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            room = await _add_room(session, name="r1", owner_id=owner.id)
            room.metadata_ = metadata
            await session.flush()

            detail = await get_room(
                room.id,
                session,
                _ROOM_STORE,
                None,  # type: ignore[arg-type]  # bridge_store: the room has no bridge
                None,  # type: ignore[arg-type]  # external_user_store
                _protocol(),
                owner,
                False,
            )

            assert (detail.can_manage, detail.can_transfer) == (True, can_transfer)
