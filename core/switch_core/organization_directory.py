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


@dataclass(frozen=True)
class DirectoryMembership:
    """Someone's membership of an organization, as the directory has it: the
    directory's id for the organization (`organizations.workos_organization_id`
    for the Switch organization linked to it), and whether they are its
    `org_admin`."""

    workos_organization_id: str
    role: str


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


class DirectorySignInRequired(DirectoryError):
    """The directory takes the change only from the admin as it knows them,
    and Switch holds no token of theirs for it: they sign in there for the
    organization (`gateway/workos_sign_in.py`) and try again. Raised before
    anything is changed."""


@dataclass(frozen=True)
class MemberChange:
    """What a change made from Switch to someone's membership needs the
    directory to do, worked out by `prepare_change` before anything is
    changed: the directory's own id for the membership to change, None when
    the directory needs no change, and the access token the directory issued
    the admin making it for the organization, None when there is none."""

    access_token: str | None
    membership_id: str | None


NO_DIRECTORY_CHANGE = MemberChange(access_token=None, membership_id=None)


class OrganizationDirectory(Protocol):
    """Implementations work outside Switch's database, over the network, and
    bound every call: they are handed rows, never a session, and a route may
    hold locks while it waits on them."""

    # The OIDC issuer whose subjects are the directory's ids for people, for
    # a route to look up the subject `prepare_change` takes; None where it has
    # none.
    identity_issuer: str | None

    async def prepare_change(
        self,
        organization: Organization,
        subject: str | None,
        role: str | None,
        access_token: str | None,
    ) -> MemberChange:
        """What giving the person the directory knows as `subject` the role
        `role` in `organization`, or removing them when `role` is None, needs
        of the directory. Asked before a route changes anything, and before
        it takes any lock: raises `DirectorySignInRequired` when the directory
        has to change and takes the change only with a token from the admin,
        and `access_token` is None; `DirectoryRefusal` when it won't take it
        at all."""
        ...

    def sends_changes_for(self, organization: Organization) -> bool:
        """Whether changes made from Switch to `organization`'s members are
        made in the directory too, so that they last. False where Switch's
        tables are the record."""
        ...

    def keeps_members_of(self, organization: Organization) -> bool:
        """Whether the directory, not Switch, is the record of who is in
        `organization` and who is its `org_admin`: then adding someone or
        making them `org_admin` is done there, and what Switch takes away
        lasts only until the directory is read again."""
        ...

    async def memberships_at_sign_in(
        self, subject: str
    ) -> list[DirectoryMembership] | None:
        """The organizations the person who signed in as `subject` (their
        OIDC `sub`) belongs to, for Switch's rows to be brought up to date
        with; None where Switch's rows are the record."""
        ...

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
        self,
        organization: Organization,
        user_id: str,
        role: str,
        change: MemberChange,
    ) -> None:
        """Change a member's role in `organization` to `role`, with what
        `prepare_change` worked out for it."""
        ...

    async def remove(
        self, organization: Organization, user_id: str, change: MemberChange
    ) -> None:
        """End `user_id`'s membership of `organization`, with what
        `prepare_change` worked out for it."""
        ...


class LocalDirectory:
    """Switch's own tables are the record: each change is the route's write
    to them, and nothing is asked first."""

    identity_issuer: str | None = None

    async def prepare_change(
        self,
        organization: Organization,
        subject: str | None,
        role: str | None,
        access_token: str | None,
    ) -> MemberChange:
        return NO_DIRECTORY_CHANGE

    def sends_changes_for(self, organization: Organization) -> bool:
        return False

    def keeps_members_of(self, organization: Organization) -> bool:
        return False

    async def memberships_at_sign_in(
        self, subject: str
    ) -> list[DirectoryMembership] | None:
        return None

    async def create_organization(
        self, creator: User, name: str
    ) -> DirectoryOrganization:
        return DirectoryOrganization(workos_organization_id=None, customer_id=None)

    async def discard_organization(self, organization: DirectoryOrganization) -> None:
        return None

    async def join(self, organization: Organization, user_id: str, role: str) -> None:
        return None

    async def set_role(
        self,
        organization: Organization,
        user_id: str,
        role: str,
        change: MemberChange,
    ) -> None:
        return None

    async def remove(
        self, organization: Organization, user_id: str, change: MemberChange
    ) -> None:
        return None
