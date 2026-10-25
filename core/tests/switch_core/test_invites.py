"""Who may bring an agent into a room is who may talk to it.

Real Postgres: the inviter is resolved from the same rows a message sender is
(clients, external users and their claims, agents and their owners), and a
refused invite must leave the room exactly as it was. The platform side is
faked: provisioning hands out room ids and every agent has a running client.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import (
    ANY,
    AddressingPolicy,
    AddressingRule,
    default_agent_policy,
)
from switch_core.clients.actor import SystemActor
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.invites import Inviter, InviteRefused
from switch_core.room_service import RoomCreateConfig, RoomService


class _Provisioning:
    async def create_room(self, name: str, topic: str) -> str:
        return f"!room-{uuid.uuid4().hex[:8]}:test"

    async def invite_to_room(self, room_id: str, user_id: str) -> None:
        return None

    async def kick_user(self, room_id: str, user_id: str) -> None:
        return None


class _Admin(SystemActor):
    """The Switch app's client, recording the notices it posts."""

    def __init__(self) -> None:  # noqa: D107 - a test double, no transport
        self.notices: list[str] = []
        # Set to a real admin client row once the world has one: a new room
        # takes the admin in as a member.
        self.client_id = ""
        self.transport_user_id = ""

    async def send_admin(self, room_id: str, body: str, **_: Any) -> None:  # type: ignore[override]
        self.notices.append(body)


@dataclass
class _Clients:
    """Every agent has a running client: the one its row names."""

    by_agent: dict[str, SimpleNamespace] = field(default_factory=dict)
    admin: _Admin = field(default_factory=_Admin)

    def get_by_agent_id(self, agent_id: str) -> Any:
        return self.by_agent.get(agent_id)

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return [self.admin] if client_type == "admin" else []

    def get(self, client_id: str) -> Any:
        return None


@dataclass
class World:
    service: RoomService
    session_factory: async_sessionmaker[AsyncSession]
    users: dict[str, str] = field(default_factory=dict)
    agents: dict[str, Agent] = field(default_factory=dict)
    chat: dict[str, str] = field(default_factory=dict)
    external: dict[str, str] = field(default_factory=dict)
    #: Each chat person's account id on the platform, as a join reports it.
    platform_ids: dict[str, str] = field(default_factory=dict)
    bridge_id: str = ""
    room_id: str = ""

    @property
    def notices(self) -> list[str]:
        return self.service._client_lifecycle.admin.notices  # type: ignore[attr-defined]

    async def room_agents(self, room_id: str | None = None) -> set[str]:
        async with self.session_factory() as session:
            ids = await RoomStore().get_agent_ids(session, room_id or self.room_id)
        return {name for name, agent in self.agents.items() if agent.id in ids}

    async def add(self, inviter: Inviter, *names: str) -> None:
        await self.service.add_agents_to_room(
            self.room_id,
            agent_ids=[self.agents[n].id for n in names],
            invited_by=inviter,
        )

    async def set_policy(self, name: str, policy: AddressingPolicy | None) -> None:
        async with self.session_factory() as session:
            agent = await session.get(Agent, self.agents[name].id)
            assert agent is not None
            agent.addressing_policy = policy.model_dump() if policy else None
            await session.commit()


async def _make_world(session_factory: async_sessionmaker[AsyncSession]) -> World:
    """Ada owns private-helper (the default policy: Ada and Ada's agents),
    open-helper (no policy) and ada-bot; Bo owns bo-bot. In chat, ada-chat is
    claimed by Ada, bo-chat by Bo, and stranger-chat by nobody."""
    tag = uuid.uuid4().hex[:8]
    clients = _Clients()
    service = object.__new__(RoomService)
    service._session_factory = session_factory  # type: ignore[assignment]
    service._room_store = RoomStore()  # type: ignore[assignment]
    service._agent_store = AgentStore()  # type: ignore[assignment]
    service._client_lifecycle = clients  # type: ignore[assignment]
    service._collab_lifecycle = SimpleNamespace(get=lambda _id: None)  # type: ignore[assignment]
    service._collab_bridge_store = CollaborationBridgeStore()  # type: ignore[assignment]
    service._provisioning = _Provisioning()  # type: ignore[assignment]
    world = World(service=service, session_factory=session_factory)

    async with session_factory() as session:
        for name in ("Ada", "Bo"):
            user = User(
                name=name,
                email=f"{name.lower()}-{tag}@example.invalid",
                role="user",
                password_hash="x",
            )
            session.add(user)
            await session.flush()
            world.users[name] = user.id

        agents = {
            "private-helper": ("Ada", default_agent_policy()),
            "open-helper": ("Ada", None),
            "ada-bot": ("Ada", default_agent_policy()),
            "bo-bot": ("Bo", default_agent_policy()),
        }
        for name, (owner, policy) in agents.items():
            mxid = f"@{name}-{tag}:test"
            key = ApiKey(
                user_id=world.users[owner],
                key_hash=f"hash-{name}-{tag}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            client = Client(transport_user_id=mxid, display_name=name, type="agent")
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
                owner_id=world.users[owner],
                addressing_policy=policy.model_dump() if policy else None,
            )
            session.add(agent)
            await session.flush()
            world.agents[name] = agent
            clients.by_agent[agent.id] = SimpleNamespace(
                client_id=client.id, transport_user_id=mxid
            )

        bridge_client = Client(
            transport_user_id=f"@bridge-{tag}:test", display_name="b", type="bridge"
        )
        admin_client = Client(
            transport_user_id=f"@switch-admin-{tag}:test",
            display_name="Switch",
            type="admin",
        )
        session.add_all([bridge_client, admin_client])
        await session.flush()
        clients.admin.client_id = admin_client.id
        clients.admin.transport_user_id = admin_client.transport_user_id
        bridge = CollaborationBridge(
            type="mattermost",
            display_name="MM",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        for person, claimed_by in (
            ("ada-chat", "Ada"),
            ("bo-chat", "Bo"),
            ("stranger-chat", None),
        ):
            mxid = f"@{person}-{tag}:test"
            client = Client(
                transport_user_id=mxid, display_name=person, type="external_user"
            )
            session.add(client)
            await session.flush()
            external = ExternalUser(
                bridge_id=bridge.id,
                external_user_id=f"U-{person}-{tag}",
                external_username=person,
                client_id=client.id,
            )
            session.add(external)
            await session.flush()
            if claimed_by:
                session.add(
                    ExternalUserClaim(
                        external_user_id=external.id, user_id=world.users[claimed_by]
                    )
                )
            world.chat[person] = mxid
            world.external[person] = external.id
            world.platform_ids[person] = external.external_user_id
        world.bridge_id = bridge.id

        room = Room(
            transport_room_id=f"!room-{tag}:test",
            name="room",
            description="d",
            channel_type="channel_public",
            bridge_id=bridge.id,
        )
        session.add(room)
        await session.commit()
        world.room_id = room.id
    return world


@pytest.fixture
async def world(session_factory: async_sessionmaker[AsyncSession]) -> World:
    return await _make_world(session_factory)


# ── The owner, and anyone the policy allows, can still invite ────────────────


async def test_the_owner_can_invite_their_agent(world: World) -> None:
    await world.add(Inviter.user(world.users["Ada"]), "private-helper")
    assert await world.room_agents() == {"private-helper"}


async def test_the_owner_can_invite_from_a_chat_account_they_claimed(
    world: World,
) -> None:
    await world.add(Inviter.chat(world.chat["ada-chat"]), "private-helper")
    assert await world.room_agents() == {"private-helper"}


async def test_the_owners_own_agent_can_invite_it(world: World) -> None:
    await world.add(Inviter.agent(world.agents["ada-bot"].id), "private-helper")
    assert await world.room_agents() == {"private-helper"}


async def test_an_open_policy_lets_anyone_invite(world: World) -> None:
    await world.add(Inviter.user(world.users["Bo"]), "open-helper")
    await world.service.remove_agents_from_room(
        world.room_id, [world.agents["open-helper"].id]
    )
    await world.add(Inviter.agent(world.agents["bo-bot"].id), "open-helper")
    await world.service.remove_agents_from_room(
        world.room_id, [world.agents["open-helper"].id]
    )
    await world.add(Inviter.chat(world.chat["stranger-chat"]), "open-helper")
    assert await world.room_agents() == {"open-helper"}


async def test_someone_the_policy_names_can_invite(world: World) -> None:
    # Bo's chat account is on the allow-list. Bo is admitted typing in chat,
    # and in Switch itself, through the account Bo claimed.
    await world.set_policy(
        "private-helper",
        AddressingPolicy(
            rules=[
                *default_agent_policy().rules,
                AddressingRule(users=[world.external["bo-chat"]], agents=[]),
            ]
        ),
    )
    await world.add(Inviter.chat(world.chat["bo-chat"]), "private-helper")
    await world.service.remove_agents_from_room(
        world.room_id, [world.agents["private-helper"].id]
    )
    await world.add(Inviter.user(world.users["Bo"]), "private-helper")
    assert await world.room_agents() == {"private-helper"}
    await world.service.remove_agents_from_room(
        world.room_id, [world.agents["private-helper"].id]
    )
    with pytest.raises(InviteRefused):
        await world.add(Inviter.chat(world.chat["stranger-chat"]), "private-helper")


# ── Everyone else is refused, with a reason and who can do it ────────────────


async def test_someone_else_is_refused_and_told_who_can_add_it(world: World) -> None:
    with pytest.raises(InviteRefused) as refused:
        await world.add(Inviter.user(world.users["Bo"]), "private-helper")
    message = str(refused.value)
    assert world.agents["private-helper"].name in message
    assert "its owner, Ada," in message
    assert "addressing policy doesn't include you" in message
    assert await world.room_agents() == set()


async def test_someone_elses_agent_is_refused(world: World) -> None:
    with pytest.raises(InviteRefused):
        await world.add(Inviter.agent(world.agents["bo-bot"].id), "private-helper")
    assert await world.room_agents() == set()


async def test_a_chat_account_someone_else_claimed_is_refused(world: World) -> None:
    with pytest.raises(InviteRefused, match="its owner, Ada,"):
        await world.add(Inviter.chat(world.chat["bo-chat"]), "private-helper")
    assert await world.room_agents() == set()


async def test_an_unclaimed_chat_account_is_told_to_link_it(world: World) -> None:
    with pytest.raises(InviteRefused, match="isn't linked to a Switch user yet"):
        await world.add(Inviter.chat(world.chat["stranger-chat"]), "private-helper")
    assert await world.room_agents() == set()


async def test_an_unknown_sender_is_refused(world: World) -> None:
    with pytest.raises(InviteRefused):
        await world.add(Inviter.chat("@nobody:test"), "private-helper")
    with pytest.raises(InviteRefused):
        await world.add(Inviter.agent(str(uuid.uuid4())), "private-helper")


async def test_one_refused_agent_stops_the_whole_invite(world: World) -> None:
    # Nothing is half-done: open-helper is not added because private-helper
    # is refused.
    with pytest.raises(InviteRefused):
        await world.add(
            Inviter.user(world.users["Bo"]), "open-helper", "private-helper"
        )
    assert await world.room_agents() == set()


async def test_an_agent_the_check_cannot_find_is_an_error_not_a_pass(
    world: World,
) -> None:
    # An agent the gate cannot read (a wrong id, or one outside the room's
    # tenant) has no policy to judge; letting it through would skip the check.
    with pytest.raises(ValueError, match="Agent not found"):
        await world.service.add_agents_to_room(
            world.room_id,
            agent_ids=[world.agents["private-helper"].id, "no-such-agent"],
            invited_by=Inviter.user(world.users["Ada"]),
        )
    assert await world.room_agents() == set()


# ── Agents already in a room stay ────────────────────────────────────────────


async def test_tightening_a_policy_does_not_remove_an_agent(world: World) -> None:
    await world.add(Inviter.user(world.users["Bo"]), "open-helper")
    await world.set_policy("open-helper", default_agent_policy())
    # Someone the new policy refuses can still add others, and the agent the
    # policy now covers is neither removed nor refused for being there.
    await world.add(Inviter.user(world.users["Bo"]), "open-helper", "bo-bot")
    assert await world.room_agents() == {"open-helper", "bo-bot"}


# ── Joins made on the platform ───────────────────────────────────────────────


async def test_a_platform_join_is_judged_as_whoever_added_the_bot(
    world: World,
) -> None:
    await world.add(
        Inviter.platform(world.bridge_id, world.platform_ids["ada-chat"]),
        "private-helper",
    )
    assert await world.room_agents() == {"private-helper"}
    assert world.notices == []


async def test_a_platform_join_by_someone_not_allowed_is_left_out_and_said(
    world: World,
) -> None:
    # The bot is already in the channel on the platform, so nothing is raised:
    # the agent stays out of the room and the room is told why. Others in the
    # same join are still added.
    await world.add(
        Inviter.platform(world.bridge_id, world.platform_ids["bo-chat"]),
        "private-helper",
        "bo-bot",
    )
    assert await world.room_agents() == {"bo-bot"}
    (notice,) = world.notices
    assert "didn't bring it into this room" in notice
    assert "Ask its owner, Ada," in notice


async def test_someone_switch_has_never_seen_is_an_unlinked_account(
    world: World,
) -> None:
    await world.add(Inviter.platform(world.bridge_id, "U-never-seen"), "private-helper")
    assert await world.room_agents() == set()
    assert "isn't linked to a Switch user yet" in world.notices[0]


async def test_an_unattributed_platform_join_is_let_in_and_said(
    world: World, caplog: pytest.LogCaptureFixture
) -> None:
    # Never trusted, never silent: in the room, a notice, a warning, and the
    # owner @-mentioned on their own linked account.
    await world.add(Inviter.platform(world.bridge_id, None), "private-helper")
    assert await world.room_agents() == {"private-helper"}
    (notice,) = world.notices
    assert "didn't say who added it" in notice
    assert "its owner (@ada-chat)" in notice
    assert f"!remove-agent @{world.agents['private-helper'].name}" in notice
    assert any("let in unverified" in r.getMessage() for r in caplog.records)


# ── Creating a room with agents ──────────────────────────────────────────────


async def _room_count(world: World) -> int:
    async with world.session_factory() as session:
        return (
            await session.execute(select(func.count()).select_from(Room))
        ).scalar_one()


def _new_room(*agents: Agent) -> RoomCreateConfig:
    return RoomCreateConfig(
        name="new",
        description="d",
        agent_ids=[a.id for a in agents],
        internal_only=True,
    )


async def test_creating_a_room_with_an_agent_needs_the_same_permission(
    world: World,
) -> None:
    before = await _room_count(world)
    with pytest.raises(InviteRefused):
        await world.service.create_room(
            _new_room(world.agents["private-helper"]),
            invited_by=Inviter.user(world.users["Bo"]),
        )
    assert await _room_count(world) == before

    created = await world.service.create_room(
        _new_room(world.agents["private-helper"]),
        invited_by=Inviter.user(world.users["Ada"]),
    )
    assert await world.room_agents(created.room.id) == {"private-helper"}


async def test_a_rule_for_one_room_admits_invites_there_only(world: World) -> None:
    # A room being created has no id yet, so a rule naming rooms cannot admit
    # an invite into it.
    await world.set_policy(
        "private-helper",
        AddressingPolicy(rules=[AddressingRule(rooms=[world.room_id], users=ANY)]),
    )
    await world.add(Inviter.user(world.users["Bo"]), "private-helper")
    assert await world.room_agents() == {"private-helper"}
    with pytest.raises(InviteRefused):
        await world.service.create_room(
            _new_room(world.agents["private-helper"]),
            invited_by=Inviter.user(world.users["Bo"]),
        )
