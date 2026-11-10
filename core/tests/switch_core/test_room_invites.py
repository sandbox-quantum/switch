"""One rule for inviting an agent into a room, on every path that does it.

The inviter must be in the room (owners, people and agents in it, and admins
count) and allowed to address the agent being invited. An agent inviting
through its tool is judged as its owner, or passes when the target admits
that agent itself. The gateway's half is `require_user_may_invite`; the agent
tool's is `AgentCore.invite_agent_to_room`.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    AddressingPolicy,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Agent, Room
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_invites import (
    NOT_IN_ROOM_REFUSAL,
    InviteRefused,
    invitable_agent_ids,
    require_user_may_add_to_new_room,
    require_user_may_invite,
)
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_public_room,
    _make_user,
    _register,
    _service,
)


class _RecordingRoomService:
    def __init__(self) -> None:
        self.added: list[str] = []

    async def add_agents_to_room(
        self, room_id: str, *, agent_names: list[str], **_: object
    ) -> None:
        self.added.extend(agent_names)


def _tool_service(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[AgentCore, _RecordingRoomService]:
    svc = _service(session_factory)
    rooms = _RecordingRoomService()
    svc.room_service = rooms  # type: ignore[assignment]
    return svc, rooms


async def _set_policy(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    policy: AddressingPolicy | None,
) -> None:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        agent.addressing_policy = policy.model_dump() if policy is not None else None
        await session.commit()


async def _agent(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str
) -> Agent:
    async with session_factory() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        return agent


class TestAgentTool:
    """`invite_agent_to_room`, judged as the calling agent's owner."""

    async def test_outsider_is_refused_as_not_in_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _tool_service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        alice_agent = await _register(svc, "alice-agent", alice)
        open_agent = await _register(svc, "open-agent", bob)
        await _set_policy(session_factory, open_agent, None)
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[]
        )

        with pytest.raises(InviteRefused, match="not in it"):
            await svc.invite_agent_to_room(alice_agent, room_id, "open-agent")
        assert rooms.added == []

    async def test_in_the_room_but_not_allowed_to_address_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _tool_service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        alice_agent = await _register(svc, "alice-agent", alice)
        await _register(svc, "bobs-private", bob)  # owner and owner's agents
        room_id = await _make_public_room(
            session_factory, owner_id=alice, member_agent_ids=[alice_agent]
        )

        with pytest.raises(InviteRefused, match="doesn't take requests from you"):
            await svc.invite_agent_to_room(alice_agent, room_id, "bobs-private")
        assert rooms.added == []

    async def test_in_the_room_and_allowed_is_let_through(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _tool_service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        alice_agent = await _register(svc, "alice-agent", alice)
        open_agent = await _register(svc, "open-agent", bob)
        await _set_policy(session_factory, open_agent, None)
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[alice_agent]
        )

        await svc.invite_agent_to_room(alice_agent, room_id, "open-agent")
        assert rooms.added == ["open-agent"]

    async def test_owner_counts_as_in_the_room_through_another_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Judged as the owner: Alice is in the room through one agent, so a
        second agent of hers, not in it, may invite her own third agent."""
        svc, rooms = _tool_service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        in_room = await _register(svc, "alice-in-room", alice)
        elsewhere = await _register(svc, "alice-elsewhere", alice)
        await _register(svc, "alice-worker", alice)
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[in_room]
        )

        await svc.invite_agent_to_room(elsewhere, room_id, "alice-worker")
        assert rooms.added == ["alice-worker"]

    async def test_a_target_that_trusts_the_agent_itself_lets_it_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Bob's agent names Alice's agent but not Alice: her agent may still
        bring it in."""
        svc, rooms = _tool_service(session_factory)
        alice = await _make_user(session_factory, "alice")
        bob = await _make_user(session_factory, "bob")
        alice_agent = await _register(svc, "alice-agent", alice)
        bobs = await _register(svc, "bobs-agent", bob)
        await _set_policy(session_factory, bobs, owner_only_policy([alice_agent]))
        room_id = await _make_public_room(
            session_factory, owner_id=alice, member_agent_ids=[alice_agent]
        )

        await svc.invite_agent_to_room(alice_agent, room_id, "bobs-agent")
        assert rooms.added == ["bobs-agent"]

    async def test_an_admins_agent_counts_as_in_the_room_but_still_needs_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, rooms = _tool_service(session_factory)
        admin = await _make_user(session_factory, "root", role="admin")
        bob = await _make_user(session_factory, "bob")
        admin_agent = await _register(svc, "admin-agent", admin)
        await _register(svc, "bobs-private", bob)
        open_agent = await _register(svc, "open-agent", bob)
        await _set_policy(session_factory, open_agent, None)
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[]
        )

        with pytest.raises(InviteRefused, match="doesn't take requests from you"):
            await svc.invite_agent_to_room(admin_agent, room_id, "bobs-private")
        await svc.invite_agent_to_room(admin_agent, room_id, "open-agent")
        assert rooms.added == ["open-agent"]


class TestGatewayRule:
    """`require_user_may_invite`, which `POST /gateway/rooms/{id}/agents` asks."""

    async def _ask(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        room_id: str,
        target_id: str,
        user_id: str,
        *,
        is_admin: bool = False,
    ) -> None:
        async with session_factory() as session:
            room = await session.get(Room, room_id)
            target = await session.get(Agent, target_id)
            assert room is not None and target is not None
            await require_user_may_invite(
                session,
                RoomStore(),
                ExternalUserStore(),
                room=room,
                targets=[target],
                user_id=user_id,
                is_admin=is_admin,
            )

    async def test_bystander_on_a_public_room_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        bob = await _make_user(session_factory, "bob")
        carol = await _make_user(session_factory, "carol")
        open_agent = await _register(svc, "open-agent", bob)
        await _set_policy(session_factory, open_agent, None)
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[]
        )

        with pytest.raises(InviteRefused) as refused:
            await self._ask(session_factory, room_id, open_agent, carol)
        assert str(refused.value) == NOT_IN_ROOM_REFUSAL

    async def test_someone_in_the_room_through_their_agent_may_invite_their_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        bob = await _make_user(session_factory, "bob")
        carol = await _make_user(session_factory, "carol")
        carols_in_room = await _register(svc, "carol-in-room", carol)
        carols_worker = await _register(svc, "carol-worker", carol)
        await _set_policy(
            session_factory, carols_worker, owner_and_owner_agents_policy()
        )
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[carols_in_room]
        )

        await self._ask(session_factory, room_id, carols_worker, carol)

    async def test_room_owner_may_not_invite_an_agent_that_wont_take_requests(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        bob = await _make_user(session_factory, "bob")
        carol = await _make_user(session_factory, "carol")
        carols_private = await _register(svc, "carols-private", carol)
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[]
        )

        with pytest.raises(InviteRefused, match="carols-private"):
            await self._ask(session_factory, room_id, carols_private, bob)

    async def test_admin_counts_as_in_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        bob = await _make_user(session_factory, "bob")
        admin = await _make_user(session_factory, "root", role="admin")
        open_agent = await _register(svc, "open-agent", bob)
        await _set_policy(session_factory, open_agent, None)
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[]
        )

        await self._ask(session_factory, room_id, open_agent, admin, is_admin=True)


async def test_refusals_never_mention_an_agent_live() -> None:
    """A refusal is posted to rooms by `!invite-agent`; `@name` would address
    the agent it names."""
    from switch_core.room_invites import not_addressable_refusal

    agent = Agent(name="bobs-agent", display_name="Bob's agent")
    assert "@" not in not_addressable_refusal(agent)
    assert "@" not in not_addressable_refusal(agent, markdown=True)


def test_plain_refusal_shows_no_markdown() -> None:
    """The Gateway and the agent tools show the refusal as it is."""
    from switch_core.room_invites import not_addressable_refusal

    agent = Agent(name="bobs-agent", display_name="Bob's agent")
    assert not_addressable_refusal(agent).startswith(
        "You can't invite Bob's agent (bobs-agent):"
    )
    assert "`bobs-agent`" in not_addressable_refusal(agent, markdown=True)
    assert "@" not in NOT_IN_ROOM_REFUSAL


class TestNewRoomAndCandidates:
    """Creating a room with agents, and the list a picker offers."""

    async def test_creator_may_not_put_in_an_agent_they_cannot_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        bob = await _make_user(session_factory, "bob")
        carol = await _make_user(session_factory, "carol")
        carols_private = await _register(svc, "carols-private", carol)
        open_agent = await _register(svc, "open-agent", carol)
        await _set_policy(session_factory, open_agent, None)

        async with session_factory() as session:
            private = await session.get(Agent, carols_private)
            opened = await session.get(Agent, open_agent)
            assert private is not None and opened is not None
            with pytest.raises(InviteRefused, match="carols-private"):
                await require_user_may_add_to_new_room(
                    session,
                    ExternalUserStore(),
                    targets=[opened, private],
                    user_id=bob,
                    group_id=None,
                )
            await require_user_may_add_to_new_room(
                session,
                ExternalUserStore(),
                targets=[opened, private],
                user_id=carol,
                group_id=None,
            )

    async def test_candidates_are_the_agents_the_invite_would_allow(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        bob = await _make_user(session_factory, "bob")
        carol = await _make_user(session_factory, "carol")
        carols_in_room = await _register(svc, "carol-in-room", carol)
        carols_worker = await _register(svc, "carol-worker", carol)
        bobs_private = await _register(svc, "bobs-private", bob)
        open_agent = await _register(svc, "open-agent", bob)
        await _set_policy(session_factory, open_agent, None)
        room_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[carols_in_room]
        )
        async with session_factory() as session:
            # A second room: the shared helper names every room alike.
            first = await session.get(Room, room_id)
            assert first is not None
            first.transport_room_id = "!first:test"
            await session.commit()
        outside_id = await _make_public_room(
            session_factory, owner_id=bob, member_agent_ids=[]
        )

        async with session_factory() as session:
            agents = list(
                await AgentStore().get_many(
                    session, [carols_in_room, carols_worker, bobs_private, open_agent]
                )
            )
            room = await session.get(Room, room_id)
            outside = await session.get(Room, outside_id)
            assert room is not None and outside is not None

            async def ask(target: Room | None) -> set[str]:
                return set(
                    await invitable_agent_ids(
                        session,
                        RoomStore(),
                        ExternalUserStore(),
                        agents=agents,
                        user_id=carol,
                        is_admin=False,
                        room=target,
                    )
                )

            # In the room: her own other agent and the open one; not Bob's
            # private one, nor her agent that is already there.
            assert await ask(room) == {carols_worker, open_agent}
            # Not in the room: nothing.
            assert await ask(outside) == set()
            # A new room: everything she may address.
            assert await ask(None) == {carols_in_room, carols_worker, open_agent}
