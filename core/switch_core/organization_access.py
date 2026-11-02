"""Ending someone's access to an organization's workspaces: what being demoted
from `org_admin`, or leaving the organization, takes away.

Shared by the organization routes (`gateway/organizations.py`), which refuse
first while the person owns agents there, and the directory mirror
(`organization_mirror.py`), which applies a change made in the directory
whatever it breaks and reports what it broke.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import Tenant, TenantMember
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.gateway.workspace_access import (
    finish_revocation,
    revoke_workspace_access,
)


@dataclass(frozen=True)
class AccessRevocation:
    """What taking someone's access away in a workspace needs."""

    agent_store: AgentStore
    api_key_store: ApiKeyStore
    broker: ServiceBroker
    protocol: AgentCore
    sign_in_flows: SignInFlows


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


async def end_access_through_organization(
    session_factory: async_sessionmaker[AsyncSession],
    revocation: AccessRevocation,
    *,
    user_id: str,
    reached: list[Tenant],
    actor_id: str | None,
    details: dict[str, Any],
    keep_agent_keys: bool,
) -> str | None:
    """Take away what `user_id` holds in `reached`, the workspaces they stand
    in only as their organization's `org_admin`: their keys, service
    connections and sign-ins under way, one workspace at a time, each
    recorded in that workspace's audit log with `details`;
    `keep_agent_keys` as `revoke_workspace_access` has it. Raises
    `ServiceError` when a connection is busy. Returns a warning naming what
    could not be revoked at a vendor, or None."""
    warnings = []
    for tenant in reached:
        async with tenant_session(session_factory, tenant.id) as session:
            revoked = await revoke_workspace_access(
                session,
                user_id,
                api_key_store=revocation.api_key_store,
                broker=revocation.broker,
                sign_in_flows=revocation.sign_in_flows,
                keep_agent_keys=keep_agent_keys,
            )
            await record_audit_event(
                session,
                tenant_id=tenant.id,
                actor_user_id=actor_id,
                action=AuditAction.ORGANIZATION_ADMIN_ACCESS_ENDED,
                target_type="user",
                target_id=user_id,
                details={
                    **details,
                    "api_keys_deleted": len(revoked.key_hashes),
                    "service_connections_deleted": len(revoked.removed_services),
                },
            )
            await session.commit()
            warning = await finish_revocation(
                session,
                user_id,
                revoked,
                protocol=revocation.protocol,
                broker=revocation.broker,
            )
        if warning:
            warnings.append(f"{tenant.name}: {warning}")
    return " ".join(warnings) or None


async def remove_from_workspace(
    session_factory: async_sessionmaker[AsyncSession],
    revocation: AccessRevocation,
    *,
    user_id: str,
    tenant: Tenant,
    actor_id: str | None,
    details: dict[str, Any],
    keep_agent_keys: bool,
) -> str | None:
    """Remove `user_id` from `tenant`, with their keys, service connections
    and sign-ins under way there, recorded in its audit log with `details`.
    Agents they own are left as they are, and with `keep_agent_keys` so are
    the keys they run on. Raises `ServiceError` when a
    connection is busy. Returns a warning naming what could not be revoked
    at a vendor, or None."""
    async with tenant_session(session_factory, tenant.id) as session:
        membership = await session.get(TenantMember, (tenant.id, user_id))
        if membership is None:
            return None
        revoked = await revoke_workspace_access(
            session,
            user_id,
            api_key_store=revocation.api_key_store,
            broker=revocation.broker,
            sign_in_flows=revocation.sign_in_flows,
            keep_agent_keys=keep_agent_keys,
        )
        await record_audit_event(
            session,
            tenant_id=tenant.id,
            actor_user_id=actor_id,
            action=AuditAction.MEMBER_REMOVED,
            target_type="user",
            target_id=user_id,
            details={
                **details,
                "role": membership.role,
                "api_keys_deleted": len(revoked.key_hashes),
                "service_connections_deleted": len(revoked.removed_services),
            },
        )
        await session.delete(membership)
        await session.commit()
        warning = await finish_revocation(
            session,
            user_id,
            revoked,
            protocol=revocation.protocol,
            broker=revocation.broker,
        )
    return f"{tenant.name}: {warning}" if warning else None
