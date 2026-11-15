"""Ending someone's access to an organization's workspaces: what being demoted
from `org_admin`, or leaving a workspace or the organization, takes away.

Shared by the workspace and organization routes (`gateway/tenants.py`,
`gateway/organizations.py`), which refuse first while the person owns agents
there, and the directory mirror (`organization_mirror.py`), which applies a
change made in the directory whatever it breaks and reports what it broke.

Each step works on one workspace's session and leaves the commit to the
caller, so whatever else belongs with it (a refusal, a conflict recorded for
the organization) commits or rolls back with it. After the commit, the caller
calls `finish_revocation` with what the step returned.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.accounts.transfer import hand_over_everything
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import RoomAdmin, Tenant, TenantMember
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.gateway.workspace_access import (
    RevokedAccess,
    finish_revocation,
    revoke_workspace_access,
)


@dataclass(frozen=True)
class MembershipRemoval:
    """What `remove_membership` did: the access it revoked, for
    `AccessRevocation.finish`, and who received what the member owned (`heir`,
    None when nobody did) with how many of each kind passed (`handed`)."""

    revoked: RevokedAccess
    heir: str | None
    handed: dict[str, int]


@dataclass(frozen=True)
class AccessRevocation:
    """What taking someone's access away in a workspace needs."""

    agent_store: AgentStore
    api_key_store: ApiKeyStore
    broker: ServiceBroker
    protocol: AgentCore
    sign_in_flows: SignInFlows

    async def finish(
        self, session: AsyncSession, user_id: str, revoked: RevokedAccess
    ) -> str | None:
        """`finish_revocation`, once the step's transaction has committed."""
        return await finish_revocation(
            session, user_id, revoked, protocol=self.protocol, broker=self.broker
        )


async def workspaces_where_they_own_agents(
    session_factory: async_sessionmaker[AsyncSession],
    agent_store: AgentStore,
    user_id: str,
    workspaces: list[Tenant],
) -> list[Tenant]:
    """Those of `workspaces` in which `user_id` owns an agent, each read on
    its own short session."""
    found = []
    for tenant in workspaces:
        async with tenant_session(session_factory, tenant.id) as session:
            if await agent_store.get_by_owner(session, user_id):
                found.append(tenant)
    return found


async def end_organization_admin_access(
    session: AsyncSession,
    revocation: AccessRevocation,
    *,
    tenant_id: str,
    user_id: str,
    actor_id: str | None,
    details: dict[str, Any],
    keep_agent_keys: bool,
) -> RevokedAccess:
    """In workspace `tenant_id`, bound on `session`, where `user_id` stands
    only as their organization's `org_admin`: remove their keys, service
    connections and sign-ins under way, recorded in its audit log with
    `details`; `keep_agent_keys` as `revoke_workspace_access` has it.

    What they own there passes to an heir, as `remove_membership` does it,
    since they can no longer reach it either. Raises `ServiceError` when a
    connection is busy."""
    revoked = await revoke_workspace_access(
        session,
        user_id,
        api_key_store=revocation.api_key_store,
        broker=revocation.broker,
        sign_in_flows=revocation.sign_in_flows,
        keep_agent_keys=keep_agent_keys,
    )
    heir, handed = await _hand_over_to_heir(
        session,
        tenant_id=tenant_id,
        user_id=user_id,
        actor_id=actor_id,
        reason="organization_admin_access_ended",
    )
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=actor_id,
        action=AuditAction.ORGANIZATION_ADMIN_ACCESS_ENDED,
        target_type="user",
        target_id=user_id,
        details={
            **details,
            "api_keys_deleted": len(revoked.key_hashes),
            "service_connections_deleted": len(revoked.removed_services),
            "handed_over_to": heir,
            "handed_over": handed,
        },
    )
    return revoked


async def remove_membership(
    session: AsyncSession,
    revocation: AccessRevocation,
    membership: TenantMember,
    *,
    actor_id: str | None,
    details: dict[str, Any],
    keep_agent_keys: bool,
) -> MembershipRemoval:
    """Remove `membership` from its workspace, bound on `session`, with the
    member's keys, service connections and sign-ins under way there, recorded
    in its audit log with `details`; `keep_agent_keys` as
    `revoke_workspace_access` has it.

    What they own there passes to an heir (`removal_heir`), so the workspace
    is not left with rooms, packages and the like owned by someone who can no
    longer reach them. Agents they own are left as they are: the callers
    refuse, or record a conflict, while there are any. Raises `ServiceError`
    when a connection is busy, before anything is removed."""
    revoked = await revoke_workspace_access(
        session,
        membership.user_id,
        api_key_store=revocation.api_key_store,
        broker=revocation.broker,
        sign_in_flows=revocation.sign_in_flows,
        keep_agent_keys=keep_agent_keys,
    )
    heir, handed = await _hand_over_to_heir(
        session,
        tenant_id=membership.tenant_id,
        user_id=membership.user_id,
        actor_id=actor_id,
        reason="member_removed",
    )
    await record_audit_event(
        session,
        tenant_id=membership.tenant_id,
        actor_user_id=actor_id,
        action=AuditAction.MEMBER_REMOVED,
        target_type="user",
        target_id=membership.user_id,
        details={
            **details,
            "role": membership.role,
            "api_keys_deleted": len(revoked.key_hashes),
            "service_connections_deleted": len(revoked.removed_services),
            "handed_over_to": heir,
            "handed_over": handed,
        },
    )
    # Room admin goes with the workspace: someone still in a channel through
    # a claimed account must not keep changing its room.
    await session.execute(
        delete(RoomAdmin).where(
            RoomAdmin.tenant_id == membership.tenant_id,
            RoomAdmin.user_id == membership.user_id,
        )
    )
    await session.delete(membership)
    return MembershipRemoval(revoked=revoked, heir=heir, handed=handed)


async def _hand_over_to_heir(
    session: AsyncSession,
    *,
    tenant_id: str,
    user_id: str,
    actor_id: str | None,
    reason: str,
) -> tuple[str | None, dict[str, int]]:
    """Hand what `user_id` owns in `tenant_id` to their `removal_heir`, for
    `reason`. Returns the heir, or None when there is none and nothing moved,
    and how many of each kind passed."""
    heir = await removal_heir(session, tenant_id, user_id, actor_id, lock=True)
    if heir is None:
        return None, {}
    handed = await hand_over_everything(
        session,
        tenant_id=tenant_id,
        previous_owner_id=user_id,
        heir_id=heir,
        actor_id=actor_id,
        reason=reason,
    )
    return heir, handed


async def removal_heir(
    session: AsyncSession,
    tenant_id: str,
    user_id: str,
    actor_id: str | None,
    *,
    lock: bool,
) -> str | None:
    """Who takes over what `user_id` owns in `tenant_id` when they lose access
    to it: the person removing them, when they are a member of the workspace
    themselves; otherwise, as for a removal the organization's directory made
    or the server's operator made from outside, the longest-standing other
    admin, then the lowest id. None when the workspace has no other admin, and
    what they own stays theirs.

    With `lock`, as for the removal itself, the heir's membership is locked
    until the caller commits, so a removal of the heir running at the same
    time waits for this one and then finds what was handed to them, rather
    than leaving it with someone already gone. Without it, as for telling an
    admin beforehand who will receive what, nothing is locked."""
    if actor_id is not None and actor_id != user_id:
        actor = await session.get(
            TenantMember, (tenant_id, actor_id), with_for_update=lock
        )
        if actor is not None:
            return actor_id
    query = (
        select(TenantMember.user_id)
        .where(
            TenantMember.tenant_id == tenant_id,
            TenantMember.user_id != user_id,
            TenantMember.role == "admin",
        )
        .order_by(TenantMember.created_at, TenantMember.user_id)
        .limit(1)
    )
    heir: str | None = await session.scalar(query.with_for_update() if lock else query)
    return heir


async def end_access_through_organization(
    session_factory: async_sessionmaker[AsyncSession],
    revocation: AccessRevocation,
    *,
    user_id: str,
    reached: list[Tenant],
    actor_id: str,
    details: dict[str, Any],
) -> str | None:
    """`end_organization_admin_access` in each of `reached`, one workspace at
    a time, each committed on its own, for a route that has refused already
    while they own agents there. Returns a warning naming what could not be
    revoked at a vendor, or None."""
    warnings = []
    for tenant in reached:
        async with tenant_session(session_factory, tenant.id) as session:
            revoked = await end_organization_admin_access(
                session,
                revocation,
                tenant_id=tenant.id,
                user_id=user_id,
                actor_id=actor_id,
                details=details,
                keep_agent_keys=False,
            )
            await session.commit()
            warning = await revocation.finish(session, user_id, revoked)
        if warning:
            warnings.append(f"{tenant.name}: {warning}")
    return " ".join(warnings) or None
