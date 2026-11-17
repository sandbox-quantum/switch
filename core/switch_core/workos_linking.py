"""`switch-link-workos`: what an operator links by hand when a server moves to
the WorkOS directory (`workos_directory.py`).

- `switch-link-workos organization ORGANIZATION_ID WORKOS_ORGANIZATION_ID
  [--replace]` makes a Switch organization follow one WorkOS organization.
  From then on its members are brought in from that organization when they
  sign in, and its `org_admin`s are its Org Admins. Nothing a WorkOS
  organization says about itself links it, so this is the only way one is
  linked. `--replace` re-links one that follows another, for a server moving
  to another WorkOS environment.
- `switch-link-workos accounts [--apply] [--from-issuer ISSUER]` links
  existing accounts to their WorkOS users. Signing in through WorkOS never
  joins an existing account by address (`UserStore.get_or_create_oidc_user`),
  so without this an account that signed in some other way before is refused.
  With `--from-issuer`, an account that signs in under that issuer (the
  server's sign-in before a move, such as a WorkOS Connect application before
  AuthKit) is linked to the same WorkOS user where the environment has it,
  its identity there copied, not moved. Any other account is linked only when
  exactly one WorkOS user has its address, verified, and that user is linked
  to no other account. Every account is reported, and without `--apply`
  nothing is written.

Both need `WORKOS_API_KEY` and the gateway's sign-in configured against the
WorkOS environment, as the server does: run them with the settings the server
signs in with after the move.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import exists, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import WORKOS_IDENTITY_ISSUER, SwitchConfig
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
    *,
    replace: bool,
) -> str:
    """Make `organization_id` follow `workos_organization_id`, and say what
    was done. Records the WorkOS organization's customer as
    `customer_id` where it names one.

    An organization following another WorkOS organization is refused, unless
    `replace`: for a server moving to another WorkOS environment, whose
    organizations have other ids there. The WorkOS mirror reads which
    organization each follows when a process starts, and a replaced link
    takes effect in each process as it next starts, which the move's own
    deploy does."""
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
        previous = organization.workos_organization_id
        if previous is not None and not replace:
            raise LinkingError(
                f"Organization {organization_id} already follows {previous}. "
                "Pass --replace to follow the new one instead, as when the "
                "server moves to another WorkOS environment."
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
                **(
                    {}
                    if previous is None
                    else {"replaced_workos_organization_id": previous}
                ),
            },
        )
        await session.commit()
    logger.warning(
        "Linked organization %s to WorkOS organization %s%s",
        organization_id,
        workos_organization_id,
        "" if previous is None else f" in place of {previous}",
    )
    replaced = (
        ""
        if previous is None
        else (
            f" in place of {previous}; each switch-core process follows it once "
            "it next starts"
        )
    )
    return (
        f"Organization {organization_id} now follows {workos_organization_id} "
        f"(customer {customer_id or 'not named'}){replaced}."
    )


@dataclass(frozen=True)
class AccountLink:
    """What linking one account did, or would do."""

    user_id: str
    email: str
    outcome: str
    linked: bool


# WorkOS's read limit is per environment, shared with every other product in
# it: a run of thousands of accounts must not take it all.
_PACE_SECONDS = 0.02


async def label_legacy_identities(
    session_factory: async_sessionmaker[AsyncSession], issuer: str, *, apply: bool
) -> int:
    """Name `issuer` on the identities stored before issuers were tracked
    (`iss` NULL), which can only be the server's one earlier generic sign-in's.
    Without it the copy below would miss them, and an AuthKit sign-in leaves
    them alone. Answers how many there are."""
    with no_tenant():
        async with session_factory() as session:
            legacy = await session.scalar(
                select(func.count())
                .select_from(OidcIdentity)
                .where(OidcIdentity.iss.is_(None))
            )
            if apply and legacy:
                await session.execute(
                    update(OidcIdentity)
                    .where(OidcIdentity.iss.is_(None))
                    .values(iss=issuer)
                )
                await session.commit()
    return int(legacy or 0)


async def link_accounts(
    session_factory: async_sessionmaker[AsyncSession],
    directory: WorkOSDirectory,
    user_store: UserStore,
    issuer: str,
    *,
    from_issuer: str | None,
    apply: bool,
) -> list[AccountLink]:
    """Link every account with no identity from `issuer` to its WorkOS user.
    Writes only when `apply`; each account in a transaction of its own, so a
    run stopped partway is finished by running it again.

    With `from_issuer`, an account signing in under that issuer is linked to
    the same WorkOS user, where this environment has it: the move from one
    sign-in to the other (a WorkOS Connect application to AuthKit, or back).
    Its identity there is copied, never moved, so the earlier sign-in still
    works. An account that has none there, or whose WorkOS user this
    environment does not have, is linked by address, as without it: when
    exactly one WorkOS user has the address, verified, and is linked to no
    other account."""
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
            earlier: dict[str, str] = {}
            if from_issuer is not None:
                earlier = {
                    user_id: sub
                    for user_id, sub in await session.execute(
                        select(OidcIdentity.user_id, OidcIdentity.sub).where(
                            OidcIdentity.iss == from_issuer
                        )
                    )
                }
        results: list[AccountLink] = []
        for user in users:
            async with session_factory() as session:
                results.append(
                    await _link_account(
                        session,
                        directory,
                        user_store,
                        issuer,
                        user,
                        earlier.get(user.id),
                        apply=apply,
                    )
                )
                if apply:
                    await session.commit()
            await asyncio.sleep(_PACE_SECONDS)
        return results


async def _link_account(
    session: AsyncSession,
    directory: WorkOSDirectory,
    user_store: UserStore,
    issuer: str,
    user: User,
    earlier_subject: str | None,
    *,
    apply: bool,
) -> AccountLink:
    def result(outcome: str, linked: bool = False) -> AccountLink:
        return AccountLink(user.id, user.email, outcome, linked)

    if earlier_subject is not None:
        workos_user = await directory.user(earlier_subject)
        if workos_user is not None:
            note = ""
            if str(workos_user.get("email", "")).lower() != user.email.lower():
                note = f"; WorkOS has its address as {workos_user.get('email')!r}"
            return await _link(
                session,
                user_store,
                issuer,
                user,
                earlier_subject,
                result,
                f"WorkOS user {earlier_subject} (as before)",
                note,
                apply=apply,
            )

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
    return await _link(
        session,
        user_store,
        issuer,
        user,
        subject,
        result,
        f"WorkOS user {subject}",
        "",
        apply=apply,
    )


async def _link(
    session: AsyncSession,
    user_store: UserStore,
    issuer: str,
    user: User,
    subject: str,
    result: Callable[[str, bool], AccountLink],
    which: str,
    note: str,
    *,
    apply: bool,
) -> AccountLink:
    holder = await user_store.get_by_oidc_identity(
        session, iss=issuer, sub=subject, match_legacy=False
    )
    if holder is not None:
        return result(f"{which} is linked to account {holder.id}{note}", False)
    if not apply:
        return result(f"would link {which}{note}", False)
    try:
        async with session.begin_nested():
            await user_store.link_oidc_identity(
                session, user=user, iss=issuer, sub=subject
            )
    except IntegrityError:
        # A sign-in linked it meanwhile, which a live server does.
        return result(f"{which} was linked meanwhile, by a sign-in{note}", False)
    return result(f"linked {which}{note}", True)


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
    organization.add_argument(
        "--replace",
        action="store_true",
        help=(
            "follow this WorkOS organization in place of the one it follows now, "
            "when the server moves to another WorkOS environment"
        ),
    )
    accounts = commands.add_parser(
        "accounts", help="link existing accounts to their WorkOS users"
    )
    accounts.add_argument(
        "--apply", action="store_true", help="write the links (default: report only)"
    )
    accounts.add_argument(
        "--from-issuer",
        help=(
            "link accounts that sign in under this issuer to the same WorkOS user "
            "first: the server's sign-in before the move"
        ),
    )
    return parser


async def _run(config: SwitchConfig, arguments: argparse.Namespace) -> int:
    issuer = config.identity_issuer
    if not config.workos_api_key or issuer is None:
        raise SystemExit(
            "switch-link-workos needs WORKOS_API_KEY and the gateway's sign-in "
            "(GATEWAY_SIGN_IN_PROVIDER=workos, or GATEWAY_OIDC_*) configured "
            "against the WorkOS environment."
        )
    engine = create_engine_from_config(config)
    try:
        async with guarded_async_client(config.outbound_policy) as http:
            # Linking reads WorkOS and changes nobody's membership there.
            directory = WorkOSDirectory(
                http,
                config.workos_api_key,
                config.workos_api_url,
                issuer,
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
                            replace=arguments.replace,
                        )
                    )
                    return 0
                from_issuer: str | None = arguments.from_issuer
                if from_issuer == issuer:
                    raise LinkingError(
                        f"--from-issuer is the issuer this server signs in under "
                        f"already ({issuer}); name the one it signed in under before."
                    )
                if from_issuer is not None and from_issuer != WORKOS_IDENTITY_ISSUER:
                    legacy = await label_legacy_identities(
                        session_factory, from_issuer, apply=arguments.apply
                    )
                    if legacy:
                        print(
                            f"{legacy} identities from before issuers were tracked "
                            + ("labelled" if arguments.apply else "would be labelled")
                            + f" {from_issuer}"
                        )
                links = await link_accounts(
                    session_factory,
                    directory,
                    UserStore(),
                    issuer,
                    from_issuer=from_issuer,
                    apply=arguments.apply,
                )
            except (LinkingError, DirectoryError) as error:
                print(error, file=sys.stderr)
                return 1
            for link in links:
                print(f"{link.user_id}\t{link.email}\t{link.outcome}")
            print(
                f"{sum(link.linked for link in links)} linked, "
                f"{len(links)} accounts without an identity from {issuer}"
                + ("" if arguments.apply else " (report only: pass --apply to link)")
            )
            return 0
    finally:
        await engine.dispose()


def main() -> None:
    config = SwitchConfig()
    raise SystemExit(asyncio.run(_run(config, _parser().parse_args())))
