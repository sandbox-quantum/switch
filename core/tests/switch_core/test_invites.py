"""Who may bring an agent into a room.

Real Postgres and real stores: an inviter resolves through a chain of lookups,
and a fake for each link would only test the fakes. The promise under test is
that an owner gets one answer to "who can reach my agent", so the core of this
file compares what an invite is told with what a message from the same person
is told.
"""

from __future__ import annotations

import ast
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import switch_core
from switch_core.addressing import (
    AddressingPolicy,
    AddressingRule,
    owner_and_owner_agents_policy,
    owner_only_policy,
)
from switch_core.bridges.collaboration.adapter import RetireOutcome
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    Agent,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    RoomGroup,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.delivery.addressing import AddressingResolver
from switch_core.gateway.rooms import invitable_agents
from switch_core.invites import (
    InviteGate,
    Inviter,
    InviteRefused,
    invite_refusal,
    unverified_join_notice,
)
from switch_core.room_service import RoomCreateConfig, RoomService
from tests.switch_core.gateway.agent_route_harness import add_agent


def _resolver() -> AddressingResolver:
    return AddressingResolver(
        room_store=RoomStore(),
        room_role_store=RoomRoleStore(),
        client_store=ClientStore(),
        agent_store=AgentStore(),
        external_user_store=ExternalUserStore(),
        live_connection_ids=set,
    )


def _gate() -> InviteGate:
    return InviteGate(
        resolver=_resolver(),
        agent_store=AgentStore(),
        external_user_store=ExternalUserStore(),
    )


async def _member(session: AsyncSession, name: str) -> tuple[User, Client]:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    client = Client(
        transport_user_id=f"@switch-member-{user.id}:test",
        display_name=name,
        type=MEMBER_CLIENT_TYPE,
        user_id=user.id,
    )
    session.add(client)
    await session.flush()
    return user, client


async def _bridge(session: AsyncSession) -> CollaborationBridge:
    client = Client(
        transport_user_id="@bridge:test", display_name="b", type="collaboration_bridge"
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack", display_name="Slack", client_id=client.id, status="active"
    )
    session.add(bridge)
    await session.flush()
    return bridge


async def _account(
    session: AsyncSession,
    bridge: CollaborationBridge,
    name: str,
    claimed_by: User | None,
) -> tuple[ExternalUser, Client]:
    client = Client(
        transport_user_id=f"@{name}-chat:test", display_name=name, type="external_user"
    )
    session.add(client)
    await session.flush()
    account = ExternalUser(
        bridge_id=bridge.id,
        external_user_id=f"U-{name}",
        external_username=name,
        client_id=client.id,
    )
    session.add(account)
    await session.flush()
    if claimed_by is not None:
        session.add(
            ExternalUserClaim(user_id=claimed_by.id, external_user_id=account.id)
        )
        await session.flush()
    return account, client


async def _room(session: AsyncSession, name: str, group_id: str | None = None) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test", name=name, description="", group_id=group_id
    )
    session.add(room)
    await session.flush()
    return room


class _World:
    """Everyone a policy might be asked about, seeded once for each case."""

    owner: User
    stranger: User
    owner_client: Client
    stranger_client: Client
    target: Agent
    own_agent: Agent
    other_agent: Agent
    claimed_account: ExternalUser
    claimed_client: Client
    unclaimed_account: ExternalUser
    unclaimed_client: Client
    bridge: CollaborationBridge
    room: Room
    other_room: Room
    group_id: str


async def _world(session: AsyncSession) -> _World:
    world = _World()
    world.owner, world.owner_client = await _member(session, "owner")
    world.stranger, world.stranger_client = await _member(session, "stranger")
    world.target = await add_agent(session, name="target", owner_id=world.owner.id)
    world.own_agent = await add_agent(session, name="own", owner_id=world.owner.id)
    world.other_agent = await add_agent(
        session, name="other", owner_id=world.stranger.id
    )
    world.bridge = await _bridge(session)
    world.claimed_account, world.claimed_client = await _account(
        session, world.bridge, "claimed", world.owner
    )
    world.unclaimed_account, world.unclaimed_client = await _account(
        session, world.bridge, "unclaimed", None
    )
    group = RoomGroup(name="g")
    session.add(group)
    await session.flush()
    world.group_id = group.id
    world.room = await _room(session, "here", group_id=group.id)
    world.other_room = await _room(session, "elsewhere")
    return world


_POLICIES: dict[str, Callable[[_World], AddressingPolicy]] = {
    "open": lambda w: AddressingPolicy(),
    "owner_only": lambda w: owner_only_policy([]),
    "owner_and_owner_agents": lambda w: owner_and_owner_agents_policy(),
    "named_agent": lambda w: owner_only_policy([w.other_agent.id]),
    "named_account": lambda w: AddressingPolicy(
        rules=[AddressingRule(users=[w.unclaimed_account.id], agents=[])]
    ),
    "everyone_in_this_room": lambda w: AddressingPolicy(
        rules=[AddressingRule(rooms=[w.room.id])]
    ),
    "everyone_in_another_room": lambda w: AddressingPolicy(
        rules=[AddressingRule(rooms=[w.other_room.id])]
    ),
    "everyone_in_this_group": lambda w: AddressingPolicy(
        rules=[AddressingRule(room_groups=[w.group_id])]
    ),
}

_SENDERS: dict[str, Callable[[_World], Client | Agent]] = {
    "owner": lambda w: w.owner_client,
    "stranger": lambda w: w.stranger_client,
    "owners_agent": lambda w: w.own_agent,
    "someone_elses_agent": lambda w: w.other_agent,
    "claimed_chat_account": lambda w: w.claimed_client,
    "unclaimed_chat_account": lambda w: w.unclaimed_client,
}


async def _transport_id(session: AsyncSession, sender: Client | Agent) -> str:
    if isinstance(sender, Client):
        return sender.transport_user_id
    client = await session.get(Client, sender.client_id)
    assert client is not None
    return client.transport_user_id


@pytest.mark.parametrize("policy_name", _POLICIES)
@pytest.mark.parametrize("sender_name", _SENDERS)
async def test_an_invite_gets_the_answer_a_message_from_that_person_would(
    session_factory: async_sessionmaker[AsyncSession],
    policy_name: str,
    sender_name: str,
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = _POLICIES[policy_name](world).model_dump()
        await session.flush()
        transport_id = await _transport_id(session, _SENDERS[sender_name](world))

        message = await _resolver().permitted(
            session,
            agent=world.target,
            room_id=world.room.id,
            sender=transport_id,
        )
        refused = await _gate().refused(
            session,
            Inviter.sender(transport_id),
            [world.target],
            room_id=world.room.id,
            group_id=world.room.group_id,
        )
    assert (refused == []) is message.allowed


async def test_the_signed_in_owner_may_invite_and_someone_else_may_not(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        await session.flush()
        allowed = await _gate().refused(
            session,
            Inviter.person(world.owner.id),
            [world.target],
            room_id=world.room.id,
            group_id=None,
        )
        refused = await _gate().refused(
            session,
            Inviter.person(world.stranger.id),
            [world.target],
            room_id=world.room.id,
            group_id=None,
        )
    assert allowed == []
    assert [agent.id for agent in refused] == [world.target.id]


async def test_an_agent_is_judged_as_itself_and_never_as_its_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        await session.flush()
        refused = await _gate().refused(
            session,
            Inviter.agent(world.own_agent.id),
            [world.target],
            room_id=world.room.id,
            group_id=None,
        )
    assert [agent.id for agent in refused] == [world.target.id]


async def test_a_template_run_can_seat_the_private_agents_it_just_created(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        world.other_agent.addressing_policy = owner_only_policy([]).model_dump()
        await session.flush()
        refused = await _gate().refused(
            session,
            Inviter.agent(
                world.own_agent.id,
                created_for_this_run=frozenset({world.target.id}),
            ),
            [world.target, world.other_agent],
            room_id=world.room.id,
            group_id=None,
        )
    # Only what the run made. Anyone else's private agent still refuses it.
    assert [agent.id for agent in refused] == [world.other_agent.id]


async def test_an_agent_running_a_template_is_judged_as_itself_for_others_agents(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Pinned so the choice is visible: a template an agent runs brings in the
    agents it created, and is judged as that agent for everyone else's. Someone
    else's agent that takes instructions from any person, but no agent, admits the
    person and refuses the agent, even when that agent runs on the person's behalf.
    """
    async with session_factory() as session:
        world = await _world(session)
        world.other_agent.addressing_policy = AddressingPolicy(
            rules=[AddressingRule(users="*", agents=[])]
        ).model_dump()
        await session.flush()
        as_person = await _gate().refused(
            session,
            Inviter.person(world.owner.id),
            [world.other_agent],
            room_id="",
            group_id=None,
        )
        as_agent = await _gate().refused(
            session,
            Inviter.agent(world.own_agent.id, created_for_this_run=frozenset()),
            [world.other_agent],
            room_id="",
            group_id=None,
        )
    assert as_person == []
    assert [agent.id for agent in as_agent] == [world.other_agent.id]


async def test_an_agent_can_always_bring_itself_along(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        await session.flush()
        refused = await _gate().refused(
            session,
            Inviter.agent(world.target.id),
            [world.target],
            room_id=world.room.id,
            group_id=None,
        )
    assert refused == []


async def test_a_chat_account_nobody_has_seen_is_refused_by_a_restricted_agent_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        unseen = Inviter.chat_account(world.bridge.id, "U-never-seen")
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        await session.flush()
        assert await _gate().refused(
            session, unseen, [world.target], room_id="", group_id=None
        ) == [world.target]

        world.target.addressing_policy = AddressingPolicy().model_dump()
        await session.flush()
        assert (
            await _gate().refused(
                session, unseen, [world.target], room_id="", group_id=None
            )
            == []
        )


async def test_a_claimed_chat_account_is_recognised_as_its_owner(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        await session.flush()
        refused = await _gate().refused(
            session,
            Inviter.chat_account(world.bridge.id, "U-claimed"),
            [world.target],
            room_id="",
            group_id=None,
        )
    assert refused == []


async def test_a_rule_for_one_room_does_not_admit_someone_to_a_new_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = _POLICIES["everyone_in_this_room"](
            world
        ).model_dump()
        await session.flush()
        refused = await _gate().refused(
            session,
            Inviter.person(world.stranger.id),
            [world.target],
            room_id="",
            group_id=None,
        )
    assert [agent.id for agent in refused] == [world.target.id]


@pytest.mark.parametrize(
    "inviter",
    [Inviter.unknown_adder(), Inviter.switch("a reason for the reader")],
    ids=["unknown_adder", "switch"],
)
async def test_nobody_to_judge_is_never_a_refusal(
    session_factory: async_sessionmaker[AsyncSession], inviter: Inviter
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        await session.commit()
    assert (
        await _service(session_factory).refused_agents(
            inviter, [world.target.id], room_id="", group_id=None
        )
        == []
    )


def _agent(**fields: Any) -> Agent:
    return Agent(name="helper", display_name="Helper", **fields)


def test_a_refusal_says_what_happened_and_what_to_do_next() -> None:
    message = invite_refusal([_agent()], Inviter.person("u"))
    assert "Helper" in message
    assert "its owner" in message
    assert "Ask" in message


def test_a_refusal_on_chat_tells_an_unlinked_owner_how_to_be_recognised() -> None:
    chat = invite_refusal([_agent()], Inviter.sender("@u:test"))
    assert "link this chat account" in chat
    assert "link this chat account" not in invite_refusal(
        [_agent()], Inviter.person("u")
    )


def test_a_refusal_for_several_agents_reads_naturally() -> None:
    message = invite_refusal([_agent(), _agent()], Inviter.person("u"))
    assert "their owners" in message


def test_an_unverified_join_notice_names_who_can_act() -> None:
    notice = unverified_join_notice(_agent(), "sam")
    assert "didn't say who added" in notice
    assert "its owner (@sam) can remove it" in notice
    assert "its owner can remove it" in unverified_join_notice(_agent(), None)


def _async_returning(value: Any) -> Callable[..., Any]:
    async def call(*_args: Any, **_kw: Any) -> Any:
        return value

    return call


class _NeverProvisioned:
    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"reached past the invite check: {name}")


def _service(session_factory: async_sessionmaker[AsyncSession]) -> RoomService:
    never: Any = _NeverProvisioned()
    return RoomService(
        provisioning=never,
        room_store=RoomStore(),
        agent_store=AgentStore(),
        client_lifecycle=never,
        collab_lifecycle=never,
        collab_bridge_store=never,
        resource_service=never,
        session_factory=session_factory,
        room_cache=never,
    )


async def test_a_refused_new_room_is_stopped_before_anything_exists(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        before = len((await session.execute(select(Room))).scalars().all())
        await session.commit()

    with pytest.raises(InviteRefused, match="only takes instructions") as refused:
        await _service(session_factory).create_room(
            RoomCreateConfig(
                name="mine",
                description="d",
                agent_ids=[world.target.id],
                internal_only=True,
            ),
            invited_by=Inviter.person(world.stranger.id),
        )
    assert refused.value.agent_ids == [world.target.id]

    async with session_factory() as session:
        assert len((await session.execute(select(Room))).scalars().all()) == before


async def test_a_policy_change_after_preflight_rolls_back_room_creation(
    session_factory: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = AddressingPolicy().model_dump()
        await session.commit()

    async def provision(_name: str, _description: str) -> str:
        async with session_factory() as session:
            target = await session.get(Agent, world.target.id)
            assert target is not None
            target.addressing_policy = owner_only_policy([]).model_dump()
            await session.commit()
        return "!late-refusal:test"

    service = _service(session_factory)
    monkeypatch.setattr(
        service, "_provisioning", SimpleNamespace(create_room=provision)
    )
    with pytest.raises(InviteRefused):
        await service.create_room(
            RoomCreateConfig(
                name="late refusal",
                description="d",
                internal_only=True,
                agent_ids=[world.target.id],
            ),
            invited_by=Inviter.person(world.stranger.id),
        )

    async with session_factory() as session:
        assert (
            await session.scalar(select(Room.id).where(Room.name == "late refusal"))
            is None
        )


async def test_a_late_refusal_retires_the_channel_switch_just_made(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The gate is asked twice: before anything is made, and again in the
    transaction. A policy tightened between them must not strand a new channel."""
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = AddressingPolicy().model_dump()
        await session.commit()

    retired: list[str] = []
    calls = 0

    class _Adapter:
        async def get_channel_type(self, _channel_id: str) -> str:
            return "channel_public"

        async def create_channel(self, *_args: Any, **_kw: Any) -> str:
            return "C-NEW"

        async def retire_channel(self, channel_id: str) -> RetireOutcome:
            retired.append(channel_id)
            return RetireOutcome(outcome="archived")

    core = SimpleNamespace(
        adapter=_Adapter(),
        begin_provisioning=lambda _channel_id: None,
        end_provisioning=lambda _channel_id: None,
    )
    service = _service(session_factory)
    service._collab_lifecycle = SimpleNamespace(get=lambda _bridge_id: core)  # type: ignore[assignment]
    service._provisioning = SimpleNamespace(  # type: ignore[assignment]
        create_room=_async_returning("!new:test")
    )
    service._require_tenant_bridge = _async_returning(None)  # type: ignore[method-assign]
    service._require_channel_creation = _async_returning(None)  # type: ignore[method-assign]
    service._resolve_bridge_id = _async_returning(world.bridge.id)  # type: ignore[method-assign]

    real_refused = service._invites.refused

    async def tightens_after_the_first_check(*args: Any, **kw: Any) -> list[Agent]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return []
        return await real_refused(*args, **kw)

    service._invites.refused = tightens_after_the_first_check  # type: ignore[method-assign]
    async with session_factory() as session:
        agent = await session.get(Agent, world.target.id)
        assert agent is not None
        agent.addressing_policy = owner_only_policy([]).model_dump()
        await session.commit()

    with pytest.raises(InviteRefused):
        await service.create_room(
            RoomCreateConfig(
                name="made",
                description="d",
                agent_ids=[world.target.id],
                bridge_id=world.bridge.id,
                channel_type="channel_public",
            ),
            invited_by=Inviter.person(world.stranger.id),
        )

    assert retired == ["C-NEW"]


async def test_a_refused_invite_changes_nothing_in_the_room(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        await session.commit()

    with pytest.raises(InviteRefused):
        await _service(session_factory).add_agents_to_room(
            world.room.id,
            agent_ids=[world.target.id],
            invited_by=Inviter.person(world.stranger.id),
        )

    async with session_factory() as session:
        assert await RoomStore().get_agent_ids(session, world.room.id) == []


async def test_a_group_change_after_loading_the_room_cannot_allow_an_invite(
    session_factory: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = _POLICIES["everyone_in_this_group"](
            world
        ).model_dump()
        await session.commit()

    service = _service(session_factory)
    service._client_lifecycle = SimpleNamespace(  # type: ignore[assignment]
        get_by_agent_id=lambda _agent_id: SimpleNamespace(
            client_id="c1", transport_user_id="@target:test"
        )
    )
    get_room = service._room_store.get

    async def read_then_move(session: AsyncSession, room_id: str) -> Room | None:
        room = await get_room(session, room_id)
        async with session_factory() as other:
            await RoomStore().set_group(other, room_id, None, acting_is_admin=True)
            await other.commit()
        return room

    monkeypatch.setattr(service._room_store, "get", read_then_move)
    with pytest.raises(InviteRefused):
        await service.add_agents_to_room(
            world.room.id,
            agent_ids=[world.target.id],
            invited_by=Inviter.person(world.stranger.id),
        )

    async with session_factory() as session:
        assert await RoomStore().get_agent_ids(session, world.room.id) == []


async def test_one_refused_agent_keeps_the_whole_invite_out(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        world.own_agent.addressing_policy = AddressingPolicy().model_dump()
        await session.commit()

    with pytest.raises(InviteRefused) as refused:
        await _service(session_factory).add_agents_to_room(
            world.room.id,
            agent_ids=[world.own_agent.id, world.target.id],
            invited_by=Inviter.person(world.stranger.id),
        )
    assert refused.value.agent_ids == [world.target.id]

    async with session_factory() as session:
        assert await RoomStore().get_agent_ids(session, world.room.id) == []


async def test_a_refused_subagent_keeps_its_parent_out_too(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.own_agent.addressing_policy = AddressingPolicy().model_dump()
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        world.target.parent_agent_id = world.own_agent.id
        await session.commit()

    with pytest.raises(InviteRefused) as refused:
        await _service(session_factory).add_agents_to_room(
            world.room.id,
            agent_ids=[world.own_agent.id],
            include_subagents_for=[world.own_agent.id],
            invited_by=Inviter.person(world.stranger.id),
        )
    assert refused.value.agent_ids == [world.target.id]


async def test_an_agent_already_in_a_room_stays_when_its_policy_tightens(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        await RoomStore().add_agents(
            session, world.room.id, [world.target.id], join_event_listeners=set()
        )
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        await session.commit()

    await _service(session_factory).add_agents_to_room(
        world.room.id,
        agent_ids=[world.target.id],
        invited_by=Inviter.person(world.stranger.id),
    )

    async with session_factory() as session:
        assert await RoomStore().get_agent_ids(session, world.room.id) == [
            world.target.id
        ]


async def test_the_picker_question_lists_only_agents_this_person_could_invite(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        world = await _world(session)
        world.target.addressing_policy = owner_only_policy([]).model_dump()
        world.own_agent.addressing_policy = _POLICIES["everyone_in_this_group"](
            world
        ).model_dump()
        world.other_agent.addressing_policy = _POLICIES["everyone_in_this_room"](
            world
        ).model_dump()
        await session.commit()

        async def invitable(
            user: User, room_id: str | None, group_id: str | None = None
        ) -> set[str]:
            answer = await invitable_agents(
                session=session,
                room_service=_service(session_factory),
                room_store=RoomStore(),
                agent_store=AgentStore(),
                user=user,
                is_admin=group_id is not None,
                room_id=room_id,
                group_id=group_id,
            )
            return set(answer.agent_ids)

        here = await invitable(world.stranger, world.room.id)
        assert world.own_agent.id in here
        assert world.other_agent.id in here
        assert world.target.id not in here

        # A rule naming a room says nothing about a room not made yet.
        new_room = await invitable(world.stranger, None)
        assert world.own_agent.id not in new_room
        assert world.other_agent.id not in new_room
        assert world.own_agent.id in await invitable(
            world.stranger, None, world.group_id
        )

        assert world.target.id in await invitable(world.owner, world.room.id)


# Who each production path is judged as. Most of all: an agent acts on its own
# authority, not its owner's, and only a direct chat is exempt.
_EXPECTED_INVITERS = {
    "bridges/agent/commands.py": {"Inviter.sender(event.user_id)"},
    "bridges/agent/protocol/agent_core.py": {
        "Inviter.agent(agent_id)",
        "Inviter.agent(agent.id)",
    },
    "bridges/collaboration/collaboration_core.py": {"adder", "invited_by"},
    "chats/service.py": {"Inviter.person(actor.id)", "Inviter.person(user.id)"},
    "gateway/rooms.py": {"Inviter.person(user.id)"},
    "rooms_yaml.py": {
        "Inviter.agent(origin.agent_id, created_for_this_run=origin.created_agent_ids)"
        " if origin else Inviter.person(user_id)"
    },
    "template_runs.py": {"Inviter.person(owner_id)"},
}


def test_each_way_into_a_room_says_who_is_asking() -> None:
    package = Path(switch_core.__file__).parent
    found: dict[str, set[str]] = {}
    for path in package.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("add_agents_to_room", "create_room")
            ):
                invited_by = next(
                    (kw.value for kw in node.keywords if kw.arg == "invited_by"),
                    None,
                )
                if invited_by is None:
                    continue
                found.setdefault(path.relative_to(package).as_posix(), set()).add(
                    ast.unparse(invited_by)
                )
    assert found == _EXPECTED_INVITERS


# Every exemption from an owner's choice is pinned here, so adding one is a
# decision someone has to see in review, not a line that slips through.
_ALLOWED_EXEMPTIONS = {
    Path("bridges/collaboration/collaboration_core.py"): 1,
}


def test_every_exemption_from_the_invite_check_is_on_the_list() -> None:
    package = Path(switch_core.__file__).parent
    found: dict[Path, int] = {}
    for path in package.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "switch"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "Inviter"
            ):
                relative = path.relative_to(package)
                found[relative] = found.get(relative, 0) + 1
    assert found == _ALLOWED_EXEMPTIONS
