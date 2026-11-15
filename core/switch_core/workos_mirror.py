"""The directory mirror under `ORGANIZATION_DIRECTORY=workos`: changes made
in WorkOS to a linked organization's members, applied in Switch
(`organization_mirror.apply_from_directory`).

- **Events.** WorkOS's Events API, polled every `POLL_INTERVAL_SECONDS` from
  the cursor in `directory_event_cursors`, rather than webhooks: ordered,
  resumable, and with no public endpoint or signing secret. An event is only
  a prompt: applying it re-reads the person's current membership from
  WorkOS, so events read out of order, twice, or after a later change all
  end in the same state.
- **Failures.** An event that fails to apply stops the pass, and the next
  pass tries it again, up to `MAX_EVENT_ATTEMPTS` times. Then it is passed
  over and its organization is re-checked in full on every pass until that
  succeeds, so a removal waits on the failure, not on the next daily check.
  An event Switch can't read is logged and passed over.
- **The daily check.** Every `CHECK_INTERVAL_SECONDS`, and when the mirror
  starts, each linked organization's members in WorkOS are compared with
  Switch's and the differences applied: the backstop for events missed or
  from before the mirror ran. One member or organization failing doesn't
  stop the rest; an organization with a failure is re-checked on every pass.
  A Switch member with no WorkOS identity can't be compared, and is logged
  and left.
- **Where the events are read from.** Until the first event, from when the
  mirror started, moved forward on every empty pass so it stays inside what
  WorkOS keeps (90 days). If WorkOS refuses the cursor anyway (the mirror
  was stopped for longer), the mirror starts again from now, says so in the
  log and the server's audit log, and checks every organization in full.

People are matched to WorkOS users by the sign-in identity linking them
(`oidc_identities`, the gateway's issuer and their WorkOS user id). Someone
WorkOS lists who has never signed in to Switch has no account to add, and is
brought in when they first sign in.

One process runs it (`ownership.py`, kind `workos_mirror`), under the fence
it was started with: each change and each move of the cursor is made only
while that hold is still this process's, so a holder taken over without
knowing it stops rather than writing beside the new one.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import exists, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import (
    OrganizationAuditAction,
    OrganizationIssueKind,
    ServerAuditAction,
    record_organization_audit_event,
    record_server_audit_event,
)
from switch_core.db.models import (
    DirectoryEventCursor,
    OidcIdentity,
    Organization,
    OrganizationMember,
    OwnershipLease,
)
from switch_core.db.session_scope import organization_session
from switch_core.db.stores.ownership_lease_store import OwnershipLeaseStore
from switch_core.db.tenant_lookup import directory_organizations
from switch_core.organization_mirror import MirrorDependencies, apply_from_directory
from switch_core.ownership import Fence, OwnedKind, Ownership
from switch_core.tenant_context import no_tenant
from switch_core.workos_directory import EventCursorRejected, WorkOSDirectory

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 30.0
CHECK_INTERVAL_SECONDS = 24 * 3600.0
MAX_EVENT_ATTEMPTS = 5
# How far back an empty pass leaves where the events are read from, so an
# event WorkOS records a little after the time it carries is not missed.
# Reading one twice changes nothing.
_START_OVERLAP = timedelta(minutes=5)
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


class TakenOver(Exception):
    """The fence the mirror runs under is no longer this process's."""


class WorkOSMirror:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        directory: WorkOSDirectory,
        dependencies: MirrorDependencies,
        leases: OwnershipLeaseStore,
        issuer: str,
    ) -> None:
        self._session_factory = session_factory
        self._directory = directory
        self._dependencies = dependencies
        self._leases = leases
        self._issuer = issuer
        self._attempts: dict[str, int] = {}
        # Organizations to check in full on every pass until that succeeds.
        self._recheck: set[str] = set()
        # The linked organizations as of the last pass, and the WorkOS
        # organization each follows, read again only when they change.
        self._linked_now: dict[str, str] | None = None

    async def poll_once(self, fence: Fence) -> int:
        """Re-check what is due, then apply the events since the cursor, page
        by page, moving the cursor past each one. Returns how many events
        were read."""
        cursor = await self._cursor()
        linked = await self._linked()
        if self._recheck:
            await self._check_all(fence, linked, only=set(self._recheck))
        polled_at = datetime.now(UTC)
        try:
            events = await self._directory.events(
                EVENT_TYPES,
                after=cursor.after,
                range_start=cursor.started_at,
            )
        except EventCursorRejected as error:
            await self._restart(fence, cursor, error.message)
            return 0
        if not events:
            if cursor.after is None:
                await self._write_cursor(
                    fence, started_at=polled_at - _START_OVERLAP, after=None
                )
            return 0
        following = {workos: own for own, workos in linked.items()}
        read = 0
        after = cursor.after
        while events:
            page_from = after
            for event in events:
                event_id = event.get("id")
                if not isinstance(event_id, str):
                    logger.error(
                        "WorkOS sent an event with no id; passed over: %r", event
                    )
                    continue
                await self._apply_event_or_pass_over(fence, event_id, event, following)
                await self._write_cursor(fence, started_at=None, after=event_id)
                after = event_id
                read += 1
            # A page with no event to move past would be asked for again,
            # and again: leave it to the next pass.
            if after is None or after == page_from:
                return read
            events = await self._directory.events(
                EVENT_TYPES, after=after, range_start=cursor.started_at
            )
        return read

    async def check_once(self, fence: Fence) -> None:
        """Compare every linked organization's members with WorkOS's, and
        apply the differences."""
        await self._check_all(fence, await self._linked(), only=None)

    async def run(self, fence: Fence) -> None:
        """Poll the events every `POLL_INTERVAL_SECONDS`, and check every
        organization when starting and every `CHECK_INTERVAL_SECONDS`, until
        the fence is lost."""
        with no_tenant():
            since_check = CHECK_INTERVAL_SECONDS
            while True:
                try:
                    if since_check >= CHECK_INTERVAL_SECONDS:
                        since_check = 0.0
                        await self._logged(self.check_once(fence), "daily check")
                    await self._logged(self.poll_once(fence), "events")
                except TakenOver:
                    logger.warning(
                        "WorkOS mirror stopped: another process holds it now"
                    )
                    return
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
                since_check += POLL_INTERVAL_SECONDS

    @staticmethod
    async def _logged(work: Awaitable[Any], what: str) -> None:
        try:
            await work
        except TakenOver:
            raise
        except Exception:
            logger.exception("WorkOS mirror %s failed; trying again later", what)

    async def _apply_event_or_pass_over(
        self,
        fence: Fence,
        event_id: str,
        event: dict[str, Any],
        following: dict[str, str],
    ) -> None:
        try:
            await self._apply_event(fence, event, following)
        except TakenOver:
            raise
        except Exception:
            attempts = self._attempts.get(event_id, 0) + 1
            if attempts < MAX_EVENT_ATTEMPTS:
                self._attempts[event_id] = attempts
                raise
            self._attempts.pop(event_id, None)
            organization_id = following.get(_organization_named(event) or "")
            logger.exception(
                "WorkOS event %s failed %d times; passed over, and organization "
                "%s is checked in full until that succeeds",
                event_id,
                attempts,
                organization_id,
            )
            if organization_id is not None:
                self._recheck.add(organization_id)
        else:
            self._attempts.pop(event_id, None)

    async def _apply_event(
        self, fence: Fence, event: dict[str, Any], following: dict[str, str]
    ) -> None:
        data = event.get("data")
        kind = event.get("event")
        workos_organization_id = _organization_named(event)
        if not isinstance(data, dict) or not isinstance(kind, str):
            logger.error(
                "WorkOS sent an event Switch can't read; passed over: %r", event
            )
            return
        organization_id = following.get(workos_organization_id or "")
        if organization_id is None or workos_organization_id is None:
            return
        if kind == "organization.deleted":
            await self._organization_deleted(
                fence, organization_id, workos_organization_id
            )
            return
        subject = data.get("user_id")
        if not isinstance(subject, str):
            logger.error("WorkOS sent a membership event with no user; passed over")
            return
        user_id = (await self._users_of([subject])).get(subject)
        if user_id is None:
            return
        wanted = await self._directory.membership_role(subject, workos_organization_id)
        await self._ensure_held(fence)
        await apply_from_directory(
            self._session_factory,
            self._dependencies,
            organization_id=organization_id,
            workos_organization_id=workos_organization_id,
            user_id=user_id,
            wanted=wanted,
            source=FROM_EVENT,
        )

    async def _check_all(
        self, fence: Fence, linked: dict[str, str], only: set[str] | None
    ) -> None:
        for organization_id, workos_organization_id in linked.items():
            if only is not None and organization_id not in only:
                continue
            try:
                complete = await self._check(
                    fence, organization_id, workos_organization_id
                )
            except TakenOver:
                raise
            except Exception:
                logger.exception(
                    "Checking organization %s against WorkOS failed; checked "
                    "again on the next pass",
                    organization_id,
                )
                complete = False
            if complete:
                self._recheck.discard(organization_id)
            else:
                self._recheck.add(organization_id)
        # One unlinked since has nothing left to check.
        self._recheck &= set(linked)

    async def _check(
        self, fence: Fence, organization_id: str, workos_organization_id: str
    ) -> bool:
        """Apply where Switch's members differ from WorkOS's. Returns whether
        every difference was applied; one that fails is logged and the rest
        go ahead."""
        in_workos = await self._directory.organization_members(workos_organization_id)
        async with organization_session(
            self._session_factory, organization_id
        ) as session:
            rows = await session.execute(
                select(OrganizationMember.user_id, OrganizationMember.role).where(
                    OrganizationMember.organization_id == organization_id
                )
            )
            in_switch = {user_id: role for user_id, role in rows}
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
        complete = True
        for user_id, role in sorted(wanted.items()):
            if in_switch.get(user_id) == role:
                continue
            await self._ensure_held(fence)
            try:
                await apply_from_directory(
                    self._session_factory,
                    self._dependencies,
                    organization_id=organization_id,
                    workos_organization_id=workos_organization_id,
                    user_id=user_id,
                    wanted=role,
                    source=FROM_CHECK,
                )
            except Exception:
                logger.exception(
                    "Applying WorkOS's membership of user %s in organization %s failed",
                    user_id,
                    organization_id,
                )
                complete = False
        return complete

    async def _organization_deleted(
        self, fence: Fence, organization_id: str, workos_organization_id: str
    ) -> None:
        """Deleting a linked organization in WorkOS removes nobody here: that
        is too much to take away on one event. It is reported for an operator
        to unlink or remove."""
        logger.error(
            "WorkOS organization %s, which organization %s follows, was deleted; "
            "its members are left as they are",
            workos_organization_id,
            organization_id,
        )
        await self._ensure_held(fence)
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
                    "kind": OrganizationIssueKind.DIRECTORY_ORGANIZATION_DELETED,
                    "workos_organization_id": workos_organization_id,
                },
            )
            await session.commit()

    async def _restart(
        self, fence: Fence, cursor: DirectoryEventCursor, reason: str
    ) -> None:
        """Start the events again from now, and check every organization in
        full for what fell between."""
        logger.warning(
            "WorkOS refused the mirror's place in its events (after %s, from %s): "
            "%s; starting again from now and checking every organization",
            cursor.after,
            cursor.started_at.isoformat(),
            reason,
        )
        await self._write_cursor(fence, started_at=datetime.now(UTC), after=None)
        with no_tenant():
            async with self._session_factory() as session:
                await record_server_audit_event(
                    session,
                    actor_user_id=None,
                    action=ServerAuditAction.DIRECTORY_EVENTS_RESTARTED,
                    target_type="directory",
                    target_id=CURSOR_SOURCE,
                    details={
                        "after": cursor.after,
                        "started_at": cursor.started_at.isoformat(),
                        "reason": reason,
                    },
                )
                await session.commit()
        self._recheck |= set(await self._linked())

    async def _linked(self) -> dict[str, str]:
        """Each linked organization's WorkOS organization, by its id. Which
        organizations are linked is read on every pass, in one lookup; each
        one's WorkOS organization only when that list changes, one short
        session each, since an organization is readable only bound to it (a
        link is never changed in place: `workos_linking.py` refuses). An
        organization linked since the last pass is checked in full: an
        operator links it from another process, and its members would
        otherwise wait for the daily check."""
        ids = await directory_organizations(self._session_factory)
        if self._linked_now is not None and set(ids) == set(self._linked_now):
            return self._linked_now
        linked: dict[str, str] = {}
        for organization_id in ids:
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
        if self._linked_now is not None:
            self._recheck |= set(linked) - set(self._linked_now)
        self._linked_now = linked
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
                        source=CURSOR_SOURCE,
                        after=None,
                        started_at=datetime.now(UTC),
                    )
                    .on_conflict_do_nothing(index_elements=["source"])
                )
                await session.commit()
                cursor = await session.get(DirectoryEventCursor, CURSOR_SOURCE)
                assert cursor is not None
                session.expunge(cursor)
                return cursor

    async def _write_cursor(
        self, fence: Fence, *, started_at: datetime | None, after: str | None
    ) -> None:
        """Set the cursor to `after` (and `started_at`, when given), in one
        statement that writes only while `fence` holds."""
        values: dict[str, Any] = {"after": after, "updated_at": datetime.now(UTC)}
        if started_at is not None:
            values["started_at"] = started_at
        with no_tenant():
            async with self._session_factory() as session:
                written = await session.execute(
                    update(DirectoryEventCursor)
                    .where(DirectoryEventCursor.source == CURSOR_SOURCE, _holds(fence))
                    .values(**values)
                    .returning(DirectoryEventCursor.source)
                )
                if written.first() is None:
                    raise TakenOver()
                await session.commit()

    async def _ensure_held(self, fence: Fence) -> None:
        """Raise `TakenOver` unless `fence` is still this process's, before a
        change it must not make beside a new holder."""
        with no_tenant():
            async with self._session_factory() as session:
                held = await self._leases.held(
                    session,
                    kind=fence.kind,
                    tokens={fence.key: fence.token},
                    process_id=fence.process_id,
                )
        if fence.key not in held:
            raise TakenOver()


def _holds(fence: Fence) -> Any:
    return exists().where(
        OwnershipLease.kind == fence.kind,
        OwnershipLease.key == fence.key,
        OwnershipLease.token == fence.token,
        OwnershipLease.process_id == fence.process_id,
    )


def _organization_named(event: dict[str, Any]) -> str | None:
    """The WorkOS organization an event is about."""
    data = event.get("data")
    if not isinstance(data, dict):
        return None
    key = "id" if event.get("event") == "organization.deleted" else "organization_id"
    value = data.get(key)
    return value if isinstance(value, str) else None


def own_workos_mirror(ownership: Ownership, mirror: WorkOSMirror) -> OwnedKind:
    """Register the mirror as owned work, wanted by this process; it runs here
    only while it holds it."""
    running: dict[str, asyncio.Task[None]] = {}

    def launch(key: str, fence: Fence) -> None:
        task = asyncio.create_task(mirror.run(fence), name="workos-mirror")
        running[key] = task
        task.add_done_callback(lambda done: ended(key, fence, done))

    def ended(key: str, fence: Fence, task: asyncio.Task[None]) -> None:
        if task.cancelled() or running.get(key) is not task:
            return
        error = task.exception()
        if error is None:
            # Returned on its own: taken over, which the next balance settles.
            running.pop(key, None)
            return
        logger.error("WorkOS mirror stopped unexpectedly; restarting", exc_info=error)
        launch(key, fence)

    async def start(key: str, fence: Fence) -> None:
        launch(key, fence)

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
