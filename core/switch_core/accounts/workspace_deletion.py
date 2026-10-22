"""Deleting a workspace that has already been emptied.

Nothing here deletes anything a person made on purpose. A workspace can be
deleted only once its owner has removed, one by one and with each in front of
them, everything in `REFUSED`: rooms (archived ones too), agents, resources,
machines, messaging and service connections and every other member, and
until every service token issued in it that can still be revoked has been.
The refusal lists what is left, by kind and count. A record kept only as
history of something already ended (`TERMINAL`: a removed machine, a
disconnected messaging app, a cloud machine since deleted) does not count, and
goes with the workspace. What remains after that is the workspace's own setup
(its settings, invitations, join domains, usage counters and the clients the
server runs for it), which goes with it, in one transaction, and the `tenants`
row last.

The workspace's audit history stays (`KEPT`): `audit_events.tenant_id`
carries no foreign key so it can outlive the tenant, and the runtime role may
not delete it anyway. No member is left to read it; the deletion itself is
also recorded in the server's audit log, which outlives every workspace, in
the same transaction, whoever asked for it.

`WORKSPACE_TABLES` says what happens to every tenant-scoped table, and a test
holds it to the schema, so a table added later cannot be swept away with a
workspace, or left to hold one back, without saying which.

Concurrent writes are shut out by locking the `tenants` row: every insert into
a scoped table checks its foreign key to it, which waits on that lock and then
fails once the row is gone.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Literal

from sqlalchemy import ColumnElement, Table, delete, func, select

from switch_core.db.audit import (
    AuditAction,
    ServerAuditAction,
    record_audit_event,
    record_server_audit_event,
)
from switch_core.db.base import Base
from switch_core.db.models import (
    TENANT_ZERO_ID,
    ApiKey,
    CloudMachine,
    Room,
    ServiceTokenIssuance,
    Tenant,
)
from switch_core.db.stores.messaging_install_store import INSTALL_ACTIVE

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

Handling = Literal["refused", "deleted", "kept"]

# Every tenant-scoped table, and what deleting the workspace does with its
# rows. "refused" means a row there blocks the deletion; `REFUSED` names it.
WORKSPACE_TABLES: dict[str, Handling] = {
    "rooms": "refused",
    "agents": "refused",
    "packages": "refused",
    "references": "refused",
    "reference_types": "refused",
    "documents": "refused",
    "templates": "refused",
    "room_groups": "refused",
    "messaging_installs": "refused",
    "collaboration_bridges": "refused",
    "machine_workspaces": "refused",
    "agent_controllers": "refused",
    "server_connectors": "refused",
    "skills": "refused",
    "service_connections": "refused",
    # Refused for anyone but the person deleting it; their own row goes.
    "tenant_members": "deleted",
    "audit_events": "kept",
    "tenants": "deleted",
    # Hang off a refused table, so they are empty by the time it is.
    "agent_connection_rooms": "deleted",
    "agent_connections": "deleted",
    "agent_controller_enrollment_codes": "deleted",
    "agent_controller_operations": "deleted",
    "agent_definitions": "deleted",
    "agent_event_drops": "deleted",
    "agent_event_heads": "deleted",
    "agent_events": "deleted",
    "agent_poll_positions": "deleted",
    "agent_position_tickets": "deleted",
    "agent_room_reads": "deleted",
    "agent_runtime_states": "deleted",
    "agent_session_command_relays": "deleted",
    "agent_session_placements": "deleted",
    "agent_sessions": "deleted",
    "agent_skills": "deleted",
    "approval_request_posts": "deleted",
    "approval_requests": "deleted",
    "bridge_message_map": "deleted",
    "chat_hidden": "deleted",
    "chat_operations": "deleted",
    "chat_owner_grants": "deleted",
    "client_rooms": "deleted",
    "delivery_cursors": "deleted",
    "external_user_claims": "deleted",
    "external_users": "deleted",
    "media_blobs": "deleted",
    "message_attachments": "deleted",
    "messages": "deleted",
    "messaging_event_receipts": "deleted",
    "messaging_install_states": "deleted",
    "models": "deleted",
    "package_documents": "deleted",
    "package_references": "deleted",
    "pending_attachment_groups": "deleted",
    "role_leases": "deleted",
    "room_agents": "deleted",
    "room_documents": "deleted",
    "room_links": "deleted",
    "room_packages": "deleted",
    "room_references": "deleted",
    "room_roles": "deleted",
    "room_skills": "deleted",
    "sealed_provider_logins": "deleted",
    "service_grants": "deleted",
    "service_token_issuances": "deleted",
    "session_activity_items": "deleted",
    "tasks": "deleted",
    "tools": "deleted",
    "turn_status_posts": "deleted",
    # The workspace's own setup, and what the person deleting it holds in it.
    "api_keys": "deleted",
    "clients": "deleted",
    "invitations": "deleted",
    "provider_connections": "deleted",
    "sign_in_flows": "deleted",
    "tenant_data_moves": "deleted",
    "tenant_join_domains": "deleted",
    "tenant_usage": "deleted",
    "usage_budgets": "deleted",
    "workspace_service_settings": "deleted",
}

# What a blocking table is called in the refusal: (singular, plural).
REFUSED: dict[str, tuple[str, str]] = {
    "rooms": ("room", "rooms"),
    "agents": ("agent", "agents"),
    "packages": ("package", "packages"),
    "references": ("reference", "references"),
    "reference_types": ("reference type", "reference types"),
    "documents": ("document", "documents"),
    "templates": ("template", "templates"),
    "room_groups": ("room group", "room groups"),
    "messaging_installs": ("messaging app connection", "messaging app connections"),
    "collaboration_bridges": ("messaging bridge", "messaging bridges"),
    "machine_workspaces": ("cloud machine", "cloud machines"),
    "agent_controllers": ("machine", "machines"),
    "server_connectors": ("server connector", "server connectors"),
    "skills": ("skill", "skills"),
    "service_connections": ("service connection", "service connections"),
}


# Rows of a refused table that are kept only as the record of something that
# has ended, and so neither block the deletion nor survive it. Every other row
# of the table still blocks.
TERMINAL: dict[str, Callable[[Table], ColumnElement[bool]]] = {
    # A machine removed in Switch Console keeps its row, revoked.
    "agent_controllers": lambda table: table.c.revoked_at.is_not(None),
    # A disconnected or revoked app keeps its row, with no token.
    "messaging_installs": lambda table: table.c.status != INSTALL_ACTIVE,
    # A cloud machine's row outlives its teardown, as `deleted`.
    "machine_workspaces": lambda table: table.c.machine_id.in_(
        select(CloudMachine.id).where(CloudMachine.state == "deleted")
    ),
}


class WorkspaceDeletionRefused(Exception):
    """The workspace still holds something; the message lists what."""


def _table(name: str) -> Table:
    table = Base.metadata.tables[name]
    assert isinstance(table, Table)
    return table


def _counted(count: int, names: tuple[str, str]) -> str:
    return f"{count} {names[0] if count == 1 else names[1]}"


async def remaining(session: AsyncSession, tenant_id: str, owner_id: str) -> list[str]:
    """What still has to go before the workspace can be deleted, by kind and
    count, in words; empty when nothing does. `session` is bound to it."""
    left: list[str] = []
    for name, names in REFUSED.items():
        table = _table(name)
        counted = select(func.count()).select_from(table)
        counted = counted.where(table.c.tenant_id == tenant_id)
        if name in TERMINAL:
            counted = counted.where(~TERMINAL[name](table))
        count = await session.scalar(counted)
        if not count:
            continue
        entry = _counted(count, names)
        if name == "rooms":
            archived = await session.scalar(
                select(func.count())
                .select_from(Room)
                .where(Room.tenant_id == tenant_id, Room.archived_at.is_not(None))
            )
            if archived:
                entry += f" ({archived} archived)"
        left.append(entry)
    # A token issued to an agent is revoked at its vendor from this row, after
    # the access it came from is gone; deleting the row first would leave it
    # live there until it expires.
    revocable = await session.scalar(
        select(func.count())
        .select_from(ServiceTokenIssuance)
        .where(
            ServiceTokenIssuance.tenant_id == tenant_id,
            ServiceTokenIssuance.encrypted_token.is_not(None),
            ServiceTokenIssuance.expires_at > func.now(),
        )
    )
    if revocable:
        left.append(
            _counted(
                revocable,
                (
                    "service token still to be revoked (try again shortly)",
                    "service tokens still to be revoked (try again shortly)",
                ),
            )
        )
    members = _table("tenant_members")
    others = await session.scalar(
        select(func.count())
        .select_from(members)
        .where(members.c.tenant_id == tenant_id, members.c.user_id != owner_id)
    )
    if others:
        left.append(_counted(others, ("other member", "other members")))
    return left


async def refusal(session: AsyncSession, tenant_id: str, owner_id: str) -> str | None:
    """Why the workspace cannot be deleted now, or None when it can."""
    if tenant_id == TENANT_ZERO_ID:
        return (
            "This is the server's default workspace, where new accounts start. "
            "It can't be deleted."
        )
    left = await remaining(session, tenant_id, owner_id)
    if left:
        return (
            "Empty the workspace before deleting it. Still in it: "
            + ", ".join(left)
            + "."
        )
    return None


async def delete_workspace(
    session: AsyncSession, tenant_id: str, owner_id: str, actor_user_id: str | None
) -> list[str]:
    """Delete the workspace on `session`, which is bound to it; the caller
    commits. Raises `WorkspaceDeletionRefused`, having deleted nothing, unless
    it is empty. Records the deletion in the workspace's audit log and the
    server's, naming `actor_user_id`. Returns the hashes of the API keys
    deleted with it, for the caller to drop from its cache once this has
    committed."""
    tenant = await session.scalar(
        select(Tenant).where(Tenant.id == tenant_id).with_for_update()
    )
    if tenant is None:
        raise WorkspaceDeletionRefused("That workspace doesn't exist.")
    reason = await refusal(session, tenant_id, owner_id)
    if reason is not None:
        raise WorkspaceDeletionRefused(reason)
    key_hashes = list(
        await session.scalars(
            select(ApiKey.key_hash).where(ApiKey.tenant_id == tenant_id)
        )
    )
    await record_audit_event(
        session,
        tenant_id=tenant_id,
        actor_user_id=actor_user_id,
        action=AuditAction.TENANT_DELETED,
        target_type="tenant",
        target_id=tenant_id,
        details={"slug": tenant.slug},
    )
    await record_server_audit_event(
        session,
        actor_user_id=actor_user_id,
        action=ServerAuditAction.WORKSPACE_DELETED,
        target_type="tenant",
        target_id=tenant_id,
        details={"slug": tenant.slug},
    )
    # Children before parents, so no foreign key between two of these tables
    # holds a delete back.
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in TERMINAL:
            # The refusal found only ended rows; a live one fails the
            # `tenants` delete below on its foreign key.
            await session.execute(
                delete(table).where(
                    table.c.tenant_id == tenant_id, TERMINAL[table.name](table)
                )
            )
            continue
        if WORKSPACE_TABLES.get(table.name) != "deleted" or table.name == "tenants":
            continue
        await session.execute(delete(table).where(table.c.tenant_id == tenant_id))
    await session.execute(delete(Tenant).where(Tenant.id == tenant_id))
    await session.flush()
    return key_hashes
