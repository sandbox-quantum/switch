"""An operator's pause and a workspace admin's per-person switch.

Two marks, each checked by every path that could start, wake or reconnect a
box (`block_reason`):

- **Paused:** `users.hosted_paused_at`, user-wide, so it holds with no
  box and through a box row being replaced, and a sign-in's write to
  `users.metadata` can't clear it. The user's box, if any, is also stopped as
  `paused`, which no other stop replaces and nothing starts. Only an
  operator's resume clears both, leaving the box asleep (`idle`) so the next
  message wakes it.
- **Turned off (A2):** `tenant_members.hosted_enabled = false` for one person
  in one workspace. Only that workspace's part of the box stops; the box
  itself stops only when that workspace was its only one, or when the revoke
  couldn't be confirmed.

Revoking reuses Core's existing controller revocation, the path a re-enrolled
box takes today: the box controller is told `credential.revoked`, stops its
agents and exits, and its gateway tokens and launch tickets go with it. Core
issues no per-agent credentials, so there is nothing else to revoke. Resume
and turn-on need nothing special: the next message wakes the box, `prepare`
issues a fresh code, and enrolment moves the agents to the new controller.

Every action is audited first (the audit writer), and a failure there changes
nothing. A failure after it is recorded as `failed` at the step reached. If
Core stops part-way, `sweep_unfinished` records `failed` on the next start.

Known limit: the room line's once-an-hour is kept in each Core process's
memory, so a second Core process could post it again within the hour.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import time
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal, Protocol

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction, ServerAuditAction
from switch_core.db.models import (
    AgentController,
    CloudMachine,
    ServerAuditEvent,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.hosted_machine_store import (
    CloudMachineStore,
    bump_revision,
    owner_paused,
    workspace_on,
)
from switch_core.db.tenant_lookup import tenants_of_cloud_machine, tenants_of_user
from switch_core.keys import Keyring
from switch_core.tenant_context import no_tenant
from switch_core.visibility.audit_log import (
    OperatorActionRecord,
    last_recorded_step,
    load_operator_request,
    record_admin_change,
    record_operator_progress,
    record_operator_request,
    record_operator_result,
)
from switch_core.visibility.keyed_id import KeyedIdKey, KeyedIdKind, is_keyed_id
from switch_core.visibility.reason_codes import StopReason

logger = logging.getLogger(__name__)

#: How long Core waits for each revoked controller's stream to close.
REVOKE_WAIT_S = 30.0
#: How long Core waits for the box to report stopped before the result. With
#: the revoke wait, a pause still unfinished is `failed` at 2 minutes: when the
#: operators' alert is raised.
STOP_WAIT_S = 90.0
#: After a pause fails part-way (mark or revoke), how long before the alert.
ALERT_AFTER_S = 120.0
_POLL_S = 1.0


# ── The checks every start, wake and reconnect path makes ────────────────────


__all__ = ["owner_paused"]  # kept in the machine store, which also needs it


async def member_enabled(session: AsyncSession, tenant_id: str, user_id: str) -> bool:
    """Whether this member may use hosted agents in this workspace (A2). A user
    who isn't a member reads as enabled: membership is checked elsewhere."""
    enabled = await session.scalar(
        select(TenantMember.hosted_enabled).where(
            TenantMember.tenant_id == tenant_id, TenantMember.user_id == user_id
        )
    )
    return enabled is not False


async def block_reason_in(
    session: AsyncSession, owner_id: str, tenant_id: str | None
) -> StopReason | None:
    """`block_reason` on a session the caller already has, bound to
    `tenant_id` (or to no tenant when it's None): the machine table is global,
    and the user and member rows are read under the caller's binding."""
    if await owner_paused(session, owner_id):
        return StopReason.PAUSED_BY_SWITCH
    if tenant_id is not None and not await member_enabled(session, tenant_id, owner_id):
        return StopReason.TURNED_OFF_BY_ADMIN
    return None


async def paused_since(
    session: AsyncSession, owner_ids: Collection[str]
) -> dict[str, datetime]:
    """When each paused owner among `owner_ids` was paused, in one read; owners
    not paused are left out. For the Status panel ("when")."""
    if not owner_ids:
        return {}
    rows = await session.execute(
        select(User.id, User.hosted_paused_at).where(
            User.id.in_(list(owner_ids)), User.hosted_paused_at.is_not(None)
        )
    )
    return {owner: at for owner, at in rows.all() if at is not None}


async def block_reason(
    session_factory: async_sessionmaker[AsyncSession],
    owner_id: str,
    tenant_id: str | None,
) -> StopReason | None:
    """Why this owner's box may not start, wake or reconnect for this workspace,
    or None when nothing blocks it. A pause wins over a turn-off. Opens its own
    sessions, so it can be called from any path."""
    with no_tenant():
        async with session_factory() as session:
            paused = await owner_paused(session, owner_id)
            await session.commit()
    if paused:
        return StopReason.PAUSED_BY_SWITCH
    if tenant_id is None:
        return None
    async with tenant_session(session_factory, tenant_id) as session:
        enabled = await member_enabled(session, tenant_id, owner_id)
        await session.commit()
    return None if enabled else StopReason.TURNED_OFF_BY_ADMIN


# ── Doing it ─────────────────────────────────────────────────────────────────


#: Raise (True) or clear (False) the operators' "still failing after 2
#: minutes" alert: for a pause, by the user's keyed id; for a
#: turn-off, by the user's and the workspace's. Wired to the alert path by
#: the app; a no-op until then.
AlertAction = Literal["pause", "turn_off"]
HostedAlert = Callable[[AlertAction, str, str | None, bool], Awaitable[None]]


async def _no_alert(
    _action: AlertAction, _user: str, _workspace: str | None, _raised: bool
) -> None:
    return None


class ControllerRevoker(Protocol):
    """Core's existing controller revocation (`ManagementService`)."""

    async def revoke_controllers(
        self,
        session: AsyncSession,
        tenant_id: str,
        controller_ids: list[str],
        revoked_by: Literal["pause", "turn_off"] | None = None,
    ) -> None: ...

    def announce_revoked(self, controller_ids: list[str]) -> None: ...


@dataclass
class HostedAccess:
    session_factory: async_sessionmaker[AsyncSession]
    revoker: ControllerRevoker
    key: KeyedIdKey
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    monotonic: Callable[[], float] = time.monotonic
    revoke_wait_s: float = REVOKE_WAIT_S
    stop_wait_s: float = STOP_WAIT_S
    alert_after_s: float = ALERT_AFTER_S
    alert: HostedAlert = _no_alert
    # To retire each workspace's unused enrolment code on a pause or turn-off;
    # without it (tests) codes are left to expire.
    keyring: Keyring | None = None

    # The background parts of each action, so a test can await them.
    pending: set[asyncio.Task[None]] = field(default_factory=set)
    # Bumped on each resume, so a delayed alert for an earlier pause is dropped.
    _resumes: dict[str, int] = field(default_factory=dict, init=False, repr=False)

    def _user_keyed(self, user_id: str) -> str:
        return self.key.keyed_id(KeyedIdKind.USER, user_id)

    def _workspace_keyed(self, tenant_id: str) -> str:
        return self.key.keyed_id(KeyedIdKind.WORKSPACE, tenant_id)

    # ── Pause and resume (operators) ─────────────────────────────────────────

    async def resolve_user(self, user_keyed_id: str) -> str | None:
        """The user whose keyed id this is, found by recomputing each user's
        keyed id (as Show name does), never by reversing one. None for an id
        that matches no one."""
        if not is_keyed_id(user_keyed_id):
            return None
        with no_tenant():
            async with self.session_factory() as session:
                user_ids = (await session.scalars(select(User.id))).all()
                await session.commit()
        found = None
        for user_id in user_ids:
            # Compare every one, so the time taken doesn't say how far it got.
            if hmac.compare_digest(self._user_keyed(user_id), user_keyed_id):
                found = user_id
        return found

    async def by_keyed_id(
        self, *, action: str, actor_id: str, user_keyed_id: str, reason: str
    ) -> OperatorActionRecord:
        """Pause or resume the user an operator named by keyed id. An id that
        matches no one is audited as failed, `not_found`, and raises
        `LookupError` (a plain 404 at the route)."""
        user_id = await self.resolve_user(user_keyed_id)
        if user_id is None:
            if is_keyed_id(user_keyed_id):
                request = await record_operator_request(
                    self.session_factory,
                    actor_user_id=actor_id,
                    action=(
                        ServerAuditAction.HOSTED_USER_PAUSED
                        if action == "pause"
                        else ServerAuditAction.HOSTED_USER_RESUMED
                    ),
                    target_type="user",
                    target_keyed_id=user_keyed_id,
                    reason=reason,
                )
                await record_operator_result(
                    self.session_factory, request, result="failed", step="not_found"
                )
            raise LookupError("no such user")
        if action == "pause":
            return await self.pause(actor_id=actor_id, user_id=user_id, reason=reason)
        return await self.resume(actor_id=actor_id, user_id=user_id, reason=reason)

    async def workspaces_for(self, user_id: str) -> list[tuple[str, str]]:
        """The `(workspace id, keyed id)` pairs a request entry for this user
        gets its workspace copies in (the rate limits write the entry first)."""
        return await self._workspaces_of(user_id)

    async def pause(
        self,
        *,
        actor_id: str,
        user_id: str,
        reason: str,
        request: OperatorActionRecord | None = None,
    ) -> OperatorActionRecord:
        """Audit, mark and revoke now; wait for the revoke and the stop in the
        background, then record the result. Raises `LookupError` for a user
        that doesn't exist, before anything more is written. `request` is the
        request entry when the caller already wrote it (the rate limits do,
        under their lock); otherwise it's written here."""
        await self._require_user(user_id)
        if request is None:
            request = await record_operator_request(
                self.session_factory,
                actor_user_id=actor_id,
                action=ServerAuditAction.HOSTED_USER_PAUSED,
                target_type="user",
                target_keyed_id=self._user_keyed(user_id),
                reason=reason,
                workspaces=await self._workspaces_of(user_id),
            )
        step = "mark"
        try:
            machine_id = await self._mark_paused(user_id)
            step = "revoke"
            controllers = (
                []
                if machine_id is None
                else await self._controllers_of(machine_id, tenant_id=None)
            )
            await self._revoke(controllers, "pause")
            if machine_id is not None:
                await self._retire_codes(machine_id, tenant_id=None)
        except Exception:
            # The mark, once set, stays: a half-done pause still refuses every
            # start. The result says how far it got.
            await record_operator_result(
                self.session_factory, request, result="failed", step=step
            )
            self._spawn(self._alert_later(request.target_keyed_id))
            raise
        self._spawn(self._finish(request, machine_id, controllers))
        return request

    async def resume(
        self,
        *,
        actor_id: str,
        user_id: str,
        reason: str,
        request: OperatorActionRecord | None = None,
    ) -> OperatorActionRecord:
        """As `pause`: `request` is the entry the caller already wrote."""
        await self._require_user(user_id)
        if request is None:
            request = await record_operator_request(
                self.session_factory,
                actor_user_id=actor_id,
                action=ServerAuditAction.HOSTED_USER_RESUMED,
                target_type="user",
                target_keyed_id=self._user_keyed(user_id),
                reason=reason,
                workspaces=await self._workspaces_of(user_id),
            )
        try:
            await self._clear_pause(user_id)
        except Exception:
            await record_operator_result(
                self.session_factory, request, result="failed", step="clear"
            )
            raise
        await record_operator_result(self.session_factory, request, result="done")
        keyed = request.target_keyed_id
        self._resumes[keyed] = self._resumes.get(keyed, 0) + 1
        await self._set_alert("pause", keyed, None, raised=False)
        return request

    async def _alert_later(self, user_keyed_id: str) -> None:
        resumes = self._resumes.get(user_keyed_id, 0)
        await self.sleep(self.alert_after_s)
        if self._resumes.get(user_keyed_id, 0) == resumes:  # not resumed since
            await self._set_alert("pause", user_keyed_id, None, raised=True)

    async def _set_alert(
        self,
        action: AlertAction,
        user_keyed_id: str,
        workspace_keyed_id: str | None,
        *,
        raised: bool,
    ) -> None:
        # The alert is a second line of news: it never changes the action.
        try:
            await self.alert(action, user_keyed_id, workspace_keyed_id, raised)
        except Exception:
            logger.exception("Updating the hosted action alert failed")

    async def _require_user(self, user_id: str) -> None:
        with no_tenant():
            async with self.session_factory() as session:
                found = await session.scalar(select(User.id).where(User.id == user_id))
                await session.commit()
        if found is None:
            raise LookupError("no such user")

    async def _workspaces_of(self, user_id: str) -> list[tuple[str, str]]:
        """Every workspace the user is in, for its admins' copy of the entry."""
        tenants = sorted(await tenants_of_user(self.session_factory, user_id))
        return [(tenant, self._workspace_keyed(tenant)) for tenant in tenants]

    async def _mark_paused(self, user_id: str) -> str | None:
        """Mark the user paused, and stop their box as paused if they have one.
        Returns the box's id, or None. One transaction; a pause already in
        place keeps its first time."""
        now = self.now()
        store = CloudMachineStore()
        with no_tenant():
            async with self.session_factory() as session:
                # A single UPDATE of the one column: nothing else on the row is
                # read or written back, so a concurrent sign-in can't undo it.
                await session.execute(
                    update(User)
                    .where(User.id == user_id, User.hosted_paused_at.is_(None))
                    .values(hosted_paused_at=now)
                )
                machine = await store.live_for_owner(session, user_id)
                if machine is not None:
                    machine = await store.locked(session, machine.id)
                if machine is not None:
                    if machine.stop_reason != "paused":
                        machine.desired_state = "stopped"
                        machine.stop_reason = "paused"
                        machine.retain_until = None
                        bump_revision(machine, now)
                await session.commit()
                return machine.id if machine is not None else None

    async def _clear_pause(self, user_id: str) -> None:
        now = self.now()
        store = CloudMachineStore()
        with no_tenant():
            async with self.session_factory() as session:
                await session.execute(
                    update(User).where(User.id == user_id).values(hosted_paused_at=None)
                )
                machine = await store.live_for_owner(session, user_id)
                if machine is not None:
                    machine = await store.locked(session, machine.id)
                if machine is not None and machine.stop_reason == "paused":
                    # Stays stopped, as if asleep: the next message wakes it.
                    machine.stop_reason = "idle"
                    machine.updated_at = now
                await session.commit()

    # ── The per-person switch (workspace admins) ─────────────────────────────

    async def set_member(
        self,
        *,
        actor_id: str,
        tenant_id: str,
        user_id: str,
        enabled: bool,
        reason: str,
    ) -> str:
        """Turn hosted agents on or off for one person in this workspace. The
        audit entry is written in the same transaction as the mark. Returns
        its event id."""
        action = (
            AuditAction.HOSTED_PERSON_TURNED_ON
            if enabled
            else AuditAction.HOSTED_PERSON_TURNED_OFF
        )
        async with tenant_session(self.session_factory, tenant_id) as session:
            member = await session.scalar(
                select(TenantMember)
                .where(
                    TenantMember.tenant_id == tenant_id, TenantMember.user_id == user_id
                )
                .with_for_update()
            )
            if member is None:
                raise LookupError("not a member of this workspace")
            member.hosted_enabled = enabled
            event_id = await record_admin_change(
                session,
                workspace_id=tenant_id,
                workspace_keyed_id=self._workspace_keyed(tenant_id),
                actor_user_id=actor_id,
                actor_keyed_id=self._user_keyed(actor_id),
                action=action,
                target_keyed_id=self._user_keyed(user_id),
                result="done",
                reason=reason,
            )
            await session.commit()
        if enabled:
            await self._clear_turned_off(user_id)
            await self._set_alert(
                "turn_off",
                self._user_keyed(user_id),
                self._workspace_keyed(tenant_id),
                raised=False,
            )
        if not enabled:
            machine_id = await self._live_machine_of(user_id)
            if machine_id is not None:
                controllers = await self._controllers_of(
                    machine_id, tenant_id=tenant_id
                )
                await self._revoke(controllers, "turn_off")
                await self._retire_codes(machine_id, tenant_id=tenant_id)
                self._spawn(
                    self._finish_turn_off(
                        event_id, tenant_id, actor_id, user_id, machine_id, controllers
                    )
                )
        return event_id

    async def _finish_turn_off(
        self,
        event_id: str,
        tenant_id: str,
        actor_id: str,
        user_id: str,
        machine_id: str,
        controllers: list[tuple[str, str]],
    ) -> None:
        only_workspace = (
            len(await tenants_of_cloud_machine(self.session_factory, machine_id)) <= 1
        )
        # The box serves nobody else: stop it now, without waiting on the revoke.
        if only_workspace:
            await self._stop_box(machine_id, "turned_off")
        closed = await self._wait_closed(controllers)
        # Within a minute the person's agents can't make AI calls,
        # whatever the connection state. Unconfirmed means the box stops, at
        # once, after the 30 s wait.
        if not closed and not only_workspace:
            # A one-off stop, not a mark: the box serves other
            # workspaces, whose next message wakes it as usual. The person
            # stays refused here through their membership row.
            await self._stop_box(machine_id, "idle")
        stopping = only_workspace or not closed
        stopped = True
        if stopping:
            deadline = self.monotonic() + self.stop_wait_s
            while not (stopped := await self._box_stopped(machine_id)):
                if self.monotonic() >= deadline:
                    break
                await self.sleep(_POLL_S)
        async with tenant_session(self.session_factory, tenant_id) as session:
            await record_admin_change(
                session,
                workspace_id=tenant_id,
                workspace_keyed_id=self._workspace_keyed(tenant_id),
                actor_user_id=actor_id,
                actor_keyed_id=self._user_keyed(actor_id),
                action=AuditAction.HOSTED_PERSON_TURNED_OFF,
                target_keyed_id=self._user_keyed(user_id),
                result="done" if stopped else "failed",
                linked_to=event_id,
                extra={
                    "revoke": "revoked" if closed else "partial",
                    "box_stopped": stopping and stopped,
                    **({} if stopped else {"failed_at": "scale"}),
                },
            )
            await session.commit()
        # A turn-off still failing at 2 minutes raises the alert.
        await self._set_alert(
            "turn_off",
            self._user_keyed(user_id),
            self._workspace_keyed(tenant_id),
            raised=not stopped,
        )

    async def _clear_turned_off(self, user_id: str) -> None:
        """A box stopped as `turned_off` sleeps again once its owner is turned
        on, so the next message wakes it (A2: works within a minute). A pause,
        if any, still holds: `paused` is never touched here."""
        now = self.now()
        store = CloudMachineStore()
        with no_tenant():
            async with self.session_factory() as session:
                machine = await store.live_for_owner(session, user_id)
                if machine is not None:
                    machine = await store.locked(session, machine.id)
                if machine is not None and machine.stop_reason == "turned_off":
                    machine.stop_reason = "idle"
                    machine.updated_at = now
                await session.commit()

    # ── Shared steps ─────────────────────────────────────────────────────────

    async def _live_machine_of(self, user_id: str) -> str | None:
        with no_tenant():
            async with self.session_factory() as session:
                machine = await CloudMachineStore().live_for_owner(session, user_id)
                await session.commit()
                return machine.id if machine is not None else None

    async def _controllers_of(
        self, machine_id: str, *, tenant_id: str | None
    ) -> list[tuple[str, str]]:
        """(workspace, controller) for the box's controllers: every workspace's
        for a pause, one workspace's for a turn-off."""
        tenants = (
            [tenant_id]
            if tenant_id is not None
            else await tenants_of_cloud_machine(self.session_factory, machine_id)
        )
        found: list[tuple[str, str]] = []
        for tenant in tenants:
            async with tenant_session(self.session_factory, tenant) as session:
                workspace = await workspace_on(session, machine_id)
                await session.commit()
            if workspace is not None and workspace.controller_id is not None:
                found.append((tenant, workspace.controller_id))
        return found

    async def _revoke(
        self,
        controllers: list[tuple[str, str]],
        revoked_by: Literal["pause", "turn_off"],
    ) -> None:
        """Revoke them, marked as this block's: once it's lifted, a message may
        wake the box to enrol a new controller."""
        by_tenant: dict[str, list[str]] = {}
        for tenant, controller in controllers:
            by_tenant.setdefault(tenant, []).append(controller)
        for tenant, ids in by_tenant.items():
            async with tenant_session(self.session_factory, tenant) as session:
                await self.revoker.revoke_controllers(session, tenant, ids, revoked_by)
                await session.commit()
            self.revoker.announce_revoked(ids)

    async def _retire_codes(self, machine_id: str, *, tenant_id: str | None) -> None:
        """No enrolment code from before the pause or turn-off can enrol after
        it is lifted: `prepare` mints a fresh one then."""
        if self.keyring is None:
            return
        from switch_core.gateway.cloud_controllers import retire_workspace_code

        tenants = (
            [tenant_id]
            if tenant_id is not None
            else await tenants_of_cloud_machine(self.session_factory, machine_id)
        )
        for tenant in tenants:
            async with tenant_session(self.session_factory, tenant) as session:
                workspace = await workspace_on(session, machine_id)
                if workspace is not None:
                    await retire_workspace_code(session, workspace, self.keyring)
                await session.commit()

    async def _wait_closed(self, controllers: list[tuple[str, str]]) -> bool:
        """Whether every revoked controller's stream closed within the wait."""
        deadline = self.monotonic() + self.revoke_wait_s
        while True:
            if all([await self._closed(tenant, cid) for tenant, cid in controllers]):
                return True
            if self.monotonic() >= deadline:
                return False
            await self.sleep(_POLL_S)

    async def _closed(self, tenant_id: str, controller_id: str) -> bool:
        async with tenant_session(self.session_factory, tenant_id) as session:
            row = await session.get(AgentController, controller_id)
            await session.commit()
        if row is None or row.connected_at is None:
            return True
        return (
            row.disconnected_at is not None and row.disconnected_at >= row.connected_at
        )

    async def _stop_box(self, machine_id: str, reason: str) -> None:
        now = self.now()
        store = CloudMachineStore()
        with no_tenant():
            async with self.session_factory() as session:
                machine = await store.locked(session, machine_id)
                # Also a box already asleep: it takes the label, so clean-up and
                # the wake path leave it alone.
                if machine is not None and (
                    machine.desired_state != "stopped" or machine.stop_reason != reason
                ):
                    store.stop(machine, reason, now)  # type: ignore[arg-type]
                await session.commit()

    async def _box_stopped(self, machine_id: str) -> bool:
        with no_tenant():
            async with self.session_factory() as session:
                machine = await session.get(CloudMachine, machine_id)
                await session.commit()
        return machine is None or machine.state in {"stopped", "retained", "deleted"}

    async def _finish(
        self,
        request: OperatorActionRecord,
        machine_id: str | None,
        controllers: list[tuple[str, str]],
    ) -> None:
        try:
            closed = await self._wait_closed(controllers)
            await record_operator_progress(
                self.session_factory, request, step="revoked" if closed else "partial"
            )
            # The box was set to stop with the mark, before the revoke, so the
            # scaler is already acting on it; nothing waits on the revoke.
            deadline = self.monotonic() + self.stop_wait_s
            while machine_id is not None and not await self._box_stopped(machine_id):
                if self.monotonic() >= deadline:
                    await record_operator_result(
                        self.session_factory, request, result="failed", step="scale"
                    )
                    await self._set_alert(
                        "pause", request.target_keyed_id, None, raised=True
                    )
                    return
                await self.sleep(_POLL_S)
            await record_operator_progress(self.session_factory, request, step="scaled")
            await record_operator_result(self.session_factory, request, result="done")
            await self._set_alert("pause", request.target_keyed_id, None, raised=False)
        except Exception:
            logger.exception("Finishing a hosted pause failed")
            await record_operator_result(
                self.session_factory, request, result="failed", step="finish"
            )
            await self._set_alert("pause", request.target_keyed_id, None, raised=True)

    async def sweep_unfinished(self) -> int:
        """On start: a pause or resume whose result never got written (Core
        stopped part-way) is recorded `failed` at the last step it reached.
        Only actions older than the longest an action can take, so one still
        running in another process is left alone. Returns how many.

        The failed result goes to the operators' log and to each workspace's
        copy of the request.
        """
        cutoff = self.now() - timedelta(
            seconds=self.revoke_wait_s + self.stop_wait_s + 60
        )
        actions = (
            ServerAuditAction.HOSTED_USER_PAUSED.value,
            ServerAuditAction.HOSTED_USER_RESUMED.value,
        )
        swept = 0
        with no_tenant():
            async with self.session_factory() as session:
                requests = (
                    (
                        await session.execute(
                            select(ServerAuditEvent)
                            .where(
                                ServerAuditEvent.action.in_(actions),
                                ServerAuditEvent.details["phase"].astext == "requested",
                                ServerAuditEvent.occurred_at < cutoff,
                            )
                            .order_by(ServerAuditEvent.occurred_at)
                        )
                    )
                    .scalars()
                    .all()
                )
                unfinished: list[tuple[ServerAuditEvent, str]] = []
                for event in requests:
                    last = await last_recorded_step(session, event.id)
                    if last is None or last[0] != "result":
                        step = last[1] if last is not None and last[1] else "mark"
                        unfinished.append((event, step))
                await session.commit()
        for event, step in unfinished:
            # The request as written, with its workspace copies, so each
            # workspace's admins see the failure too.
            request = await load_operator_request(
                self.session_factory, event.id, self.key
            )
            if request is None:
                continue
            await record_operator_result(
                self.session_factory,
                request,
                result="failed",
                step=step,
                extra={"swept": True},
            )
            swept += 1
        return swept

    def _spawn(self, work: Awaitable[None]) -> None:
        task = asyncio.ensure_future(work)
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)
