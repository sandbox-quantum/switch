"""Invitation policy and membership changes against real PostgreSQL."""

from unittest.mock import AsyncMock

import pytest

from switch_core.addressing import owner_and_owner_agents_policy
from switch_core.agent_invites import AgentInviteDenied, AgentInviter
from switch_core.db.models import (
    Agent,
    Client,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    require_tenant_id,
)
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomCreateConfig


async def room(chats):
    return (
        await chats.room_service.create_room(
            RoomCreateConfig(name="room", description="", internal_only=True)
        )
    ).room


@pytest.mark.parametrize("who", ["bob", "admin"])
async def test_denied_invite_writes_nothing_and_admin_has_no_bypass(chats, who):
    agent = await chats.agent(
        "worker", owner=chats.alice, policy=owner_and_owner_agents_policy().model_dump()
    )
    destination = await room(chats)
    with pytest.raises(AgentInviteDenied):
        await chats.room_service.add_agents_to_room(
            destination.id,
            agent_ids=[agent.id],
            inviter=AgentInviter(kind="user", subject=getattr(chats, who).id),
        )
    async with chats.factory() as db:
        assert await RoomStore().get_agent_ids(db, destination.id) == []
    await chats.room_service.add_agents_to_room(
        destination.id,
        agent_ids=[agent.id],
        inviter=AgentInviter(kind="user", subject=chats.alice.id),
    )
    async with chats.factory() as db:
        assert await RoomStore().get_agent_ids(db, destination.id) == [agent.id]


async def test_bulk_invite_is_all_or_nothing(chats):
    opened = await chats.agent("open", owner=chats.bob)
    closed = await chats.agent(
        "closed", owner=chats.alice, policy=owner_and_owner_agents_policy().model_dump()
    )
    destination = await room(chats)
    with pytest.raises(AgentInviteDenied):
        await chats.room_service.add_agents_to_room(
            destination.id,
            agent_ids=[opened.id, closed.id],
            inviter=AgentInviter(kind="user", subject=chats.bob.id),
        )
    async with chats.factory() as db:
        assert await RoomStore().get_agent_ids(db, destination.id) == []


async def test_inviting_agent_is_checked_and_existing_members_are_not_removed(chats):
    target = await chats.agent(
        "worker", owner=chats.alice, policy=owner_and_owner_agents_policy().model_dump()
    )
    manager = await chats.agent("manager", owner=chats.alice)
    stranger = await chats.agent("stranger", owner=chats.bob)
    destination = await room(chats)
    with pytest.raises(AgentInviteDenied):
        await chats.room_service.add_agents_to_room(
            destination.id,
            agent_ids=[target.id],
            inviter=AgentInviter(kind="agent", subject=stranger.id),
        )
    await chats.room_service.add_agents_to_room(
        destination.id,
        agent_ids=[target.id],
        inviter=AgentInviter(kind="agent", subject=manager.id),
    )
    await chats.room_service.add_agents_to_room(
        destination.id,
        agent_ids=[target.id],
        inviter=AgentInviter(kind="user", subject=chats.bob.id),
    )
    async with chats.factory() as db:
        assert await RoomStore().get_agent_ids(db, destination.id) == [target.id]


async def test_creation_and_template_runs_check_the_person_before_provisioning(
    chats, monkeypatch
):
    target = await chats.agent(
        "worker", owner=chats.alice, policy=owner_and_owner_agents_policy().model_dump()
    )
    provision = AsyncMock(wraps=chats.room_service._provisioning.create_room)
    monkeypatch.setattr(chats.room_service._provisioning, "create_room", provision)
    for template in (False, True):
        with pytest.raises(AgentInviteDenied):
            await chats.room_service.create_room(
                RoomCreateConfig(
                    name="denied",
                    description="",
                    internal_only=True,
                    agent_ids=[target.id],
                    acting_user_id=chats.bob.id,
                    acting_is_admin=True,
                    from_template=template,
                )
            )
    provision.assert_not_awaited()
    created = await chats.room_service.create_room(
        RoomCreateConfig(
            name="allowed",
            description="",
            internal_only=True,
            agent_ids=[target.id],
            acting_user_id=chats.alice.id,
            from_template=True,
        )
    )
    async with chats.factory() as db:
        assert await RoomStore().get_agent_ids(db, created.room.id) == [target.id]


async def platform_identity(chats, claim):
    async with chats.factory() as db:
        bot = Client(
            transport_user_id="@bridge:test", display_name="bridge", type="bridge"
        )
        human = Client(
            transport_user_id="@person:test", display_name="person", type="user"
        )
        db.add_all([bot, human])
        await db.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="test",
            connection_config={},
            client_id=bot.id,
            status="active",
        )
        db.add(bridge)
        await db.flush()
        external = ExternalUser(
            bridge_id=bridge.id,
            client_id=human.id,
            external_user_id="UOWNER",
            external_username="owner",
        )
        db.add(external)
        await db.flush()
        if claim:
            db.add(
                ExternalUserClaim(external_user_id=external.id, user_id=chats.alice.id)
            )
        await db.commit()
        return bridge.id, external.id


@pytest.mark.parametrize("claimed", [False, True])
async def test_platform_inviter_claims_are_checked_against_postgres(chats, claimed):
    bridge, _ = await platform_identity(chats, claimed)
    target = await chats.agent(
        "worker", owner=chats.alice, policy=owner_and_owner_agents_policy().model_dump()
    )
    destination = await room(chats)
    call = chats.room_service.add_agents_to_room(
        destination.id,
        agent_ids=[target.id],
        inviter=AgentInviter(kind="platform", subject="UOWNER", bridge_id=bridge),
    )
    if claimed:
        await call
    else:
        with pytest.raises(AgentInviteDenied):
            await call


async def test_user_allowlists_resolve_claimed_accounts_for_console_users(chats):
    _, external = await platform_identity(chats, True)
    target = await chats.agent(
        "worker",
        owner=chats.bob,
        policy={"rules": [{"users": [external], "agents": []}]},
    )
    destination = await room(chats)
    await chats.room_service.add_agents_to_room(
        destination.id,
        agent_ids=[target.id],
        inviter=AgentInviter(kind="user", subject=chats.alice.id),
    )


async def test_unknown_platform_join_warns_room_and_owner_without_relaxing_policy(
    chats, monkeypatch, caplog
):
    bridge, _ = await platform_identity(chats, False)
    target = await chats.agent(
        "worker", owner=chats.alice, policy=owner_and_owner_agents_policy().model_dump()
    )
    destination = await room(chats)
    notice = AsyncMock()
    owner = AsyncMock()
    monkeypatch.setattr(chats.room_service, "post_invite_notice", notice)
    chats.room_service.set_invite_owner_notifier(owner)
    await chats.room_service.add_agents_to_room(
        destination.id,
        agent_ids=[target.id],
        added_by_kind="system",
        inviter=AgentInviter(kind="platform", subject=None, bridge_id=bridge),
    )
    assert "Unverified platform invite" in caplog.text
    notice.assert_awaited_once()
    owner.assert_awaited_once()
    assert owner.await_args.args[:2] == (destination.tenant_id, chats.alice.id)
    async with chats.factory() as db:
        stored = await db.get(Agent, target.id)
        assert stored.addressing_policy == owner_and_owner_agents_policy().model_dump()


async def test_owner_notice_is_private_persistent_and_reuses_one_inbox(
    chats, monkeypatch
):
    posted = AsyncMock()
    monkeypatch.setattr(chats.room_service, "post_invite_notice", posted)
    tenant = require_tenant_id()
    await chats.service.notify_invite_owner(tenant, chats.alice.id, "First warning")
    await chats.service.notify_invite_owner(tenant, chats.alice.id, "Second warning")
    assert posted.await_count == 2
    first, second = [call.args[0] for call in posted.await_args_list]
    assert first.id == second.id
    async with chats.factory() as db:
        saved = await db.get(Room, first.id)
        assert saved.owner_id == chats.alice.id
        assert saved.read_visibility == saved.write_visibility == "private"
        assert saved.bridge_id is None
        assert await RoomStore().get_agent_ids(db, saved.id) == []
        assert first.id in [
            item.id for item in await chats.service.list_chats(db, chats.alice.id)
        ]
    response = await chats.client.get(
        f"/chats/{first.id}/messages", headers=chats.as_user(chats.bob)
    )
    assert response.status_code == 403
