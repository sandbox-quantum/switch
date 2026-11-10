"""A new room takes its visibility from its channel.

A private channel, a group or a DM makes a private room; a public channel, or
no channel at all, a public one. A caller who says which it should be gets
that instead. Every room is stored write-private: changing a room is its
owner's (`room_policy`), so the write visibility grants nothing.

Real Postgres; the running bridge is faked.
"""

from __future__ import annotations

from typing import Any

import pytest

from switch_core.db.session_scope import tenant_session
from switch_core.room_policy import visibility_for_channel
from switch_core.room_service import RoomCreateConfig, RoomService
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness
from tests.switch_core.test_room_service_foreign_bridge import (
    _FakeLifecycle,
    _make_bridge,
    _make_tenant,
    _RecordingAdapter,
    _RecordingCollaborationCore,
    _service,
)

pytestmark = pytest.mark.no_ambient_tenant


class _Adapter(_RecordingAdapter):
    """Reports whatever type the test gives an existing channel."""

    def __init__(self, calls: list[str], existing_type: str) -> None:
        super().__init__(calls)
        self._existing_type = existing_type

    async def get_channel_type(self, external_channel_id: str) -> str:
        return self._existing_type

    async def require_bindable_channel(self, external_channel_id: str) -> None:
        return None


class _Lifecycle(_FakeLifecycle):
    def rooms_changed(self, bridge_id: str) -> None:
        return None


@pytest.fixture
async def world(rls_harness: RLSHarness) -> Any:
    tenant = await _make_tenant(rls_harness.owner)
    bridge = await _make_bridge(rls_harness.owner, tenant_id=tenant)
    core = _RecordingCollaborationCore(tenant)
    svc = _service(rls_harness.restricted, {bridge: core})
    svc._collab_lifecycle = _Lifecycle({bridge: core})  # type: ignore[assignment]

    async def make(existing_type: str = "channel_public", **config: Any) -> Any:
        core.adapter = _Adapter(core.calls, existing_type)
        with tenant_scope(tenant):
            result = await svc.create_room(
                RoomCreateConfig(name="r", description="d", **config)
            )
            async with tenant_session(rls_harness.restricted, tenant) as session:
                return await svc._room_store.get(session, result.room.id)

    return make, bridge


@pytest.mark.parametrize(
    ("channel_type", "expected"),
    [
        ("channel_public", "public"),
        ("channel_private", "private"),
        ("group", "private"),
        ("direct", "private"),
        ("lobby", "public"),
    ],
)
def test_visibility_for_channel(channel_type: str, expected: str) -> None:
    assert visibility_for_channel(channel_type) == expected


async def test_a_new_private_channel_makes_a_private_room(world: Any) -> None:
    make, bridge = world
    room = await make(bridge_id=bridge, channel_type="channel_private")
    assert (room.read_visibility, room.write_visibility) == ("private", "private")


async def test_a_new_public_channel_makes_a_public_room(world: Any) -> None:
    make, bridge = world
    room = await make(bridge_id=bridge, channel_type="channel_public")
    assert (room.read_visibility, room.write_visibility) == ("public", "private")


async def test_an_existing_channel_is_asked_what_it_is(world: Any) -> None:
    make, bridge = world
    room = await make(
        existing_type="channel_private",
        bridge_id=bridge,
        external_channel_id="chan-existing",
    )
    assert room.channel_type == "channel_private"
    assert room.read_visibility == "private"


async def test_a_channel_the_platform_delivered_follows_it(world: Any) -> None:
    make, bridge = world
    room = await make(
        bridge_id=bridge,
        external_channel_id="dm-1",
        channel_type="direct",
        created_by_kind="system",
    )
    assert room.read_visibility == "private"


async def test_a_room_with_no_channel_is_public_unless_told(world: Any) -> None:
    make, _ = world
    room = await make(internal_only=True)
    assert (room.read_visibility, room.write_visibility) == ("public", "private")
    room = await make(internal_only=True, read_visibility="private")
    assert room.read_visibility == "private"


async def test_an_explicit_choice_beats_the_channel(world: Any) -> None:
    make, bridge = world
    room = await make(
        bridge_id=bridge, channel_type="channel_private", read_visibility="public"
    )
    assert room.read_visibility == "public"


async def test_an_unknown_visibility_is_refused(world: Any) -> None:
    make, _ = world
    with pytest.raises(ValueError, match="read_visibility"):
        await make(internal_only=True, read_visibility="everyone")


async def test_changing_a_room_leaves_its_write_visibility_private(
    rls_harness: RLSHarness,
) -> None:
    tenant = await _make_tenant(rls_harness.owner)
    svc: RoomService = _service(rls_harness.restricted, {})
    svc.room_changed = lambda *a: None  # type: ignore[method-assign]
    with tenant_scope(tenant):
        created = await svc.create_room(
            RoomCreateConfig(name="r", description="d", internal_only=True)
        )
        await svc.update_room(created.room.id, read_visibility="private")
        async with tenant_session(rls_harness.restricted, tenant) as session:
            room = await svc._room_store.get(session, created.room.id)
        assert (room.read_visibility, room.write_visibility) == ("private", "private")
        with pytest.raises(ValueError, match="read_visibility"):
            await svc.update_room(created.room.id, read_visibility="nobody")
