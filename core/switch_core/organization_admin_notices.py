"""Telling an organization's admins when someone stops being one of them, or
is made one by a platform operator.

Once the change has committed, every `org_admin` of the organization is
e-mailed, and so is the person it was made to: who made it (or that they
made it themselves), whom it was made to, the organization, when, and a link
to the organization's audit log, which records each of these changes.

Sent through the relay invitations go through (`gateway/invite_mail.py`,
`GATEWAY_SMTP_*`). A deployment without one sends nothing and logs a warning
for each change. Anything that goes wrong sending, from reading who the
admins are to the relay, is logged as an error with the change's ids and
fails nothing: the change has already committed.

Covered: an `org_admin` made a member by another, or stepping down; an
`org_admin` removed from the organization, or leaving it; an `org_admin`'s
account deleted, by them, by the operator, or with `switch-accounts delete`;
and `switch-promote-org-admin`. Not covered: a change brought in from a
directory kept outside Switch (`organization_mirror.py`), which writes
through code of its own and is recorded in the audit log as coming from
there.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.authz import ORGANIZATION_ADMIN_ROLE
from switch_core.db.models import Organization
from switch_core.db.session_scope import organization_session
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.gateway.invite_mail import AdminChangeEmail, InviteMailer

logger = logging.getLogger(__name__)

AUDIT_LOG_PATH = "/settings/org/audit-log"


class AdminChangeKind(StrEnum):
    # Another `org_admin` made them a member.
    DEMOTED = "demoted"
    # They made themselves a member.
    STEPPED_DOWN = "stepped_down"
    # Another `org_admin` removed them from the organization.
    REMOVED = "removed"
    # They removed themselves from the organization.
    LEFT = "left"
    # Their account was deleted, which takes their `org_admin` rows with it.
    ACCOUNT_DELETED = "account_deleted"
    # A platform operator made them `org_admin` (`switch-promote-org-admin`).
    PROMOTED_BY_OPERATOR = "promoted_by_operator"


@dataclass(frozen=True)
class Person:
    user_id: str
    name: str
    email: str

    def __str__(self) -> str:
        return f"{self.name} ({self.email})"


@dataclass(frozen=True)
class AdminChange:
    organization_id: str
    kind: AdminChangeKind
    target: Person
    # Who made it; None for a platform operator's server command, which has
    # no account behind it.
    actor: Person | None
    # Why, where the one who made it had to say (`switch-promote-org-admin`).
    reason: str | None


def _who(actor: Person | None) -> str:
    return (
        "A platform operator, with a server command," if actor is None else str(actor)
    )


def describe(change: AdminChange, organization: str) -> tuple[str, str]:
    """The subject and the one-sentence summary of `change` in the
    organization named `organization`."""
    target = change.target
    no_longer = f"{target.name} is no longer an organization admin of {organization}"
    match change.kind:
        case AdminChangeKind.DEMOTED:
            return no_longer, (
                f"{_who(change.actor)} made {target} a member of {organization}, "
                "so they are no longer an organization admin there."
            )
        case AdminChangeKind.STEPPED_DOWN:
            return no_longer, (
                f"{target} stepped down as an organization admin of {organization}."
            )
        case AdminChangeKind.REMOVED:
            return no_longer, (
                f"{_who(change.actor)} removed {target} from {organization}, "
                "where they were an organization admin."
            )
        case AdminChangeKind.LEFT:
            return no_longer, (
                f"{target} left {organization}, where they were an organization admin."
            )
        case AdminChangeKind.ACCOUNT_DELETED:
            if change.actor is not None and change.actor.user_id == target.user_id:
                deleted = f"{target} deleted their Switch account"
            else:
                deleted = f"{_who(change.actor)} deleted the Switch account of {target}"
            return no_longer, (
                f"{deleted}, so they are no longer an organization admin of "
                f"{organization}."
            )
        case AdminChangeKind.PROMOTED_BY_OPERATOR:
            return (
                f"{target.name} was made an organization admin of {organization}",
                f"{_who(change.actor)} made {target} an organization admin of "
                f"{organization}, without an organization admin doing so.",
            )


@dataclass(frozen=True)
class OrganizationAdminNotices:
    session_factory: async_sessionmaker[AsyncSession]
    # None when no SMTP relay is configured.
    mailer: InviteMailer | None
    dashboard_base_url: str | None

    async def send(self, change: AdminChange) -> None:
        """E-mail `change`, which has committed, to the organization's
        `org_admin`s as they now stand and to the person it was made to.
        Never raises: a failure is logged, with the change's ids rather than
        anyone's address, and the change stands."""
        try:
            await self._send(change)
        except Exception:
            logger.exception(
                "User %s's change in organization %s (%s) committed, but its "
                "e-mails were not sent",
                change.target.user_id,
                change.organization_id,
                change.kind.value,
            )

    async def send_all(self, changes: list[AdminChange]) -> None:
        """`send` each of `changes`, in turn."""
        for change in changes:
            await self.send(change)

    async def _send(self, change: AdminChange) -> None:
        occurred_at = datetime.now(UTC)
        async with organization_session(
            self.session_factory, change.organization_id
        ) as session:
            organization = await session.get(Organization, change.organization_id)
            if organization is None:
                raise RuntimeError(
                    f"Organization {change.organization_id} is not visible here"
                )
            name = organization.name
            admins = [
                user.email
                for user, member in await OrganizationStore().list_members(
                    session, change.organization_id
                )
                if member.role == ORGANIZATION_ADMIN_ROLE
            ]
        if self.mailer is None:
            logger.warning(
                "User %s's change in organization %s (%s) was not e-mailed to its "
                "organization admins: no SMTP relay is configured "
                "(GATEWAY_SMTP_HOST). Its audit log records the change.",
                change.target.user_id,
                change.organization_id,
                change.kind.value,
            )
            return
        if self.dashboard_base_url is None:
            raise RuntimeError(
                "An SMTP relay is configured but the dashboard has no address to "
                "link to (FRONTEND_BASE_URL)"
            )
        subject, summary = describe(change, name)
        recipients: dict[str, str] = {}
        for email in [*admins, change.target.email]:
            recipients.setdefault(email.lower(), email)
        link = self.dashboard_base_url.rstrip("/") + AUDIT_LOG_PATH
        await asyncio.gather(
            *(
                self._send_one(
                    change,
                    AdminChangeEmail(
                        to=to,
                        subject=subject,
                        summary=summary,
                        occurred_at=occurred_at,
                        reason=change.reason,
                        audit_log_link=link,
                    ),
                )
                for to in recipients.values()
            )
        )

    async def _send_one(self, change: AdminChange, email: AdminChangeEmail) -> None:
        """One recipient's e-mail; a failure is logged, and the others are
        sent all the same."""
        assert self.mailer is not None
        try:
            await self.mailer.send_admin_change(email)
        except Exception:
            logger.exception(
                "User %s's change in organization %s (%s) committed, but its "
                "e-mail to one of the people told was not sent",
                change.target.user_id,
                change.organization_id,
                change.kind.value,
            )
