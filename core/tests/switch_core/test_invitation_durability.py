"""Invitation policy and owner notices survive concurrent metadata/room edits."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.agent.protocol.agent_connections import ClientDeclaration
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Agent, Room, RoomGroup
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.agents import _invitation_warnings
from switch_core.invitations import InvitationActor, InvitationDenied
from tests.switch_core.gateway.agent_route_harness import add_agent
from tests.switch_core.test_invitation_policy import seed, service


async def test_metadata_replacements_cannot_erase_or_forge_owner_notices(
    session_factory,
):  # type: ignore[no-untyped-def]
    owner, _, target, room = await seed(session_factory)
    svc = service(session_factory, target)
    svc._announce_unverified_invites = AsyncMock()
    await svc.add_agents_to_room(
        room.id, agent_ids=[target.id], invited_by=InvitationActor(kind="unknown")
    )
    protocol = object.__new__(AgentCore)
    protocol.session_factory, protocol.agent_store = session_factory, AgentStore()
    for metadata in [
        {"known_agent_type": "custom"},
        {"unverified_invites": [{"room_name": "forged"}]},
        {},
    ]:
        await protocol.update_agent(target.id, metadata=metadata)
        async with session_factory() as saved:
            agent = await saved.get(Agent, target.id)
            assert agent is not None
            assert agent.metadata_["unverified_invites"] == [
                {"room_id": room.id, "room_name": room.name}
            ]
            assert room.name in _invitation_warnings(agent.metadata_)[0]
    async with session_factory() as saved:
        new = await add_agent(saved, name="new-client", owner_id=owner.id)
        new.metadata_ = {
            "unverified_invites": [{"room_name": "forged"}],
            "custom": "retained",
        }
        await AgentStore().create(saved, new)
        assert new.metadata_ == {"custom": "retained"}
        await AgentStore().update(
            saved, new.id, metadata_={"unverified_invites": [{"room_name": "forged"}]}
        )
        await saved.commit()
        assert new.metadata_ == {}


async def test_stale_client_declaration_preserves_a_concurrent_invitation_notice(
    session_factory,
):  # type: ignore[no-untyped-def]
    _, _, target, room = await seed(session_factory)
    read, resume = asyncio.Event(), asyncio.Event()

    class PausingStore(AgentStore):
        async def get(self, session, agent_id, *, for_update=False):  # type: ignore[no-untyped-def]
            agent = await super().get(session, agent_id, for_update=for_update)
            if not for_update:
                read.set()
                await resume.wait()
            return agent

    protocol = object.__new__(AgentCore)
    protocol.session_factory, protocol.agent_store = session_factory, PausingStore()
    record = asyncio.create_task(
        protocol.record_client_declaration(
            target.id, "connection", ClientDeclaration(speaks=1, version="0.1.5")
        )
    )
    try:
        await asyncio.wait_for(read.wait(), timeout=5)
        svc = service(session_factory, target)
        svc._announce_unverified_invites = AsyncMock()
        await svc.add_agents_to_room(
            room.id, agent_ids=[target.id], invited_by=InvitationActor(kind="unknown")
        )
        resume.set()
        await asyncio.wait_for(record, timeout=5)
        async with session_factory() as saved:
            agent = await saved.get(Agent, target.id)
            assert agent is not None
            assert (
                agent.metadata_["client_declaration"]["connection_id"] == "connection"
            )
            assert agent.metadata_["unverified_invites"] == [
                {"room_id": room.id, "room_name": room.name}
            ]
    finally:
        resume.set()
        if not record.done():
            record.cancel()
        await asyncio.gather(record, return_exceptions=True)


async def test_final_invitation_check_uses_the_current_locked_room_group(
    session_factory,
):  # type: ignore[no-untyped-def]
    owner, _, target, room = await seed(session_factory)
    async with session_factory() as saved:
        allowed_group, other_group = RoomGroup(name="allowed"), RoomGroup(name="other")
        saved.add_all([allowed_group, other_group])
        await saved.flush()
        stored_room = await saved.get(Room, room.id)
        stored_agent = await saved.get(Agent, target.id)
        assert stored_room is not None and stored_agent is not None
        stored_room.group_id = allowed_group.id
        stored_agent.addressing_policy = {
            "rules": [
                {
                    "room_groups": [allowed_group.id],
                    "users": [],
                    "agents": [],
                    "owner": True,
                }
            ]
        }
        await saved.commit()
    first_read, resume = asyncio.Event(), asyncio.Event()

    class PausingRoomStore(RoomStore):
        async def get(self, session, room_id, *, for_update=False):  # type: ignore[no-untyped-def]
            current = await super().get(session, room_id, for_update=for_update)
            if not for_update:
                first_read.set()
                await resume.wait()
            return current

    svc = service(session_factory, target)
    svc._room_store = PausingRoomStore()
    joining = asyncio.create_task(
        svc.add_agents_to_room(
            room.id,
            agent_ids=[target.id],
            invited_by=InvitationActor(kind="user", id=owner.id),
        )
    )
    try:
        await asyncio.wait_for(first_read.wait(), timeout=5)
        async with session_factory() as moved:
            current = await moved.get(Room, room.id)
            assert current is not None
            current.group_id = other_group.id
            await moved.commit()
        resume.set()
        with pytest.raises(InvitationDenied):
            await asyncio.wait_for(joining, timeout=5)
        async with session_factory() as saved:
            assert await RoomStore().get_agent_ids(saved, room.id) == []
        svc._provisioning.invite_to_room.assert_not_called()
    finally:
        resume.set()
        if not joining.done():
            joining.cancel()
        await asyncio.gather(joining, return_exceptions=True)
