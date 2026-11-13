"""The audit logs: append an event in the caller's transaction, read it back.

A tenant's changes go to `audit_events`; a change to an organization as a
whole, its members and workspaces, goes to `organization_audit_events`; a
change to the server as a whole, which no tenant owns, goes to
`server_audit_events`.

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

from switch_core.db.models import (
    AuditEvent,
    OrganizationAuditEvent,
    ServerAuditEvent,
)


class AuditAction(StrEnum):
    TENANT_CREATED = "tenant.created"
    TENANT_DELETED = "tenant.deleted"
    INVITATION_CREATED = "invitation.created"
    INVITATION_REVOKED = "invitation.revoked"
    INVITATION_ACCEPTED = "invitation.accepted"
    MEMBER_JOINED_BY_DOMAIN = "member.joined_by_domain"
    MEMBER_ROLE_CHANGED = "member.role_changed"
    MEMBER_REMOVED = "member.removed"
    # Someone in the workspace only as their organization's `org_admin` stopped
    # being one, and their keys and connections here were removed.
    ORGANIZATION_ADMIN_ACCESS_ENDED = "organization_admin.access_ended"
    # The platform operator acting in a workspace on the operator flag alone:
    # entering it, and every write while there.
    PLATFORM_ACCESS = "platform.access"
    ACCOUNT_DELETED = "account.deleted"
    JOIN_DOMAIN_ADDED = "join_domain.added"
    JOIN_DOMAIN_REMOVED = "join_domain.removed"
    API_KEY_CREATED = "api_key.created"
    API_KEY_REVEALED = "api_key.revealed"
    API_KEY_DELETED = "api_key.deleted"
    BRIDGE_CREATED = "collaboration_bridge.created"
    BRIDGE_UPDATED = "collaboration_bridge.updated"
    BRIDGE_DEFAULT_SET = "collaboration_bridge.default_set"
    BRIDGE_DELETED = "collaboration_bridge.deleted"
    # A claim took effect. Once links needed confirming from the account
    # (CHOO-3881), that is when the account confirmed one, not when someone
    # asked for it (`BRIDGE_IDENTITY_LINK_REQUESTED`).
    BRIDGE_IDENTITY_CLAIMED = "collaboration_bridge.identity_claimed"
    BRIDGE_IDENTITY_LINK_REQUESTED = "collaboration_bridge.identity_link_requested"
    BRIDGE_IDENTITY_LINK_CANCELLED = "collaboration_bridge.identity_link_cancelled"
    BRIDGE_IDENTITY_CONFIRMATION_REQUIRED = (
        "collaboration_bridge.identity_confirmation_required"
    )
    BRIDGE_IDENTITY_RELEASED = "collaboration_bridge.identity_released"
    MESSAGING_INSTALL_STARTED = "messaging_install.started"
    MESSAGING_INSTALL_CONNECTED = "messaging_install.connected"
    MESSAGING_INSTALL_DISCONNECTED = "messaging_install.disconnected"
    SERVICE_CONNECTED = "service.connected"
    SERVICE_DISCONNECTED = "service.disconnected"
    # A workspace admin ended someone else's connection to a service.
    SERVICE_CONNECTION_REVOKED = "service.connection_revoked"
    SERVICE_GRANT_SET = "service_grant.set"
    SERVICE_GRANT_REMOVED = "service_grant.removed"
    AGENT_DELETION_REQUESTED = "agent.deletion_requested"
    AGENT_DELETED = "agent.deleted"
    WORKSPACE_SERVICE_ENABLED = "workspace_service.enabled"
    WORKSPACE_SERVICE_DISABLED = "workspace_service.disabled"
    # Switch posted "I was restarted…" in a room as a managed agent: for its
    # controller or for a box that never came back.
    AGENT_RESTART_NOTICE_POSTED = "agent.restart_notice_posted"
    AGENT_REST_NOTICE_POSTED = "agent.rest_notice_posted"
    # Switch posted "I couldn't reset my session…" for a controller whose box
    # had no session to take the reset.
    AGENT_RESET_REFUSED_POSTED = "agent.reset_refused_posted"
    # Visibility. A workspace admin turned hosted agents off or
    # on for one person (A2).
    HOSTED_PERSON_TURNED_OFF = "hosted.person_turned_off"
    HOSTED_PERSON_TURNED_ON = "hosted.person_turned_on"
    # The workspace's copy of an operator action on its people, shown to its
    # admins as "Switch operator". The operator's own entry is server-wide.
    HOSTED_OPERATOR_ACTION = "hosted.operator_action"
    # A workspace admin added, changed or removed a usage budget: who, which budget, and the limit and period before and after.
    BUDGET_CREATED = "budget.created"
    BUDGET_UPDATED = "budget.updated"
    BUDGET_DELETED = "budget.deleted"
    WORKSPACE_SERVICE_CLEARED = "workspace_service.cleared"
    OWNERSHIP_TRANSFERRED = "ownership.transferred"
    RETENTION_POLICY_SET = "retention_policy.set"
    RETENTION_POLICY_CLEARED = "retention_policy.cleared"
    PERSON_ERASURE_REQUESTED = "person_erasure.requested"
    PERSON_ERASURE_COMPLETED = "person_erasure.completed"


class OrganizationAuditAction(StrEnum):
    ORGANIZATION_CREATED = "organization.created"
    WORKSPACE_CREATED = "organization.workspace_created"
    ROLE_CHANGED = "organization.role_changed"
    MEMBER_REMOVED = "organization.member_removed"
    CONNECTOR_APP_SAVED = "organization.connector_app_saved"
    CONNECTOR_APP_REMOVED = "organization.connector_app_removed"
    SERVICE_SET = "organization.service_set"
    SERVICE_CLEARED = "organization.service_cleared"
    # Changes made in a directory kept outside Switch, brought in at sign-in,
    # from its events or by the daily check (`details.source`).
    MEMBER_ADDED_FROM_DIRECTORY = "organization.member_added_from_directory"
    MEMBER_PROMOTED_FROM_DIRECTORY = "organization.member_promoted_from_directory"
    MEMBER_DEMOTED_FROM_DIRECTORY = "organization.member_demoted_from_directory"
    MEMBER_REMOVED_FROM_DIRECTORY = "organization.member_removed_from_directory"
    # A change brought in from the directory broke a rule Switch keeps itself
    # (the last Org Admin, agents left with an owner who can't act); applied
    # anyway, and recorded for the organization's admins (`details.kind`).
    DIRECTORY_CONFLICT = "organization.directory_conflict"
    # An operator made the organization follow one in the directory.
    LINKED_TO_DIRECTORY = "organization.linked_to_directory"


class OrganizationIssueKind(StrEnum):
    """What can need an organization admin's attention
    (`organization_issues.py`). `directory_organization_deleted` is also the
    `details.kind` of the `DIRECTORY_CONFLICT` that reports it. Mirrored by
    hand as `OrganizationIssueKind` in the gateway's `data/api.ts`."""

    NO_ORG_ADMIN = "no_org_admin"
    WORKSPACE_WITHOUT_ADMIN = "workspace_without_admin"
    AGENTS_WITHOUT_ACTING_OWNER = "agents_without_acting_owner"
    DIRECTORY_ORGANIZATION_DELETED = "directory_organization_deleted"


class ServerAuditAction(StrEnum):
    CONNECTOR_APP_SAVED = "connector_app.saved"
    CONNECTOR_APP_IMPORTED = "connector_app.imported"
    CONNECTOR_APP_REMOVED = "connector_app.removed"
    USER_DELETED = "user.deleted"
    USER_DELETION_REFUSED = "user.deletion_refused"
    USER_DELETION_FAILED = "user.deletion_failed"
    # Every session the account held was ended, by the person ("Sign out of
    # all devices") or by the operator for them.
    USER_SESSIONS_ENDED = "user.sessions_ended"
    WORKSPACE_DELETED = "workspace.deleted"
    # A run of the operator's purge of an organization at its owner's request
    # (`accounts/organization_purge.py`) began deleting, naming the accounts
    # it is to delete: the record a run that stops part-way is resumed from.
    ORGANIZATION_PURGE_STARTED = "organization.purge_started"
    # The purge deleted the organization's own rows, after its workspaces.
    # Each account it deleted, or failed to, is recorded on its own.
    ORGANIZATION_PURGED = "organization.purged"
    # WorkOS refused where the directory mirror had got to in its events, and
    # the mirror started again from now, with a full check of every linked
    # organization.
    DIRECTORY_EVENTS_RESTARTED = "directory.events_restarted"
    # Visibility: the operator list, name reveals, operator
    # actions, and the server-wide copy of each workspace admin change, so the
    # operators' log is this one table.
    OPERATOR_GRANTED = "operator.granted"
    OPERATOR_REMOVED = "operator.removed"
    OPERATOR_NAME_REVEALED = "operator.name_revealed"
    HOSTED_USER_PAUSED = "hosted.user_paused"
    HOSTED_USER_RESUMED = "hosted.user_resumed"
    HOSTED_BOX_RESTARTED = "hosted.box_restarted"
    HOSTED_MACHINE_DRAINED = "hosted.machine_drained"
    HOSTED_ADMIN_CHANGE = "hosted.admin_change"
    # Core asks the provisioner for a new user's box; claims and the
    # result are linked entries.
    HOSTED_BOX_PROVISION = "hosted.box_provision"
    # A user's cleaned-up machine row brought back, same id, for a new box.
    HOSTED_BOX_REVIVED = "hosted.box_revived"
    # Operator alerts: one row per raise and per clear, with no actor.
    # `alert.` is one of the operators' log's prefixes; it leaves them out
    # unless asked for.
    ALERT_RAISED = "alert.raised"
    ALERT_CLEARED = "alert.cleared"
    # An operator held a cloud machine stopped, so its owner cannot start it,
    # or released it again (`switch-cloud-machine`).
    CLOUD_MACHINE_ADMIN_STOPPED = "cloud_machine.admin_stopped"
    CLOUD_MACHINE_ADMIN_RELEASED = "cloud_machine.admin_released"


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


async def record_organization_audit_event(
    session: AsyncSession,
    *,
    organization_id: str,
    actor_user_id: str | None,
    action: OrganizationAuditAction,
    target_type: str,
    target_id: str | None,
    details: dict[str, Any] | None,
) -> OrganizationAuditEvent:
    """Add an organization event to `session`; it lands when the caller commits.

    `session` may be bound to the organization or to any of its workspaces:
    the policy derives the organization from either.
    """
    event = OrganizationAuditEvent(
        organization_id=organization_id,
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


async def list_organization_audit_events(
    session: AsyncSession,
    *,
    organization_id: str,
    limit: int,
    before: datetime | None,
) -> list[OrganizationAuditEvent]:
    """Newest first. Names its organization as well as relying on the policy,
    as `list_audit_events` does."""
    query = select(OrganizationAuditEvent).where(
        OrganizationAuditEvent.organization_id == organization_id
    )
    if before is not None:
        query = query.where(OrganizationAuditEvent.occurred_at < before)
    result = await session.execute(
        query.order_by(
            OrganizationAuditEvent.occurred_at.desc(),
            OrganizationAuditEvent.id.desc(),
        ).limit(limit)
    )
    return list(result.scalars().all())
