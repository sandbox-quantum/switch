"""What archiving or restoring a workspace sets going once it has committed
(`WorkspaceArchive`): its agents cut off, its bridges and its devices' agents
brought in line, and on Restore its schedules moved past the runs it missed.

The parts it drives are fakes; what it reads and changes in the database is
real, through the role row-level security applies to, beside a second
workspace it must leave alone.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    AgentConnectionRecord,
    ApiKey,
    Client,
    CollaborationBridge,
    Room,
    RoomSchedule,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.tenant_context import current_tenant_id
from switch_core.workspace_archive import WorkspaceArchive
from tests.conftest import RLSHarness

LONDON = "Europe/London"


@dataclass
class _Workspace:
    tenant_id: str
    agent_ids: list[str] = field(default_factory=list)
    bridge_ids: list[str] = field(default_factory=list)
    schedule_id: str = ""


class _Connections:
    def __init__(self) -> None:
        self.ended: list[tuple[str, str | None]] = []

    async def agent_workspace_archived(self, agent_id: str) -> None:
        self.ended.append((agent_id, current_tenant_id()))


class _ApiKeyCache:
    def __init__(self) -> None:
        self.invalidated: list[str] = []

    def invalidate_agent(self, agent_id: str) -> None:
        self.invalidated.append(agent_id)


class _Bridges:
    def __init__(self) -> None:
        self.reconciled: list[str] = []

    async def reconcile_and_announce(self, bridge_id: str) -> None:
        self.reconciled.append(bridge_id)


class _Management:
    def __init__(self) -> None:
        self.changed: list[tuple[str, str | None]] = []

    async def workspace_archive_changed(
        self, session: AsyncSession, tenant_id: str
    ) -> None:
        self.changed.append((tenant_id, current_tenant_id()))


async def _agent(session: AsyncSession, tenant_id: str, suffix: str) -> str:
    owner = User(name=suffix, email=f"{suffix}@example.test", role="user")
    session.add(owner)
    await session.flush()
    api_key = ApiKey(
        tenant_id=tenant_id,
        user_id=owner.id,
        key_hash=f"hash-{suffix}",
        encrypted_key="enc",
        label=suffix,
        type="agent",
    )
    client = Client(
        tenant_id=tenant_id,
        transport_user_id=f"@{suffix}:test",
        display_name=suffix,
        type="agent",
    )
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        tenant_id=tenant_id,
        name=suffix,
        description="",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner.id,
    )
    session.add(agent)
    await session.flush()
    for n in range(2):
        await AgentConnectionStore().record_open(
            session,
            tenant_id=tenant_id,
            connection_id=f"conn-{suffix}-{n}",
            agent_id=agent.id,
            process_id="process-1",
            incarnation=n,
            scope="all",
            delivery_filter="addressed",
            spawn_capable=False,
            transport="websocket",
            speaks=None,
            accepts=None,
        )
    return agent.id


async def _workspace(harness: RLSHarness, label: str, missed: datetime) -> _Workspace:
    """A workspace with two connected agents, a bridge and a schedule whose
    run came due at `missed`."""
    suffix = uuid.uuid4().hex[:8]
    workspace = _Workspace(tenant_id=f"tenant-{label}-{suffix}")
    tenant_id = workspace.tenant_id
    async with harness.owner() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()
    async with tenant_session(harness.owner, tenant_id) as session:
        for n in range(2):
            workspace.agent_ids.append(
                await _agent(session, tenant_id, f"{label}-{n}-{suffix}")
            )
        bridge_client = Client(
            tenant_id=tenant_id,
            transport_user_id=f"@bridge-{label}-{suffix}:test",
            display_name="bridge",
            type="bridge",
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            tenant_id=tenant_id,
            type="mattermost",
            display_name="MM",
            client_id=bridge_client.id,
            status="active",
        )
        author = User(
            name=f"author-{suffix}",
            email=f"author-{label}-{suffix}@example.test",
            role="user",
        )
        room = Room(
            tenant_id=tenant_id,
            transport_room_id=f"!standup-{label}-{suffix}:test",
            name="standup",
            description="",
        )
        session.add_all([bridge, author, room])
        await session.flush()
        schedule = RoomSchedule(
            tenant_id=tenant_id,
            room_id=room.id,
            author_id=author.id,
            agent_ids=[],
            text="Summarise the new issues.",
            cron="0 9 * * *",
            run_at=None,
            timezone=LONDON,
            paused=False,
            next_run_at=missed,
        )
        session.add(schedule)
        await session.commit()
        workspace.bridge_ids.append(bridge.id)
        workspace.schedule_id = schedule.id
    return workspace


async def _connection_agents(harness: RLSHarness) -> set[str]:
    async with harness.owner() as session:
        return set(await session.scalars(select(AgentConnectionRecord.agent_id)))


async def _next_run(harness: RLSHarness, workspace: _Workspace) -> RoomSchedule:
    async with harness.owner() as session:
        schedule = await session.get(RoomSchedule, workspace.schedule_id)
    assert schedule is not None
    return schedule


@dataclass
class _Parts:
    connections: _Connections = field(default_factory=_Connections)
    cache: _ApiKeyCache = field(default_factory=_ApiKeyCache)
    bridges: _Bridges = field(default_factory=_Bridges)
    management: _Management = field(default_factory=_Management)


def _archive(harness: RLSHarness, parts: _Parts, *, managed: bool) -> WorkspaceArchive:
    return WorkspaceArchive(
        session_factory=harness.restricted,
        connections=parts.connections,  # type: ignore[arg-type]
        api_key_cache=parts.cache,  # type: ignore[arg-type]
        bridges=parts.bridges,  # type: ignore[arg-type]
        management=parts.management if managed else None,
    )


async def test_closing_cuts_off_its_agents_and_stops_its_bridges_and_devices(
    rls_harness: RLSHarness,
) -> None:
    missed = datetime.now(UTC) - timedelta(days=2)
    archived = await _workspace(rls_harness, "archived", missed)
    other = await _workspace(rls_harness, "other", missed)
    parts = _Parts()

    await _archive(rls_harness, parts, managed=True).closed(archived.tenant_id)

    assert await _connection_agents(rls_harness) == set(other.agent_ids)
    assert sorted(parts.cache.invalidated) == sorted(archived.agent_ids)
    assert sorted(parts.connections.ended) == sorted(
        (agent_id, archived.tenant_id) for agent_id in archived.agent_ids
    )
    assert parts.bridges.reconciled == archived.bridge_ids
    assert parts.management.changed == [(archived.tenant_id, archived.tenant_id)]
    # Its schedules simply wait while it is archived; Restore moves them on.
    assert (await _next_run(rls_harness, archived)).next_run_at == missed


async def test_reopening_starts_its_bridges_and_devices(
    rls_harness: RLSHarness,
) -> None:
    """Its agents are not told anything: they reconnect on their own once
    they are let in. Its schedules were moved on in the commit that restored
    it, so they are not touched here."""
    missed = datetime.now(UTC) - timedelta(days=2)
    restored = await _workspace(rls_harness, "restored", missed)
    other = await _workspace(rls_harness, "other", missed)
    parts = _Parts()

    await _archive(rls_harness, parts, managed=True).reopened(restored.tenant_id)

    assert (await _next_run(rls_harness, restored)).next_run_at == missed
    assert parts.bridges.reconciled == restored.bridge_ids
    assert parts.management.changed == [(restored.tenant_id, restored.tenant_id)]
    assert parts.cache.invalidated == []
    assert parts.connections.ended == []
    assert await _connection_agents(rls_harness) == set(
        restored.agent_ids + other.agent_ids
    )


async def test_without_agent_management_the_rest_still_happens(
    rls_harness: RLSHarness,
) -> None:
    archived = await _workspace(rls_harness, "archived", datetime.now(UTC))
    parts = _Parts()
    archive = _archive(rls_harness, parts, managed=False)

    await archive.closed(archived.tenant_id)
    await archive.reopened(archived.tenant_id)

    assert parts.bridges.reconciled == archived.bridge_ids * 2
    assert sorted(parts.cache.invalidated) == sorted(archived.agent_ids)
    assert parts.management.changed == []
