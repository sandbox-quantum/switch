"""The clean-up that makes Public rooms on private channels Private.

The preview lists every unarchived Public room bound to a private channel, a
group or a DM, or to a channel of unrecorded type the platform says is private
or cannot place, and changes nothing. A room whose channel cannot list its
members, or whose type is unknown, is listed unticked rather than left out.
Applying changes only the confirmed rooms still eligible, audits each change,
and posts a history line.

Real Postgres behind row-level security; the running bridges are faked.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import select

from switch_core.db.models import (
    AuditEvent,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    Room,
    Tenant,
)
from switch_core.db.session_scope import tenant_session
from switch_core.private_channel_rooms import (
    MADE_PRIVATE_NOTICE,
    PrivateChannelRooms,
)
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


class _Adapter:
    def __init__(
        self,
        *,
        lists_members: bool = True,
        types: dict[str, str] | None = None,
        type_fails: bool = False,
    ) -> None:
        self.lists_members = lists_members
        self.types = types or {}
        self.type_fails = type_fails
        self.asked_types: list[str] = []

    async def get_channel_type(self, channel_id: str) -> str:
        self.asked_types.append(channel_id)
        if self.type_fails:
            raise RuntimeError("platform unavailable")
        return self.types[channel_id]

    async def can_list_channel_members(self, channel_id: str) -> bool:
        return self.lists_members


class _Core:
    def __init__(self, adapter: _Adapter) -> None:
        self.adapter = adapter


class _Lifecycle:
    def __init__(self, cores: dict[str, _Core]) -> None:
        self.cores = cores

    def get(self, bridge_id: str) -> Any:
        return self.cores.get(bridge_id)


class _Changes:
    def __init__(self) -> None:
        self.changed: list[tuple[str, str]] = []

    def room_changed(self, tenant_id: str, room_id: str) -> None:
        self.changed.append((tenant_id, room_id))


class _Notices:
    def __init__(self, fails: bool = False) -> None:
        self.posted: list[tuple[str, str, str]] = []
        self.fails = fails

    async def __call__(self, tenant_id: str, transport_room_id: str, body: str) -> None:
        if self.fails:
            raise RuntimeError("no admin client here")
        self.posted.append((tenant_id, transport_room_id, body))


class World:
    def __init__(self, harness: RLSHarness, tenant: str) -> None:
        self.harness = harness
        self.tenant = tenant
        self.cores: dict[str, _Core] = {}
        self.changes = _Changes()
        self.notices = _Notices()

    def service(self) -> PrivateChannelRooms:
        return PrivateChannelRooms(
            session_factory=self.harness.restricted,
            collab_lifecycle=_Lifecycle(self.cores),
            room_changes=self.changes,
            post_notice=self.notices,
        )

    async def bridge(
        self,
        kind: str = "slack",
        adapter: _Adapter | None = None,
        *,
        running: bool = True,
    ) -> str:
        async with tenant_session(self.harness.owner, self.tenant) as session:
            client = Client(
                transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
                display_name="bridge",
                type="bridge",
            )
            session.add(client)
            await session.flush()
            bridge = CollaborationBridge(
                type=kind,
                display_name=kind.title(),
                client_id=client.id,
                status="active",
            )
            session.add(bridge)
            await session.commit()
            bridge_id = bridge.id
        if running:
            self.cores[bridge_id] = _Core(adapter or _Adapter())
        return bridge_id

    async def room(
        self,
        name: str,
        bridge_id: str | None,
        channel_type: str | None,
        *,
        visibility: str = "public",
        archived: bool = False,
        people: int = 0,
    ) -> str:
        suffix = uuid.uuid4().hex[:8]
        async with tenant_session(self.harness.owner, self.tenant) as session:
            room = Room(
                transport_room_id=f"!{suffix}:test",
                name=name,
                description="",
                bridge_id=bridge_id,
                external_channel_id=f"C-{suffix}" if bridge_id else None,
                channel_type=channel_type,
                read_visibility=visibility,
            )
            if archived:
                room.archived_at = datetime.now(UTC)
            session.add(room)
            await session.flush()
            for i in range(people):
                person = Client(
                    transport_user_id=f"@p{i}-{suffix}:test",
                    display_name=f"p{i}",
                    type="user",
                )
                session.add(person)
                await session.flush()
                session.add(
                    ExternalUser(
                        bridge_id=bridge_id or "",
                        external_user_id=f"U{i}-{suffix}",
                        external_username=f"p{i}",
                        client_id=person.id,
                    )
                )
                session.add(ClientRoom(client_id=person.id, room_id=room.id))
            await session.commit()
            return room.id

    async def channel_of(self, room_id: str) -> str:
        async with tenant_session(self.harness.owner, self.tenant) as session:
            room = await session.get(Room, room_id)
            assert room is not None
            return room.external_channel_id or ""

    async def visibility(self, room_id: str) -> str:
        async with tenant_session(self.harness.owner, self.tenant) as session:
            room = await session.get(Room, room_id)
            assert room is not None
            return room.read_visibility

    async def audits(self) -> list[AuditEvent]:
        async with tenant_session(self.harness.owner, self.tenant) as session:
            result = await session.execute(
                select(AuditEvent).where(AuditEvent.action == "room.made_private")
            )
            return list(result.scalars().all())


async def _tenant(harness: RLSHarness) -> str:
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with harness.owner() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()
    return tenant_id


@pytest.fixture
async def world(rls_harness: RLSHarness) -> World:
    return World(rls_harness, await _tenant(rls_harness))


async def _ids(world: World) -> list[str]:
    return [c.room_id for c in await world.service().preview(world.tenant)]


async def test_lists_public_rooms_on_private_channels_groups_and_dms(
    world: World,
) -> None:
    slack = await world.bridge()
    private = await world.room("private", slack, "channel_private", people=3)
    group = await world.room("group", slack, "group")
    dm = await world.room("dm", slack, "direct")
    await world.room("public channel", slack, "channel_public")
    await world.room("already private", slack, "channel_private", visibility="private")
    await world.room("archived", slack, "channel_private", archived=True)
    await world.room("no channel", None, None)

    rooms = await world.service().preview(world.tenant)

    assert {c.room_id for c in rooms} == {private, group, dm}
    listed = next(c for c in rooms if c.room_id == private)
    assert listed.people == 3
    assert listed.bridge_type == "slack"
    assert listed.members_listed is True
    assert listed.recommended
    # A dry run: nothing changed.
    assert await world.visibility(private) == "public"
    assert await world.audits() == []


async def test_another_workspaces_rooms_are_not_listed(world: World) -> None:
    slack = await world.bridge()
    mine = await world.room("mine", slack, "channel_private")
    other = World(world.harness, await _tenant(world.harness))
    other_slack = await other.bridge()
    await other.room("theirs", other_slack, "channel_private")
    world.cores.update(other.cores)

    assert await _ids(world) == [mine]


async def test_a_platform_that_cannot_list_members_is_listed_unticked(
    world: World,
) -> None:
    telegram = await world.bridge("telegram", _Adapter(lists_members=False))
    room_id = await world.room("telegram group", telegram, "group")

    (candidate,) = await world.service().preview(world.tenant)

    assert candidate.room_id == room_id
    assert candidate.members_listed is False
    assert candidate.cautions == ("members_not_listed",)
    assert not candidate.recommended


async def test_a_channel_of_unrecorded_type_is_asked_about(world: World) -> None:
    adapter = _Adapter()
    slack = await world.bridge(adapter=adapter)
    private = await world.room("old private", slack, None)
    public = await world.room("old public", slack, None)
    adapter.types = {
        await world.channel_of(private): "channel_private",
        await world.channel_of(public): "channel_public",
    }

    (candidate,) = await world.service().preview(world.tenant)

    assert candidate.room_id == private
    assert candidate.channel_type == "channel_private"
    assert candidate.recommended
    # Asked, not recorded: the preview writes nothing.
    async with tenant_session(world.harness.owner, world.tenant) as session:
        room = await session.get(Room, private)
        assert room is not None and room.channel_type is None


async def test_a_type_the_platform_cannot_say_is_listed_as_unknown(
    world: World,
) -> None:
    slack = await world.bridge(adapter=_Adapter(type_fails=True))
    room_id = await world.room("old", slack, None)

    (candidate,) = await world.service().preview(world.tenant)

    assert candidate.room_id == room_id
    assert candidate.channel_type is None
    assert candidate.cautions == ("channel_type_unknown",)


async def test_a_bridge_not_running_here_is_listed_unticked(world: World) -> None:
    slack = await world.bridge(running=False)
    room_id = await world.room("private", slack, "channel_private")

    (candidate,) = await world.service().preview(world.tenant)

    assert candidate.room_id == room_id
    assert candidate.members_listed is None
    assert candidate.cautions == ("bridge_not_connected",)


async def test_rooms_needing_a_second_look_come_first(world: World) -> None:
    slack = await world.bridge()
    telegram = await world.bridge("telegram", _Adapter(lists_members=False))
    ok = await world.room("a ok", slack, "channel_private")
    caution = await world.room("z caution", telegram, "group")

    assert await _ids(world) == [caution, ok]


async def test_apply_makes_only_the_confirmed_rooms_private(world: World) -> None:
    slack = await world.bridge()
    confirmed = await world.room("confirmed", slack, "channel_private")
    unticked = await world.room("unticked", slack, "channel_private")

    result = await world.service().apply(
        world.tenant, [confirmed], actor_user_id="admin-1"
    )

    assert result.changed == [confirmed]
    assert result.skipped == []
    assert await world.visibility(confirmed) == "private"
    assert await world.visibility(unticked) == "public"
    (audit,) = await world.audits()
    assert (audit.target_id, audit.actor_user_id) == (confirmed, "admin-1")
    assert audit.details is not None
    assert audit.details["channel_type"] == "channel_private"
    assert world.changes.changed == [(world.tenant, confirmed)]
    assert [body for _, _, body in world.notices.posted] == [MADE_PRIVATE_NOTICE]


async def test_apply_skips_rooms_that_changed_since_the_preview(world: World) -> None:
    slack = await world.bridge()
    already = await world.room("a", slack, "channel_private", visibility="private")
    archived = await world.room("b", slack, "channel_private", archived=True)
    now_public = await world.room("c", slack, "channel_public")
    unbridged = await world.room("d", None, None)
    other = World(world.harness, await _tenant(world.harness))
    theirs = await other.room("theirs", await other.bridge(), "channel_private")

    result = await world.service().apply(
        world.tenant,
        [already, archived, now_public, unbridged, theirs, "missing"],
        actor_user_id="admin-1",
    )

    assert result.changed == []
    assert result.skipped == [
        (already, "already_private"),
        (archived, "archived"),
        (now_public, "not_eligible"),
        (unbridged, "not_eligible"),
        (theirs, "not_found"),
        ("missing", "not_found"),
    ]
    assert await other.visibility(theirs) == "public"
    assert await world.audits() == []
    assert world.notices.posted == []


async def test_apply_changes_a_confirmed_room_of_unrecorded_type(world: World) -> None:
    slack = await world.bridge(adapter=_Adapter(type_fails=True))
    room_id = await world.room("old", slack, None)

    result = await world.service().apply(world.tenant, [room_id], actor_user_id="a")

    assert result.changed == [room_id]
    assert await world.visibility(room_id) == "private"


async def test_a_notice_that_cannot_be_posted_does_not_undo_the_change(
    world: World,
) -> None:
    slack = await world.bridge()
    room_id = await world.room("r", slack, "channel_private")
    world.notices = _Notices(fails=True)

    result = await world.service().apply(world.tenant, [room_id], actor_user_id="a")

    assert result.changed == [room_id]
    assert await world.visibility(room_id) == "private"
    assert len(await world.audits()) == 1


async def test_applying_twice_changes_once(world: World) -> None:
    slack = await world.bridge()
    room_id = await world.room("r", slack, "channel_private")
    service = world.service()

    await service.apply(world.tenant, [room_id, room_id], actor_user_id="a")
    again = await service.apply(world.tenant, [room_id], actor_user_id="a")

    assert again.skipped == [(room_id, "already_private")]
    assert len(await world.audits()) == 1
