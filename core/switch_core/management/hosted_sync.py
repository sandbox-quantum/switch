"""Cloud agents as managed agents placed on their machine's controller.

A cloud agent's cloud launch (`hosted_launches`) stays the record of its
machine, limits, billing and lifecycle, and the owner keeps changing it
through the cloud agent routes. What runs it on the machine is the machine's
agents controller, so each launch that has an agent is mirrored here as an
`agent_definitions` row placed on that controller (kind `ec2`, bound 1:1 to
the machine):

- The definition is the v1 shape (provider, model, instructions,
  auto_approve, isolated) plus a `hosted` block with what the machine's
  supervisor builds the agent's deployment from: the launch and its
  revision, the provider credential kind, the repository, the launch spec
  and the connection skills. The worker capability is not stored; the
  assignment adds it as it is read (`worker_capability`).
- It is rebuilt only when the launch moves to a new revision. Until then the
  row keeps what it had, the way a supervisor that ran the agent itself
  reinstalled it only on a new revision: instructions edited in between take
  effect at the next start, and a change to another agent on the machine
  restarts nothing here.
- It is placed on the machine's live controller, or left unplaced while the
  machine has none (before its first enrollment). An unplaced cloud agent is
  run the old way, from `/hosted/machines/{id}/agents`, so a machine on an
  image from before controllers keeps working.
- A launch being removed, or whose agent is gone, loses its row.

`place` runs inside a transaction that holds the machine's lock, and changes
rows only; `announce`, after the commit, tells Core's `ControllerPresence` and
nudges the controllers. Core triggers a sync through its `HostedPlacement`
hook (`machine_changed`, `machine_seen`).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.controller_presence import (
    DETACH_UNASSIGNED,
    Binding,
    ControllerPresence,
)
from switch_core.connections.loader import CATALOG, SKILL_PROVIDERS, deployment_skills
from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    Agent,
    AgentController,
    HostedLaunch,
    HostedMachine,
    ProviderConnection,
)
from switch_core.db.models import AgentDefinition as AgentDefinitionRow
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_controller_operation_store import (
    AgentControllerOperationStore,
)
from switch_core.db.stores.agent_controller_store import AgentControllerStore
from switch_core.db.stores.agent_definition_store import AgentDefinitionStore
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_machine_store import HostedMachineStore, lock_launch
from switch_core.management.notifier import ControllerNotifier
from switch_core.management.schemas import (
    HostedDefinition,
    StoredDefinition,
)

logger = logging.getLogger(__name__)

# The launch spec keys the supervisor builds a deployment from.
_SPEC_KEYS = (
    "name",
    "definition",
    "instructions",
    "definition_attributes",
    "auto_session",
    "auto_approve",
)


@dataclass
class HostedChange:
    """What a sync changed: rows placed or moved, agents unmanaged, and the
    controllers whose assignment moved on."""

    placed: list[AgentDefinitionRow] = field(default_factory=list)
    # The controllers rows were placed on, so they can be bound after commit.
    controllers: dict[str, AgentController] = field(default_factory=dict)
    removed: list[str] = field(default_factory=list)
    revisions: dict[str, int] = field(default_factory=dict)


def hosted_of(row: AgentDefinitionRow) -> HostedDefinition | None:
    return StoredDefinition.model_validate(row.definition).hosted


class HostedPlacements:
    def __init__(
        self,
        *,
        session_factory: async_sessionmaker[AsyncSession],
        controllers: AgentControllerStore,
        definitions: AgentDefinitionStore,
        operations: AgentControllerOperationStore,
        presence: ControllerPresence,
        notifier: ControllerNotifier,
        secret_key: str,
        binding_of: Callable[[str, AgentDefinitionRow, AgentController], Binding],
    ) -> None:
        self._session_factory = session_factory
        self._controllers = controllers
        self._definitions = definitions
        self._operations = operations
        self._presence = presence
        self._notifier = notifier
        self._secret_key = secret_key
        self._binding_of = binding_of
        # The agents version each machine was last synced at, so a heartbeat
        # syncs only what has changed since. Memory only: a restart syncs
        # every machine again on its first heartbeat.
        self._synced: dict[tuple[str, str], int] = {}

    # ── Core's hook ───────────────────────────────────────────────────────────

    async def machine_changed(self, tenant_id: str, machine_id: str) -> None:
        await self.sync(tenant_id, machine_id)

    async def machine_seen(
        self, tenant_id: str, machine_id: str, agents_version: int
    ) -> None:
        if self._synced.get((tenant_id, machine_id)) == agents_version:
            return
        await self.sync(tenant_id, machine_id)

    async def sync(self, tenant_id: str, machine_id: str) -> None:
        """Bring the machine's cloud agents' definitions in line with its launches."""
        async with tenant_session(self._session_factory, tenant_id) as session:
            machine = await HostedMachineStore().locked(session, machine_id)
            if machine is None:
                await session.commit()
                return
            controller = await self._controllers.live_for_machine(
                session, tenant_id, machine_id
            )
            change = await self.place(
                session,
                tenant_id,
                machine,
                None if controller is None else controller.id,
            )
            version = machine.agents_version
            await session.commit()
        self.announce(tenant_id, change)
        self._synced[(tenant_id, machine_id)] = version

    # ── Inside a transaction holding the machine lock ─────────────────────────

    async def place(
        self,
        session: AsyncSession,
        tenant_id: str,
        machine: HostedMachine,
        controller_id: str | None,
    ) -> HostedChange:
        change = HostedChange()
        if controller_id is not None:
            placed_on = await self._controllers.get(session, tenant_id, controller_id)
            if placed_on is None:
                raise RuntimeError(f"Controller {controller_id} vanished while placing")
            change.controllers[controller_id] = placed_on
        affected: set[str | None] = set()
        for launch in await HostedMachineStore().launches(session, machine.id):
            agent_id = launch.agent_id
            if agent_id is None:
                continue
            existing = await self._definitions.get_for_agent(
                session, tenant_id, agent_id
            )
            wanted = (
                launch.state not in {"deleting", "deleted"}
                and launch.desired_state != "deleted"
                and await session.get(Agent, agent_id) is not None
            )
            if existing is not None and hosted_of(existing) is None:
                logger.error(
                    "Cloud launch %s names agent %s, which is managed as a local "
                    "agent; leaving its definition alone",
                    launch.id,
                    agent_id,
                )
                continue
            if not wanted:
                if existing is not None:
                    await self._unmanage(session, tenant_id, existing)
                    affected.add(existing.controller_id)
                    change.removed.append(agent_id)
                continue
            row = await self._upsert(
                session, tenant_id, machine.id, launch, existing, controller_id
            )
            if row is None:
                continue
            if existing is not None:
                affected.add(existing.controller_id)
            affected.add(controller_id)
            change.placed.append(row)
            if (
                controller_id is not None
                and launch.state == "queued"
                and launch.desired_state == "running"
            ):
                # What the supervisor's own list used to do on first read: the
                # launch is handed to a runner, and must attach within the
                # attach timeout from now on.
                launch.state = "provisioning"
        for affected_id in sorted(c for c in affected if c is not None):
            change.revisions[
                affected_id
            ] = await self._controllers.bump_assignment_revision(
                session, tenant_id, affected_id
            )
        return change

    async def _upsert(
        self,
        session: AsyncSession,
        tenant_id: str,
        machine_id: str,
        launch: HostedLaunch,
        existing: AgentDefinitionRow | None,
        controller_id: str | None,
    ) -> AgentDefinitionRow | None:
        assert launch.agent_id is not None
        if existing is None:
            return await self._definitions.create(
                session,
                agent_id=launch.agent_id,
                owner_id=launch.owner_id,
                controller_id=controller_id,
                desired_state=self._desired_state(launch),
                definition=await self._definition(
                    session, tenant_id, machine_id, launch
                ),
            )
        hosted = hosted_of(existing)
        assert hosted is not None
        current = hosted.launch_revision == launch.revision
        if current and existing.controller_id == controller_id:
            return None
        return await self._definitions.update(
            session,
            tenant_id,
            launch.agent_id,
            controller_id=controller_id,
            desired_state=existing.desired_state
            if current
            else self._desired_state(launch),
            definition=existing.definition
            if current
            else await self._definition(session, tenant_id, machine_id, launch),
        )

    async def _unmanage(
        self, session: AsyncSession, tenant_id: str, row: AgentDefinitionRow
    ) -> None:
        await self._definitions.delete(session, tenant_id, row.agent_id)
        if row.controller_id is not None:
            await self._operations.cancel_open(
                session,
                tenant_id,
                controller_id=row.controller_id,
                agent_id=row.agent_id,
            )

    @staticmethod
    def _desired_state(launch: HostedLaunch) -> str:
        return "running" if launch.desired_state == "running" else "stopped"

    async def _definition(
        self,
        session: AsyncSession,
        tenant_id: str,
        machine_id: str,
        launch: HostedLaunch,
    ) -> dict[str, Any]:
        """The definition for the launch's current revision.

        Mints the launch's worker capability for this revision as it goes
        (the same bytes for every call at one revision), so the assignment
        always has one to hand out with the block.
        """
        await lock_launch(session, launch.id)
        spec = launch.spec
        provider = spec.get("provider", "claude")
        connection = await session.get(
            ProviderConnection, (tenant_id, launch.owner_id, provider)
        )
        if connection is None:
            logger.warning(
                "Cloud launch %s: the owner's %s connection is gone; its definition "
                "names no credential kind",
                launch.id,
                provider,
            )
        HostedLaunchStore().issue_worker_capability(launch, self._secret_key)
        attributes = spec.get("definition_attributes") or {}
        model = attributes.get("model") if isinstance(attributes, dict) else None
        definition = StoredDefinition(
            provider=provider,
            model=str(model) if model else None,
            instructions=spec.get("instructions", ""),
            auto_approve=bool(spec.get("auto_approve", False)),
            directory=None,
            isolation="isolated",
            hosted=HostedDefinition(
                machine_id=machine_id,
                launch_id=launch.id,
                launch_revision=launch.revision,
                provider_credential_kind=None
                if connection is None
                else connection.kind,
                repository=launch.repository,
                spec={key: spec[key] for key in _SPEC_KEYS if key in spec},
                skills=deployment_skills(CATALOG, ["github"])
                if provider in SKILL_PROVIDERS
                else [],
            ),
        )
        return definition.model_dump(mode="json")

    # ── After the commit ──────────────────────────────────────────────────────

    def announce(self, tenant_id: str, change: HostedChange) -> None:
        """Tell Core where each changed agent runs now, and nudge."""
        for row in change.placed:
            if row.controller_id is None:
                self._presence.unbind(row.agent_id, DETACH_UNASSIGNED)
            else:
                self._presence.bind(
                    self._binding_of(
                        tenant_id, row, change.controllers[row.controller_id]
                    )
                )
        for agent_id in change.removed:
            self._presence.unbind(agent_id, DETACH_UNASSIGNED)
        for controller_id, revision in change.revisions.items():
            self._notifier.assignment_changed(controller_id, revision)

    # ── Reading ───────────────────────────────────────────────────────────────

    async def worker_capability(
        self, session: AsyncSession, row: AgentDefinitionRow
    ) -> str | None:
        """The worker capability for the launch revision a cloud agent's
        definition names; None for any other agent, and for a launch that has
        moved past that revision (its definition is about to be replaced)."""
        hosted = hosted_of(row)
        if hosted is None:
            return None
        launch = await session.get(
            HostedLaunch, (row.tenant_id, hosted.launch_id), populate_existing=True
        )
        if (
            launch is None
            or launch.worker_capability_encrypted is None
            or launch.worker_capability_revision != hosted.launch_revision
            or launch.revision != hosted.launch_revision
        ):
            return None
        return decrypt_token(launch.worker_capability_encrypted, self._secret_key)
