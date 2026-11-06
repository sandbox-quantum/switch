"""Invitation boundaries against real PostgreSQL; network provisioning is stubbed."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.addressing import owner_and_owner_agents_policy, owner_only_policy
from switch_core.bridges.agent.protocol.agent_detail import agent_summary
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.bridges.collaboration.models import InboundAgentJoin
from switch_core.db.models import Agent, Client, Room
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.agents import _for_caller, _invitation_warnings
from switch_core.invitations import (
    InvitationActor,
    InvitationDenied,
    require_invitation,
)
from switch_core.room_service import RoomCreateConfig, RoomService
from tests.switch_core.gateway.agent_route_harness import add_agent, add_user


async def seed(factory: async_sessionmaker[AsyncSession]):  # type: ignore[no-untyped-def]
    async with factory() as session:
        owner = await add_user(session, name="owner")
        other = await add_user(session, name="other", role="admin")
        target = await add_agent(session, name="target", owner_id=owner.id)
        target.addressing_policy = owner_only_policy([]).model_dump()
        room = Room(
            name="Private rehearsal", description="", transport_room_id="!room:test"
        )
        session.add(room)
        await session.commit()
    return owner, other, target, room


def service(factory, target):  # type: ignore[no-untyped-def]
    svc = object.__new__(RoomService)
    svc._session_factory = factory
    svc._room_store = RoomStore()
    svc._agent_store = AgentStore()
    svc._provisioning = SimpleNamespace(
        invite_to_room=AsyncMock(), create_room=AsyncMock()
    )
    svc._collab_lifecycle = SimpleNamespace(get=lambda _: None)
    svc._client_lifecycle = SimpleNamespace(
        get_by_agent_id=lambda _: SimpleNamespace(
            client_id=target.client_id, transport_user_id="@target:test"
        ),
        get_by_type=lambda *_: [],
    )
    return svc


@pytest.mark.parametrize(
    "actor_kind", ["user", "agent", "sender", "external", "missing"]
)
async def test_missing_or_unpermitted_actor_never_inherits_admin_authority(
    session_factory, actor_kind
):  # type: ignore[no-untyped-def]
    owner, admin, target, room = await seed(session_factory)
    async with session_factory() as session:
        actor = (
            None
            if actor_kind == "missing"
            else InvitationActor(kind=actor_kind, id=admin.id)
        )
        with pytest.raises(InvitationDenied, match="agent's owner"):
            await require_invitation(
                session, agent=target, actor=actor, room_id=room.id, group_id=None
            )


async def test_owner_and_allowed_owner_agent_work_but_another_owners_agent_does_not(
    session_factory,
):  # type: ignore[no-untyped-def]
    owner, other, target, room = await seed(session_factory)
    async with session_factory() as session:
        own_agent = await add_agent(session, name="own-worker", owner_id=owner.id)
        stranger_agent = await add_agent(
            session, name="stranger-worker", owner_id=other.id
        )
        target = await session.get(Agent, target.id)
        assert target is not None
        target.addressing_policy = owner_and_owner_agents_policy().model_dump()
        for actor in [
            InvitationActor(kind="user", id=owner.id),
            InvitationActor(kind="agent", id=own_agent.id),
        ]:
            assert not await require_invitation(
                session, agent=target, actor=actor, room_id=room.id, group_id=None
            )
        with pytest.raises(InvitationDenied):
            await require_invitation(
                session,
                agent=target,
                actor=InvitationActor(kind="agent", id=stranger_agent.id),
                room_id=room.id,
                group_id=None,
            )


async def test_transport_member_resolves_to_owner_without_a_display_name_guess(
    session_factory,
):  # type: ignore[no-untyped-def]
    from switch_core.chats import MEMBER_CLIENT_TYPE

    owner, _, target, room = await seed(session_factory)
    async with session_factory() as session:
        sender = Client(
            type=MEMBER_CLIENT_TYPE,
            transport_user_id="opaque-person",
            display_name="Unrelated label",
            user_id=owner.id,
        )
        session.add(sender)
        await session.flush()
        assert not await require_invitation(
            session,
            agent=target,
            actor=InvitationActor(kind="sender", id=sender.transport_user_id),
            room_id=room.id,
            group_id=None,
        )


async def test_room_scoping_is_checked_for_creation_and_existing_room(session_factory):  # type: ignore[no-untyped-def]
    owner, _, target, room = await seed(session_factory)
    target.addressing_policy = {
        "rules": [{"rooms": [room.id], "users": [], "agents": [], "owner": True}]
    }
    async with session_factory() as session:
        actor = InvitationActor(kind="user", id=owner.id)
        assert not await require_invitation(
            session, agent=target, actor=actor, room_id=room.id, group_id=None
        )
        with pytest.raises(InvitationDenied):
            await require_invitation(
                session, agent=target, actor=actor, room_id="", group_id=None
            )


async def test_refused_add_has_no_membership_or_provisioning_effect(session_factory):  # type: ignore[no-untyped-def]
    _, other, target, room = await seed(session_factory)
    svc = service(session_factory, target)
    with pytest.raises(InvitationDenied):
        await svc.add_agents_to_room(
            room.id,
            agent_ids=[target.id],
            invited_by=InvitationActor(kind="user", id=other.id),
        )
    async with session_factory() as session:
        assert await RoomStore().get_agent_ids(session, room.id) == []
    svc._provisioning.invite_to_room.assert_not_called()


async def test_refused_create_precedes_external_and_transport_room_provisioning(
    session_factory,
):  # type: ignore[no-untyped-def]
    _, other, target, _ = await seed(session_factory)
    svc = service(session_factory, target)
    with pytest.raises(InvitationDenied):
        await svc.create_room(
            RoomCreateConfig(
                name="New room",
                description="",
                agent_ids=[target.id],
                created_by=other.id,
                acting_is_admin=True,
            )
        )
    svc._provisioning.create_room.assert_not_called()


async def test_existing_members_are_not_rechecked_or_removed(session_factory):  # type: ignore[no-untyped-def]
    _, other, target, room = await seed(session_factory)
    async with session_factory() as session:
        await RoomStore().add_agents(session, room.id, [target.id])
        await session.commit()
    svc = service(session_factory, target)
    await svc.add_agents_to_room(
        room.id,
        agent_ids=[target.id],
        invited_by=InvitationActor(kind="user", id=other.id),
    )
    svc._provisioning.invite_to_room.assert_not_called()
    async with session_factory() as session:
        assert await RoomStore().get_agent_ids(session, room.id) == [target.id]


async def test_unknown_platform_join_is_recorded_and_not_an_owner_or_admin_bypass(
    session_factory, caplog
):  # type: ignore[no-untyped-def]
    owner, other, target, room = await seed(session_factory)
    svc = service(session_factory, target)
    svc._announce_unverified_invites = AsyncMock()
    await svc.add_agents_to_room(
        room.id,
        agent_ids=[target.id],
        added_by_kind="system",
        invited_by=InvitationActor(kind="unknown"),
    )
    svc._announce_unverified_invites.assert_awaited_once()
    async with session_factory() as session:
        saved = await session.get(Agent, target.id)
        assert saved is not None
        assert saved.metadata_["unverified_invites"] == [
            {"room_id": room.id, "room_name": room.name}
        ]
        warnings = _invitation_warnings(saved.metadata_)
        summary = agent_summary(saved, owner.name, 0, 0)
        assert (
            _for_caller(summary, owner, False, warnings).invitation_warnings == warnings
        )
        assert _for_caller(summary, other, True, warnings).invitation_warnings == []
        assert summary.invitation_warnings == []  # shared MCP output is empty
    assert "without verifying the inviter" in caplog.text


async def test_known_platform_refusal_is_visible_and_does_not_add_agent(
    session_factory,
):  # type: ignore[no-untyped-def]
    _, _, target, room = await seed(session_factory)
    bridge = object.__new__(CollaborationCore)
    bridge._session_factory = session_factory
    bridge._agent_store = AgentStore()
    bridge._channel_to_room = {"platform-channel": (room.id, room.transport_room_id)}
    bridge._inviter = AsyncMock(
        return_value=InvitationActor(kind="external", id="unclaimed-account")
    )
    bridge._room_service = service(session_factory, target)
    bridge._adapter = SimpleNamespace(admin_message=AsyncMock())
    await bridge._handle_agent_joined_channel_locked(
        InboundAgentJoin(
            channel_id="platform-channel",
            channel_type="channel_private",
            agent_name=target.name,
            inviter_id="reported-inviter",
        )
    )
    bridge._adapter.admin_message.assert_awaited_once()
    assert "Cannot invite" in bridge._adapter.admin_message.call_args.args[1]
    async with session_factory() as session:
        assert await RoomStore().get_agent_ids(session, room.id) == []


async def test_owner_warnings_are_private_at_gateway_list_and_detail_routes(
    session_factory,
):  # type: ignore[no-untyped-def]
    from switch_core.bridges.agent.protocol.agent_connections import (
        AgentConnectionRegistry,
    )
    from switch_core.db.stores.agent_session_store import AgentSessionStore
    from switch_core.db.stores.room_role_store import RoomRoleStore
    from switch_core.db.stores.user_store import UserStore
    from switch_core.gateway.agents import get_agent_detail, list_agents

    owner, admin, target, room = await seed(session_factory)
    async with session_factory() as session:
        saved = await session.get(Agent, target.id)
        assert saved is not None
        saved.metadata_ = {
            "unverified_invites": [{"room_id": room.id, "room_name": room.name}]
        }
        await session.commit()
        protocol = SimpleNamespace(
            agent_session_store=AgentSessionStore(),
            room_role_store=RoomRoleStore(),
            connections=AgentConnectionRegistry(),
        )
        for user, is_admin, expected in [(owner, False, True), (admin, True, False)]:
            summaries = await list_agents(
                session, AgentStore(), UserStore(), user, is_admin
            )
            detail = await get_agent_detail(
                target.id,
                session,
                AgentStore(),
                RoomStore(),
                UserStore(),
                protocol,
                user,
                is_admin,
            )
            summary = next(item for item in summaries if item.id == target.id)
            assert bool(summary.invitation_warnings) is expected
            assert bool(detail.invitation_warnings) is expected
            assert (room.name in summary.model_dump_json()) is expected
            assert (room.name in detail.model_dump_json()) is expected


async def test_locked_policy_refreshes_a_stale_identity_map_and_serializes_membership(
    session_factory,
):  # type: ignore[no-untyped-def]
    import asyncio

    from sqlalchemy import update

    owner, _, target, room = await seed(session_factory)
    async with session_factory() as stale:
        old = await AgentStore().get(stale, target.id)
        assert old is not None
        async with session_factory() as changer:
            await changer.execute(
                update(Agent)
                .where(Agent.id == target.id)
                .values(addressing_policy={"rules": []})
            )
            await changer.commit()
        locked = await AgentStore().get(stale, target.id, for_update=True)
        assert locked is old
        assert locked.addressing_policy == {"rules": []}
        await stale.rollback()
    # Exercise RoomService's actual gate and membership transaction, not only
    # the store lock in isolation. Tightening policy waits for the allowed join.
    async with session_factory() as reset:
        await reset.execute(
            update(Agent)
            .where(Agent.id == target.id)
            .values(addressing_policy=owner_only_policy([]).model_dump())
        )
        await reset.commit()
    checked, release = asyncio.Event(), asyncio.Event()

    async def pause_before_commit(_session):  # type: ignore[no-untyped-def]
        checked.set()
        await release.wait()

    async def change():  # type: ignore[no-untyped-def]
        async with session_factory() as changer:
            await changer.execute(
                update(Agent)
                .where(Agent.id == target.id)
                .values(addressing_policy={"rules": []})
            )
            await changer.commit()

    svc = service(session_factory, target)
    joining = asyncio.create_task(
        svc.add_agents_to_room(
            room.id,
            agent_ids=[target.id],
            invited_by=InvitationActor(kind="user", id=owner.id),
            with_agents=pause_before_commit,
        )
    )
    update_task = None
    try:
        await asyncio.wait_for(checked.wait(), timeout=5)
        update_task = asyncio.create_task(change())
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(update_task), timeout=0.1)
        release.set()
        await asyncio.wait_for(joining, timeout=5)
        await asyncio.wait_for(update_task, timeout=5)
        async with session_factory() as saved:
            assert await RoomStore().get_agent_ids(saved, room.id) == [target.id]
            target_after = await AgentStore().get(saved, target.id)
            assert target_after is not None and target_after.addressing_policy == {
                "rules": []
            }
    finally:
        release.set()
        tasks = [joining, *([update_task] if update_task is not None else [])]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_unknown_room_notice_is_not_an_addressed_agent_instruction(
    session_factory,
):  # type: ignore[no-untyped-def]
    from unittest.mock import MagicMock

    from switch_core.clients.actor import SystemActor

    _, _, target, room = await seed(session_factory)
    svc = service(session_factory, target)
    actor = MagicMock(spec=SystemActor)
    actor.send_notice = AsyncMock()
    svc._client_lifecycle.get_by_type = lambda *_: [actor]
    await svc._announce_unverified_invites(room)
    actor.send_notice.assert_awaited_once()
    assert actor.send_notice.call_args.args[0] == room.transport_room_id
    assert "could not verify" in actor.send_notice.call_args.args[1]
    actor.send_notice.side_effect = RuntimeError("transport unavailable")
    await svc._announce_unverified_invites(
        room
    )  # warning persists despite delivery failure
