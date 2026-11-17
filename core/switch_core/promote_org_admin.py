"""`switch-promote-org-admin`: break-glass, for when an organization's admins
can't make someone an admin themselves (`operator_commands.py`).

`switch-promote-org-admin ORGANIZATION EMAIL --reason TEXT` makes the person
with EMAIL an `org_admin` of ORGANIZATION (its id or slug). They must already
be a member of one of its workspaces: someone outside the organization is
invited first, by one of its workspaces' admins. Without `--execute` it only
says what would happen.

The change is recorded in the organization's own audit log as a role change
made on platform access, with the reason, where its admins read it; and every
`org_admin` of the organization, the new one included, is e-mailed
(`organization_admin_notices.py`). An organization whose members come from
WorkOS keeps its admins there, so it is refused: make them an admin in the
organization's WorkOS account instead.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.bridges.agent.registration_bootstrap import (
    SERVICE_ACCOUNT_ADMIN_REFUSAL,
    is_bootstrap_owner,
)
from switch_core.config import SwitchConfig
from switch_core.db.audit import (
    PLATFORM_OPERATOR_COMMAND,
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import Organization, OrganizationMember, User
from switch_core.db.session_scope import organization_session
from switch_core.db.tenant_lookup import all_organization_ids
from switch_core.gateway.auth import workspaces_in_organization
from switch_core.operator_commands import (
    CommandRefused,
    account_by_email,
    admin_notices,
    database,
    run,
)
from switch_core.organization_admin_notices import (
    AdminChange,
    AdminChangeKind,
    OrganizationAdminNotices,
    Person,
)


@dataclass(frozen=True)
class Promotion:
    """Making `user` an `org_admin` of `organization_id`: what they are there
    now (None for no organization membership), and the workspaces of it they
    are in, by name."""

    organization_id: str
    organization_name: str
    user: User
    current_role: str | None
    workspaces: list[str]


async def find_organization(
    session_factory: async_sessionmaker[AsyncSession], reference: str
) -> Organization:
    """The organization `reference` names, by id or slug."""
    for organization_id in await all_organization_ids(session_factory):
        async with organization_session(session_factory, organization_id) as session:
            organization = await session.get(Organization, organization_id)
        if organization is not None and reference in (
            organization.id,
            organization.slug,
        ):
            return organization
    raise CommandRefused(f"No organization here has the id or slug {reference!r}.")


async def plan_promotion(
    session_factory: async_sessionmaker[AsyncSession],
    reference: str,
    email: str,
    reason: str,
) -> Promotion:
    """What promoting would do; refuses, before anything changes, whatever
    it can't."""
    if not reason.strip():
        raise CommandRefused("--reason must say why, for the organization's admins.")
    organization = await find_organization(session_factory, reference)
    if organization.workos_organization_id is not None:
        raise CommandRefused(
            f"{organization.name}'s admins are kept in its WorkOS account, which "
            "Switch follows. Make them an organization admin there."
        )
    user = await account_by_email(session_factory, email)
    if is_bootstrap_owner(user):
        raise CommandRefused(SERVICE_ACCOUNT_ADMIN_REFUSAL)
    workspaces = await workspaces_in_organization(
        session_factory, user.id, organization.id
    )
    if not workspaces:
        raise CommandRefused(
            f"{email} is in none of {organization.name}'s workspaces. Invite them "
            "to one of its workspaces first, then run this again."
        )
    async with organization_session(session_factory, organization.id) as session:
        member = await session.get(OrganizationMember, (organization.id, user.id))
    current = None if member is None else member.role
    if current == ORGANIZATION_ADMIN_ROLE:
        raise CommandRefused(
            f"{email} is already an organization admin of {organization.name}."
        )
    return Promotion(
        organization_id=organization.id,
        organization_name=organization.name,
        user=user,
        current_role=current,
        workspaces=sorted(tenant.name for tenant in workspaces),
    )


async def promote(
    session_factory: async_sessionmaker[AsyncSession],
    notices: OrganizationAdminNotices,
    promotion: Promotion,
    reason: str,
) -> None:
    """Make them `org_admin`, recorded in the organization's audit log as a
    role change on platform access with the reason, and e-mail its admins."""
    organization_id, user = promotion.organization_id, promotion.user
    async with organization_session(session_factory, organization_id) as session:
        member = await session.get(
            OrganizationMember, (organization_id, user.id), with_for_update=True
        )
        previous = None if member is None else member.role
        if previous == ORGANIZATION_ADMIN_ROLE:
            raise CommandRefused(
                f"{user.email} became an organization admin of "
                f"{promotion.organization_name} meanwhile."
            )
        if member is None:
            session.add(
                OrganizationMember(
                    organization_id=organization_id,
                    user_id=user.id,
                    role=ORGANIZATION_ADMIN_ROLE,
                )
            )
        else:
            member.role = ORGANIZATION_ADMIN_ROLE
        await record_organization_audit_event(
            session,
            organization_id=organization_id,
            actor_user_id=None,
            action=OrganizationAuditAction.ROLE_CHANGED,
            target_type="user",
            target_id=user.id,
            details={
                "from": previous,
                "to": ORGANIZATION_ADMIN_ROLE,
                "reason": reason,
                "platform_access": True,
                PLATFORM_OPERATOR_COMMAND: True,
            },
        )
        await session.commit()
    await notices.send(
        AdminChange(
            organization_id=organization_id,
            kind=AdminChangeKind.PROMOTED_BY_OPERATOR,
            target=Person(user.id, user.name, user.email),
            actor=None,
            reason=reason,
        )
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="switch-promote-org-admin",
        description=(
            "Break-glass: make someone an organization admin when the "
            "organization's admins can't, for example when none is left who "
            "can sign in. They must already be a member of one of the "
            "organization's workspaces. The change goes in the organization's "
            "own audit log as made by a platform operator, with your reason, "
            "and its organization admins are e-mailed. Without --execute it "
            "only says what would happen. Run it where switch-core runs, with "
            "the same configuration."
        ),
    )
    parser.add_argument("organization", help="the organization's id or slug")
    parser.add_argument("email", help="the e-mail of the person to promote")
    parser.add_argument(
        "--reason",
        required=True,
        help="why, which the organization's admins read in its audit log",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="make the change. Without this, only show what would happen.",
    )
    return parser


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    try:
        async with database(config, restricted=False) as session_factory:
            promotion = await plan_promotion(
                session_factory,
                arguments.organization,
                arguments.email,
                arguments.reason,
            )
            user = promotion.user
            print(
                f"{user.name} ({user.email}), now "
                f"{promotion.current_role or 'in no organization role'} of "
                f"{promotion.organization_name} ({promotion.organization_id}), in "
                f"its workspaces {', '.join(promotion.workspaces)}."
            )
            if not arguments.execute:
                print(
                    "Would make them an organization admin, recorded in the "
                    "organization's audit log as platform access with your "
                    "reason, and e-mail its organization admins. Nothing "
                    "changed. Add --execute to do it."
                )
                return 0
            await promote(
                session_factory,
                admin_notices(config, session_factory),
                promotion,
                arguments.reason,
            )
            print(f"{user.email} is now an organization admin.")
    except CommandRefused as refused:
        print(f"Refused: {refused}", file=sys.stderr)
        return 1
    return 0


def main() -> None:
    run(_parser(), _run)
