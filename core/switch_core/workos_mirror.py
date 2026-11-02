"""The directory mirror under `ORGANIZATION_DIRECTORY=workos`: changes made
in WorkOS to a linked organization's members, applied in Switch
(`organization_mirror.apply_from_directory`).

- **Events.** WorkOS's Events API, polled every `POLL_INTERVAL_SECONDS` from
  the cursor in `directory_event_cursors`, rather than webhooks: ordered,
  resumable, and with no public endpoint or signing secret. An event is only
  a prompt: applying it re-reads the person's current membership from
  WorkOS, so events read out of order, twice, or after a later change all
  end in the same state. An event that fails to apply stops the pass, and the
  next pass starts again from it.
- **The daily check.** Every `CHECK_INTERVAL_SECONDS`, and when the mirror
  starts, each linked organization's members in WorkOS are compared with
  Switch's: the backstop for events missed (the Events API keeps 90 days) or
  from before the mirror ran. A Switch member with no WorkOS identity can't
  be compared, and is logged and left.

People are matched to WorkOS users by the sign-in identity linking them
(`oidc_identities`, the gateway's issuer and their WorkOS user id). Someone
WorkOS lists who has never signed in to Switch has no account to add, and is
brought in when they first sign in.

One process runs it (`ownership.py`, kind `workos_mirror`).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.connections.broker import ServiceError
from switch_core.db.audit import (
    OrganizationAuditAction,
    record_organization_audit_event,
)
from switch_core.db.models import (
    DirectoryEventCursor,
    OidcIdentity,
    Organization,
    OrganizationMember,
)
from switch_core.db.session_scope import organization_session
from switch_core.db.tenant_lookup import directory_organizations
from switch_core.organization_access import AccessRevocation
from switch_core.organization_directory import DirectoryUnavailable
from switch_core.organization_mirror import apply_from_directory
from switch_core.ownership import Fence, OwnedKind, Ownership
from switch_core.tenant_context import no_tenant
from switch_core.workos_directory import WorkOSDirectory

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 30.0
CHECK_INTERVAL_SECONDS = 24 * 3600.0
CURSOR_SOURCE = "workos"
EVENT_TYPES = (
    "organization_membership.created",
    "organization_membership.updated",
    "organization_membership.deleted",
    "organization.deleted",
)
FROM_EVENT = "directory_event"
FROM_CHECK = "daily_check"

MIRROR_KIND = "workos_mirror"
MIRROR_KEY = "all"


class WorkOSMirror:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        directory: WorkOSDirectory,
        revocation: AccessRevocation,
        issuer: str,
    ) -> None:
        self._session_factory = session_factory
        self._directory = directory
        self._revocation = revocation
        self._issuer = issuer

    async def poll_once(self) -> int:
        """Apply the events since the cursor, page by page, moving the cursor
        past each one applied. Returns how many were read."""
        cursor = await self._cursor()
        linked = await self._linked()
        read = 0
        after = cursor.after
        while True:
            events = await self._directory.events(
                EVENT_TYPES, after=after, range_start=cursor.started_at.isoformat()
            )
            if not events:
                return read
            for event in events:
                await self._apply_event(event, linked)
                after = event["id"]
                await self._advance(after)
                read += 1

    async def check_once(self) -> None:
        """Compare every linked organization's members with WorkOS's, and
        apply the difference. One organization failing doesn't stop the
        others."""
        for organization_id, workos_organization_id in (await self._linked()).items():
            try:
                await self._check(organization_id, workos_organization_id)
            except (DirectoryUnavailable, ServiceError) as error:
                logger.error(
                    "Daily check of organization %s against WorkOS stopped: %s",
                    organization_id,
                    error,
                )

    async def run(self) -> None:
        """Poll the events every `POLL_INTERVAL_SECONDS`, and check every
        organization when starting and every `CHECK_INTERVAL_SECONDS`."""
        with no_tenant():
            since_check = CHECK_INTERVAL_SECONDS
            while True:
                if since_check >= CHECK_INTERVAL_SECONDS:
                    since_check = 0.0
                    await self._logged(self.check_once(), "daily check")
                await self._logged(self.poll_once(), "events")
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
                since_check += POLL_INTERVAL_SECONDS

    @staticmethod
    async def _logged(work: Any, what: str) -> None:
        try:
            await work
        except (DirectoryUnavailable, ServiceError) as error:
            logger.error("WorkOS mirror %s: %s; trying again later", what, error)
        except Exception:
            logger.exception("WorkOS mirror %s failed; trying again later", what)

    async def _apply_event(self, event: dict[str, Any], linked: dict[str, str]) -> None:
        data = event["data"]
        following = {workos: own for own, workos in linked.items()}
        if event["event"] == "organization.deleted":
            organization_id = following.get(str(data.get("id")))
            if organization_id is not None:
                await self._organization_deleted(organization_id, data)
            return
        organization_id = following.get(str(data.get("organization_id")))
        subject = data.get("user_id")
        if organization_id is None or not isinstance(subject, str):
            return
        users = await self._users_of([subject])
        user_id = users.get(subject)
        if user_id is None:
            return
        wanted = await self._directory.membership_role(subject, linked[organization_id])
        await apply_from_directory(
            self._session_factory,
            self._revocation,
            organization_id=organization_id,
            user_id=user_id,
            wanted=wanted,
            source=FROM_EVENT,
        )

    async def _check(self, organization_id: str, workos_organization_id: str) -> None:
        in_workos = await self._directory.organization_members(workos_organization_id)
        async with organization_session(
            self._session_factory, organization_id
        ) as session:
            in_switch = set(
                await session.scalars(
                    select(OrganizationMember.user_id).where(
                        OrganizationMember.organization_id == organization_id
                    )
                )
            )
        users = await self._users_of(list(in_workos))
        subjects = await self._subjects_of(list(in_switch))
        wanted: dict[str, str | None] = {
            user_id: in_workos[subject] for subject, user_id in users.items()
        }
        for user_id in in_switch:
            subject = subjects.get(user_id)
            if subject is None:
                logger.error(
                    "User %s is in organization %s but has no WorkOS identity "
                    "to compare; left as they are",
                    user_id,
                    organization_id,
                )
                continue
            wanted.setdefault(user_id, in_workos.get(subject))
        for user_id, role in sorted(wanted.items()):
            await apply_from_directory(
                self._session_factory,
                self._revocation,
                organization_id=organization_id,
                user_id=user_id,
                wanted=role,
                source=FROM_CHECK,
            )

    async def _organization_deleted(
        self, organization_id: str, data: dict[str, Any]
    ) -> None:
        """Deleting a linked organization in WorkOS removes nobody here: that
        is too much to take away on one event. It is reported for an operator
        to unlink or remove."""
        logger.error(
            "WorkOS organization %s, which organization %s follows, was deleted; "
            "its members are left as they are",
            data.get("id"),
            organization_id,
        )
        async with organization_session(
            self._session_factory, organization_id
        ) as session:
            await record_organization_audit_event(
                session,
                organization_id=organization_id,
                actor_user_id=None,
                action=OrganizationAuditAction.DIRECTORY_CONFLICT,
                target_type="organization",
                target_id=organization_id,
                details={
                    "source": FROM_EVENT,
                    "kind": "directory_organization_deleted",
                },
            )
            await session.commit()

    async def _linked(self) -> dict[str, str]:
        """Each linked organization's WorkOS organization, by its id."""
        linked: dict[str, str] = {}
        for organization_id in await directory_organizations(self._session_factory):
            async with organization_session(
                self._session_factory, organization_id
            ) as session:
                workos_organization_id = await session.scalar(
                    select(Organization.workos_organization_id).where(
                        Organization.id == organization_id
                    )
                )
            if workos_organization_id is not None:
                linked[organization_id] = workos_organization_id
        return linked

    async def _users_of(self, subjects: list[str]) -> dict[str, str]:
        """The Switch account linked to each of WorkOS users `subjects` that
        has one."""
        if not subjects:
            return {}
        with no_tenant():
            async with self._session_factory() as session:
                rows = await session.execute(
                    select(OidcIdentity.sub, OidcIdentity.user_id).where(
                        OidcIdentity.iss == self._issuer,
                        OidcIdentity.sub.in_(subjects),
                    )
                )
                return {sub: user_id for sub, user_id in rows}

    async def _subjects_of(self, user_ids: list[str]) -> dict[str, str]:
        """The WorkOS user each of `user_ids` signs in as, where linked."""
        if not user_ids:
            return {}
        with no_tenant():
            async with self._session_factory() as session:
                rows = await session.execute(
                    select(OidcIdentity.user_id, OidcIdentity.sub).where(
                        OidcIdentity.iss == self._issuer,
                        OidcIdentity.user_id.in_(user_ids),
                    )
                )
                return {user_id: sub for user_id, sub in rows}

    async def _cursor(self) -> DirectoryEventCursor:
        """The cursor, made on the mirror's first run: events are read from
        then on, and the daily check covers what came before."""
        with no_tenant():
            async with self._session_factory() as session:
                await session.execute(
                    insert(DirectoryEventCursor)
                    .values(
                        source=CURSOR_SOURCE, after=None, started_at=datetime.now(UTC)
                    )
                    .on_conflict_do_nothing(index_elements=["source"])
                )
                await session.commit()
                cursor = await session.get(DirectoryEventCursor, CURSOR_SOURCE)
                assert cursor is not None
                return cursor

    async def _advance(self, after: str) -> None:
        with no_tenant():
            async with self._session_factory() as session:
                cursor = await session.get(DirectoryEventCursor, CURSOR_SOURCE)
                assert cursor is not None
                cursor.after = after
                cursor.updated_at = datetime.now(UTC)
                await session.commit()


def own_workos_mirror(ownership: Ownership, mirror: WorkOSMirror) -> OwnedKind:
    """Register the mirror as owned work, wanted by this process; it runs here
    only while it holds it."""
    running: dict[str, asyncio.Task[None]] = {}

    def launch(key: str) -> None:
        task = asyncio.create_task(mirror.run(), name="workos-mirror")
        running[key] = task
        task.add_done_callback(lambda done: ended(key, done))

    def ended(key: str, task: asyncio.Task[None]) -> None:
        if task.cancelled() or running.get(key) is not task:
            return
        logger.error(
            "WorkOS mirror stopped unexpectedly; restarting",
            exc_info=task.exception(),
        )
        launch(key)

    async def start(key: str, fence: Fence) -> None:
        launch(key)

    async def stop(key: str) -> None:
        task = running.pop(key, None)
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    kind = ownership.kind(MIRROR_KIND, start=start, stop=stop)
    kind.want(MIRROR_KEY)
    return kind
