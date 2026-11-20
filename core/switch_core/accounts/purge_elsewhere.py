"""What a purged organization leaves outside Switch's database:

- **Switch Trust**, which holds the messages it checked under their room
  ids. Each of the purged workspaces' rooms is sent for deletion when the
  organization connected a Switch Trust policy, with that policy's own
  endpoint and key; the deletion call is provisional until Switch Trust
  publishes one (`HttpTrustClient.delete_session`). The organization's
  settings go with its rows, so this runs before the purge deletes
  anything (`erase_at_trust`, between `OrganizationPurge.prepare` and
  `delete`), and a deletion that fails stops the purge there, to be
  retried by running it again. A run resumed after an earlier one deleted
  the organization has no settings left to erase with: it lists the room
  sessions for a person to have deleted at Switch Trust.
- **WorkOS** (`workos_offboarding.py`), with the server's `WORKOS_API_KEY`,
  once the purge has deleted the organization's rows (`run`). A WorkOS user
  is deleted only where no account here signs in as it any more and no
  other product in the environment uses it. Without the key, nothing at
  WorkOS changes and the outcome lists what is left there.

Both run on every run of the purge, the resumed ones included, from what
the plan and the records of earlier runs name: a deletion already done
answers 404, which counts as done. Each run records what it did in the
server's audit log.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy import or_, select

from switch_core.accounts.workos_offboarding import WorkOSOffboarding, WorkOSSteps
from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import OidcIdentity, ServerAuditEvent
from switch_core.trust.client import TrustDeletionError, TrustSessionEraser

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
class TrustErasure:
    """What Switch Trust was asked to delete, before the purge deletes
    anything."""

    # False when the organization connected no Switch Trust policy, or its
    # settings were already gone (`settings_gone`).
    configured: bool
    # True on a run resumed after the organization's rows, its Switch Trust
    # settings among them, were deleted: this tool can no longer delete what
    # Switch Trust holds for its rooms, which is left for a person.
    settings_gone: bool = False
    deleted: int = 0
    # Deleted at Switch Trust by an earlier run, on a run resumed after the
    # organization's rows went: nothing is left to do for them.
    deleted_earlier: int = 0
    failed: list[tuple[str, str]] = field(default_factory=list)
    # What is left at Switch Trust for a person; set with `settings_gone`.
    left_by_hand: list[str] = field(default_factory=list)


@dataclass
class ElsewhereOutcome:
    # What was done at WorkOS; None on a server with no WorkOS API key.
    workos: WorkOSSteps | None
    # What is left at WorkOS for a person; set when `workos` is None.
    workos_leftover: WorkOSLeftover | None
    trust: TrustErasure

    @property
    def failed(self) -> bool:
        """Whether something outside failed, so running again is needed."""
        return bool(self.trust.failed) or bool(
            self.workos is not None and self.workos.failures
        )

    @property
    def left_by_hand(self) -> bool:
        """Whether something at WorkOS or Switch Trust is left for a person
        to remove."""
        return self.trust.settings_gone or (
            self.workos_leftover is not None and not self.workos_leftover.empty
        )


@dataclass
class PurgeElsewhere:
    session_factory: async_sessionmaker[AsyncSession]
    # None on a server with no WorkOS API key.
    workos: WorkOSOffboarding | None
    # The Switch Trust client the purged organization's own settings made,
    # read before the purge deleted them; None when it connected no policy
    # or, on a resumed run, its settings were already gone.
    trust: TrustSessionEraser | None
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

    async def erase_at_trust(self, plan: PurgePlan, request: str) -> TrustErasure:
        """Have Switch Trust delete every room session of the plan, and
        record it. Call before the purge deletes anything, and go on to
        delete only when nothing is in `failed`."""
        erasure = TrustErasure(configured=False)
        erased: list[str] = []
        eraser = self.trust
        if eraser is None:
            if plan.resuming and plan.trust_sessions:
                await self._after_settings_went(plan, erasure)
        else:
            erasure.configured = True
            for session_id in plan.trust_sessions:
                try:
                    await eraser.delete_session(session_id)
                except TrustDeletionError as error:
                    logger.error(
                        "Switch Trust did not delete session %s: %s", session_id, error
                    )
                    erasure.failed.append((session_id, str(error)))
                    continue
                erased.append(session_id)
            erasure.deleted = len(erased)
        async with self.session_factory() as session:
            await record_server_audit_event(
                session,
                actor_user_id=None,
                action=ServerAuditAction.ORGANIZATION_PURGE_TRUST,
                target_type="organization",
                target_id=plan.organization_id,
                details={
                    "configured": erasure.configured,
                    "settings_gone": erasure.settings_gone,
                    "sessions": len(plan.trust_sessions),
                    "sessions_deleted": erasure.deleted,
                    "sessions_erased": erased,
                    "sessions_failed": [s for s, _ in erasure.failed],
                    "sessions_left_by_hand": erasure.left_by_hand,
                    "request": request,
                },
            )
            await session.commit()
        return erasure

    async def _after_settings_went(
        self, plan: PurgePlan, erasure: TrustErasure
    ) -> None:
        """On a run resumed after the organization's rows, its Switch Trust
        settings among them, went: what earlier runs recorded erasing there
        is done, and the rest can no longer be erased by the purge. An
        organization an earlier run found with no policy had nothing there."""
        async with self.session_factory() as session:
            records = list(
                await session.scalars(
                    select(ServerAuditEvent.details).where(
                        ServerAuditEvent.action
                        == ServerAuditAction.ORGANIZATION_PURGE_TRUST,
                        ServerAuditEvent.target_id == plan.organization_id,
                    )
                )
            )
        earlier = [record or {} for record in records]
        if any(
            not record.get("configured") and not record.get("settings_gone")
            for record in earlier
        ):
            return
        done = {
            session_id
            for record in earlier
            for session_id in record.get("sessions_erased", [])
        }
        erasure.deleted_earlier = len(done & set(plan.trust_sessions))
        erasure.configured = erasure.deleted_earlier > 0
        erasure.left_by_hand = [s for s in plan.trust_sessions if s not in done]
        if not erasure.left_by_hand:
            return
        logger.warning(
            "Organization %s's Switch Trust settings were deleted with it by an "
            "earlier run; %d room session(s) it may have left at Switch Trust "
            "can no longer be deleted by the purge",
            plan.organization_id,
            len(erasure.left_by_hand),
        )
        erasure.settings_gone = True

    async def run(
        self, plan: PurgePlan, request: str, trust: TrustErasure
    ) -> ElsewhereOutcome:
        """Take out of WorkOS what the purged organization left there, as far
        as it will go now, and record it. Call once Switch's side is done,
        with what `erase_at_trust` did before it."""
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
        outcome = ElsewhereOutcome(workos=workos, workos_leftover=leftover, trust=trust)
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
            await session.commit()
