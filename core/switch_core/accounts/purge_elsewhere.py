"""What a purged organization leaves outside Switch's database, taken out
after the purge has deleted its rows (`organization_purge.py`):

- **WorkOS** (`workos_offboarding.py`), with the server's `WORKOS_API_KEY`.
  A WorkOS user is deleted only where no account here signs in as it any
  more and no other product in the environment uses it. Without the key,
  nothing at WorkOS changes and the outcome lists what is left there.
- **Switch Trust**, which holds the messages it checked under their room
  ids. Each of the purged workspaces' rooms is sent for deletion when the
  server's Trust settings configure it; the deletion call is provisional
  until Switch Trust publishes one (`HttpTrustClient.delete_session`).

Both run on every run of the purge once Switch's side is done, the
resumed ones included, from what the plan and the records of earlier runs
name: a deletion already done answers 404, which counts as done. Each run
records what it did in the server's audit log.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy import or_, select

from switch_core.accounts.workos_offboarding import WorkOSOffboarding, WorkOSSteps
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import OidcIdentity
from switch_core.trust.client import (
    GuardrailsCheckError,
    TrustDeletionError,
    TrustSessionEraser,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.accounts.organization_purge import PurgePlan

logger = logging.getLogger(__name__)


@dataclass
class WorkOSLeftover:
    """What stays at WorkOS for a person to remove, on a server with no
    WorkOS API key."""

    organization: str | None
    # WorkOS user id to the account it was, for those Switch no longer uses.
    users: list[str]
    # Users Switch still uses: only their membership is to go.
    memberships_only: list[str]

    @property
    def empty(self) -> bool:
        return (
            self.organization is None and not self.users and not self.memberships_only
        )


@dataclass
class ElsewhereOutcome:
    # What was done at WorkOS; None on a server with no WorkOS API key.
    workos: WorkOSSteps | None
    # What is left at WorkOS for a person; set when `workos` is None.
    workos_leftover: WorkOSLeftover | None
    # False when the server's settings don't configure Switch Trust.
    trust_configured: bool
    trust_deleted: int = 0
    trust_failed: list[tuple[str, str]] = field(default_factory=list)

    @property
    def failed(self) -> bool:
        """Whether something outside failed, so running again is needed."""
        return bool(self.trust_failed) or bool(
            self.workos is not None and self.workos.failures
        )

    @property
    def left_by_hand(self) -> bool:
        """Whether something at WorkOS is left for a person to remove."""
        return self.workos_leftover is not None and not self.workos_leftover.empty


@dataclass
class PurgeElsewhere:
    session_factory: async_sessionmaker[AsyncSession]
    # None on a server with no WorkOS API key.
    workos: WorkOSOffboarding | None
    # The Switch Trust client the server's settings make now, or None when
    # they don't configure Switch Trust.
    trust: Callable[[], Awaitable[TrustSessionEraser | None]]
    # The issuer whose subjects `plan.workos_users` are, to tell whether an
    # account here still signs in as one.
    sign_in_issuer: str | None

    async def plan_workos(self, plan: PurgePlan) -> WorkOSSteps | None:
        """What the purge would do at WorkOS, read now; None without a key.
        Before the purge, the users Switch would stop using are those of
        accounts it deletes."""
        if self.workos is None:
            return None
        deleted = {account.id for account in plan.deleted_accounts}
        users = sorted(plan.workos_users)
        return await self.workos.plan(
            plan.workos_organization_id,
            users,
            {
                user_id
                for user_id in users
                if plan.workos_users[user_id] in deleted
                or not await self._signs_in(user_id)
            },
        )

    async def run(self, plan: PurgePlan, request: str) -> ElsewhereOutcome:
        """Take out of WorkOS and Switch Trust what the purged organization
        left there, as far as each will go now, and record it. Call once
        Switch's side is done."""
        users = sorted(plan.workos_users)
        unused = {user_id for user_id in users if not await self._signs_in(user_id)}
        if self.workos is None:
            workos = None
            leftover = WorkOSLeftover(
                organization=plan.workos_organization_id,
                users=sorted(unused),
                memberships_only=sorted(set(users) - unused),
            )
        else:
            workos = await self.workos.carry_out(
                plan.workos_organization_id, users, unused
            )
            leftover = None
        outcome = ElsewhereOutcome(
            workos=workos,
            workos_leftover=leftover,
            trust_configured=False,
        )
        await self._erase_at_trust(plan, outcome)
        await self._record(plan, request, outcome)
        return outcome

    async def _signs_in(self, user_id: str) -> bool:
        """Whether an account here still signs in as WorkOS user `user_id`:
        one the purge kept, one it failed to delete, or one made by the same
        person signing in again since."""
        async with self.session_factory() as session:
            return (
                await session.scalar(
                    select(OidcIdentity.id).where(
                        # A row from before issuers were recorded is the
                        # server's one sign-in too.
                        or_(
                            OidcIdentity.iss == self.sign_in_issuer,
                            OidcIdentity.iss.is_(None),
                        ),
                        OidcIdentity.sub == user_id,
                    )
                )
                is not None
            )

    async def _erase_at_trust(self, plan: PurgePlan, outcome: ElsewhereOutcome) -> None:
        try:
            eraser = await self.trust()
        except GuardrailsCheckError as error:
            outcome.trust_configured = True
            outcome.trust_failed = [
                (session_id, f"the Switch Trust settings could not be read: {error}")
                for session_id in plan.trust_sessions
            ]
            return
        if eraser is None:
            return
        outcome.trust_configured = True
        for session_id in plan.trust_sessions:
            try:
                await eraser.delete_session(session_id)
            except TrustDeletionError as error:
                logger.error(
                    "Switch Trust did not delete session %s: %s", session_id, error
                )
                outcome.trust_failed.append((session_id, str(error)))
                continue
            outcome.trust_deleted += 1

    async def _record(
        self, plan: PurgePlan, request: str, outcome: ElsewhereOutcome
    ) -> None:
        workos = outcome.workos
        workos_details: dict[str, object]
        if workos is None:
            assert outcome.workos_leftover is not None
            workos_details = {
                "configured": False,
                "left_by_hand": not outcome.workos_leftover.empty,
            }
        else:
            workos_details = {
                "configured": True,
                "memberships_removed": [m.id for m in workos.memberships],
                "users_deleted": workos.users_deleted,
                "users_kept": workos.users_kept,
                "organization_deleted": workos.organization_deleted,
                "organization_kept": workos.organization_kept,
                "failures": len(workos.failures),
            }
        async with self.session_factory() as session:
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.ORGANIZATION_PURGE_WORKOS,
                target_type="organization",
                target_id=plan.organization_id,
                details={
                    "workos_organization_id": plan.workos_organization_id,
                    **workos_details,
                    "request": request,
                },
            )
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.ORGANIZATION_PURGE_TRUST,
                target_type="organization",
                target_id=plan.organization_id,
                details={
                    "configured": outcome.trust_configured,
                    "sessions": len(plan.trust_sessions),
                    "sessions_deleted": outcome.trust_deleted,
                    "sessions_failed": [s for s, _ in outcome.trust_failed],
                    "request": request,
                },
            )
            await session.commit()
