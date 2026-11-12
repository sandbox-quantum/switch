"""Central authorization for owned Switch entities.

Single chokepoint for "may this principal perform this action on this
resource". Consolidates the access rules that were previously scattered as
ad-hoc `owner == user or public or admin` checks.

Model:
  - The subject of every decision is a **user** (`Principal`). Agent-initiated
    requests resolve to the agent's owner (see the protocol service's
    `_resolve_acting_identity`); an agent inherits exactly its owner's
    permissions in the tenant the request is bound to — never more than the
    owner holds there.
  - `Principal.is_admin` means "may administer the tenant bound to this
    request" — the deployment operator bypass (`User.role == "admin"`, global,
    never granted by anything self-service) OR an `admin` membership row for
    this user in the bound tenant (`tenant_members.role`, granted per tenant,
    e.g. by creating it) OR `org_admin` of the organization the bound tenant
    belongs to (`organization_members.role`), which administers every
    workspace in it. `administers_tenant` below computes it; a
    caller with a database session should use that rather than re-deriving it.
  - Owned entities carry a nullable owner plus independent `read_visibility`
    and `write_visibility` ("public" | "private").

The rule is uniform across References, ReferenceTypes, Documents, Packages, and
Rooms — the only difference between them lives in their *default* visibility,
not here.

This module is deliberately pure (no DB, no I/O) so it is trivially testable
and so a future relationship-based backend can replace `can` without touching
any call site.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

Action = Literal["read", "write", "delete"]

VISIBILITIES = ("public", "private")


@dataclass(frozen=True)
class Principal:
    """The subject of an authorization decision — always a user identity.

    `id` may be ``None`` for an agent with no owner; such a principal owns
    nothing and is limited to public access.

    `is_admin` is tenant-scoped, not global — see `administers_tenant`.
    """

    id: str | None
    is_admin: bool


# `tenant_members.role` is a checked string, not an enum type (`db/models.py`).
TENANT_ADMIN_ROLES = ("admin",)


ORGANIZATION_ADMIN_ROLE = "org_admin"

# The workspace role an organization's `org_admin` is reported as holding in
# each of its workspaces, membership row or not.
ORGANIZATION_ADMIN_TENANT_ROLE = "admin"


def administers_tenant(
    *, is_operator: bool, tenant_role: str | None, organization_role: str | None
) -> bool:
    """Whether a caller may administer the tenant they hold `tenant_role` in,
    and `organization_role` in the organization it belongs to.

    True for a deployment operator (the global bypass), regardless of
    membership — an operator administers every tenant. True for the
    organization's `org_admin`, with or without a membership row in the tenant.
    Otherwise true only if the membership role itself is `admin`; a plain
    `member`, or no membership row at all, is false. This is the one function
    that should ever turn a role into an admin bit — see `Principal.is_admin`.
    """
    return (
        is_operator
        or organization_role == ORGANIZATION_ADMIN_ROLE
        or tenant_role in TENANT_ADMIN_ROLES
    )


def effective_tenant_role(
    *, tenant_role: str | None, organization_role: str | None
) -> str | None:
    """The role someone acts with in a workspace: their membership role, or
    `ORGANIZATION_ADMIN_TENANT_ROLE` when they are its organization's
    `org_admin` and hold no higher role there. None when they hold neither."""
    if tenant_role in TENANT_ADMIN_ROLES:
        return tenant_role
    if organization_role == ORGANIZATION_ADMIN_ROLE:
        return ORGANIZATION_ADMIN_TENANT_ROLE
    return tenant_role


@runtime_checkable
class Authorizable(Protocol):
    """Structural interface for any entity `can` arbitrates over.

    Satisfied by the Reference, ReferenceType, Document, Package, and Room ORM
    models — no base class required. Declared as read-only properties so a model
    with a non-nullable ``owner_id: str`` still satisfies ``str | None``
    (mutable Protocol attributes would be invariant).
    """

    @property
    def owner_id(self) -> str | None: ...

    @property
    def read_visibility(self) -> str: ...

    @property
    def write_visibility(self) -> str: ...


def can(principal: Principal, action: Action, resource: Authorizable) -> bool:
    """Return whether `principal` may perform `action` on `resource`.

    read   = owner OR admin OR read_visibility  == "public"
    write  = owner OR admin OR write_visibility == "public"
    delete = owner OR admin
    """
    if principal.is_admin:
        return True
    # Owner. The None-guard is load-bearing: a null-owner resource must not be
    # treated as "owned" by a principal whose id is also None.
    if resource.owner_id is not None and resource.owner_id == principal.id:
        return True
    if action == "read":
        return resource.read_visibility == "public"
    if action == "write":
        return resource.write_visibility == "public"
    return False  # delete — owner/admin only, never via visibility


def require(principal: Principal, action: Action, resource: Authorizable) -> None:
    """Raise ``PermissionError`` unless `principal` may `action` `resource`.

    ``PermissionError`` is mapped to HTTP 403 by the gateway and surfaced as an
    error by the MCP server.
    """
    if not can(principal, action, resource):
        raise PermissionError(f"Not authorized to {action} this resource")


def owns(principal: Principal, owner_id: str | None) -> bool:
    """Whether `principal` owns the entity, whatever their role.

    For what only the owner may do, where administering the workspace is not
    enough: an agent's own capabilities and the service access it holds on its
    owner's connections, and a person's own API keys, devices and connections.
    """
    return owner_id is not None and owner_id == principal.id


def can_manage(principal: Principal, owner_id: str | None) -> bool:
    """Owner-or-admin check for entities that have no visibility model.

    Some owned entities (e.g. Agents) are listable by everyone but have no
    public read/write dimension — only the owner or an admin may modify or
    delete them. This is equivalent to write/delete on an always-private
    resource.
    """
    return principal.is_admin or owns(principal, owner_id)


def require_manage(principal: Principal, owner_id: str | None) -> None:
    """Raise ``PermissionError`` unless `principal` owns the entity or is admin."""
    if not can_manage(principal, owner_id):
        raise PermissionError("Not authorized to manage this resource")


def require_visibility_change(
    principal: Principal,
    resource: Authorizable,
    read_visibility: str | None,
    write_visibility: str | None,
    label: str,
) -> None:
    """Raise ``PermissionError`` if this changes who may see or edit
    `resource` and `principal` is neither its owner nor an admin.

    Write access is not enough, the same as for a room: with write visibility
    public, anyone could otherwise make the resource private and lock everyone
    else out of it, and out of the rooms that use it. A value equal to the
    current one changes nothing, so an edit that sends it back unchanged
    needs only write access.
    """
    changes = (
        read_visibility is not None and read_visibility != resource.read_visibility
    ) or (
        write_visibility is not None and write_visibility != resource.write_visibility
    )
    if changes and not can_manage(principal, resource.owner_id):
        raise PermissionError(
            f"Only the {label}'s owner or a workspace admin can change who may "
            "see or edit it."
        )


def can_unlink_from_room(principal: Principal, *, takes_part: bool) -> bool:
    """Whether `principal` may unlink a reference, document or package from a
    room: those taking part in it and tenant admins. `takes_part` is the room
    store's `involves`, which needs the database, so the caller works it out.
    Write access is not enough: on a publicly writable room it is everyone's.
    Linking still takes write access to the room. Note that whoever may write
    to a room may also add their own agent to it, and so take part in it.
    """
    return principal.is_admin or takes_part


def can_delete_room_document(
    principal: Principal, *, room_owner_id: str | None, document_owner_id: str | None
) -> bool:
    """Whether `principal` may delete a room-scoped document: its creator, the
    room's owner, or a tenant admin. An agent's document is recorded under the
    agent's owner, so that person counts as its creator.
    """
    if principal.is_admin:
        return True
    return principal.id is not None and principal.id in (
        room_owner_id,
        document_owner_id,
    )


def can_change_workspace_member(
    *, administers: bool, member_is_organization_admin: bool
) -> bool:
    """Whether the caller may change a workspace member's role or remove them.

    A workspace admin may, their own row included, so an admin steps down or
    leaves while another admin remains; the last one is refused when asked.
    Never an organization admin's row, whose standing in the workspace comes
    from the organization and is changed in its members.
    """
    return administers and not member_is_organization_admin


def admin_by_own_membership(tenant_role: str | None) -> bool:
    """Whether `tenant_role` is an admin's own membership of the workspace:
    not the operator's bypass and not an organization admin acting as one.

    What nobody can undo takes it: deleting the workspace, erasing a person,
    and setting its messages to be deleted."""
    return tenant_role in TENANT_ADMIN_ROLES


def can_delete_workspace(*, tenant_role: str | None, is_default: bool) -> bool:
    """Whether the caller may delete the workspace they hold `tenant_role` in:
    `admin_by_own_membership`, and never the server's default workspace,
    where new accounts start. That it must first be emptied is checked when
    it is deleted.
    """
    return admin_by_own_membership(tenant_role) and not is_default


def can_delete_api_key(
    principal: Principal, owner_id: str | None, *, an_agent_signs_in_with_it: bool
) -> bool:
    """Whether `principal` may delete an API key: their own, unless an agent
    still signs in with it. That key goes with its agent; once the agent is
    deleted, what is left of it may go too."""
    return owns(principal, owner_id) and not an_agent_signs_in_with_it


def require_group_filing(is_admin: bool) -> None:
    """Raise ``PermissionError`` unless a workspace admin is putting a room
    into a room group.

    A room's group is an input to agents' addressing policies (a rule can
    admit every room in a group), so filing a room into one can open agents
    to its members. Groups are admin-managed, and so is what goes in them.
    Taking a room out of a group only needs write access to the room.
    """
    if not is_admin:
        raise PermissionError("Only a workspace admin can put a room in a room group.")


def validate_visibility_pair(read_visibility: str, write_visibility: str) -> None:
    """Validate a (read, write) visibility pair, raising ``ValueError`` if bad.

    Enforces the enum and the write⊇read invariant: a publicly writable
    resource must also be publicly readable (writable-but-unreadable is
    nonsensical).
    """
    for label, value in (("read", read_visibility), ("write", write_visibility)):
        if value not in VISIBILITIES:
            raise ValueError(
                f"Invalid {label}_visibility '{value}' (expected public|private)"
            )
    if write_visibility == "public" and read_visibility != "public":
        raise ValueError(
            "write_visibility=public requires read_visibility=public "
            "(a writable resource must be readable)"
        )
