"""The audit logs: append an event in the caller's transaction, read it back.

A tenant's changes go to `audit_events`; a change to an organization as a
whole, its members and workspaces, goes to `organization_audit_events`; a
change to the server as a whole, which no tenant owns, goes to
`server_audit_events`.

Functions rather than an injected store because there is nothing to hold: each
call takes the session of the change it records, so the event commits or rolls
back with that change.

Each event is also written to the security event stream once its transaction
commits (`security_events.py`), which is how it reaches a log pipeline.
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
from switch_core.logging_context import current_log_context
from switch_core.security_events import (
    SecurityEvent,
    SecurityScope,
    emit_after_commit,
    subject_ids,
)

# Set, to true, in the details of every audit event a platform operator's
# server command records (`switch-accounts`, `switch-connector-apps`,
# `switch-promote-org-admin`): no account is behind the change, so the event
# names no actor.
PLATFORM_OPERATOR_COMMAND = "platform_operator_command"


class AuditAction(StrEnum):
    TENANT_CREATED = "tenant.created"
    TENANT_DELETED = "tenant.deleted"
    TENANT_RENAMED = "tenant.renamed"
    TENANT_ARCHIVED = "tenant.archived"
    TENANT_RESTORED = "tenant.restored"
    INVITATION_CREATED = "invitation.created"
    INVITATION_REVOKED = "invitation.revoked"
    INVITATION_ACCEPTED = "invitation.accepted"
    MEMBER_JOINED_BY_DOMAIN = "member.joined_by_domain"
    MEMBER_ROLE_CHANGED = "member.role_changed"
    MEMBER_REMOVED = "member.removed"
    # One of the organization's admins added someone already in it.
    MEMBER_ADDED_BY_ORGANIZATION = "member.added_by_organization"
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
    # Someone other than its owner, a workspace admin, narrowed who may
    # address an agent.
    AGENT_ADDRESSING_CHANGED = "agent.addressing_changed"
    AGENT_DELETED = "agent.deleted"
    WORKSPACE_SERVICE_ENABLED = "workspace_service.enabled"
    WORKSPACE_SERVICE_DISABLED = "workspace_service.disabled"
    WORKSPACE_SERVICE_CLEARED = "workspace_service.cleared"
    OWNERSHIP_TRANSFERRED = "ownership.transferred"
    ROOM_ADMIN_ADDED = "room_admin.added"
    ROOM_ADMIN_REMOVED = "room_admin.removed"
    RETENTION_POLICY_SET = "retention_policy.set"
    RETENTION_POLICY_CLEARED = "retention_policy.cleared"
    PERSON_ERASURE_REQUESTED = "person_erasure.requested"
    PERSON_ERASURE_COMPLETED = "person_erasure.completed"
    # A workspace admin made a Public room on a private channel Private, from
    # the clean-up of rooms made before rooms followed their channel
    # (`private_channel_rooms.py`).
    ROOM_MADE_PRIVATE = "room.made_private"
    # Switch Console signed a browser in to the workspace with a one-time
    # link, opening a dashboard page (`details.next`).
    BROWSER_HANDOFF = "auth.browser_handoff"
    ROOM_CREATED = "room.created"
    ROOM_ARCHIVED = "room.archived"
    ROOM_UNARCHIVED = "room.unarchived"
    ROOM_DELETED = "room.deleted"
    # A client joined or left a room (`client_rooms`): an agent, a person in
    # Switch Console, or a person on a bridged platform. Bridges and Switch's
    # own system clients are not recorded. `details.client_type` says which.
    ROOM_MEMBER_ADDED = "room.member_added"
    ROOM_MEMBER_REMOVED = "room.member_removed"
    AGENT_REGISTERED = "agent.registered"
    # An existing agent registered again, which issues it a new key.
    AGENT_REREGISTERED = "agent.reregistered"
    AGENT_MANAGEMENT_GRANTED = "agent.can_manage_agents_granted"
    AGENT_MANAGEMENT_REVOKED = "agent.can_manage_agents_revoked"
    # A managed agent was created with, or changed to, `auto_approve`: its
    # sessions run tools without asking anyone.
    AGENT_AUTO_APPROVE_ENABLED = "agent.auto_approve_enabled"
    CONTROLLER_ENROLLED = "controller.enrolled"
    CONTROLLER_REVOKED = "controller.revoked"
    # Switch Trust blocked a message, or redacted it before it was delivered
    # (`trust/client.py`): the policy, the outcome and what each finding
    # was, never the text found. Alerts and errors are log-only.
    TRUST_MESSAGE_BLOCKED = "trust.message_blocked"
    TRUST_MESSAGE_REDACTED = "trust.message_redacted"


class OrganizationAuditAction(StrEnum):
    ORGANIZATION_CREATED = "organization.created"
    ORGANIZATION_RENAMED = "organization.renamed"
    WORKSPACE_CREATED = "organization.workspace_created"
    WORKSPACE_RENAMED = "organization.workspace_renamed"
    WORKSPACE_ARCHIVED = "organization.workspace_archived"
    WORKSPACE_RESTORED = "organization.workspace_restored"
    MEMBER_ADDED_TO_WORKSPACE = "organization.member_added_to_workspace"
    # An org admin changed someone's role in one of its workspaces, from the
    # organization's pages (Manage admins included), or removed them from one.
    MEMBER_WORKSPACE_ROLE_CHANGED = "organization.member_workspace_role_changed"
    MEMBER_REMOVED_FROM_WORKSPACE = "organization.member_removed_from_workspace"
    # Someone new to the organization joined one of its workspaces.
    MEMBER_JOINED_BY_INVITATION = "organization.member_joined_by_invitation"
    MEMBER_JOINED_BY_DOMAIN = "organization.member_joined_by_domain"
    ROLE_CHANGED = "organization.role_changed"
    MEMBER_REMOVED = "organization.member_removed"
    # Someone in none of its workspaces left it themselves.
    MEMBER_LEFT = "organization.member_left"
    CONNECTOR_APP_SAVED = "organization.connector_app_saved"
    CONNECTOR_APP_REMOVED = "organization.connector_app_removed"
    SERVICE_SET = "organization.service_set"
    SERVICE_CLEARED = "organization.service_cleared"
    GUARDRAILS_CONNECTED = "organization.guardrails_connected"
    GUARDRAILS_DISCONNECTED = "organization.guardrails_disconnected"
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
    # Someone finished signing in to the organization's directory to act as
    # one of its admins (`gateway/workos_sign_in_routes.py`).
    DIRECTORY_SIGN_IN = "organization.directory_sign_in"


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
    # An operator added an account, in no workspace (`switch-accounts create`).
    USER_CREATED = "user.created"
    # An operator made an account a platform operator, or a platform operator
    # a regular account (`switch-accounts grant-operator`, `revoke-operator`).
    USER_PROMOTED = "user.promoted"
    USER_DEMOTED = "user.demoted"
    USER_DELETED = "user.deleted"
    USER_DELETION_REFUSED = "user.deletion_refused"
    USER_DELETION_FAILED = "user.deletion_failed"
    # Every session the account held was ended, by the person ("Sign out of
    # all devices") or by the operator for them.
    USER_SESSIONS_ENDED = "user.sessions_ended"
    # The operator lifted the lock failed password sign-ins put on an account's
    # email address, so its owner could try again at once.
    USER_SIGN_IN_LOCK_CLEARED = "user.sign_in_lock_cleared"
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
    # An operator held a cloud machine stopped, so its owner cannot start it,
    # or released it again (`switch-cloud-machine`).
    CLOUD_MACHINE_ADMIN_STOPPED = "cloud_machine.admin_stopped"
    CLOUD_MACHINE_ADMIN_RELEASED = "cloud_machine.admin_released"
    # A person signed in to the gateway. A failed sign-in is a log-only
    # security event (`security_events.SecuritySignal.SIGN_IN_FAILED`): it
    # names no account it can trust, and a row per attempt would let anyone
    # grow this table at will.
    USER_SIGNED_IN = "user.signed_in"


def request_actor() -> tuple[str | None, str | None]:
    """Who the current request acts for, as authentication bound it: the
    signed-in person, or the owner of the agent or controller calling
    (`gateway/auth.py`, `bridges/agent/auth.py`), and the calling agent when
    an agent is calling. `(None, None)` outside a request.

    For a change made deep below the route, in a function many callers share,
    where threading the actor through every caller would be the alternative.
    """
    context = current_log_context()
    return context.user_id, context.agent_id


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
    _mirror(
        session,
        event,
        SecurityScope.TENANT,
        tenant_id=tenant_id,
        organization_id=None,
    )
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
    _mirror(
        session,
        event,
        SecurityScope.ORGANIZATION,
        tenant_id=None,
        organization_id=organization_id,
    )
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
    _mirror(session, event, SecurityScope.SERVER, tenant_id=None, organization_id=None)
    return event


def _mirror(
    session: AsyncSession,
    event: AuditEvent | OrganizationAuditEvent | ServerAuditEvent,
    scope: SecurityScope,
    *,
    tenant_id: str | None,
    organization_id: str | None,
) -> None:
    agent_id, room_id = subject_ids(event.target_type, event.target_id, event.details)
    emit_after_commit(
        session,
        SecurityEvent(
            action=event.action,
            scope=scope,
            tenant_id=tenant_id,
            organization_id=organization_id,
            actor_user_id=event.actor_user_id,
            target_type=event.target_type,
            target_id=event.target_id,
            agent_id=agent_id,
            room_id=room_id,
            details=None if event.details is None else dict(event.details),
            audit_event_id=event.id,
        ),
    )


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


async def last_removed_by_someone_else(
    session: AsyncSession, *, tenant_id: str, user_id: str
) -> bool:
    """Whether the last time `user_id` was removed from `tenant_id`, someone
    other than themselves removed them: an admin, an organization admin, or
    the organization's directory. False for someone never removed, or who
    last left on their own.

    Read from the workspace's own log, the one record of who removed whom,
    which the runtime role can add to but not rewrite. Names its tenant as
    `list_audit_events` does.
    """
    actor = await session.execute(
        select(AuditEvent.actor_user_id)
        .where(
            AuditEvent.tenant_id == tenant_id,
            AuditEvent.action == AuditAction.MEMBER_REMOVED.value,
            AuditEvent.target_type == "user",
            AuditEvent.target_id == user_id,
        )
        .order_by(AuditEvent.occurred_at.desc(), AuditEvent.id.desc())
        .limit(1)
    )
    row = actor.first()
    return row is not None and row[0] != user_id


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
