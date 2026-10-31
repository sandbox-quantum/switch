from __future__ import annotations

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Organization, OrganizationMember, User

# Postgres's default name for `organizations.slug`'s unique constraint.
_SLUG_CONSTRAINT = "organizations_slug_key"


class OrganizationSlugTaken(Exception):
    """The slug belongs to another organization. Nothing was written."""

    def __init__(self, slug: str) -> None:
        super().__init__(f"Organization slug {slug!r} is taken")
        self.slug = slug


def _violated_constraint(err: IntegrityError) -> str | None:
    return getattr(getattr(err.orig, "__cause__", None), "constraint_name", None)


class OrganizationStore:
    """Organizations and their members.

    Every method runs on a session whose organization is bound, explicitly
    (`db/session_scope.organization_session`) or through a bound workspace:
    the policy on both tables (`db/rls_ddl.py`) narrows every read to it and
    refuses every write outside it.
    """

    async def create(
        self, session: AsyncSession, organization: Organization
    ) -> Organization:
        """Insert `organization`, on a session bound to its own id.

        A taken slug raises `OrganizationSlugTaken`; every other integrity
        error propagates as it is.
        """
        session.add(organization)
        try:
            await session.flush()
        except IntegrityError as err:
            if _violated_constraint(err) == _SLUG_CONSTRAINT:
                raise OrganizationSlugTaken(organization.slug) from err
            raise
        return organization

    async def delete_empty(self, session: AsyncSession, organization_id: str) -> None:
        """Delete an organization that no workspace or member was ever added to.

        Undoes a `create` whose workspace could not be created after it. A
        foreign key refuses it once anything references the organization.
        """
        await session.execute(
            delete(Organization).where(Organization.id == organization_id)
        )

    async def role(
        self, session: AsyncSession, organization_id: str, user_id: str
    ) -> str | None:
        """`user_id`'s role in `organization_id`, or None if not a member."""
        member = await session.get(OrganizationMember, (organization_id, user_id))
        return member.role if member is not None else None

    async def list_members(
        self, session: AsyncSession, organization_id: str
    ) -> list[tuple[User, OrganizationMember]]:
        """Every member of `organization_id`, with their user row."""
        result = await session.execute(
            select(User, OrganizationMember)
            .join(OrganizationMember, OrganizationMember.user_id == User.id)
            .where(OrganizationMember.organization_id == organization_id)
            .order_by(User.name, User.id)
        )
        return [(row[0], row[1]) for row in result.all()]

    async def count_admins(self, session: AsyncSession, organization_id: str) -> int:
        """How many `org_admin`s `organization_id` has."""
        return (
            await session.execute(
                select(func.count())
                .select_from(OrganizationMember)
                .where(
                    OrganizationMember.organization_id == organization_id,
                    OrganizationMember.role == "org_admin",
                )
            )
        ).scalar_one()

    async def lock_admins(self, session: AsyncSession, organization_id: str) -> int:
        """Lock `organization_id`'s `org_admin` rows to the end of the caller's
        transaction, and count them.

        Every write that could leave the organization without an `org_admin`
        counts through this and writes in the same transaction. Two admins
        demoting each other at once then queue on the same rows, and the
        second counts after the first has committed.
        """
        rows = await session.execute(
            select(OrganizationMember.user_id)
            .where(
                OrganizationMember.organization_id == organization_id,
                OrganizationMember.role == "org_admin",
            )
            .with_for_update()
        )
        return len(rows.all())
