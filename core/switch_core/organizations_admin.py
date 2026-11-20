"""`switch-orgs`: the deployment's organizations, for the platform operator
(`operator_commands.py`).

- `switch-orgs list` prints every organization: its id, slug and name, its
  organization admins' e-mail addresses, and its workspaces with their ids,
  names and how many people each has. Nothing is changed.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.config import SwitchConfig
from switch_core.db.models import Organization, Tenant
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_lookup import all_organization_ids, tenants_of_organization
from switch_core.operator_commands import database, run


@dataclass(frozen=True)
class WorkspaceListing:
    id: str
    name: str
    # People on its roster: members, and the organization's admins who are
    # not one (`UserStore.count_people`), as its page counts them.
    people: int
    archived: bool


@dataclass(frozen=True)
class OrganizationListing:
    id: str
    slug: str
    name: str
    admins: list[str]
    workspaces: list[WorkspaceListing]


async def list_organizations(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[OrganizationListing]:
    """Every organization, oldest first, each read on sessions of its own."""
    listings: list[OrganizationListing] = []
    for organization_id in await all_organization_ids(session_factory):
        async with organization_session(session_factory, organization_id) as session:
            organization = await session.get(Organization, organization_id)
            if organization is None:
                raise RuntimeError(f"Organization {organization_id} vanished")
            admins = sorted(
                user.email
                for user, member in await OrganizationStore().list_members(
                    session, organization_id
                )
                if member.role == ORGANIZATION_ADMIN_ROLE
            )
            slug, name = organization.slug, organization.name
        workspaces: list[WorkspaceListing] = []
        for tenant_id in await tenants_of_organization(
            session_factory, organization_id
        ):
            async with tenant_session(session_factory, tenant_id) as bound:
                tenant = await bound.get(Tenant, tenant_id)
                if tenant is None:
                    raise RuntimeError(f"Workspace {tenant_id} vanished")
                workspaces.append(
                    WorkspaceListing(
                        id=tenant.id,
                        name=tenant.name,
                        people=await UserStore().count_people(bound, tenant),
                        archived=tenant.archived_at is not None,
                    )
                )
        listings.append(
            OrganizationListing(
                id=organization_id,
                slug=slug,
                name=name,
                admins=admins,
                workspaces=sorted(workspaces, key=lambda w: (w.name.casefold(), w.id)),
            )
        )
    return listings


def print_organizations(listings: list[OrganizationListing]) -> None:
    for listing in listings:
        print(f"{listing.name} (slug {listing.slug}, id {listing.id})")
        print(f"  Organization admins: {', '.join(listing.admins) or '(none)'}")
        print(f"  Workspaces ({len(listing.workspaces)}):")
        for workspace in listing.workspaces:
            archived = ", archived" if workspace.archived else ""
            people = "person" if workspace.people == 1 else "people"
            print(
                f"    {workspace.id}  {workspace.name}  "
                f"({workspace.people} {people}{archived})"
            )
    print(f"{len(listings)} organization(s)")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="switch-orgs",
        description=(
            "The organizations on this Switch deployment, for its platform "
            "operator. Run it where switch-core runs, with the same "
            "configuration."
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "list",
        help="every organization, its admins' e-mails and its workspaces",
        description=(
            "Print every organization: its id, slug and name, its "
            "organization admins' e-mail addresses, and its workspaces with "
            "their ids, names and how many people each has. Changes nothing."
        ),
    )
    return parser


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    assert arguments.command == "list"
    # Every read names its organization or workspace, so it keeps to it on
    # any connection, the policies' or not.
    async with database(config, restricted=False) as session_factory:
        print_organizations(await list_organizations(session_factory))
    return 0


def main() -> None:
    run(_parser(), _run)
