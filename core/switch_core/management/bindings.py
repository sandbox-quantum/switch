"""Telling Core which controller runs each managed agent.

Core keeps the bindings in memory (`ControllerPresence`), so a restart forgets
them, and they must be back before the agent bridge serves: until then a
controller-backed agent would read as directly connected, and its own API key
would be let in. They are read from every tenant, which is a question no
tenant can be scoped to, so the tenants come from the exemption
(`db/tenant_lookup.py`) and each tenant's definitions are then read under its
own policy. `management/reload.py` reads them the same way afterwards, to
follow changes made outside this process.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    Binding,
    ControllerPresence,
)
from switch_core.db.models import AgentController
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.tenant_lookup import all_tenant_ids
from switch_core.management.service import binding_of

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Placements:
    """Every placed definition as a binding, the controllers already revoked
    that agents are still placed on, and the assignment revision of each
    controller an agent is placed on."""

    bindings: list[Binding]
    revoked: set[str]
    revisions: dict[str, int]


async def read_placements(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    controllers: AgentControllerStore,
) -> Placements:
    bindings: list[Binding] = []
    revoked: set[str] = set()
    revisions: dict[str, int] = {}
    for tenant_id in await all_tenant_ids(session_factory):
        async with tenant_session(session_factory, tenant_id) as session:
            placed_on: dict[str, AgentController] = {}
            # Filtered on the row's own tenant as well as by the store: see
            # `db/tenant_lookup.py`, "a fan-out ... filters what it reads back".
            for row in await definitions.list_placed(session, tenant_id):
                if row.tenant_id != tenant_id or row.controller_id is None:
                    continue
                controller = placed_on.get(row.controller_id)
                if controller is None:
                    controller = await controllers.get(
                        session, tenant_id, row.controller_id
                    )
                    if controller is None:
                        raise RuntimeError(
                            f"agent {row.agent_id} is placed on controller "
                            f"{row.controller_id}, which does not exist"
                        )
                    placed_on[controller.id] = controller
                    revisions[controller.id] = controller.assignment_revision
                if controller.revoked_at is not None:
                    revoked.add(controller.id)
                bindings.append(binding_of(tenant_id, row, controller))
    return Placements(bindings, revoked, revisions)


async def load_bindings(
    *,
    session_factory: async_sessionmaker[AsyncSession],
    definitions: AgentDefinitionStore,
    controllers: AgentControllerStore,
    presence: ControllerPresence,
) -> int:
    """Load every placed definition into `presence`, and mark the controllers
    already revoked that agents are still placed on. Returns how many."""
    placements = await read_placements(
        session_factory=session_factory,
        definitions=definitions,
        controllers=controllers,
    )
    presence.load(placements.bindings)
    for controller_id in placements.revoked:
        presence.revoke_controller(controller_id)
    logger.info("Loaded %d controller binding(s) into Core", len(placements.bindings))
    return len(placements.bindings)
