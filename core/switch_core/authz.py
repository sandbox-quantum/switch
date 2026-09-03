"""Central authorization for owned Switch entities.

Single chokepoint for "may this principal perform this action on this
resource". Consolidates the access rules that were previously scattered as
ad-hoc `owner == user or public or admin` checks.

Model:
  - The subject of every decision is a **user** (`Principal`). Agent-initiated
    requests resolve to the agent's owner (see the protocol service's
    `_resolve_acting_identity`); an agent inherits exactly its owner's
    permissions.
  - `User.role == "admin"` is a global bypass.
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
    """

    id: str | None
    is_admin: bool


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


def can_manage(principal: Principal, owner_id: str | None) -> bool:
    """Owner-or-admin check for entities that have no visibility model.

    Some owned entities (e.g. Agents) are listable by everyone but have no
    public read/write dimension — only the owner or an admin may modify or
    delete them. This is equivalent to write/delete on an always-private
    resource.
    """
    return principal.is_admin or (owner_id is not None and owner_id == principal.id)


def require_manage(principal: Principal, owner_id: str | None) -> None:
    """Raise ``PermissionError`` unless `principal` owns the entity or is admin."""
    if not can_manage(principal, owner_id):
        raise PermissionError("Not authorized to manage this resource")


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
