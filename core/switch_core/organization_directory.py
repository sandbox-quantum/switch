"""Who keeps the record of organizations and their members.

Authorization reads Switch's own tables, `organizations` and
`organization_members`, on every server, so no request waits on anything
else. The directory is what decides them:

- `LocalDirectory`: Switch's tables are the record, so the write to them is
  the whole change and the directory's step is nothing.
- A directory kept outside Switch is the record, and Switch's rows follow it.

Every route that creates an organization, adds someone to one or changes or
ends their role there runs every check of its own that can refuse first (the
last Org Admin, nobody granting above their own role, removal while someone
is still in a workspace), then asks the directory, then writes and commits.
A directory that refuses or can't be reached raises `DirectoryError`, and
Switch's rows are left as they were. A failure after the directory has
changed (the commit) leaves Switch behind the directory, and it is the
directory's own record that brings Switch's rows up to date.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from switch_core.db.models import Organization, User


@dataclass(frozen=True)
class DirectoryOrganization:
    """What a new organization is known by in the directory, kept on its
    `organizations` row. Both None for an organization Switch keeps itself."""

    workos_organization_id: str | None
    customer_id: str | None


class DirectoryError(Exception):
    """The directory did not make a change. `message` says why, for people to
    read."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class DirectoryUnavailable(DirectoryError):
    """The directory could not be reached or failed: trying again may work."""


class DirectoryRefusal(DirectoryError):
    """The directory refused the change by its own rules: trying again won't."""


class OrganizationDirectory(Protocol):
    """Implementations work outside Switch's database, over the network, and
    bound every call: they are handed rows, never a session, and a route may
    hold locks while it waits on them."""

    async def create_organization(
        self, creator: User, name: str
    ) -> DirectoryOrganization:
        """Record a new organization named `name`, with `creator` its
        `org_admin`, before its rows are written."""
        ...

    async def discard_organization(self, organization: DirectoryOrganization) -> None:
        """Undo `create_organization` when Switch could not create the rows
        that follow it."""
        ...

    async def join(self, organization: Organization, user_id: str, role: str) -> None:
        """Make `user_id` a `role` member of `organization`. Only asked for
        someone who is not a member yet."""
        ...

    async def set_role(
        self, organization: Organization, user_id: str, role: str
    ) -> None:
        """Change a member's role in `organization` to `role`."""
        ...

    async def remove(self, organization: Organization, user_id: str) -> None:
        """End `user_id`'s membership of `organization`."""
        ...


class LocalDirectory:
    """Switch's own tables are the record: each change is the route's write
    to them, and nothing is asked first."""

    async def create_organization(
        self, creator: User, name: str
    ) -> DirectoryOrganization:
        return DirectoryOrganization(workos_organization_id=None, customer_id=None)

    async def discard_organization(self, organization: DirectoryOrganization) -> None:
        return None

    async def join(self, organization: Organization, user_id: str, role: str) -> None:
        return None

    async def set_role(
        self, organization: Organization, user_id: str, role: str
    ) -> None:
        return None

    async def remove(self, organization: Organization, user_id: str) -> None:
        return None
