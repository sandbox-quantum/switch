"""Shared sessions' settings: the home room, which rooms share it, and
who may change them (CHOO-3725, stage 1).

Only the settings are covered here; nothing routes differently yet.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.commands import (
    _describe_sharing_for_room,
    _session_action,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Agent, Room
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.shared_session import Sharing, SharingRefused, sharing_marks
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_user,
    _register,
    _service,
)


async def _room(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    agent_ids: list[str],
    *,
    shared: dict[str, bool] | None = None,
) -> str:
    async with session_factory() as session:
        room = Room(transport_room_id=f"!{name}:test", name=name, description="")
        session.add(room)
        await session.flush()
        await RoomStore().add_agents(session, room.id, agent_ids, shared=shared)
        await session.commit()
        return room.id


async def _set(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str, **columns: object
) -> None:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        for key, value in columns.items():
            setattr(agent, key, value)
        await session.commit()


async def _marked(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str
) -> set[str]:
    async with session_factory() as session:
        return set(await RoomStore().shared_room_ids(session, agent_id))


async def _home(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str
) -> str | None:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        return agent.home_room_id


def _can_list_participants(svc: AgentCore) -> None:
    async def _statuses(_session, agents, _room_id):  # type: ignore[no-untyped-def]
        return dict.fromkeys((a.id for a in agents), None)

    svc.external_user_store = ExternalUserStore()  # type: ignore[attr-defined]
    svc.room_role_store = RoomRoleStore()  # type: ignore[attr-defined]
    svc.connections = SimpleNamespace(live_connection_ids=lambda: set())  # type: ignore[attr-defined]
    svc._compute_statuses = _statuses  # type: ignore[method-assign]


class TestSharing:
    def test_no_home_room_means_no_shared_session(self) -> None:
        sharing = Sharing(None, True, False, frozenset({"r1"}))
        assert not sharing.active
        assert not sharing.covers("r1")
        assert sharing.mark("r1") is None
        assert sharing.other_room_ids == []

    def test_home_is_always_covered_and_marked_rooms_are_satellites(self) -> None:
        sharing = Sharing("home", False, False, frozenset({"b", "a"}))
        assert sharing.covers("home")
        assert sharing.covers("a")
        assert not sharing.covers("local")
        assert sharing.mark("home") == "home"
        assert sharing.mark("a") == "shared"
        assert sharing.mark("local") is None
        assert sharing.other_room_ids == ["a", "b"]

    def test_marks_skip_agents_without_a_home(self) -> None:
        lead = SimpleNamespace(id="lead", home_room_id="hub")
        idle = SimpleNamespace(id="idle", home_room_id=None)
        marks = sharing_marks([lead, idle], {"lead", "idle"}, "work")  # type: ignore[list-item]
        assert marks == {"lead": "shared"}
        assert sharing_marks([lead], set(), "hub") == {"lead": "home"}  # type: ignore[list-item]


class TestJoiningARoom:
    async def test_follows_the_agents_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        local = await _register(svc, "plain", alice)
        lead = await _register(svc, "lead", alice)
        await _set(session_factory, lead, shared_by_default=True)

        room = await _room(session_factory, "work", [local, lead])

        assert await _marked(session_factory, local) == set()
        assert await _marked(session_factory, lead) == {room}

    async def test_the_choice_made_when_adding_wins_over_the_default(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        lead = await _register(svc, "lead", alice)
        other = await _register(svc, "other", alice)
        await _set(session_factory, lead, shared_by_default=True)

        await _room(session_factory, "a", [lead, other], shared={lead: False})
        room_b = await _room(session_factory, "b", [other], shared={other: True})

        assert await _marked(session_factory, lead) == set()
        assert await _marked(session_factory, other) == {room_b}

    async def test_a_locked_agent_always_joins(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        lead = await _register(svc, "lead", alice)
        await _set(session_factory, lead, sharing_locked=True)

        room = await _room(session_factory, "a", [lead], shared={lead: False})

        assert await _marked(session_factory, lead) == {room}

    async def test_leaving_the_home_room_stops_sharing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        lead = await _register(svc, "lead", alice)
        hub = await _room(session_factory, "hub", [lead])
        work = await _room(session_factory, "work", [lead])
        await _set(session_factory, lead, home_room_id=hub)

        async with session_factory() as session:
            await RoomStore().remove_agents(session, work, [lead])
            await session.commit()
        assert await _home(session_factory, lead) == hub

        async with session_factory() as session:
            await RoomStore().remove_agents(session, hub, [lead])
            await session.commit()
        assert await _home(session_factory, lead) is None


class TestChangingTheSettings:
    async def _setup(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> tuple[AgentCore, str, str, str, str]:
        svc = _service(session_factory)
        _can_list_participants(svc)
        alice = await _make_user(session_factory, "alice")
        buddy = await _register(svc, "alice-buddy", alice)
        lead = await _register(svc, "lead", alice)
        hub = await _room(session_factory, "hub", [lead])
        work = await _room(session_factory, "work", [lead])
        return svc, buddy, lead, hub, work

    async def test_owners_agent_sets_the_home_and_shares_a_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, buddy, lead, hub, work = await self._setup(session_factory)

        await svc.update_shared_session(buddy, "lead", home_room_id=hub)
        sharing = await svc.set_room_session(buddy, work, "lead", True)

        assert sharing["shared"] is True
        assert sharing["home_room"] == {"id": hub, "name": "hub"}
        assert sharing["rooms"] == [{"id": work, "name": "work"}]
        participants = await svc.list_participants(work)
        assert [p.shared_session for p in participants if p.id == lead] == ["shared"]
        participants = await svc.list_participants(hub)
        assert [p.shared_session for p in participants if p.id == lead] == ["home"]

        sharing = await svc.update_shared_session(buddy, "lead", clear_home=True)
        assert sharing["shared"] is False
        assert sharing["home_room"] is None

    async def test_home_room_must_be_one_of_its_rooms(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, buddy, _lead, _hub, _work = await self._setup(session_factory)
        elsewhere = await _room(session_factory, "elsewhere", [buddy])

        with pytest.raises(SharingRefused, match="isn't in that room"):
            await svc.update_shared_session(buddy, "lead", home_room_id=elsewhere)

    async def test_another_owners_agent_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, _buddy, lead, hub, _work = await self._setup(session_factory)
        bob = await _make_user(session_factory, "bob")
        stranger = await _register(svc, "bob-agent", bob)

        with pytest.raises(PermissionError, match="owner or a workspace admin"):
            await svc.update_shared_session(stranger, "lead", home_room_id=hub)
        with pytest.raises(PermissionError):
            await svc.set_room_session(stranger, hub, "lead", True)
        assert await _home(session_factory, lead) is None

    async def test_an_admins_agent_may(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, _buddy, lead, hub, _work = await self._setup(session_factory)
        root = await _make_user(session_factory, "root", role="admin")
        admins_agent = await _register(svc, "root-agent", root)

        await svc.update_shared_session(admins_agent, "lead", home_room_id=hub)

        assert await _home(session_factory, lead) == hub

    async def test_locking_shares_every_room_and_forbids_isolated(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, buddy, lead, hub, work = await self._setup(session_factory)

        sharing = await svc.update_shared_session(
            buddy, "lead", home_room_id=hub, locked=True
        )

        assert sharing["locked"] is True
        assert await _marked(session_factory, lead) == {hub, work}
        with pytest.raises(SharingRefused, match="locked"):
            await svc.set_room_session(buddy, work, "lead", False)

    async def test_the_home_room_cannot_be_isolated(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, buddy, _lead, hub, _work = await self._setup(session_factory)
        await svc.update_shared_session(buddy, "lead", home_room_id=hub)

        with pytest.raises(SharingRefused, match="home room"):
            await svc.set_room_session(buddy, hub, "lead", False)

    async def test_session_command_describes_the_sharing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, buddy, lead, hub, work = await self._setup(session_factory)
        await svc.update_shared_session(
            buddy, "lead", home_room_id=hub, shared_by_default=True
        )
        await svc.set_room_session(buddy, work, "lead", True)

        async with session_factory() as session:
            agent = await session.get(Agent, lead)
            assert agent is not None
            body = await _describe_sharing_for_room(
                SimpleNamespace(_room_store=RoomStore()),  # type: ignore[arg-type]
                session,
                agent,
                work,
            )
        assert "based in **hub**" in body
        assert "**work** (this room)" in body
        assert "share its session by default" in body


class TestInviting:
    async def test_choosing_needs_the_owner_or_an_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        bobs = await _register(svc, "bob-agent", bob)
        await _register(svc, "lead", alice)
        room = await _room(session_factory, "work", [bobs])

        with pytest.raises(PermissionError):
            await svc.invite_agent_to_room(bobs, room, "lead", shared=True)


@pytest.mark.parametrize(
    ("words", "action"),
    [
        ([], ""),
        (["shared"], "shared"),
        (["isolated"], "isolated"),
        (["home"], "home"),
        (["home", "off"], "home off"),
        (["off"], None),
        (["shared", "isolated"], None),
    ],
)
def test_session_command_arguments(words: list[str], action: str | None) -> None:
    assert _session_action(words) == action
