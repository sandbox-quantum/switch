from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, cast

from sqlalchemy import and_, case, exists, literal, or_, select, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import (
    Agent,
    ApprovalRequest,
    HostedLaunch,
    HostedMachine,
    HostedOperation,
    ProviderConnection,
    require_tenant_id,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.hosted_machine_store import (
    HostedMachineStore,
    capability_hash,
    idle_sleeping,
    lock_launch,
    lock_launches,
    machine_starting,
)
from switch_core.db.stores.hosted_mailbox_store import HostedMailboxStore
from switch_core.keys import Keyring

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.agent_connections import (
        AgentConnectionRegistry,
    )
    from switch_core.bridges.agent.protocol.hosted_workers import IdleReport


class HostedLaunchConflict(Exception):
    pass


@dataclass(frozen=True)
class IdleEvidence:
    """Whether a launch is busy, why, and the report an idle verdict rests on."""

    busy: bool
    reasons: list[str]
    report: IdleReport | None


UNCONFIRMED_CLAIM_EXPIRY = timedelta(minutes=5)


class HostedLaunchStore:
    async def reserve(
        self,
        session: AsyncSession,
        *,
        request_id: str,
        owner_id: str,
        name: str,
        spec: dict,
        capacity: int,
        owner_capacity: int,
        slots: list[str],
        repository: str | None,
        now: datetime,
    ) -> HostedLaunch:
        """Reserve a launch on the owner's machine, claiming one if needed.

        Raises `HostedLaunchConflict` for the name, request and per-owner
        checks, and `HostedMachineConflict` when no machine can take it.
        """
        tenant_id = require_tenant_id()
        await lock_launches(session)
        await AgentStore().lock_name(session, name)
        existing = await session.get(HostedLaunch, (tenant_id, request_id))
        if existing:
            if (
                existing.owner_id != owner_id
                or existing.name != name
                or existing.spec != spec
            ):
                raise HostedLaunchConflict(
                    "This launch request was already used for different agent details."
                )
            return existing
        if await session.scalar(
            select(Agent.id).where(Agent.tenant_id == tenant_id, Agent.name == name)
        ):
            raise HostedLaunchConflict("An agent already uses this name.")
        launches = list(
            (
                await session.scalars(
                    select(HostedLaunch).where(HostedLaunch.tenant_id == tenant_id)
                )
            ).all()
        )
        if any(launch.name == name for launch in launches):
            raise HostedLaunchConflict(
                "A cloud launch already reserves this agent name."
            )
        if (
            sum(
                launch.owner_id == owner_id and launch.state != "deleted"
                for launch in launches
            )
            >= owner_capacity
        ):
            raise HostedLaunchConflict(
                "Your cloud agent limit has been reached. Remove an agent before creating another."
            )
        machines = HostedMachineStore()
        machine = await machines.claim(
            session, owner_id=owner_id, slots=slots, capacity=capacity, now=now
        )
        launch = HostedLaunch(
            id=request_id,
            owner_id=owner_id,
            name=name,
            spec=spec,
            state="queued",
            agent_id=None,
            machine_id=machine.id,
            repository=repository,
            active_at=now,
            created_at=now,
            updated_at=now,
        )
        session.add(launch)
        machines.bump_agents(machine)
        await session.flush()
        return launch

    async def owned(
        self, session: AsyncSession, request_id: str, owner_id: str
    ) -> HostedLaunch | None:
        return cast(
            HostedLaunch | None,
            await session.scalar(
                select(HostedLaunch).where(
                    HostedLaunch.tenant_id == require_tenant_id(),
                    HostedLaunch.id == request_id,
                    HostedLaunch.owner_id == owner_id,
                )
            ),
        )

    async def merge_spec(
        self, session: AsyncSession, launch_id: str, changes: dict
    ) -> None:
        """Overwrite these keys of a launch's spec in one statement, keeping its other keys."""
        await session.execute(
            update(HostedLaunch)
            .where(
                HostedLaunch.tenant_id == require_tenant_id(),
                HostedLaunch.id == launch_id,
            )
            .values(
                spec=HostedLaunch.spec.op("||", return_type=JSONB)(
                    literal(changes, JSONB)
                )
            )
            .execution_options(synchronize_session=False)
        )

    async def fail_stale_operations(
        self, session: AsyncSession, launch_id: str, revision: int
    ) -> None:
        await session.execute(
            update(HostedOperation)
            .where(
                HostedOperation.tenant_id == require_tenant_id(),
                HostedOperation.launch_id == launch_id,
                HostedOperation.launch_revision != revision,
                HostedOperation.state.in_(["queued", "claimed"]),
            )
            .values(
                state=case(
                    (HostedOperation.state == "claimed", "unknown"), else_="failed"
                ),
                error="The worker changed before this operation was confirmed. Inspect the session if the outcome is unknown.",
                updated_at=datetime.now(UTC),
            )
        )
        await session.execute(
            update(HostedOperation)
            .where(
                HostedOperation.tenant_id == require_tenant_id(),
                HostedOperation.launch_id == launch_id,
                HostedOperation.state == "claimed",
                HostedOperation.updated_at
                < datetime.now(UTC) - UNCONFIRMED_CLAIM_EXPIRY,
            )
            .values(
                state="unknown",
                error="The worker did not confirm the outcome. Inspect the session before issuing another operation.",
                updated_at=datetime.now(UTC),
            )
        )

    async def locked(
        self, session: AsyncSession, launch_id: str
    ) -> HostedLaunch | None:
        await lock_launch(session, launch_id)
        return await session.get(
            HostedLaunch, (require_tenant_id(), launch_id), populate_existing=True
        )

    def issue_worker_capability(self, launch: HostedLaunch, keyring: Keyring) -> str:
        """The worker capability for the launch's current revision.

        The same bytes for every call at one revision, so a lost `prepare`
        response costs nothing; a new revision mints new ones and overwrites
        the old, so at most one is ever valid. The caller commits.
        """
        if (
            launch.worker_capability_revision == launch.revision
            and launch.worker_capability_encrypted is not None
        ):
            return keyring.decrypt(launch.worker_capability_encrypted)
        capability = secrets.token_urlsafe(32)
        launch.worker_capability_encrypted = keyring.encrypt(capability)
        launch.worker_capability_hash = capability_hash(capability)
        launch.worker_capability_revision = launch.revision
        return capability

    @staticmethod
    def capability_matches(launch: HostedLaunch, capability: str) -> bool:
        """Whether `capability` is the one minted for the launch's current revision.

        Launch state and owner membership are the caller's to check alongside.
        """
        return (
            launch.worker_capability_hash is not None
            and launch.worker_capability_revision == launch.revision
            and secrets.compare_digest(
                launch.worker_capability_hash, capability_hash(capability)
            )
        )

    async def queued_operation_ids(
        self, session: AsyncSession, launch: HostedLaunch, boot_id: str
    ) -> list[str]:
        """The operations the worker on `boot_id` should claim.

        Includes those that boot already claimed without a result: the claim
        reply may have been lost, and the worker runs an operation only after
        journaling its claim, so claiming again never runs it twice.
        """
        return list(
            await session.scalars(
                select(HostedOperation.id)
                .where(
                    HostedOperation.tenant_id == require_tenant_id(),
                    HostedOperation.launch_id == launch.id,
                    HostedOperation.launch_revision == launch.revision,
                    or_(
                        HostedOperation.state == "queued",
                        and_(
                            HostedOperation.state == "claimed",
                            HostedOperation.claimed_boot_id == boot_id,
                        ),
                    ),
                )
                .order_by(HostedOperation.created_at)
            )
        )

    async def credential_revision(
        self, session: AsyncSession, launch: HostedLaunch
    ) -> str | None:
        """The owner's provider credential revision, as the credential route reports it."""
        connection = await session.get(
            ProviderConnection,
            (
                require_tenant_id(),
                launch.owner_id,
                launch.spec.get("provider", "claude"),
            ),
            populate_existing=True,
        )
        return None if connection is None else str(connection.verified_at)

    async def idle_evidence(
        self,
        session: AsyncSession,
        launch: HostedLaunch,
        registry: AgentConnectionRegistry,
    ) -> IdleEvidence:
        """What Core knows about whether the launch's worker is doing anything.

        Read under the launch lock. Busy wins on any single signal, and a
        missing or stale report is a signal: the controller stops a VM only on
        evidence.
        """
        reasons: list[str] = []
        report = (
            registry.fresh_idle_report(launch.agent_id, launch.id, launch.revision)
            if launch.agent_id
            else None
        )
        if report is None:
            reasons.append("no_fresh_report")
        else:
            if report.busy:
                reasons.append("report_busy")
            if report.relays_through < launch.relay_seq:
                reasons.append("relays_unacknowledged")
        if launch.agent_id and registry.relays.mutating_pending(
            launch.agent_id, launch.id
        ):
            reasons.append("relay_pending")
        if await session.scalar(
            select(
                exists().where(
                    HostedOperation.tenant_id == require_tenant_id(),
                    HostedOperation.launch_id == launch.id,
                    HostedOperation.launch_revision == launch.revision,
                    HostedOperation.state.in_(["queued", "claimed"]),
                )
            )
        ):
            reasons.append("operation_pending")
        if await HostedMailboxStore().busy(session, launch.id):
            reasons.append("mailbox_pending")
        if launch.agent_id and await session.scalar(
            select(
                exists().where(
                    ApprovalRequest.tenant_id == require_tenant_id(),
                    ApprovalRequest.agent_id == launch.agent_id,
                    ApprovalRequest.state == "open",
                )
            )
        ):
            reasons.append("approval_open")
        return IdleEvidence(busy=bool(reasons), reasons=reasons, report=report)

    async def note_addressed(
        self, session: AsyncSession, launch_id: str
    ) -> tuple[HostedLaunch | None, HostedMachine | None]:
        """Record that the launch's agent was addressed, waking its machine if idle-stopped.

        Takes the machine and launch locks. The caller commits. Raises
        `ProviderDisconnected` rather than wake a machine for a launch whose
        owner has no provider connection: the agent would only fail to start.
        """
        machines = HostedMachineStore()
        launch, machine = await machines.locked_launch(session, launch_id)
        if launch is None or machine is None:
            return launch, machine
        now = datetime.now(UTC)
        if (
            idle_sleeping(machine)
            and machine.state != "error"
            and launch.desired_state == "running"
            and launch.state != "error"
        ):
            if await self.credential_revision(session, launch) is None:
                raise ProviderDisconnected(
                    f"launch {launch.id} is asleep and its owner's provider connection is gone"
                )
            machines.start(machine, now)
            launch.active_at = now
        elif launch.desired_state == "running" and machine.desired_state == "running":
            launch.active_at = now
        return launch, machine


class ProviderDisconnected(Exception):
    """A launch on a sleeping machine was addressed, but its owner's provider connection is gone."""


def is_waking(launch: HostedLaunch, machine: HostedMachine | None) -> bool:
    return (
        machine is not None
        and machine.state != "error"
        and launch.desired_state == "running"
        and launch.state != "error"
        and (machine_starting(machine) or launch.state in {"queued", "provisioning"})
    )
