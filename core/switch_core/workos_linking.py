"""`switch-link-workos`: what an operator links by hand when a server moves to
the WorkOS directory (`workos_directory.py`).

- `switch-link-workos organization ORGANIZATION_ID WORKOS_ORGANIZATION_ID`
  makes a Switch organization follow one WorkOS organization. From then on its
  members are brought in from that organization when they sign in, and its
  `org_admin`s are its Org Admins. Nothing a WorkOS organization says about
  itself links it, so this is the only way one is linked.
- `switch-link-workos accounts [--apply]` links existing accounts to their
  WorkOS users, by address. Signing in through WorkOS never joins an existing
  account by address (`UserStore.get_or_create_oidc_user`), so without this an
  account that signed in some other way before is refused. Each account is
  linked only when exactly one WorkOS user has its address, verified, and that
  user is linked to no other account. Every account is reported, and without
  `--apply` nothing is written.

Both need `WORKOS_API_KEY` and the gateway's OIDC sign-in configured against
the WorkOS environment, as the server does.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from dataclasses import dataclass

from sqlalchemy import exists, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.db.models import OidcIdentity, Organization, User
from switch_core.db.session_scope import organization_session
from switch_core.db.stores.user_store import UserStore
from switch_core.organization_directory import DirectoryError
from switch_core.outbound import guarded_async_client
from switch_core.tenant_context import no_tenant
from switch_core.workos_directory import WorkOSDirectory, customer_id_of

logger = logging.getLogger(__name__)


class LinkingError(Exception):
    """A link refused; the message says why, for the operator."""


async def link_organization(
    session_factory: async_sessionmaker[AsyncSession],
    directory: WorkOSDirectory,
    organization_id: str,
    workos_organization_id: str,
) -> str:
    """Make `organization_id` follow `workos_organization_id`, and say what
    was done. Records the WorkOS organization's customer as
    `customer_id` where it names one."""
    workos_organization = await directory.organization(workos_organization_id)
    customer_id = customer_id_of(workos_organization)
    async with organization_session(session_factory, organization_id) as session:
        organization = await session.get(Organization, organization_id)
        if organization is None:
            raise LinkingError(f"No organization {organization_id} here.")
        if organization.workos_organization_id == workos_organization_id:
            return (
                f"Organization {organization_id} already follows "
                f"{workos_organization_id}."
            )
        if organization.workos_organization_id is not None:
            raise LinkingError(
                f"Organization {organization_id} already follows "
                f"{organization.workos_organization_id}."
            )
        organization.workos_organization_id = workos_organization_id
        organization.customer_id = customer_id
        try:
            await session.flush()
        except IntegrityError as error:
            raise LinkingError(
                f"Another organization already follows {workos_organization_id}"
                + (f" or customer {customer_id}" if customer_id else "")
                + "."
            ) from error
        await record_organization_audit_event(
            session,
            organization_id=organization_id,
            actor_user_id=None,
            action=OrganizationAuditAction.LINKED_TO_DIRECTORY,
            target_type="organization",
            target_id=organization_id,
            details={
                "workos_organization_id": workos_organization_id,
                "customer_id": customer_id,
            },
        )
        await session.commit()
    logger.warning(
        "Linked organization %s to WorkOS organization %s",
        organization_id,
        workos_organization_id,
    )
    return (
        f"Organization {organization_id} now follows {workos_organization_id} "
        f"(customer {customer_id or 'not named'})."
    )


@dataclass(frozen=True)
class AccountLink:
    """What linking one account did, or would do."""

    user_id: str
    email: str
    outcome: str
    linked: bool


async def link_accounts(
    session_factory: async_sessionmaker[AsyncSession],
    directory: WorkOSDirectory,
    user_store: UserStore,
    issuer: str,
    *,
    apply: bool,
) -> list[AccountLink]:
    """Link every account with no identity from `issuer` to the WorkOS user
    with its address, where exactly one has it verified and is linked to no
    other account. Writes only when `apply`."""
    with no_tenant():
        async with session_factory() as session:
            users = list(
                await session.scalars(
                    select(User)
                    .where(
                        ~exists().where(
                            OidcIdentity.user_id == User.id, OidcIdentity.iss == issuer
                        )
                    )
                    .order_by(User.created_at, User.id)
                )
            )
            results: list[AccountLink] = []
            for user in users:
                results.append(
                    await _link_account(
                        session, directory, user_store, issuer, user, apply=apply
                    )
                )
            if apply:
                await session.commit()
            return results


async def _link_account(
    session: AsyncSession,
    directory: WorkOSDirectory,
    user_store: UserStore,
    issuer: str,
    user: User,
    *,
    apply: bool,
) -> AccountLink:
    def result(outcome: str, linked: bool = False) -> AccountLink:
        return AccountLink(user.id, user.email, outcome, linked)

    candidates = [
        workos_user
        for workos_user in await directory.users_with_email(user.email)
        if str(workos_user.get("email", "")).lower() == user.email.lower()
    ]
    if not candidates:
        return result("no WorkOS user has this address")
    if len(candidates) > 1:
        return result(f"{len(candidates)} WorkOS users have this address")
    workos_user = candidates[0]
    subject = workos_user.get("id")
    if not isinstance(subject, str) or not subject:
        return result("the WorkOS user has no id Switch can read")
    if workos_user.get("email_verified") is not True:
        return result(f"WorkOS user {subject} has not verified this address")
    holder = await user_store.get_by_oidc_identity(session, iss=issuer, sub=subject)
    if holder is not None:
        return result(f"WorkOS user {subject} is linked to account {holder.id}")
    if not apply:
        return result(f"would link WorkOS user {subject}")
    await user_store.link_oidc_identity(session, user=user, iss=issuer, sub=subject)
    return result(f"linked WorkOS user {subject}", linked=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="switch-link-workos",
        description="Link organizations and existing accounts to WorkOS.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    organization = commands.add_parser(
        "organization", help="make a Switch organization follow a WorkOS one"
    )
    organization.add_argument("organization_id")
    organization.add_argument("workos_organization_id")
    accounts = commands.add_parser(
        "accounts", help="link existing accounts to their WorkOS users by address"
    )
    accounts.add_argument(
        "--apply", action="store_true", help="write the links (default: report only)"
    )
    return parser


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    if not config.workos_api_key or not config.gateway_oidc_issuer_url:
        raise SystemExit(
            "switch-link-workos needs WORKOS_API_KEY and the gateway's OIDC "
            "sign-in (GATEWAY_OIDC_*) configured against the WorkOS environment."
        )
    engine = create_engine_from_config(config)
    try:
        async with guarded_async_client(config.outbound_policy) as http:
            # Linking reads WorkOS and changes nobody's membership there.
            directory = WorkOSDirectory(
                http,
                config.workos_api_key,
                config.workos_api_url,
                config.gateway_oidc_issuer_url,
                None,
            )
            session_factory = create_session_factory(engine)
            try:
                if arguments.command == "organization":
                    print(
                        await link_organization(
                            session_factory,
                            directory,
                            arguments.organization_id,
                            arguments.workos_organization_id,
                        )
                    )
                    return 0
                links = await link_accounts(
                    session_factory,
                    directory,
                    UserStore(),
                    config.gateway_oidc_issuer_url,
                    apply=arguments.apply,
                )
            except (LinkingError, DirectoryError) as error:
                print(error, file=sys.stderr)
                return 1
            for link in links:
                print(f"{link.user_id}\t{link.email}\t{link.outcome}")
            print(
                f"{sum(link.linked for link in links)} linked, "
                f"{len(links)} accounts without a WorkOS identity"
                + ("" if arguments.apply else " (report only: pass --apply to link)")
            )
            return 0
    finally:
        await engine.dispose()


def main() -> None:
    config = SwitchConfig()
    raise SystemExit(asyncio.run(_run(config, _parser().parse_args())))
