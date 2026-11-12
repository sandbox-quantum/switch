"""Purging an organization at its owner's request: the operator's side of
"delete everything you hold about us".

Nothing here waits for the customer. Unlike deleting a workspace from the
dashboard (`workspace_deletion.py`), which refuses until its owner has
removed everything by hand, a purge takes the organization whole: every
workspace with everything in it, the organization's own rows, and every
account that belongs to nothing else. `switch-purge-organization`
(`purge_organization.py`) runs it.

**Waiting on what lives outside Switch.** Before anything is deleted:

- **Service sign-ins.** Every connection is removed and revoked at its
  vendor, and every token issued on one is revoked, as removing a member
  does. A token still live afterwards (its vendor failed, say) holds the
  purge back until it is revoked or expires, as it holds back deleting a
  workspace.
- **Cloud machines.** Each machine of an account the purge deletes is set to
  be deleted with its disk's retention ended (`retain_until` now), and the
  purge waits until the hosted controller reports it deleted, which it does
  only once the instance is terminated and the data volume is gone: deleting
  its rows first would leave both with nothing to tear them down. A machine
  whose owner keeps their account is not torn down; it only loses the
  organization's workspaces.

A purge that has to wait says what for and deletes nothing; running it again
carries on from where things are.

**Deleting.** Once nothing is left to wait on, the run is recorded as started
in the server's audit log, naming the accounts it is to delete. Then, for
each workspace in turn, its live messaging installs are ended as
disconnecting them does (`install_service.let_go_at_platform`), its rows are
deleted in one transaction (`purge_workspace`), and the processes running its
agents, clients, bridges and machines are told. Then the organization's rows
go, then the accounts, each recorded as deleted or as failed.

**Resuming.** A run that stops part-way is finished by running it again.
Every account a started run named is considered again, so one found only
through a workspace already deleted is not lost; and once the organization
itself is gone, it is still found by its id, slug or WorkOS id from those
records, for the accounts still to delete.

**Accounts.** One is deleted when everything it belonged to was this
organization: no membership of another workspace or organization, and no
row left in another workspace from one it was in. Anyone else keeps their
account and loses only what was here. The server's administrator account is
always kept.

**Outside, afterwards.** The plan names, and the start record keeps for a
resumed run, the WorkOS users of the people involved and every room id of
every workspace. `purge_elsewhere.py` takes the organization out of WorkOS
and has Switch Trust delete those rooms' sessions, once this is done.

**What stays.** The workspaces' audit history, for two years
(`retention/audit_history.py`), and the server's own audit log, which records
the purge. The organization's audit log stays too, as a workspace's does;
nothing purges it later.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Protocol

from sqlalchemy import delete, distinct, func, or_, select

from switch_core.accounts.deletion import (
    delete_account_rows,
    is_server_administrator,
    workspaces_naming,
)
from switch_core.accounts.workspace_deletion import (
    WORKSPACE_TABLES,
    live_service_tokens,
    purge_workspace,
)
from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.bridges.agent.protocol.connection_rows import (
    CHANGED_SIGNAL as AGENT_CONNECTIONS_CHANGED_SIGNAL,
)
from switch_core.bridges.collaboration.bridge_signals import BRIDGE_CHANGED_SIGNAL
from switch_core.bridges.collaboration.install_service import let_go_at_platform
from switch_core.clients.client_signals import CLIENT_CHANGED_SIGNAL
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.base import Base
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentController,
    CloudMachine,
    CollaborationBridge,
    MachineWorkspace,
    MessagingInstall,
    OidcIdentity,
    Organization,
    OrganizationMember,
    Room,
    ServerAuditEvent,
    ServiceConnection,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.rls_ddl import (
    ORGANIZATION_HISTORY_TABLES,
    organization_scoped_tables,
)
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.hosted_machine_store import CloudMachineStore, bump_revision
from switch_core.db.stores.messaging_install_store import (
    INSTALL_ACTIVE,
    INSTALL_DISCONNECTED,
    MessagingInstallStore,
)
from switch_core.db.tenant_lookup import (
    all_organization_ids,
    tenants_of_cloud_machine,
    tenants_of_organization,
    tenants_of_user,
)
from switch_core.tenant_context import tenant_scope

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.bridges.collaboration.install import MessagingInstallerRegistry
    from switch_core.connections.broker import SignIn
    from switch_core.keys import Keyring
    from switch_core.signals import SignalBus

logger = logging.getLogger(__name__)


class PurgeRefused(Exception):
    """The organization can't be purged as it stands; the message says why,
    for the operator."""


class ServiceRevoker(Protocol):
    """What the purge needs of the service broker (`connections/broker.py`)."""

    async def remove_connections(
        self, session: AsyncSession, user_id: str
    ) -> list[tuple[str, SignIn]]: ...

    async def finish_disconnect(
        self, session: AsyncSession, user_id: str, removed: list[tuple[str, SignIn]]
    ) -> str | None: ...

    async def revoke_pending(
        self, session: AsyncSession, conditions: tuple[Any, ...]
    ) -> bool: ...


@dataclass(frozen=True)
class WorkspaceContents:
    id: str
    slug: str
    name: str
    # Rows per table, for the tables that hold any.
    rows: dict[str, int]


@dataclass(frozen=True)
class Account:
    id: str
    email: str
    # (issuer, subject) of each sign-in identity: at WorkOS, the user id.
    identities: tuple[tuple[str, str], ...]
    # Why the account stays, or None when the purge deletes it.
    kept_because: str | None


@dataclass(frozen=True)
class PurgePlan:
    organization_id: str
    slug: str
    name: str
    workos_organization_id: str | None
    customer_id: str | None
    # True when an earlier run already deleted the organization's rows, and
    # only accounts are left.
    resuming: bool
    workspaces: list[WorkspaceContents]
    accounts: list[Account]
    # Live cloud machines of accounts the purge deletes, to tear down.
    machines: list[str]
    # Live cloud machines of accounts that stay, serving the organization:
    # they lose its workspaces and keep running.
    detached_machines: list[str]
    # Cloud machines of accounts the purge deletes that the hosted controller
    # has already deleted, instance and disk.
    removed_machines: list[str]
    # The WorkOS user id of each person in the plan who signs in through the
    # server's sign-in, with their account id: what to take out of WorkOS
    # (`purge_elsewhere.py`). Earlier runs' records add those whose accounts
    # are gone.
    workos_users: dict[str, str]
    # Every room id of every workspace, the session ids Switch Trust holds
    # checked messages under. Earlier runs' records add those of workspaces
    # already deleted.
    trust_sessions: list[str]
    # Why the purge can't go ahead; empty when it can.
    refusals: list[str]

    @property
    def deleted_accounts(self) -> list[Account]:
        return [account for account in self.accounts if account.kept_because is None]


@dataclass
class PurgeOutcome:
    # False while the purge waits on something outside Switch; run it again.
    finished: bool
    waiting: list[str] = field(default_factory=list)
    # What was withdrawn only in part, to follow up by hand.
    warnings: list[str] = field(default_factory=list)
    # Service sign-ins removed and revoked at their vendors.
    revoked_sign_ins: int = 0
    # Messaging installs ended at their platforms, as "platform id".
    ended_installs: list[str] = field(default_factory=list)
    deleted_accounts: list[Account] = field(default_factory=list)
    failed_accounts: list[tuple[Account, str]] = field(default_factory=list)


@dataclass
class OrganizationPurge:
    session_factory: async_sessionmaker[AsyncSession]
    broker: ServiceRevoker
    installers: MessagingInstallerRegistry
    keyring: Keyring
    signals: SignalBus
    # Tells every process a machine's controller is gone, as revoking it
    # does. Agent management's, handed over by the wiring: core does not
    # import it.
    controller_removed: Callable[[str], None]
    admin_email: str
    # The issuer of the server's own sign-in (`GATEWAY_OIDC_ISSUER_URL`),
    # whose subjects are WorkOS user ids where that sign-in is WorkOS. None
    # for a server without one.
    sign_in_issuer: str | None

    async def find(self, reference: str) -> str:
        """The id of the organization `reference` names, by id, slug or
        WorkOS organization id; for one an earlier run already deleted, from
        that run's record."""
        for organization_id in await all_organization_ids(self.session_factory):
            async with organization_session(
                self.session_factory, organization_id
            ) as session:
                organization = await session.get(Organization, organization_id)
            if organization is not None and reference in (
                organization.id,
                organization.slug,
                organization.workos_organization_id,
            ):
                return organization.id
        async with self.session_factory() as session:
            started = await session.scalar(
                select(ServerAuditEvent.target_id)
                .where(
                    ServerAuditEvent.action
                    == ServerAuditAction.ORGANIZATION_PURGE_STARTED,
                    or_(
                        ServerAuditEvent.target_id == reference,
                        ServerAuditEvent.details["slug"].astext == reference,
                        ServerAuditEvent.details["workos_organization_id"].astext
                        == reference,
                    ),
                )
                .order_by(ServerAuditEvent.occurred_at.desc())
                .limit(1)
            )
        if started is None:
            raise PurgeRefused(f"No organization here is {reference!r}.")
        return started

    async def plan(self, organization_id: str) -> PurgePlan:
        """What purging the organization would delete and keep, and why it
        can't go ahead, if it can't. Changes nothing."""
        records = await self._started_runs(organization_id)
        async with organization_session(
            self.session_factory, organization_id
        ) as session:
            organization = await session.get(Organization, organization_id)
            member_ids = set(
                await session.scalars(
                    select(OrganizationMember.user_id).where(
                        OrganizationMember.organization_id == organization_id
                    )
                )
            )
        if organization is None and not records:
            raise PurgeRefused(f"No organization {organization_id} here.")
        for record in records:
            member_ids.update(record["accounts_to_delete"])
        tenant_ids = await tenants_of_organization(
            self.session_factory, organization_id
        )
        refusals = []
        if TENANT_ZERO_ID in tenant_ids:
            refusals.append(
                "The organization holds the server's default workspace, which "
                "can't be deleted."
            )
        workspaces = []
        machine_ids: set[str] = set()
        trust_sessions: set[str] = set()
        for record in records:
            trust_sessions.update(record.get("trust_sessions", []))
        for tenant_id in tenant_ids:
            async with tenant_session(self.session_factory, tenant_id) as session:
                workspaces.append(await _contents(session, tenant_id))
                trust_sessions.update(
                    await session.scalars(
                        select(Room.id).where(Room.tenant_id == tenant_id)
                    )
                )
                member_ids.update(
                    await session.scalars(
                        select(TenantMember.user_id).where(
                            TenantMember.tenant_id == tenant_id
                        )
                    )
                )
                machine_ids.update(
                    await session.scalars(
                        select(distinct(MachineWorkspace.machine_id)).where(
                            MachineWorkspace.tenant_id == tenant_id
                        )
                    )
                )
        accounts = []
        for user_id in sorted(member_ids):
            account = await self._account(user_id, organization_id, set(tenant_ids))
            if account is not None:
                accounts.append(account)
        deleted = {account.id for account in accounts if account.kept_because is None}
        machines, detached, machine_refusals = await self._machines(
            machine_ids, deleted, set(tenant_ids)
        )
        workos_users: dict[str, str] = {}
        for record in records:
            workos_users.update(record.get("workos_users", {}))
        for account in accounts:
            for issuer, subject in account.identities:
                # "" is a row from before issuers were recorded: the
                # server's one sign-in too.
                if self.sign_in_issuer is not None and issuer in (
                    self.sign_in_issuer,
                    "",
                ):
                    workos_users[subject] = account.id
        if organization is not None:
            slug, name = organization.slug, organization.name
            workos_organization_id = organization.workos_organization_id
            customer_id = organization.customer_id
        else:
            last = records[-1]
            slug, name = last["slug"], last["name"]
            workos_organization_id = last["workos_organization_id"]
            customer_id = last["customer_id"]
        return PurgePlan(
            organization_id=organization_id,
            slug=slug,
            name=name,
            workos_organization_id=workos_organization_id,
            customer_id=customer_id,
            resuming=organization is None,
            workspaces=workspaces,
            accounts=accounts,
            machines=machines,
            detached_machines=detached,
            removed_machines=await self._removed_machines(deleted),
            workos_users=workos_users,
            trust_sessions=sorted(trust_sessions),
            refusals=refusals + machine_refusals,
        )

    async def run(self, plan: PurgePlan, request: str) -> PurgeOutcome:
        """Purge what `plan` found, as far as it can go now. `request` is
        the operator's reference to the owner's request (a ticket or
        similar), recorded in the server's audit log.

        Raises `PurgeRefused` for a plan with refusals, before anything
        changes. Returns unfinished, having deleted nothing, while it waits
        on something outside Switch."""
        if plan.refusals:
            raise PurgeRefused(" ".join(plan.refusals))
        if not request.strip():
            raise PurgeRefused("Say which request the purge answers.")
        members = {account.id for account in plan.accounts}
        for workspace in plan.workspaces:
            await self._check_newcomers(workspace, members)
        outcome = PurgeOutcome(finished=False)
        for workspace in plan.workspaces:
            with tenant_scope(workspace.id):
                await self._revoke_services(workspace, outcome)
        await self._tear_down_machines(plan.machines, outcome)
        if outcome.waiting:
            return outcome

        await self._record_start(plan, request)
        for workspace in plan.workspaces:
            await self._check_newcomers(workspace, members)
            with tenant_scope(workspace.id):
                await self._end_installs(workspace, outcome)
            await self._purge_workspace(workspace, members, request)
        await self._detach_machines(plan.detached_machines)
        if not plan.resuming:
            await self._delete_organization(plan, request)
        for account in plan.deleted_accounts:
            await self._delete_account(account, plan, request, outcome)
        outcome.finished = True
        return outcome

    async def purge_workspaces(
        self, members: dict[str, set[str]], request: str
    ) -> PurgeOutcome:
        """Purge these workspaces alone, as `run` purges each of an
        organization's, leaving the organization and every account.
        `members` maps each workspace to the accounts allowed to use it,
        directly or as an organization admin. Returns unfinished, having
        deleted nothing, while it waits. Raises `PurgeRefused`, before
        touching the workspace, when anyone else can use it."""
        workspaces = []
        for tenant_id in members:
            async with tenant_session(self.session_factory, tenant_id) as session:
                workspaces.append(await _contents(session, tenant_id))
        for workspace in workspaces:
            await self._check_newcomers(workspace, members[workspace.id])
        outcome = PurgeOutcome(finished=False)
        for workspace in workspaces:
            with tenant_scope(workspace.id):
                await self._revoke_services(workspace, outcome)
        if outcome.waiting:
            return outcome
        for workspace in workspaces:
            await self._check_newcomers(workspace, members[workspace.id])
            with tenant_scope(workspace.id):
                await self._end_installs(workspace, outcome)
            await self._purge_workspace(workspace, members[workspace.id], request)
        outcome.finished = True
        return outcome

    async def organizations_of(self, user_id: str) -> list[str]:
        """The organizations the account is a member of."""
        found = []
        for organization_id in await all_organization_ids(self.session_factory):
            async with organization_session(
                self.session_factory, organization_id
            ) as session:
                if await session.scalar(
                    select(OrganizationMember.user_id).where(
                        OrganizationMember.organization_id == organization_id,
                        OrganizationMember.user_id == user_id,
                    )
                ):
                    found.append(organization_id)
        return found

    async def tear_down_machines_of(
        self, user_id: str, tenant_ids: set[str]
    ) -> PurgeOutcome:
        """Set the account's live cloud machines to be deleted, as `run` does
        for an account it deletes. Raises `PurgeRefused` for one that also
        serves a workspace outside `tenant_ids`. Unfinished while any is
        still being torn down."""
        machines, _, refusals = await self._machines(set(), {user_id}, tenant_ids)
        if refusals:
            raise PurgeRefused(" ".join(refusals))
        outcome = PurgeOutcome(finished=False)
        await self._tear_down_machines(machines, outcome)
        outcome.finished = not outcome.waiting
        return outcome

    # ── Planning ─────────────────────────────────────────────────────────────

    async def _started_runs(self, organization_id: str) -> list[dict[str, Any]]:
        """What each earlier run that started deleting recorded, oldest first."""
        async with self.session_factory() as session:
            return [
                details
                for details in await session.scalars(
                    select(ServerAuditEvent.details)
                    .where(
                        ServerAuditEvent.action
                        == ServerAuditAction.ORGANIZATION_PURGE_STARTED,
                        ServerAuditEvent.target_id == organization_id,
                    )
                    .order_by(ServerAuditEvent.occurred_at)
                )
                if details is not None
            ]

    async def _account(
        self, user_id: str, organization_id: str, tenant_ids: set[str]
    ) -> Account | None:
        """The account, or None when an earlier run already deleted it."""
        async with self.session_factory() as session:
            user = await session.get(User, user_id)
            if user is None:
                return None
            identities = tuple(
                (identity.iss or "", identity.sub)
                for identity in await session.scalars(
                    select(OidcIdentity)
                    .where(OidcIdentity.user_id == user_id)
                    .order_by(OidcIdentity.iss, OidcIdentity.sub)
                )
            )
        return Account(
            id=user.id,
            email=user.email,
            identities=identities,
            kept_because=await self._kept_because(user, organization_id, tenant_ids),
        )

    async def _kept_because(
        self, user: User, organization_id: str, tenant_ids: set[str]
    ) -> str | None:
        if is_server_administrator(user, self.admin_email):
            return "the server's administrator account"
        elsewhere = set(await tenants_of_user(self.session_factory, user.id))
        if elsewhere - tenant_ids:
            return "a member of another workspace"
        if set(await self.organizations_of(user.id)) - {organization_id}:
            return "a member of another organization"
        if await workspaces_naming(self.session_factory, user.id, tenant_ids):
            return "still named by records in a workspace they left"
        return None

    async def _machines(
        self, serving: set[str], deleted_accounts: set[str], tenant_ids: set[str]
    ) -> tuple[list[str], list[str], list[str]]:
        """The live machines to tear down, those to take off the
        organization's workspaces, and refusals for any to tear down that
        still serve a workspace outside it."""
        async with self.session_factory() as session:
            rows = await session.execute(
                select(CloudMachine.id, CloudMachine.owner_id).where(
                    CloudMachine.state != "deleted",
                    (CloudMachine.id.in_(serving))
                    | (CloudMachine.owner_id.in_(deleted_accounts)),
                )
            )
            live = {machine_id: owner_id for machine_id, owner_id in rows}
        torn_down = sorted(m for m, owner in live.items() if owner in deleted_accounts)
        detached = sorted(
            m for m, owner in live.items() if owner not in deleted_accounts
        )
        refusals = []
        for machine_id in torn_down:
            outside = (
                set(await tenants_of_cloud_machine(self.session_factory, machine_id))
                - tenant_ids
            )
            if outside:
                refusals.append(
                    f"Cloud machine {machine_id} also serves "
                    f"{len(outside)} workspace(s) outside the organization "
                    f"({', '.join(sorted(outside))}). Take it off them first."
                )
        return torn_down, detached, refusals

    async def _removed_machines(self, deleted_accounts: set[str]) -> list[str]:
        """The machines of accounts the purge deletes that the hosted
        controller reported deleted. It reports that only once the data
        volume is gone too."""
        async with self.session_factory() as session:
            return sorted(
                await session.scalars(
                    select(CloudMachine.id).where(
                        CloudMachine.state == "deleted",
                        CloudMachine.owner_id.in_(deleted_accounts),
                    )
                )
            )

    # ── Withdrawing what lives outside Switch ────────────────────────────────

    async def _revoke_services(
        self, workspace: WorkspaceContents, outcome: PurgeOutcome
    ) -> None:
        async with tenant_session(self.session_factory, workspace.id) as session:
            holders = list(
                await session.scalars(
                    select(distinct(ServiceConnection.user_id)).where(
                        ServiceConnection.tenant_id == workspace.id
                    )
                )
            )
        for user_id in holders:
            async with tenant_session(self.session_factory, workspace.id) as session:
                removed = await self.broker.remove_connections(session, user_id)
                await session.commit()
                outcome.revoked_sign_ins += len(removed)
                warning = await self.broker.finish_disconnect(session, user_id, removed)
            if warning:
                outcome.warnings.append(f"{workspace.slug}: {warning}")
        async with tenant_session(self.session_factory, workspace.id) as session:
            await self.broker.revoke_pending(session, ())
        async with tenant_session(self.session_factory, workspace.id) as session:
            live = await live_service_tokens(session, workspace.id)
        if live:
            outcome.waiting.append(
                f"{workspace.slug}: {live} service token(s) not yet revoked at "
                "their vendor. They are retried, and expire within the hour."
            )

    async def _tear_down_machines(
        self, machine_ids: list[str], outcome: PurgeOutcome
    ) -> None:
        store = CloudMachineStore()
        for machine_id in machine_ids:
            async with self.session_factory() as session:
                machine = await store.locked(session, machine_id)
                if machine is None or machine.state == "deleted":
                    continue
                now = datetime.now(UTC)
                # The hosted controller deletes the data volume only once
                # `retain_until` has passed, and once a machine is to be
                # deleted it never brings that date forward: the date has to
                # be now in the same revision that deletes it.
                if machine.desired_state != "deleted" or (
                    machine.retain_until is not None and machine.retain_until > now
                ):
                    machine.desired_state = "deleted"
                    machine.retain_until = now
                    bump_revision(machine, now)
                    logger.info(
                        "Set cloud machine %s to be deleted, disk included", machine_id
                    )
                state = machine.state
                await session.commit()
            outcome.waiting.append(
                f"Cloud machine {machine_id} is being torn down, its instance "
                f"and disk deleted (now {state})."
            )

    async def _end_installs(
        self, workspace: WorkspaceContents, outcome: PurgeOutcome
    ) -> None:
        """End the workspace's live installs, just before its rows go, so a
        bridge never runs for long on a token revoked under it."""
        store = MessagingInstallStore()
        async with tenant_session(self.session_factory, workspace.id) as session:
            installs = list(
                await session.scalars(
                    select(MessagingInstall).where(
                        MessagingInstall.tenant_id == workspace.id,
                        MessagingInstall.status == INSTALL_ACTIVE,
                    )
                )
            )
        for install in installs:
            token = install.encrypted_bot_token
            # Not connected as far as this process can tell, so a tokenless
            # install is released here. That is the only release: a server
            # running its bridge stops it once the row is gone without
            # withdrawing it (`lifecycle_service.reconcile_bridge`); only
            # `remove`, which the purge never calls, withdraws.
            await let_go_at_platform(
                self.installers.get(install.platform),
                bot_token=None if token is None else self.keyring.decrypt(token),
                external_workspace_id=install.external_workspace_id,
                bridge_connected=False,
            )
            async with tenant_session(self.session_factory, workspace.id) as session:
                await store.end(
                    session, install_id=install.id, status=INSTALL_DISCONNECTED
                )
                await session.commit()
            outcome.ended_installs.append(
                f"{install.platform} {install.external_workspace_id}"
            )
            logger.info(
                "Ended the %s install of %s in workspace %s",
                install.platform,
                install.external_workspace_id,
                workspace.id,
            )

    # ── Deleting ─────────────────────────────────────────────────────────────

    async def _record_start(self, plan: PurgePlan, request: str) -> None:
        """Record, before the first row goes, what the run is to delete, so
        a run that stops part-way can be finished: the accounts it found
        through workspaces about to go, and the organization's names for
        `find` once its row is gone."""
        async with self.session_factory() as session:
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.ORGANIZATION_PURGE_STARTED,
                target_type="organization",
                target_id=plan.organization_id,
                details={
                    "slug": plan.slug,
                    "name": plan.name,
                    "workos_organization_id": plan.workos_organization_id,
                    "customer_id": plan.customer_id,
                    "workspaces": [workspace.id for workspace in plan.workspaces],
                    "accounts_to_delete": [
                        account.id for account in plan.deleted_accounts
                    ],
                    "workos_users": plan.workos_users,
                    "trust_sessions": plan.trust_sessions,
                    "request": request,
                },
            )
            await session.commit()

    async def _purge_workspace(
        self, workspace: WorkspaceContents, members: set[str], request: str
    ) -> None:
        async with tenant_session(self.session_factory, workspace.id) as session:
            await _refuse_newcomers(session, workspace, members)
            agent_ids = list(
                await session.scalars(
                    select(Agent.id).where(Agent.tenant_id == workspace.id)
                )
            )
            bridge_ids = list(
                await session.scalars(
                    select(CollaborationBridge.id).where(
                        CollaborationBridge.tenant_id == workspace.id
                    )
                )
            )
            controller_ids = list(
                await session.scalars(
                    select(AgentController.id).where(
                        AgentController.tenant_id == workspace.id,
                        AgentController.revoked_at.is_(None),
                    )
                )
            )
            await purge_workspace(session, workspace.id, request)
            await session.commit()
        # As deleting an agent does: every process closes the agent's
        # connections and drops its cached keys at once, rather than letting
        # a deleted key authenticate until the cache entry expires.
        for agent_id in agent_ids:
            self.signals.publish(
                AGENT_CONNECTIONS_CHANGED_SIGNAL,
                tenant_id=workspace.id,
                agent_id=agent_id,
                released=[],
                ending="deleted",
            )
        self.signals.publish(CLIENT_CHANGED_SIGNAL, tenant_id=workspace.id)
        for bridge_id in bridge_ids:
            self.signals.publish(BRIDGE_CHANGED_SIGNAL, bridge_id=bridge_id)
        for controller_id in controller_ids:
            self.controller_removed(controller_id)
        logger.info("Purged workspace %s (%s)", workspace.id, workspace.slug)

    async def _check_newcomers(
        self, workspace: WorkspaceContents, members: set[str]
    ) -> None:
        """`_refuse_newcomers` in a transaction of its own, so no lock is
        held across what follows outside Switch."""
        async with tenant_session(self.session_factory, workspace.id) as session:
            await _refuse_newcomers(session, workspace, members)

    async def _detach_machines(self, machine_ids: list[str]) -> None:
        """A kept account's machine has lost the organization's workspaces
        with their rows; a new revision has it prepared again without them."""
        store = CloudMachineStore()
        for machine_id in machine_ids:
            async with self.session_factory() as session:
                machine = await store.locked(session, machine_id)
                if machine is None or machine.state == "deleted":
                    continue
                bump_revision(machine, datetime.now(UTC))
                await session.commit()
            logger.info(
                "Took cloud machine %s off the organization's workspaces", machine_id
            )

    async def _delete_organization(self, plan: PurgePlan, request: str) -> None:
        scoped = organization_scoped_tables(Base.metadata)
        async with organization_session(
            self.session_factory, plan.organization_id
        ) as session:
            # Holds off a new workspace or member until this commits.
            await session.execute(
                select(Organization.id)
                .where(Organization.id == plan.organization_id)
                .with_for_update()
            )
            left = await tenants_of_organization(
                self.session_factory, plan.organization_id
            )
            if left:
                raise PurgeRefused(
                    f"{len(left)} workspace(s) joined the organization during the "
                    "purge. Run it again."
                )
            joined = set(
                await session.scalars(
                    select(OrganizationMember.user_id).where(
                        OrganizationMember.organization_id == plan.organization_id
                    )
                )
            ) - {account.id for account in plan.accounts}
            if joined:
                raise PurgeRefused(
                    f"{len(joined)} person(s) joined the organization during the "
                    "purge. Run it again."
                )
            # Children first, so no foreign key between two of them holds a
            # delete back.
            for table in reversed(Base.metadata.sorted_tables):
                if (
                    table.name in scoped
                    and table.name not in ORGANIZATION_HISTORY_TABLES
                ):
                    await session.execute(
                        delete(table).where(
                            table.c[scoped[table.name]] == plan.organization_id
                        )
                    )
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.ORGANIZATION_PURGED,
                target_type="organization",
                target_id=plan.organization_id,
                details={
                    "slug": plan.slug,
                    "workos_organization_id": plan.workos_organization_id,
                    "customer_id": plan.customer_id,
                    "workspaces": [workspace.id for workspace in plan.workspaces],
                    "request": request,
                },
            )
            await session.commit()
        logger.info("Purged organization %s (%s)", plan.organization_id, plan.slug)

    async def _delete_account(
        self, account: Account, plan: PurgePlan, request: str, outcome: PurgeOutcome
    ) -> None:
        """Delete one account, recording that it was deleted or that it
        failed. A failure does not stop the others; running the purge again
        tries it again."""
        details = {"organization_purged": plan.organization_id, "request": request}
        try:
            async with self.session_factory() as session:
                user = await session.get(User, account.id)
                if user is None:
                    return
                await delete_account_rows(
                    self.session_factory, session, user, self.admin_email
                )
                await record_server_audit_event(
                    session,
                    actor_user_id=None,
                    action=ServerAuditAction.USER_DELETED,
                    target_type="user",
                    target_id=account.id,
                    details=details,
                )
                await session.commit()
        except Exception as error:
            logger.exception("Could not delete account %s", account.id)
            outcome.failed_accounts.append(
                (account, f"{type(error).__name__}: {error}")
            )
            async with self.session_factory() as session:
                await record_server_audit_event(
                    session,
                    actor_user_id=None,
                    action=ServerAuditAction.USER_DELETION_FAILED,
                    target_type="user",
                    target_id=account.id,
                    details={**details, "error": type(error).__name__},
                )
                await session.commit()
            return
        outcome.deleted_accounts.append(account)


async def _refuse_newcomers(
    session: AsyncSession, workspace: WorkspaceContents, members: set[str]
) -> None:
    """Refuse when anyone outside `members` can use the workspace: a member
    of it, or an admin of its organization. The locks hold off anyone
    joining or being made an organization admin until `session` ends."""
    tenant = await session.scalar(
        select(Tenant).where(Tenant.id == workspace.id).with_for_update()
    )
    assert tenant is not None and tenant.organization_id is not None
    await session.execute(
        select(Organization.id)
        .where(Organization.id == tenant.organization_id)
        .with_for_update()
    )
    # Every row, so a member's promotion to admin waits too.
    organization_members = await session.execute(
        select(OrganizationMember.user_id, OrganizationMember.role)
        .where(OrganizationMember.organization_id == tenant.organization_id)
        .with_for_update(read=True)
    )
    admins = {
        user_id
        for user_id, role in organization_members
        if role == ORGANIZATION_ADMIN_ROLE
    }
    users = admins | set(
        await session.scalars(
            select(TenantMember.user_id).where(TenantMember.tenant_id == workspace.id)
        )
    )
    if users - members:
        raise PurgeRefused(
            f"Someone joined {workspace.name} during the purge. Run it again."
        )


async def _contents(session: AsyncSession, tenant_id: str) -> WorkspaceContents:
    tenant = await session.get(Tenant, tenant_id)
    assert tenant is not None, f"workspace {tenant_id} vanished"
    rows = {}
    for name, handling in WORKSPACE_TABLES.items():
        if handling == "kept" or name == "tenants":
            continue
        table = Base.metadata.tables[name]
        count = await session.scalar(
            select(func.count())
            .select_from(table)
            .where(table.c.tenant_id == tenant_id)
        )
        if count:
            rows[name] = count
    return WorkspaceContents(
        id=tenant.id, slug=tenant.slug, name=tenant.name, rows=rows
    )
