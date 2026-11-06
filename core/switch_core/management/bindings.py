"""Telling Core which controller runs each managed agent.

Core keeps the bindings in memory (`ControllerPresence`), so a restart forgets
them, and they must be back before the agent bridge serves: until then a
controller-backed agent would read as directly connected, and its own API key
would be let in. They are read from every tenant, which is a question no
tenant can be scoped to, so the tenants come from the exemption
(`db/tenant_lookup.py`) and each tenant's definitions are then read under its
own policy.

The same reads keep every process's bindings current after startup. A
placement changes in the process that served the request, and every other
process holds the old binding until it reads the tables again: on a
`controller.assignment_changed` or `controller.renamed` signal for one
controller (`reconcile_controller_bindings`), and for all of them when the
signal connection comes back and on each periodic re-check
(`reconcile_bindings`). See `management/signals.py`.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    Binding,
    ControllerPresence,
)
from switch_core.db.fingerprint import Fingerprint
from switch_core.db.models import AgentController
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.tenant_lookup import all_tenant_ids

logger = logging.getLogger(__name__)


def binding_of(
    tenant_id: str, row: AgentDefinitionRow, controller: AgentController
) -> Binding:
    """The binding Core keeps for a definition placed on `controller`."""
    assert row.controller_id == controller.id
    return Binding(
        agent_id=row.agent_id,
        controller_id=controller.id,
        tenant_id=tenant_id,
        controller_name=controller.name,
        running=row.desired_state == "running",
    )


async def load_bindings(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    presence: ControllerPresence,
) -> int:
    """Load every placed definition into `presence`, and mark the controllers
    already revoked that agents are still placed on. Returns how many."""
    bindings, revoked, _ = await _read_bindings(
        session_factory=session_factory, definitions=definitions
    )
    presence.load(bindings)
    for controller_id in revoked:
        presence.revoke_controller(controller_id)
    logger.info("Loaded %d controller binding(s) into Core", len(bindings))
    return len(bindings)


async def reconcile_bindings(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    presence: ControllerPresence,
    fingerprints: dict[str, Fingerprint] | None = None,
) -> None:
    """Bring every binding in `presence` in line with the tables, changing
    only what differs, and close the controllers revoked meanwhile.

    With `fingerprints`, each tenant's placements as the last full read here
    found them, nothing is read when no tenant's placements have changed
    since (`AgentDefinitionStore.placements_fingerprint`), and `fingerprints`
    is brought up to date when they have. That is the periodic re-check,
    which every process runs and which on a quiet deployment finds nothing to
    repair."""
    if fingerprints is not None and await _unchanged(
        session_factory, definitions, fingerprints
    ):
        return
    since = presence.change_mark()
    bindings, revoked, read = await _read_bindings(
        session_factory=session_factory, definitions=definitions
    )
    if fingerprints is not None:
        fingerprints.clear()
        fingerprints.update(read)
    presence.reconcile(
        bindings,
        agent_ids=presence.bound_agent_ids() | {b.agent_id for b in bindings},
        since=since,
    )
    for controller_id in revoked:
        if not presence.is_revoked(controller_id):
            presence.revoke_controller(controller_id)


async def reconcile_controller_bindings(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    controllers: AgentControllerStore,
    presence: ControllerPresence,
    tenant_id: str,
    controller_id: str,
) -> None:
    """Bring the bindings of the agents on one controller in line with the
    tables: the agents placed on it now, and the ones this process still has
    bound to it. One of those that moved to another controller is bound
    there, so the order in which the two controllers' signals arrive does not
    matter."""
    since = presence.change_mark()
    bindings: list[Binding] = []
    async with tenant_session(session_factory, tenant_id) as session:
        controller = await controllers.get(session, tenant_id, controller_id)
        placed = (
            await definitions.list_for_controller(session, tenant_id, controller_id)
            if controller is not None
            else []
        )
        for row, _agent in placed:
            assert controller is not None
            bindings.append(binding_of(tenant_id, row, controller))
        placed_here = {binding.agent_id for binding in bindings}
        for agent_id in presence.agents_of(controller_id) - placed_here:
            moved = await definitions.get_for_agent(session, tenant_id, agent_id)
            if moved is None or moved.controller_id is None:
                continue
            elsewhere = await controllers.get(session, tenant_id, moved.controller_id)
            if elsewhere is not None:
                bindings.append(binding_of(tenant_id, moved, elsewhere))
    presence.reconcile(
        bindings,
        agent_ids=presence.agents_of(controller_id) | placed_here,
        since=since,
    )


async def _unchanged(
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    fingerprints: dict[str, Fingerprint],
) -> bool:
    """Whether every tenant's placements read as they did when
    `fingerprints` were taken, and there are no tenants beyond those."""
    tenant_ids = await all_tenant_ids(session_factory)
    if set(tenant_ids) != set(fingerprints):
        return False
    for tenant_id in tenant_ids:
        async with tenant_session(session_factory, tenant_id) as session:
            now = await definitions.placements_fingerprint(session, tenant_id)
        if now != fingerprints[tenant_id]:
            return False
    return True


async def _read_bindings(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
) -> tuple[list[Binding], set[str], dict[str, Fingerprint]]:
    """Every placed definition's binding, the revoked controllers that agents
    are still placed on, and each tenant's fingerprint of its placements, one
    query per tenant."""
    bindings: list[Binding] = []
    revoked: set[str] = set()
    fingerprints: dict[str, Fingerprint] = {}
    for tenant_id in await all_tenant_ids(session_factory):
        async with tenant_session(session_factory, tenant_id) as session:
            placements, fingerprints[tenant_id] = await definitions.placements(
                session, tenant_id
            )
        for placement in placements:
            if placement.controller_name is None:
                raise RuntimeError(
                    f"agent {placement.agent_id} is placed on controller "
                    f"{placement.controller_id}, which does not exist"
                )
            if placement.controller_revoked_at is not None:
                revoked.add(placement.controller_id)
            bindings.append(
                Binding(
                    agent_id=placement.agent_id,
                    controller_id=placement.controller_id,
                    tenant_id=tenant_id,
                    controller_name=placement.controller_name,
                    running=placement.desired_state == "running",
                )
            )
    return bindings, revoked, fingerprints
