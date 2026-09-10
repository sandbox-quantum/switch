"""An inbound platform event acts under the tenant it belongs to (CHOO-2623).

`_traced` is the one choke point every inbound handler goes through, and it is
where the tenant is bound: the room's, when the channel already maps to one;
the bridge's, when it does not and the handler is about to create the room.

Two properties fall out of doing it there, and both are pinned below.

**A room created after the bridge started resolves like any other.** The
channel map is not only loaded at boot — `add_room_mapping` is called whenever
a room is created, adopted or moved onto a channel — so it, and not the boot
load, is what has to carry the tenant. It does, which is why the inbound path
reads no row at all.

**The platform stops mattering.** Mattermost's websocket runs on an OS thread
and hands its coroutine over with `asyncio.run_coroutine_threadsafe`, which
starts it in an *empty* context; Slack's dispatches from a task that inherited
whatever created it. Binding at the choke point rather than depending on what
the handler inherits means both land in the same tenant, so which platform a
message arrived on can no longer decide where its room goes.
"""

from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.bridge_core import BridgeCore
from switch_core.tenant_context import current_tenant_id, tenant_scope

BRIDGE_TENANT = "tenant-bridge"
ROOM_TENANT = "tenant-room"


class _ExplodingSessionFactory:
    """A session factory that fails if anything opens a session.

    The inbound path must resolve a tenant from what it already holds. A read
    here would not merely be slow: it would run under whatever tenant is bound
    at the time, which on this path is the question being asked.
    """

    def __call__(self) -> Any:
        raise AssertionError(
            "the inbound path opened a database session to resolve a tenant; "
            "add_room_mapping is supposed to have recorded it already"
        )


def _bridge() -> BridgeCore:
    bridge = BridgeCore.__new__(BridgeCore)
    bridge._bridge_id = "bridge-1"
    bridge._bridge_tenant_id = BRIDGE_TENANT
    bridge._bridge_type = "mattermost"
    bridge._channel_to_room = {}
    bridge._room_to_channel = {}
    bridge._room_tenants = {}
    bridge._session_factory = _ExplodingSessionFactory()  # type: ignore[assignment]
    return bridge


def _event(channel_id: str) -> SimpleNamespace:
    return SimpleNamespace(channel_id=channel_id)


async def test_a_room_created_after_the_bridge_started_resolves_its_tenant() -> None:
    """The defect this replaces: `add_room_mapping` filled the channel maps
    and not the tenant map, so every room created after boot missed the cache
    and fell into a database read under whatever was ambient."""
    bridge = _bridge()
    seen: list[str | None] = []

    async def _handler(event: object) -> None:
        seen.append(current_tenant_id())

    traced = bridge._traced(_handler)

    # Exactly what room creation does once the room exists (room_service),
    # long after `_load_channel_map` ran.
    bridge.add_room_mapping("room-new", "!new:test", "C-new", ROOM_TENANT)

    await traced(_event("C-new"))

    assert seen == [ROOM_TENANT]


async def test_an_unmapped_channel_binds_the_bridges_own_tenant() -> None:
    """Auto-room-creation. There is no room to ask, but the answer is not
    ambient either: a room this bridge creates belongs to the tenant that owns
    the bridge, and the schema agrees — `rooms` keys to
    `collaboration_bridges` on `tenant_id`."""
    bridge = _bridge()
    seen: list[str | None] = []

    async def _handler(event: object) -> None:
        seen.append(current_tenant_id())

    await bridge._traced(_handler)(_event("C-unknown"))

    assert seen == [BRIDGE_TENANT]


async def test_the_binding_does_not_outlive_the_event() -> None:
    bridge = _bridge()
    bridge.add_room_mapping("room-1", "!one:test", "C1", ROOM_TENANT)

    async def _handler(event: object) -> None:
        assert current_tenant_id() == ROOM_TENANT

    await bridge._traced(_handler)(_event("C1"))

    assert current_tenant_id() is None


async def test_removing_a_mapping_forgets_the_tenant_with_it() -> None:
    """Otherwise the tenant map is the one part of the mapping that only ever
    grows, and a room id reused after a bridge move would resolve to a stale
    answer with nothing to correct it."""
    bridge = _bridge()
    bridge.add_room_mapping("room-1", "!one:test", "C1", ROOM_TENANT)
    bridge.remove_room_mapping("room-1", "!one:test")

    assert bridge._room_tenants == {}


async def test_a_thread_dispatched_event_lands_in_the_same_tenant() -> None:
    """Mattermost, in miniature.

    `asyncio.run_coroutine_threadsafe` starts the coroutine in an empty
    context — nothing the bridge's task had bound reaches it. Under the model
    this replaces, that made auto-created rooms land in tenant zero on
    Mattermost and in the bridge's tenant everywhere else: a per-platform
    lottery. Both dispatch styles now agree.
    """
    bridge = _bridge()
    bridge.add_room_mapping("room-1", "!one:test", "C1", ROOM_TENANT)
    seen: list[str | None] = []

    async def _handler(event: object) -> None:
        seen.append(current_tenant_id())

    traced = bridge._traced(_handler)
    loop = asyncio.get_running_loop()

    # Dispatched the way the Mattermost adapter does it, from a thread with no
    # context of its own, and the way every other adapter does it, inline.
    await asyncio.wrap_future(
        asyncio.run_coroutine_threadsafe(traced(_event("C1")), loop)
    )
    await traced(_event("C1"))

    assert seen == [ROOM_TENANT, ROOM_TENANT]


class TestAPuppetIsMintedInTheBridgesTenant:
    """A puppet is per-bridge and reused for every room the person it stands
    for ever speaks in, so it cannot be stamped with the tenant of whichever
    room happened to trigger it first. The rooms a bridge carries are all in
    its tenant (`rooms` keys to `collaboration_bridges` on `tenant_id`), so
    the bridge's is the only answer that holds for all of them.
    """

    async def test_the_identity_is_created_under_the_bridges_tenant(self) -> None:
        bridge = BridgeCore.__new__(BridgeCore)
        bridge._bridge_id = "bridge-1"
        bridge._bridge_tenant_id = BRIDGE_TENANT
        bridge._bridge_type = "mattermost"
        bridge._puppet_locks = {}
        bridge._user_puppets = {}
        bridge._puppet_matrix_ids = set()
        seen: list[str | None] = []

        async def _locked(external_user_id: str, external_username: str) -> str:
            seen.append(current_tenant_id())
            return "client-1"

        bridge._create_puppet_locked = _locked  # type: ignore[assignment]

        # Reached from inside an inbound event for a room — the binding the
        # puppet must *not* adopt, were the two ever to differ.
        with tenant_scope(ROOM_TENANT):
            assert await bridge._create_puppet("U1", "alice") == "client-1"

        assert seen == [BRIDGE_TENANT]

    async def test_a_cached_puppet_is_returned_without_reminting(self) -> None:
        bridge = BridgeCore.__new__(BridgeCore)
        bridge._bridge_tenant_id = BRIDGE_TENANT
        bridge._puppet_locks = {}
        bridge._user_puppets = {"U1": "client-1"}

        # The cache check lives inside the locked half, so this proves the
        # split did not move it out from under the lock.
        bridge._create_puppet_locked = BridgeCore._create_puppet_locked.__get__(bridge)  # type: ignore[assignment]

        assert await bridge._create_puppet("U1", "alice") == "client-1"


@pytest.mark.parametrize("tenant", [BRIDGE_TENANT, ROOM_TENANT])
async def test_the_mapping_records_whatever_tenant_it_is_given(tenant: str) -> None:
    """`add_room_mapping` does not guess. Its caller has the room row in hand
    and passes the row's tenant, so a room whose tenant somehow differs from
    its bridge's is still handled under its own."""
    bridge = _bridge()
    room_id = f"room-{uuid.uuid4().hex[:8]}"
    bridge.add_room_mapping(room_id, f"!{room_id}:test", "C1", tenant)

    assert await bridge._room_tenant(room_id) == tenant
