"""People in rooms with no messaging app, and rooms moved off a retired
Mattermost connector: both reach their people through Switch Console
membership — against real Postgres, through the shared harness."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.chats.service import ChatError
from switch_core.chats.views import chat_summary
from switch_core.db.models import (
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    User,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.room_service import RoomCreateConfig
from tests.switch_core.gateway.conftest import _Harness


async def _in_room(chats: _Harness, room_id: str, user: User) -> bool:
    async with chats.factory() as session:
        return room_id in {
            room.id for room in await chats.service.readable_rooms(session, user.id)
        }


async def _listed(chats: _Harness, room_id: str, user: User) -> bool:
    async with chats.factory() as session:
        return room_id in {
            room.id for room in await chats.service.stream_rooms(session, user.id)
        }


async def _agentless_room(chats: _Harness, name: str) -> Room:
    created = await chats.room_service.create_room(
        RoomCreateConfig(name=name, description="d", internal_only=True)
    )
    return created.room


async def test_a_room_with_no_bridge_takes_its_people_and_creator(
    chats: _Harness,
) -> None:
    agent = await chats.agent("claude-code.helper", owner=chats.alice)

    created = await chats.room_service.create_room(
        RoomCreateConfig(
            name="plans",
            description="d",
            agent_ids=[agent.id],
            user_names=["bob", "nobody", "carol"],
            created_by=chats.alice.id,
            owner_id=chats.alice.id,
        )
    )

    assert created.room.bridge_id is None
    assert await _in_room(chats, created.room.id, chats.alice)
    assert await _in_room(chats, created.room.id, chats.bob)
    # carol has no role in the workspace, so her name resolves to nobody.
    assert not await _in_room(chats, created.room.id, chats.carol)
    assert sorted(f["id"] for f in created.failed_attachments) == ["carol", "nobody"]


async def test_adding_people_to_a_room_with_no_bridge(chats: _Harness) -> None:
    room = await _agentless_room(chats, "ops")

    unresolved = await chats.room_service.add_users_to_room(
        room.id, ["bob@example.com", "ghost"], chats.admin
    )

    assert unresolved == ["ghost"]
    assert await _in_room(chats, room.id, chats.bob)


async def test_only_a_manager_adds_people_to_a_room_with_no_bridge(
    chats: _Harness,
) -> None:
    room = await _agentless_room(chats, "owned")
    await _owned_by(chats, room, chats.alice)

    with pytest.raises(ChatError) as refused:
        await chats.room_service.add_users_to_room(room.id, ["bob"], chats.bob)
    assert refused.value.code == "NOT_A_MANAGER"
    assert not await _in_room(chats, room.id, chats.bob)

    assert (
        await chats.room_service.add_users_to_room(room.id, ["bob"], chats.alice) == []
    )
    assert await _in_room(chats, room.id, chats.bob)


def _agent_core(chats: _Harness) -> AgentCore:
    core = object.__new__(AgentCore)
    core.session_factory = chats.factory  # type: ignore[misc]
    core.agent_store = AgentStore()  # type: ignore[misc]
    core.room_store = RoomStore()  # type: ignore[misc]
    core.user_store = UserStore()  # type: ignore[misc]
    core.room_service = chats.room_service  # type: ignore[misc]
    return core


@pytest.mark.parametrize("owner", ["alice", "bob"])
async def test_an_agent_adds_people_only_where_its_owner_manages(
    chats: _Harness, owner: str
) -> None:
    agent = await chats.agent("claude-code.helper", owner=getattr(chats, owner))
    created = await chats.room_service.create_room(
        RoomCreateConfig(
            name="private",
            description="d",
            agent_ids=[agent.id],
            internal_only=True,
            owner_id=chats.alice.id,
        )
    )
    add = _agent_core(chats).add_users_to_room(agent.id, created.room.id, ["admin"])

    if owner == "alice":
        assert await add == []
        assert await _in_room(chats, created.room.id, chats.admin)
    else:
        with pytest.raises(PermissionError, match="owner or a workspace admin"):
            await add
        assert not await _in_room(chats, created.room.id, chats.admin)


async def test_a_room_of_people_alone_is_a_chat_they_can_open(
    chats: _Harness,
) -> None:
    created = await chats.room_service.create_room(
        RoomCreateConfig(name="people", description="d", user_names=["bob"])
    )
    room_id = created.room.id

    listed = await chats.client.get("/chats", headers=chats.as_user(chats.bob))
    assert listed.status_code == 200, listed.text
    assert room_id in {chat["roomId"] for chat in listed.json()["chats"]}
    messages = await chats.client.get(
        f"/chats/{room_id}/messages", headers=chats.as_user(chats.bob)
    )
    assert messages.status_code == 200, messages.text


async def _retiring_bridge(
    chats: _Harness, room: Room, platform: str = "mattermost"
) -> CollaborationBridge:
    async with chats.factory() as session:
        bot = Client(
            transport_user_id=f"@{platform}-bot:switch.test",
            display_name="bot",
            type="bridge",
        )
        session.add(bot)
        await session.flush()
        bridge = CollaborationBridge(
            tenant_id=room.tenant_id,
            type=platform,
            display_name=platform,
            connection_config={},
            client_id=bot.id,
            status="retiring",
        )
        session.add(bridge)
        await session.flush()
        row = await session.get(Room, room.id)
        assert row is not None
        row.bridge_id = bridge.id
        row.external_channel_id = "mm-chan"
        await session.commit()
        return bridge


async def _person_on(
    chats: _Harness,
    bridge: CollaborationBridge,
    name: str,
    *,
    in_room: Room | None,
    claimed_by: User | None,
) -> None:
    async with chats.factory() as session:
        actor = Client(
            transport_user_id=f"@mm-{name}:switch.test", display_name=name, type="human"
        )
        session.add(actor)
        await session.flush()
        external = ExternalUser(
            bridge_id=bridge.id,
            external_user_id=f"mm-{name}",
            external_username=name,
            client_id=actor.id,
        )
        session.add(external)
        await session.flush()
        if in_room is not None:
            session.add(ClientRoom(client_id=actor.id, room_id=in_room.id))
        if claimed_by is not None:
            session.add(
                ExternalUserClaim(external_user_id=external.id, user_id=claimed_by.id)
            )
        await session.commit()


async def test_a_retired_mattermost_room_moves_to_its_linked_people(
    chats: _Harness, caplog: pytest.LogCaptureFixture
) -> None:
    room = await _agentless_room(chats, "Mattermost: town-square")
    bridge = await _retiring_bridge(chats, room)
    # bob's account was in the room and is linked to him.
    await _person_on(chats, bridge, "bob", in_room=room, claimed_by=chats.bob)
    # Someone in the room whose account nobody linked.
    await _person_on(chats, bridge, "stranger", in_room=room, claimed_by=None)
    # alice is linked on the connector, but was never in the room.
    await _person_on(chats, bridge, "alice", in_room=None, claimed_by=chats.alice)

    with caplog.at_level("WARNING", logger="switch_core.room_service"):
        await chats.room_service.retire_mattermost_bridges()

    claim_joins = [
        r.getMessage()
        for r in caplog.records
        if r.levelname == "WARNING" and "claim" in r.getMessage()
    ]
    assert claim_joins == [
        f"Retired Mattermost room {room.id}: joined user {chats.bob.id} on their "
        "unreviewed claim of external user mm-bob"
    ]
    # Listed with no agent in it, on the strength of where it came from.
    assert await _listed(chats, room.id, chats.bob)
    assert not await _in_room(chats, room.id, chats.alice)
    async with chats.factory() as session:
        row = await session.get(Room, room.id)
        stored = await session.get(CollaborationBridge, bridge.id)
        assert row is not None and stored is not None
        assert (row.bridge_id, row.external_channel_id) == (None, None)
        assert row.metadata_["retired_bridge"] == {
            "type": "mattermost",
            "bridge_id": bridge.id,
            "external_channel_id": "mm-chan",
        }
        assert stored.status == "inactive"
        summary = await chat_summary(
            session, row, viewer_id=chats.bob.id, can_manage=False
        )
        assert summary.bridge_type is None
        members = set(
            (
                await session.execute(
                    select(ClientRoom.client_id).where(ClientRoom.room_id == room.id)
                )
            ).scalars()
        )

    await chats.room_service.retire_mattermost_bridges()

    async with chats.factory() as session:
        assert (
            set(
                (
                    await session.execute(
                        select(ClientRoom.client_id).where(
                            ClientRoom.room_id == room.id
                        )
                    )
                ).scalars()
            )
            == members
        )


async def test_a_room_that_fails_to_move_stays_put_until_the_next_boot(
    chats: _Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    room = await _agentless_room(chats, "Mattermost: ops")
    bridge = await _retiring_bridge(chats, room)
    await _person_on(chats, bridge, "bob", in_room=room, claimed_by=chats.bob)
    await _person_on(chats, bridge, "admin", in_room=room, claimed_by=chats.admin)
    await _person_on(chats, bridge, "stranger", in_room=room, claimed_by=None)
    join_member = chats.service.join_member
    joins = 0

    async def second_join_fails(tenant_id: str, room_id: str, target: User) -> Room:
        nonlocal joins
        joins += 1
        if joins == 2:
            raise RuntimeError("join failed")
        return await join_member(tenant_id, room_id, target)

    monkeypatch.setattr(chats.service, "join_member", second_join_fails)
    await chats.room_service.retire_mattermost_bridges()

    async with chats.factory() as session:
        row = await session.get(Room, room.id)
        stored = await session.get(CollaborationBridge, bridge.id)
        assert row is not None and stored is not None
        assert row.bridge_id == bridge.id
        assert "retired_bridge" not in (row.metadata_ or {})
        assert stored.status == "retiring"

    monkeypatch.setattr(chats.service, "join_member", join_member)
    await chats.room_service.retire_mattermost_bridges()

    async with chats.factory() as session:
        row = await session.get(Room, room.id)
        stored = await session.get(CollaborationBridge, bridge.id)
        assert row is not None and stored is not None
        assert row.bridge_id is None
        assert row.metadata_["retired_bridge"]["bridge_id"] == bridge.id
        assert stored.status == "inactive"
    readers = {
        user.id
        for user in (chats.alice, chats.bob, chats.carol, chats.admin)
        if await _in_room(chats, room.id, user)
    }
    assert readers == {chats.bob.id, chats.admin.id}


@pytest.mark.parametrize(
    ("platform", "shown"), [("mattermost", None), ("slack", "slack")]
)
async def test_only_a_retired_mattermost_connector_names_no_platform(
    chats: _Harness, platform: str, shown: str | None
) -> None:
    room = await _agentless_room(chats, "old")
    bridge = await _retiring_bridge(chats, room, platform)
    async with chats.factory() as session:
        stored = await session.get(CollaborationBridge, bridge.id)
        row = await session.get(Room, room.id)
        assert stored is not None and row is not None
        stored.status = "inactive"
        await session.commit()
        summary = await chat_summary(
            session, row, viewer_id=chats.alice.id, can_manage=False
        )

    assert summary.bridge_type == shown


async def _owned_by(chats: _Harness, room: Room, owner: User) -> None:
    async with chats.factory() as session:
        row = await session.get(Room, room.id)
        assert row is not None
        row.owner_id = owner.id
        await session.commit()


async def test_a_retired_room_with_no_linked_people_moves_to_its_owner(
    chats: _Harness,
) -> None:
    room = await _agentless_room(chats, "Mattermost: plans")
    await _owned_by(chats, room, chats.alice)
    bridge = await _retiring_bridge(chats, room)
    await _person_on(chats, bridge, "stranger", in_room=room, claimed_by=None)

    await chats.room_service.retire_mattermost_bridges()

    assert await _in_room(chats, room.id, chats.alice)


async def test_a_retired_room_with_no_one_to_move_to_is_warned_and_still_unbound(
    chats: _Harness, caplog: pytest.LogCaptureFixture
) -> None:
    room = await _agentless_room(chats, "Mattermost: empty")
    bridge = await _retiring_bridge(chats, room)
    await _person_on(chats, bridge, "stranger", in_room=room, claimed_by=None)

    with caplog.at_level("WARNING", logger="switch_core.room_service"):
        await chats.room_service.retire_mattermost_bridges()

    assert any(
        room.id in r.getMessage() and "Mattermost: empty" in r.getMessage()
        for r in caplog.records
        if r.levelname == "WARNING"
    )
    async with chats.factory() as session:
        row = await session.get(Room, room.id)
        assert row is not None
        assert row.bridge_id is None
        assert row.metadata_["retired_bridge"]["external_channel_id"] == "mm-chan"


async def test_an_account_claimed_by_two_people_links_neither(
    chats: _Harness,
) -> None:
    room = await _agentless_room(chats, "Mattermost: shared")
    await _owned_by(chats, room, chats.alice)
    bridge = await _retiring_bridge(chats, room)
    await _person_on(chats, bridge, "bob", in_room=room, claimed_by=chats.bob)
    async with chats.factory() as session:
        external = await session.scalar(
            select(ExternalUser).where(ExternalUser.external_user_id == "mm-bob")
        )
        assert external is not None
        session.add(
            ExternalUserClaim(external_user_id=external.id, user_id=chats.admin.id)
        )
        await session.commit()

    await chats.room_service.retire_mattermost_bridges()

    assert not await _in_room(chats, room.id, chats.bob)
    assert not await _in_room(chats, room.id, chats.admin)
    assert await _in_room(chats, room.id, chats.alice)


async def test_a_removed_members_claim_does_not_unlink_a_current_member(
    chats: _Harness,
) -> None:
    room = await _agentless_room(chats, "Mattermost: alumni")
    bridge = await _retiring_bridge(chats, room)
    await _person_on(chats, bridge, "bob", in_room=room, claimed_by=chats.bob)
    async with chats.factory() as session:
        external = await session.scalar(
            select(ExternalUser).where(ExternalUser.external_user_id == "mm-bob")
        )
        assert external is not None
        # carol has no tenant membership: a removed member whose claim remains.
        session.add(
            ExternalUserClaim(external_user_id=external.id, user_id=chats.carol.id)
        )
        await session.commit()

    await chats.room_service.retire_mattermost_bridges()

    assert await _in_room(chats, room.id, chats.bob)


@pytest.mark.parametrize("owner", ["none", "removed member"])
async def test_a_retired_room_with_no_joinable_owner_moves_to_its_creator(
    chats: _Harness, owner: str
) -> None:
    room = await _agentless_room(chats, "Mattermost: ownerless")
    async with chats.factory() as session:
        row = await session.get(Room, room.id)
        assert row is not None
        row.owner_id = chats.carol.id if owner == "removed member" else None
        row.created_by = chats.alice.id
        await session.commit()
    bridge = await _retiring_bridge(chats, room)
    await _person_on(chats, bridge, "stranger", in_room=room, claimed_by=None)

    await chats.room_service.retire_mattermost_bridges()

    assert await _in_room(chats, room.id, chats.alice)
