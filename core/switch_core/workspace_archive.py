"""Archiving a workspace: closing it whole, with nothing deleted, and opening
it again (`Tenant.archived_at`).

An organization's admins archive and restore its workspaces
(`gateway/organizations.py`). While a workspace is archived:

- nobody but the organization's `org_admin`s, and the platform operator, may
  enter it: `tenants_bindable_by_user` leaves a membership in it out
  (`db/tenant_lookup.py`), which every request already reads;
- its agents may not authenticate (`bridges/agent/auth.py`), and those
  connected are cut off when it is archived;
- every agent on its devices is assigned stopped, without anything being
  revoked, so Restore starts them again (`management/service.py`);
- its messaging bridges stop, and a shared messaging app's events for it are
  dropped (`bridges/collaboration`);
- it can't be joined, by an invitation or a domain (`gateway/tenants.py`);
- its room schedules don't fire, and runs missed meanwhile are skipped in
  the commit that restores it, as for a paused schedule (`room_schedules.py`).

Each part asks `archived_workspace.is_archived` where it reads the workspace
anyway. What has to
happen once the change commits, in this process and every other, is
`WorkspaceArchive`'s; a process that misses it finds the state on its next
periodic re-check, since each re-check above reads it.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent, CollaborationBridge
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_connection_store import AgentConnectionStore
from switch_core.tenant_context import tenant_scope

if TYPE_CHECKING:
    from switch_core.bridges.agent.api_key_cache import ApiKeyCache
    from switch_core.bridges.agent.protocol.agent_connections import (
        AgentConnectionRegistry,
    )
    from switch_core.bridges.collaboration.lifecycle_service import (
        CollaborationBridgeLifecycleService,
    )

logger = logging.getLogger(__name__)


class DeviceAssignments(Protocol):
    """Agent management's part (`ManagementService`), injected so the core
    does not depend on it: telling a workspace's devices that its archive
    changed."""

    async def workspace_archive_changed(
        self, session: AsyncSession, tenant_id: str
    ) -> None: ...


class WorkspaceArchive:
    """What archiving or restoring a workspace sets going once it has
    committed: here at once, and in every other process when it is told."""

    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        connections: AgentConnectionRegistry,
        api_key_cache: ApiKeyCache,
        bridges: CollaborationBridgeLifecycleService,
        management: DeviceAssignments | None,
    ) -> None:
        self._session_factory = session_factory
        self._connections = connections
        self._api_key_cache = api_key_cache
        self._bridges = bridges
        self._management = management
        self._connection_store = AgentConnectionStore()

    async def closed(self, tenant_id: str) -> None:
        """`tenant_id` was archived: cut off its agents, stop its bridges and
        stop every agent on its devices."""
        agent_ids, bridge_ids = await self._contents(tenant_id)
        await self._end_connections(tenant_id, agent_ids)
        await self._reconcile_bridges(bridge_ids)
        await self._reassign_devices(tenant_id)
        logger.info(
            "Closed archived workspace %s: %d agents cut off, %d bridges stopped",
            tenant_id,
            len(agent_ids),
            len(bridge_ids),
        )

    async def reopened(self, tenant_id: str) -> None:
        """`tenant_id` was restored: start its bridges and its devices'
        agents again. Its agents reconnect on their own, now that they are let
        in, and its schedules were moved past the runs it missed in the commit
        that restored it (`room_schedules.skip_missed_runs`)."""
        _, bridge_ids = await self._contents(tenant_id)
        await self._reconcile_bridges(bridge_ids)
        await self._reassign_devices(tenant_id)
        logger.info(
            "Reopened restored workspace %s: %d bridges started",
            tenant_id,
            len(bridge_ids),
        )

    async def _contents(self, tenant_id: str) -> tuple[list[str], list[str]]:
        async with tenant_session(self._session_factory, tenant_id) as session:
            agent_ids = list(
                await session.scalars(
                    select(Agent.id).where(Agent.tenant_id == tenant_id)
                )
            )
            bridge_ids = list(
                await session.scalars(
                    select(CollaborationBridge.id).where(
                        CollaborationBridge.tenant_id == tenant_id
                    )
                )
            )
        return agent_ids, bridge_ids

    async def _end_connections(self, tenant_id: str, agent_ids: list[str]) -> None:
        """As re-issuing an agent's key does (`gateway/ownership.py`): the rows
        go first, so every process ends the connections when it reads them,
        even one that misses being told; then the keys this process
        remembers, which its authentication would otherwise let in until they
        expire."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            for agent_id in agent_ids:
                await self._connection_store.delete_agent(
                    session, tenant_id=tenant_id, agent_id=agent_id
                )
            await session.commit()
        with tenant_scope(tenant_id):
            for agent_id in agent_ids:
                self._api_key_cache.invalidate_agent(agent_id)
                await self._connections.agent_workspace_archived(agent_id)

    async def _reconcile_bridges(self, bridge_ids: list[str]) -> None:
        """Each bridge brought in line with its workspace here, and announced
        so every other process does the same (`bridge_signals.py`)."""
        for bridge_id in bridge_ids:
            await self._bridges.reconcile_and_announce(bridge_id)

    async def _reassign_devices(self, tenant_id: str) -> None:
        if self._management is None:
            return
        async with tenant_session(self._session_factory, tenant_id) as session:
            await self._management.workspace_archive_changed(session, tenant_id)
