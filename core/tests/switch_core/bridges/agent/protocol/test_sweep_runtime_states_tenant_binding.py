"""`ProtocolService.sweep_runtime_states` (CHOO-2623) spans every tenant by
nature: one pass resets every stale runtime-state row anywhere, so the read
that finds them is unscoped. Each row is itself tenant-scoped, so the rest of
the work for that row — the liveness check and the reset — binds that row's
own tenant, one at a time, rather than the whole sweep.

This pins three things about that: each row's write is bound to its own
tenant; a row from one tenant cannot leak its binding into the next row's
work, even when the two are processed back to back in the same sweep; and the
*whole* of a row's work is inside its binding, the emit at the end included.
That last one is not decoration — the emit is the visible half. It resolves a
mention handle and posts to a bridge, and leaving it outside the scope would
put every write a reader actually sees back on whatever was ambient.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.db.models import (
    Agent,
    AgentRuntimeState,
    ApiKey,
    Client,
    Room,
    Tenant,
    User,
)
from switch_core.db.stores.agent_runtime_state_store import AgentRuntimeStateStore
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.tenant_context import current_tenant_id


def _service(session_factory: async_sessionmaker[AsyncSession]) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    # Nothing is registered, so every agent/room pair reads as not live —
    # the sweep's job is exactly to reset those.
    svc.connections = ConnectionRegistry()  # type: ignore[attr-defined]
    svc.agent_session_store = AgentSessionStore()  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.agent_runtime_state_store = AgentRuntimeStateStore()  # type: ignore[attr-defined]

    async def _no_emit(**_kwargs: object) -> None:
        return None

    svc._emit_runtime_state = _no_emit  # type: ignore[attr-defined,method-assign]

    async def _no_mention(*_args: object, **_kwargs: object) -> None:
        return None

    svc._mention_handle_for = _no_mention  # type: ignore[attr-defined,method-assign]
    return svc


async def _make_tenant(session: AsyncSession, tenant_id: str) -> None:
    session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
    await session.flush()


async def _make_stale_runtime_state(
    session: AsyncSession, *, tenant_id: str
) -> tuple[str, str]:
    """A `working` row with no live agent session or connection behind it —
    exactly what the sweep exists to find. Returns (agent_id, room_id)."""
    suffix = uuid.uuid4().hex[:8]
    owner = User(name=f"owner-{suffix}", email=f"owner-{suffix}@test", role="user")
    session.add(owner)
    await session.flush()
    api_key = ApiKey(
        tenant_id=tenant_id,
        user_id=owner.id,
        key_hash=f"hash-{suffix}",
        encrypted_key="enc",
        label="k",
        type="agent",
    )
    client = Client(
        tenant_id=tenant_id,
        matrix_user_id=f"@agent-{suffix}:test",
        display_name="agent",
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        tenant_id=tenant_id,
        name=f"agent-{suffix}",
        description="d",
        agent_type="session_addressable",
        connector_type="external",
        integration_profile={"connection_model": "session_passive"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    room = Room(
        tenant_id=tenant_id,
        matrix_room_id=f"!room-{suffix}:test",
        name="room",
        description="d",
    )
    session.add(room)
    await session.flush()
    session.add(
        AgentRuntimeState(
            tenant_id=tenant_id,
            agent_id=agent.id,
            room_id=room.id,
            state="working",
        )
    )
    await session.flush()
    return agent.id, room.id


async def test_sweep_binds_each_row_s_own_tenant_and_does_not_leak(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
    tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant_a)
        await _make_tenant(session, tenant_b)
        agent_a, room_a = await _make_stale_runtime_state(session, tenant_id=tenant_a)
        agent_b, room_b = await _make_stale_runtime_state(session, tenant_id=tenant_b)
        await session.commit()

    seen: dict[str, str | None] = {}
    original_upsert = AgentRuntimeStateStore.upsert

    async def _spy_upsert(self, session, agent_id, room_id, state, *args, **kwargs):
        seen[agent_id] = current_tenant_id()
        return await original_upsert(
            self, session, agent_id, room_id, state, *args, **kwargs
        )

    AgentRuntimeStateStore.upsert = _spy_upsert  # type: ignore[method-assign]
    try:
        service = _service(session_factory)
        assert current_tenant_id() is None
        await service.sweep_runtime_states()
        assert current_tenant_id() is None
    finally:
        AgentRuntimeStateStore.upsert = original_upsert  # type: ignore[method-assign]

    assert seen == {agent_a: tenant_a, agent_b: tenant_b}

    async with session_factory() as session:
        store = AgentRuntimeStateStore()
        row_a = await store.get(session, agent_a, room_a)
        row_b = await store.get(session, agent_b, room_b)
    assert row_a is not None and row_a.state == "idle"
    assert row_b is not None and row_b.state == "idle"


async def test_the_tail_of_a_row_s_work_is_still_inside_its_binding(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """`_mention_handle_for` and `_emit_runtime_state` run after the upsert's
    session has closed. They are still that row's work — the handle is read
    from `external_users`, and what the emit provokes is a post into the
    room — so they must still be under the row's tenant."""
    tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
    tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant_a)
        await _make_tenant(session, tenant_b)
        agent_a, _ = await _make_stale_runtime_state(session, tenant_id=tenant_a)
        agent_b, _ = await _make_stale_runtime_state(session, tenant_id=tenant_b)
        await session.commit()

    service = _service(session_factory)
    emitted: dict[str, str | None] = {}
    handles: dict[str, str | None] = {}

    async def _record_emit(**kwargs: object) -> None:
        emitted[str(kwargs["agent_id"])] = current_tenant_id()

    async def _record_handle(agent: object, bridge_id: object) -> None:
        handles[str(getattr(agent, "id", agent))] = current_tenant_id()

    service._emit_runtime_state = _record_emit  # type: ignore[attr-defined,method-assign]
    service._mention_handle_for = _record_handle  # type: ignore[attr-defined,method-assign]

    await service.sweep_runtime_states()

    assert emitted == {agent_a: tenant_a, agent_b: tenant_b}
    assert handles == {agent_a: tenant_a, agent_b: tenant_b}
    assert current_tenant_id() is None
