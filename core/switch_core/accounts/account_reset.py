"""Wiping a test account, on a server that allows it.

For test and canary servers, where the same person signs up again and again.
It reuses the operator's organization purge (`organization_purge.py`):

- An organization nobody else is in is purged whole, as
  `switch-purge-organization` does, and the purge deletes the account with it
  unless the person belongs somewhere else too.
- In an organization with other people (Switch Cloud, where everyone shares
  one), only the workspaces the person is alone in are purged; the
  organization stays.

Whatever the purge left of the account then goes through `AccountDeletion`,
which leaves the remaining workspaces, the server's default one included,
and drops the organization memberships, once the account's cloud machines
are torn down. Every refusal is checked before anything changes.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import select

from switch_core.accounts.deletion import (
    FORMER_MEMBER,
    AccountDeletionRefused,
    Workspace,
)
from switch_core.accounts.organization_purge import (
    PurgeOutcome,
    PurgePlan,
    PurgeRefused,
)
from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.models import (
    TENANT_ZERO_ID,
    MessagingInstall,
    OrganizationMember,
    Tenant,
    TenantMember,
)
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.messaging_install_store import INSTALL_ACTIVE

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.accounts.deletion import AccountDeletion
    from switch_core.accounts.organization_purge import OrganizationPurge
    from switch_core.db.models import User


@dataclass
class AccountReset:
    session_factory: async_sessionmaker[AsyncSession]
    purge: OrganizationPurge
    deletion: AccountDeletion

    async def reset(
        self, session: AsyncSession, user: User, workspaces: list[Workspace]
    ) -> None:
        """Wipe the account. `session` is the caller's, as `AccountDeletion`
        takes it. Raises `AccountDeletionRefused`, before anything changes,
        for what can't be wiped now."""
        by_organization: dict[str, list[Workspace]] = defaultdict(list)
        for workspace in workspaces:
            if workspace.role == FORMER_MEMBER or workspace.id == TENANT_ZERO_ID:
                continue
            async with tenant_session(self.session_factory, workspace.id) as scoped:
                tenant = await scoped.get(Tenant, workspace.id)
            assert tenant is not None and tenant.organization_id is not None
            by_organization[tenant.organization_id].append(workspace)
        # One whose workspaces an interrupted reset already purged.
        for organization_id in await self.purge.organizations_of(user.id):
            by_organization.setdefault(organization_id, [])

        plans: list[PurgePlan] = []
        # Each workspace to purge alone, with who may use it as things stand.
        alone: dict[str, set[str]] = {}
        for organization_id, own in by_organization.items():
            plan = await self._sole_plan(user, organization_id)
            if plan is not None:
                if plan.refusals:
                    raise AccountDeletionRefused(" ".join(plan.refusals))
                plans.append(plan)
                continue
            for workspace in own:
                async with tenant_session(self.session_factory, workspace.id) as scoped:
                    reason = await self.deletion.organization_refusal(
                        scoped, user, workspace.id
                    )
                    if reason is not None:
                        raise AccountDeletionRefused(reason)
                    if not await scoped.scalar(
                        select(TenantMember.user_id).where(
                            TenantMember.tenant_id == workspace.id,
                            TenantMember.user_id != user.id,
                        )
                    ):
                        alone[workspace.id] = {user.id} | set(
                            await scoped.scalars(
                                select(OrganizationMember.user_id).where(
                                    OrganizationMember.organization_id
                                    == organization_id,
                                    OrganizationMember.role == ORGANIZATION_ADMIN_ROLE,
                                )
                            )
                        )

        purged = set(alone) | {w.id for p in plans for w in p.workspaces}
        remaining = [w for w in workspaces if w.id not in purged]
        deleted_by_purge = any(
            account.id == user.id and account.kept_because is None
            for plan in plans
            for account in plan.accounts
        )
        if not deleted_by_purge:
            reason = await self.deletion.refusal_besides_machines(user, remaining)
            if reason is not None:
                raise AccountDeletionRefused(reason)
        await self._check_installs(sorted(purged))
        if not deleted_by_purge:
            try:
                teardown = await self.purge.tear_down_machines_of(
                    user.id, {w.id for w in workspaces}
                )
            except PurgeRefused as refused:
                raise AccountDeletionRefused(str(refused)) from None
            _finished(teardown, user.id)

        request = f"Test-account reset by user {user.id}"
        # shortcut: a sole organization purged before workspaces in a shared one
        # leaves a half-reset account if the second step waits; a retry finishes.
        for plan in plans:
            try:
                outcome = await self.purge.run(plan, request)
            except PurgeRefused as refused:
                raise AccountDeletionRefused(str(refused)) from None
            _finished(outcome, user.id)
        if alone:
            try:
                outcome = await self.purge.purge_workspaces(alone, request)
            except PurgeRefused as refused:
                raise AccountDeletionRefused(str(refused)) from None
            _finished(outcome, user.id)
        if not deleted_by_purge:
            await self.deletion.delete(session, user, remaining, actor_id=user.id)

    async def _sole_plan(self, user: User, organization_id: str) -> PurgePlan | None:
        """The purge plan for an organization nobody but `user` is in, or
        None when anyone else is."""
        async with organization_session(
            self.session_factory, organization_id
        ) as scoped:
            # Checked first, so a large shared organization is never planned.
            if await scoped.scalar(
                select(OrganizationMember.user_id).where(
                    OrganizationMember.organization_id == organization_id,
                    OrganizationMember.user_id != user.id,
                )
            ):
                return None
        plan = await self.purge.plan(organization_id)
        if any(account.id != user.id for account in plan.accounts):
            return None
        return plan

    async def _check_installs(self, tenant_ids: list[str]) -> None:
        """Refuse an install the purge could not end on this server."""
        platforms = self.purge.installers.platforms()
        for tenant_id in tenant_ids:
            async with tenant_session(self.session_factory, tenant_id) as scoped:
                platform = await scoped.scalar(
                    select(MessagingInstall.platform).where(
                        MessagingInstall.tenant_id == tenant_id,
                        MessagingInstall.status == INSTALL_ACTIVE,
                        MessagingInstall.platform.not_in(platforms),
                    )
                )
                if platform is not None:
                    tenant = await scoped.get(Tenant, tenant_id)
                    assert tenant is not None
                    raise AccountDeletionRefused(
                        f"{tenant.name} is connected to {platform.title()}, which "
                        "this server can't disconnect. Disconnect it first."
                    )


def _finished(outcome: PurgeOutcome, user_id: str) -> None:
    if not outcome.finished:
        raise AccountDeletionRefused(" ".join(outcome.waiting))
    for account, error in outcome.failed_accounts:
        if account.id == user_id:
            raise RuntimeError(f"Resetting user {user_id} failed: {error}")
