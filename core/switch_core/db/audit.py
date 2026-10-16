"""The audit logs: append an event in the caller's transaction, read it back.

A tenant's changes go to `audit_events`; a change to the server as a whole,
which no tenant owns, goes to `server_audit_events`.

Functions rather than an injected store because there is nothing to hold: each
call takes the session of the change it records, so the event commits or rolls
back with that change.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import AuditEvent, ServerAuditEvent


class AuditAction(StrEnum):
    TENANT_CREATED = "tenant.created"
    INVITATION_CREATED = "invitation.created"
    INVITATION_REVOKED = "invitation.revoked"
    INVITATION_ACCEPTED = "invitation.accepted"
    MEMBER_JOINED_BY_DOMAIN = "member.joined_by_domain"
    MEMBER_ROLE_CHANGED = "member.role_changed"
    MEMBER_REMOVED = "member.removed"
    JOIN_DOMAIN_ADDED = "join_domain.added"
    JOIN_DOMAIN_REMOVED = "join_domain.removed"
    API_KEY_CREATED = "api_key.created"
    API_KEY_REVEALED = "api_key.revealed"
    API_KEY_DELETED = "api_key.deleted"
    BRIDGE_CREATED = "collaboration_bridge.created"
    BRIDGE_UPDATED = "collaboration_bridge.updated"
    BRIDGE_DEFAULT_SET = "collaboration_bridge.default_set"
    BRIDGE_DELETED = "collaboration_bridge.deleted"
    BRIDGE_IDENTITY_CLAIMED = "collaboration_bridge.identity_claimed"
    BRIDGE_IDENTITY_RELEASED = "collaboration_bridge.identity_released"
    MESSAGING_INSTALL_STARTED = "messaging_install.started"
    MESSAGING_INSTALL_CONNECTED = "messaging_install.connected"
    MESSAGING_INSTALL_DISCONNECTED = "messaging_install.disconnected"
    SERVICE_CONNECTED = "service.connected"
    SERVICE_DISCONNECTED = "service.disconnected"
    SERVICE_GRANT_SET = "service_grant.set"
    SERVICE_GRANT_REMOVED = "service_grant.removed"
    WORKSPACE_SERVICE_ENABLED = "workspace_service.enabled"
    WORKSPACE_SERVICE_DISABLED = "workspace_service.disabled"


class ServerAuditAction(StrEnum):
    CONNECTOR_APP_SAVED = "connector_app.saved"
    CONNECTOR_APP_IMPORTED = "connector_app.imported"
    CONNECTOR_APP_REMOVED = "connector_app.removed"


async def record_audit_event(
    session: AsyncSession,
    *,
    tenant_id: str,
    actor_user_id: str | None,
    action: AuditAction,
    target_type: str,
    target_id: str | None,
    details: dict[str, Any] | None,
) -> AuditEvent:
    """Add an event to `session`; it lands when the caller commits."""
    event = AuditEvent(
        tenant_id=tenant_id,
        actor_user_id=actor_user_id,
        action=action.value,
        target_type=target_type,
        target_id=target_id,
        details=details,
    )
    session.add(event)
    await session.flush()
    return event


async def record_server_audit_event(
    session: AsyncSession,
    *,
    actor_user_id: str | None,
    action: ServerAuditAction,
    target_type: str,
    target_id: str | None,
    details: dict[str, Any] | None,
) -> ServerAuditEvent:
    """Add a server-wide event to `session`; it lands when the caller commits."""
    event = ServerAuditEvent(
        actor_user_id=actor_user_id,
        action=action.value,
        target_type=target_type,
        target_id=target_id,
        details=details,
    )
    session.add(event)
    await session.flush()
    return event


async def list_audit_events(
    session: AsyncSession,
    *,
    tenant_id: str,
    limit: int,
    before: datetime | None,
) -> list[AuditEvent]:
    """Newest first. Names its tenant as well as relying on the policy, for the
    reason `JoinDomainStore` gives."""
    query = select(AuditEvent).where(AuditEvent.tenant_id == tenant_id)
    if before is not None:
        query = query.where(AuditEvent.occurred_at < before)
    result = await session.execute(
        query.order_by(AuditEvent.occurred_at.desc(), AuditEvent.id.desc()).limit(limit)
    )
    return list(result.scalars().all())
