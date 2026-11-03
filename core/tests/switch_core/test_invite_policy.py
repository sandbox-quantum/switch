"""Inviting an agent follows its addressing policy (`invite_policy`).

Whoever the policy lets talk to an agent in a room may bring it into that
room; nobody else may. The first half pins the decision itself, which is pure.
The second half runs `RoomService` against a real Postgres: a refused invite
adds nothing, and agents already in a room stay there.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    AddressingPolicy,
    AddressingRule,
    owner_and_owner_agents_policy,
    owner_only_policy,
    platform_allowed_policy,
)
from switch_core.db.models import Agent, ApiKey, Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import SenderPrincipal
from switch_core.invite_policy import (
    Inviter,
    InviteRefused,
    may_invite,
    require_may_invite,
)
from switch_core.room_service import RoomCreateConfig, RoomService

OWNER = "user-owner"
STRANGER = "user-stranger"


def _agent(policy: AddressingPolicy | None, *, name: str = "helper") -> Agent:
    return Agent(
        id=f"agent-{name}",
        name=name,
        owner_id=OWNER,
        addressing_policy=policy.model_dump() if policy is not None else None,
    )


# ── The decision ────────────────────────────────────────────────────────────


class TestMayInvite:
    def test_an_open_agent_can_be_invited_by_anyone(self) -> None:
        agent = _agent(None)
        assert may_invite(agent, Inviter.person(STRANGER), room_id="r", group_id=None)
        assert may_invite(
            agent, Inviter.agent("other-agent", STRANGER), room_id="r", group_id=None
        )
        # Even a sender nobody can name: an open agent asks nothing of them.
        assert may_invite(agent, Inviter.from_sender(None), room_id="r", group_id=None)

    def test_owner_only_admits_the_owner_and_refuses_everyone_else(self) -> None:
        agent = _agent(owner_only_policy([]))
        assert may_invite(agent, Inviter.person(OWNER), room_id="r", group_id=None)
        assert not may_invite(
            agent, Inviter.person(STRANGER), room_id="r", group_id=None
        )
        assert not may_invite(
            agent, Inviter.agent("owners-agent", OWNER), room_id="r", group_id=None
        )

    def test_the_default_policy_also_admits_the_owners_own_agents(self) -> None:
        agent = _agent(owner_and_owner_agents_policy())
        assert may_invite(
            agent, Inviter.agent("owners-agent", OWNER), room_id="r", group_id=None
        )
        assert not may_invite(
            agent, Inviter.agent("strangers-agent", STRANGER), room_id="r", group_id=None
        )

    def test_a_chat_sender_is_judged_by_who_claimed_their_account(self) -> None:
        agent = _agent(owner_only_policy([]))
        owner_in_chat = SenderPrincipal("user", "ext-1", [OWNER], None)
        stranger_in_chat = SenderPrincipal("user", "ext-2", [STRANGER], None)
        nobody_claimed = SenderPrincipal("user", "ext-3", [], None)
        assert may_invite(
            agent, Inviter.from_sender(owner_in_chat), room_id="r", group_id=None
        )
        assert not may_invite(
            agent, Inviter.from_sender(stranger_in_chat), room_id="r", group_id=None
        )
        assert not may_invite(
            agent, Inviter.from_sender(nobody_claimed), room_id="r", group_id=None
        )

    def test_a_restricted_agent_refuses_a_sender_nobody_can_name(self) -> None:
        agent = _agent(owner_only_policy([]))
        assert not may_invite(
            agent, Inviter.from_sender(None), room_id="r", group_id=None
        )

    def test_a_users_list_admits_the_people_it_names(self) -> None:
        policy = AddressingPolicy(
            rules=[AddressingRule(users=["ext-friend"], agents=[], owner=True)]
        )
        agent = _agent(policy)
        friend = SenderPrincipal("user", "ext-friend", [STRANGER], None)
        assert may_invite(agent, Inviter.from_sender(friend), room_id="r", group_id=None)

    def test_room_scoped_rules_follow_the_room_invited_into(self) -> None:
        policy = AddressingPolicy(
            rules=[AddressingRule(rooms=["room-a"], users="*", agents=[])]
        )
        agent = _agent(policy)
        anyone = SenderPrincipal("user", "ext-1", [STRANGER], None)
        inviter = Inviter.from_sender(anyone)
        assert may_invite(agent, inviter, room_id="room-a", group_id=None)
        assert not may_invite(agent, inviter, room_id="room-b", group_id=None)
        # A room not made yet is named by no rule.
        assert not may_invite(agent, inviter, room_id="", group_id=None)

    def test_the_platform_speaking_for_someone_is_judged_as_them(self) -> None:
        agent = _agent(owner_only_policy([]))
        for_owner = SenderPrincipal("platform", "admin", [], None, on_behalf_of=OWNER)
        for_stranger = SenderPrincipal(
            "platform", "admin", [], None, on_behalf_of=STRANGER
        )
        assert may_invite(
            agent, Inviter.from_sender(for_owner), room_id="r", group_id=None
        )
        assert not may_invite(
            agent, Inviter.from_sender(for_stranger), room_id="r", group_id=None
        )

    def test_the_platform_on_its_own_needs_a_platform_rule(self) -> None:
        bare = Inviter.from_sender(SenderPrincipal("platform", "admin", [], None))
        assert not may_invite(_agent(None), bare, room_id="r", group_id=None)
        assert may_invite(
            _agent(platform_allowed_policy()), bare, room_id="r", group_id=None
        )

    def test_system_is_not_judged(self) -> None:
        agent = _agent(owner_only_policy([]))
        assert may_invite(agent, Inviter.system(), room_id="r", group_id=None)


class TestRefusal:
    def test_names_the_agents_and_who_can_invite_them(self) -> None:
        refused = [_agent(owner_only_policy([]), name="private-helper")]
        with pytest.raises(InviteRefused) as caught:
            require_may_invite(
                refused, Inviter.person(STRANGER), room_id="r", group_id=None
            )
        assert caught.value.agent_names == ["private-helper"]
        message = caught.value.message
        assert "`private-helper`" in message
        assert "Ask the owner to invite it" in message
        assert isinstance(caught.value, PermissionError)

    def test_lists_only_the_refused_agents(self) -> None:
        agents = [
            _agent(None, name="open-helper"),
            _agent(owner_only_policy([]), name="private-helper"),
        ]
        with pytest.raises(InviteRefused) as caught:
            require_may_invite(
                agents, Inviter.person(STRANGER), room_id="r", group_id=None
            )
        assert caught.value.agent_names == ["private-helper"]
        assert "open-helper" not in caught.value.message

    def test_tells_an_unlinked_chat_account_how_to_be_recognised(self) -> None:
        unclaimed = Inviter.from_sender(SenderPrincipal("user", "ext-3", [], None))
        with pytest.raises(InviteRefused) as caught:
            require_may_invite(
                [_agent(owner_only_policy([]))], unclaimed, room_id="r", group_id=None
            )
        assert "isn't linked to your Switch user" in caught.value.message

    def test_passes_when_everyone_is_allowed(self) -> None:
        require_may_invite(
            [_agent(owner_only_policy([]))],
            Inviter.person(OWNER),
            room_id="r",
            group_id=None,
        )


# ── RoomService, against Postgres ────────────────────────────────────────────


class _Provisioning:
    def __init__(self) -> None:
        self.invited: list[str] = []

    async def invite_to_room(self, transport_room_id: str, user_id: str) -> None:
        self.invited.append(user_id)


class _Clients:
    def __init__(self, by_agent: dict[str, Any]) -> None:
        self._by_agent = by_agent
        self._by_id = {c.client_id: c for c in by_agent.values()}

    def get_by_agent_id(self, agent_id: str) -> Any:
        return self._by_agent.get(agent_id)

    def get(self, client_id: str) -> Any:
        return self._by_id.get(client_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str, str, dict[str, str], dict[str, Any]]:
    """An owner, a stranger, a room, and two of the owner's agents: one
    owner-only (`private`) and one open (`open`). Neither is in the room."""
    async with session_factory() as session:
        owner = User(name="owner", email="owner@test", role="user", password_hash="x")
        stranger = User(
            name="stranger", email="stranger@test", role="user", password_hash="x"
        )
        session.add_all([owner, stranger])
        await session.flush()
        ids: dict[str, str] = {}
        running: dict[str, Any] = {}
        for name, policy in (("private", owner_only_policy([])), ("open", None)):
            key = ApiKey(
                user_id=owner.id,
                key_hash=f"hash-{name}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            client = Client(
                transport_user_id=f"@{name}:test", display_name=name, type="agent"
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=name,
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=owner.id,
                addressing_policy=policy.model_dump() if policy else None,
            )
            session.add(agent)
            await session.flush()
            ids[name] = agent.id
            running[agent.id] = SimpleNamespace(
                client_id=client.id, transport_user_id=client.transport_user_id
            )
        room = Room(transport_room_id="!r:test", name="room", description="d")
        session.add(room)
        await session.commit()
        return owner.id, stranger.id, room.id, ids, running


def _service(
    session_factory: async_sessionmaker[AsyncSession], running: dict[str, Any]
) -> tuple[RoomService, _Provisioning]:
    provisioning = _Provisioning()
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._provisioning = provisioning  # type: ignore[assignment]
    svc._client_lifecycle = _Clients(running)  # type: ignore[assignment]
    svc._collab_lifecycle = _Clients({})  # type: ignore[assignment]
    svc._room_cache = SimpleNamespace(  # type: ignore[assignment]
        invalidate=lambda tenant_id, room_id: None
    )
    svc._room_listeners = ()
    svc._room_agents_listeners = ()
    svc._telemetry = None
    return svc, provisioning


async def _members(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> set[str]:
    async with session_factory() as session:
        return set(await RoomStore().get_agent_ids(session, room_id))


class TestAddAgentsToRoom:
    async def test_a_stranger_cannot_invite_an_owner_only_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _owner, stranger, room_id, ids, running = await _seed(session_factory)
        svc, provisioning = _service(session_factory, running)

        with pytest.raises(InviteRefused) as caught:
            await svc.add_agents_to_room(
                room_id, agent_ids=[ids["private"]], invited_by=Inviter.person(stranger)
            )

        assert caught.value.agent_names == ["private"]
        assert await _members(session_factory, room_id) == set()
        assert provisioning.invited == []

    async def test_one_refused_agent_stops_the_whole_invite(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _owner, stranger, room_id, ids, running = await _seed(session_factory)
        svc, provisioning = _service(session_factory, running)

        with pytest.raises(InviteRefused):
            await svc.add_agents_to_room(
                room_id,
                agent_ids=[ids["open"], ids["private"]],
                invited_by=Inviter.person(stranger),
            )

        assert await _members(session_factory, room_id) == set()
        assert provisioning.invited == []

    async def test_the_owner_can_invite_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, _stranger, room_id, ids, running = await _seed(session_factory)
        svc, provisioning = _service(session_factory, running)

        await svc.add_agents_to_room(
            room_id, agent_ids=[ids["private"]], invited_by=Inviter.person(owner)
        )

        assert await _members(session_factory, room_id) == {ids["private"]}
        assert provisioning.invited == ["@private:test"]

    async def test_anyone_can_invite_an_open_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _owner, stranger, room_id, ids, running = await _seed(session_factory)
        svc, _provisioning = _service(session_factory, running)

        await svc.add_agents_to_room(
            room_id, agent_ids=[ids["open"]], invited_by=Inviter.person(stranger)
        )

        assert await _members(session_factory, room_id) == {ids["open"]}

    async def test_an_agent_already_in_the_room_stays_and_is_not_rechecked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, stranger, room_id, ids, running = await _seed(session_factory)
        svc, _provisioning = _service(session_factory, running)
        await svc.add_agents_to_room(
            room_id, agent_ids=[ids["private"]], invited_by=Inviter.person(owner)
        )

        # Already a member: nothing to add, so nothing to refuse.
        await svc.add_agents_to_room(
            room_id, agent_ids=[ids["private"]], invited_by=Inviter.person(stranger)
        )
        # Inviting someone else alongside it judges only the newcomer.
        await svc.add_agents_to_room(
            room_id,
            agent_ids=[ids["private"], ids["open"]],
            invited_by=Inviter.person(stranger),
        )

        assert await _members(session_factory, room_id) == {
            ids["private"],
            ids["open"],
        }


class TestCreateRoomWithAgents:
    async def test_a_user_cannot_create_a_room_with_an_agent_they_may_not_use(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _owner, stranger, _room_id, ids, running = await _seed(session_factory)
        svc, _provisioning = _service(session_factory, running)
        config = RoomCreateConfig(
            name="new", description="d", agent_ids=[ids["private"]], created_by=stranger
        )

        with pytest.raises(InviteRefused):
            await svc._require_may_invite_to_new_room(config, [ids["private"]])

    async def test_the_owner_can(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, _stranger, _room_id, ids, running = await _seed(session_factory)
        svc, _provisioning = _service(session_factory, running)
        config = RoomCreateConfig(
            name="new", description="d", agent_ids=[ids["private"]], created_by=owner
        )

        await svc._require_may_invite_to_new_room(config, [ids["private"]])

    async def test_an_agent_creating_a_room_is_judged_as_that_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner, _stranger, _room_id, ids, running = await _seed(session_factory)
        svc, _provisioning = _service(session_factory, running)
        # `open` is the owner's agent, but `private` is owner-only: not even
        # the owner's own agents may bring it along.
        config = RoomCreateConfig(
            name="new",
            description="d",
            agent_ids=[ids["private"]],
            created_by=owner,
            created_by_kind="agent",
            created_by_agent_id=ids["open"],
        )

        with pytest.raises(InviteRefused):
            await svc._require_may_invite_to_new_room(config, [ids["private"]])

    async def test_a_room_the_platform_delivered_is_not_judged(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        _owner, _stranger, _room_id, ids, running = await _seed(session_factory)
        svc, _provisioning = _service(session_factory, running)
        config = RoomCreateConfig(
            name="channel",
            description="d",
            agent_ids=[ids["private"]],
            created_by_kind="system",
        )

        await svc._require_may_invite_to_new_room(config, [ids["private"]])
