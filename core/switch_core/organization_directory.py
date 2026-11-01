"""Who keeps the record of organizations and their members.

Authorization reads Switch's own tables, `organizations` and
`organization_members`, on every server, so no request waits on anything
else. The directory is what decides them. Every route that creates an
organization, adds someone to one or changes or ends their role there asks the
directory first, then writes Switch's rows:

- `LocalDirectory`: Switch's tables are the record, so the write to them is
  the whole change and the directory's step is nothing.
- A directory kept outside Switch makes the change there first, and Switch's
  rows follow it. If it refuses or can't be reached it raises
  `DirectoryRefusal`, and the route changes nothing in Switch.

The rules (the last Org Admin, nobody granting above their own role, removal
refused while someone is still in a workspace) are checked by the routes
before they ask, so they hold whichever directory is in use.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import User


@dataclass(frozen=True)
class DirectoryOrganization:
    """What a new organization is known by in the directory, kept on its
    `organizations` row. Both None for an organization Switch keeps itself."""

    workos_organization_id: str | None
    customer_id: str | None


class DirectoryRefusal(Exception):
    """The directory refused a change or could not be reached. `message` says
    why, for people to read; nothing was changed in Switch."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class OrganizationDirectory(Protocol):
    async def create_organization(
        self, creator: User, name: str
    ) -> DirectoryOrganization:
        """Record a new organization named `name`, with `creator` its
        `org_admin`, before its row is written."""
        ...

    async def join(
        self, session: AsyncSession, *, organization_id: str, user_id: str, role: str
    ) -> None:
        """Make `user_id` a `role` member of `organization_id`, if not one
        already. An existing membership keeps its role."""
        ...

    async def set_role(
        self, session: AsyncSession, *, organization_id: str, user_id: str, role: str
    ) -> None:
        """Change a member's role in `organization_id` to `role`."""
        ...

    async def remove(
        self, session: AsyncSession, *, organization_id: str, user_id: str
    ) -> None:
        """End `user_id`'s membership of `organization_id`."""
        ...


class LocalDirectory:
    """Switch's own tables are the record: each change is the route's write
    to them, and nothing is asked first."""

    async def create_organization(
        self, creator: User, name: str
    ) -> DirectoryOrganization:
        return DirectoryOrganization(workos_organization_id=None, customer_id=None)

    async def join(
        self, session: AsyncSession, *, organization_id: str, user_id: str, role: str
    ) -> None:
        return None

    async def set_role(
        self, session: AsyncSession, *, organization_id: str, user_id: str, role: str
    ) -> None:
        return None

    async def remove(
        self, session: AsyncSession, *, organization_id: str, user_id: str
    ) -> None:
        return None
